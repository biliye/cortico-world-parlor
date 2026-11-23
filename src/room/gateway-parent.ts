/** 网关家长门户路由（/v1/parent/* 与旧单厅迁移链接 /v1/owner）。 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serverClock } from './clock.ts';
import type { CooAccountDb, ParentAccount } from './coo-account-db.ts';
import type { Db } from './db.ts';
import { DIVINATION_REQUEST } from './divination-protocol.ts';
import { GAME_LABELS, gameLabelOf } from './game-labels.ts';
import { payloadVersion } from './gateway-support.ts';
import type { IdentityRegistry } from './global-identity.ts';
import { HttpError, json, readJson } from './http.ts';
import { LedgerDb } from './ledger-db.ts';
import { MailDb } from './mail-db.ts';
import { personalHistory, type AccountHistoryQuery } from './personal-account.ts';
import type { RoomEvent, Seat } from './protocol.ts';
import type { RoomHost } from './room-host.ts';
import { activeSeatForCoo, activeSeats, getRoom, renameSeat, resolveRoom, type RoomRow, type SeatRow } from './room-seat-db.ts';

function compactParentEvent(event: RoomEvent) {
  return {
    seq: event.seq, ts: event.ts, type: event.type, from: event.from, text: event.text,
    data: { name: event.data?.name, presenceWeb: event.data?.presenceWeb },
  };
}

export interface ParentRouteContext {
  db: Db;
  coo: CooAccountDb;
  registry: IdentityRegistry;
  now: () => number;
  defaultRoomId: string;
  identityAuthority?: string;
  authorityUrl(): string;
  cookieOf(req: IncomingMessage, name: string): string;
  parentCookie(token: string, req: IncomingMessage): string;
  clearParentCookie(req: IncomingMessage): string;
  parentSession(req: IncomingMessage): Promise<{ account: ParentAccount; sessionId: string; expiresAt: number }>;
  checkParentKeyRate(req: IncomingMessage): void;
  requireWebPost(req: IncomingMessage): void;
  ensureAccount(req: IncomingMessage, cooId: string, displayName?: string): Promise<{ account: ParentAccount; ownerKey?: string }>;
  ensurePlayerCoo(account: ParentAccount, requested?: string): Promise<{ cooId: string; secret: string; name: string }>;
  enterPlayerRoom(target: RoomRow, player: { cooId: string; name: string }, allowHallFallback: boolean): Promise<{
    room: RoomRow; seat: SeatRow; token: string;
  }>;
  leaveOwnSeat(cooId: string, body: Record<string, unknown>): Promise<{ ok: true; left: boolean }>;
  host(roomId: string): Promise<RoomHost>;
  onlineSeatIds(roomId: string): string[];
  seatOfRow(roomId: string, seat: SeatRow): Promise<Seat>;
  historyQuery(params: URLSearchParams): AccountHistoryQuery;
}

async function parentSeatView(ctx: ParentRouteContext, cooId: string) {
  const seat = await activeSeatForCoo(ctx.db, cooId);
  if (!seat) return null;
  const room = await getRoom(ctx.db, seat.roomId);
  return {
    room: seat.roomId,
    roomName: room?.name ?? seat.roomId,
    id: seat.id,
    name: seat.name,
    kind: seat.kind,
    tier: seat.tier,
  };
}

async function parentPlay(ctx: ParentRouteContext, account: ParentAccount, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requested = typeof body.room === 'string' && body.room.trim() ? body.room.trim() : '';
  const childSeat = await activeSeatForCoo(ctx.db, account.cooId);
  const wanted = requested || childSeat?.roomId || ctx.defaultRoomId;
  const target = (await getRoom(ctx.db, wanted)) ?? (await resolveRoom(ctx.db, wanted));
  if (!target) throw new HttpError(404, `客厅不存在：${wanted}`);
  if (target.archivedAt !== null) throw new HttpError(409, '这个客厅已经归档了');

  if (ctx.identityAuthority && ctx.identityAuthority !== 'self') {
    return { globalEntry: ctx.authorityUrl(), room: target.id };
  }
  const player = await ctx.ensurePlayerCoo(account, typeof body.name === 'string' ? body.name : '');
  if (ctx.identityAuthority === 'self') await ctx.registry.enroll(player.cooId, player.secret, player.name, 'human');
  const { room, seat, token } = await ctx.enterPlayerRoom(target, player, true);
  return {
    room: room.id,
    roomName: room.name,
    seat: await ctx.seatOfRow(room.id, seat),
    token,
    identity: { cooId: player.cooId, cooSecret: ctx.identityAuthority ? 'seat-only' : player.secret },
    player: true,
    ...(room.id !== target.id ? { fallback: 'room_full' } : {}),
  };
}

async function parentRename(ctx: ParentRouteContext, account: ParentAccount, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const raw = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  if (!raw) throw new HttpError(400, '名字不能为空');
  if (raw.length > 24) throw new HttpError(400, '名字最多 24 个字');

  const playerId = await ctx.coo.playerCooOf(account.id);
  let seat: { room: string; id: string; name: string } | null = null;
  if (playerId) {
    const active = await activeSeatForCoo(ctx.db, playerId);
    if (active) {
      // 同厅重名会抛 RoomSeatError('name_taken')，由 statusOf 转成 409。
      await renameSeat(ctx.db, active.roomId, active.id, raw);
      seat = { room: active.roomId, id: active.id, name: raw };
    }
    await ctx.coo.renameCooDisplay(playerId, raw);
  }
  const renamed = await ctx.coo.rename(account.id, raw);
  if (!renamed) throw new HttpError(409, '改不了名字');
  if (!playerId && (!ctx.identityAuthority || ctx.identityAuthority === 'self')) await ctx.ensurePlayerCoo(renamed, raw);
  return {
    account: { id: renamed.id, cooId: renamed.cooId, displayName: renamed.displayName },
    seat,
  };
}

/** 家长只读视图跟孩子当前席位走，只显示家长需要的通知文案。 */
async function parentView(ctx: ParentRouteContext, cooId: string, since: number, limit: number, compact: boolean) {
  const now = ctx.now();
  const seat = await activeSeatForCoo(ctx.db, cooId);
  const mail = new MailDb(ctx.db, { now: ctx.now });
  const divinationText = '问卦阁已把你的签寄给孩子，正在等解签。';
  const recentMail = async () => (await mail.parentRecent(cooId, limit)).map(item =>
    item.action === DIVINATION_REQUEST ? { ...item, text: divinationText } : item);
  if (!seat) {
    return {
      seat: null,
      room: null,
      ...(compact ? {} : { latest: 0, now, at: serverClock(now) }),
      events: [],
      tablePrivate: null,
      mail: await recentMail(),
      mailUnread: await mail.unreadCount(cooId),
    };
  }
  const room = await getRoom(ctx.db, seat.roomId);
  const host = await ctx.host(seat.roomId);
  const snapshot = await host.snapshot(cooId, { since, limit, parentMessagesOnly: compact });
  const events = snapshot.events.map(event => {
    const notice = event.data?.mail as { action?: string } | undefined;
    return notice?.action === DIVINATION_REQUEST ? { ...event, text: divinationText } : event;
  });
  // 家长防偷看：桌上还有「真人」席位时，藏起孩子的暗牌与私牌事件。同桌的 Coo 不算真人。
  const liveTableId = snapshot.table && snapshot.table.status !== 'ended'
    ? snapshot.table.id ?? snapshot.table.tableId
    : undefined;
  let humanAtTable = false;
  if (liveTableId) {
    const row = await ctx.db.prepare(
      `SELECT 1 AS hit
         FROM table_seats ts
         JOIN room_seats rs ON rs.room_id = ts.room_id AND rs.id = ts.seat_id
        WHERE ts.table_id = ? AND ts.left_at IS NULL AND rs.kind = 'human'
        LIMIT 1`,
    ).get(liveTableId) as { hit?: number } | undefined;
    humanAtTable = !!row;
  }
  const ownerPrivateHidden = !!liveTableId && humanAtTable;
  const active = await host.tableLock(cooId);
  const watchTableId = active && snapshot.table?.tableId === active.tableId && !snapshot.table.frozen
    && (active.status === 'bidding' || active.status === 'playing')
    ? active.tableId : undefined;
  return {
    seat: snapshot.seat,
    room: { id: seat.roomId, name: room?.name ?? seat.roomId, kind: room?.kind ?? 'room' },
    ...(compact ? {} : { latest: snapshot.latest, now: snapshot.now, at: snapshot.at }),
    events: ownerPrivateHidden
      ? events.filter((event) => event.type !== 'parlor.table.turn')
      : events,
    ...(compact ? {} : { tables: snapshot.tables ?? [] }),
    ...(snapshot.table ? {
      table: compact
        ? { label: snapshot.table.label, game: snapshot.table.game, text: snapshot.table.text }
        : snapshot.table,
    } : {}),
    ...(watchTableId ? { watchTableId } : {}),
    tablePrivate: ownerPrivateHidden || !snapshot.tablePrivate ? null
      : compact ? { text: snapshot.tablePrivate.text } : snapshot.tablePrivate,
    ...(snapshot.ledger ? { ledger: snapshot.ledger } : {}),
    ledgerRoom: snapshot.ledgerRoom ?? [],
    mailUnread: snapshot.mailUnread ?? 0,
    mail: await recentMail(),
    ownerPrivateHidden,
  };
}

export async function serveParentRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  ctx: ParentRouteContext,
): Promise<boolean> {
  if (method === 'POST' && url.pathname === '/v1/parent/session') {
    const body = await readJson(req);
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    ctx.checkParentKeyRate(req);
    const account = key ? await ctx.coo.verifyOwnerKey(key) : null;
    if (!account) throw new HttpError(401, '这个家长链接不对，或已经失效了');
    const session = await ctx.coo.createSession(account.id);
    if (!session) throw new HttpError(403, '这个家长账户被停用了');
    res.setHeader('set-cookie', ctx.parentCookie(session.token, req));
    json(res, 200, {
      account: { id: account.id, cooId: account.cooId, displayName: account.displayName },
      expiresAt: session.expiresAt,
    });
    return true;
  }

  if (method === 'GET' && url.pathname === '/v1/parent/me') {
    const session = await ctx.parentSession(req);
    json(res, 200, {
      account: { id: session.account.id, cooId: session.account.cooId, displayName: session.account.displayName },
      expiresAt: session.expiresAt,
      seat: await parentSeatView(ctx, session.account.cooId),
    });
    return true;
  }

  if (method === 'GET' && url.pathname === '/v1/parent/history') {
    const { account } = await ctx.parentSession(req);
    const playerCooId = await ctx.coo.playerCooOf(account.id);
    let page: Awaited<ReturnType<typeof personalHistory>> = { items: [], next: null };
    let ledger: { games: number; wins: number; losses: number; draws: number } | null = null;
    if (playerCooId) {
      try {
        page = await personalHistory(ctx.db, playerCooId, ctx.historyQuery(url.searchParams));
      } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : String(error)); }
      const summary = await new LedgerDb(ctx.db, { now: ctx.now }).summaryFor(playerCooId);
      ledger = { games: summary.games, wins: summary.wins, losses: summary.losses, draws: summary.draws };
    }
    res.setHeader('cache-control', 'private, no-store');
    json(res, 200, {
      player: playerCooId !== null,
      ledger,
      games: Object.entries(GAME_LABELS).map(([id, label]) => ({ id, label })),
      items: page.items.map((item) => ({
        ...item,
        gameLabel: item.game ? gameLabelOf(item.game) : '',
      })),
      next: page.next,
    }, req);
    return true;
  }

  if (method === 'GET' && url.pathname === '/v1/parent/view') {
    const session = await ctx.parentSession(req);
    const since = Number(url.searchParams.get('since') ?? 0) || 0;
    const limit = Number(url.searchParams.get('limit') ?? 30) || 30;
    const compact = url.searchParams.get('view') === 'compact-v1';
    const view = await parentView(ctx, session.account.cooId, since, limit, compact);
    res.setHeader('cache-control', 'private, no-store');
    if (!compact) {
      json(res, 200, view, req);
      return true;
    }
    const { events: rawEvents, mail, ...state } = view;
    const events = rawEvents.map(compactParentEvent);
    const versions = { state: payloadVersion(state), events: payloadVersion(events), mail: payloadVersion(mail) };
    json(res, 200, {
      now: ctx.now(), versions,
      ...(versions.state === url.searchParams.get('stateVersion') ? {} : { state }),
      ...(versions.events === url.searchParams.get('eventsVersion') ? {} : { events }),
      ...(versions.mail === url.searchParams.get('mailVersion') ? {} : { mail }),
    }, req);
    return true;
  }

  if (method === 'GET' && url.pathname === '/v1/parent/table') {
    const { account } = await ctx.parentSession(req);
    const seat = await activeSeatForCoo(ctx.db, account.cooId);
    const tableId = url.searchParams.get('table');
    if (!seat || !tableId) throw new HttpError(404, '孩子当前没有在这张牌桌上');
    const host = await ctx.host(seat.roomId);
    const active = await host.tableLock(account.cooId);
    if (active?.tableId !== tableId) throw new HttpError(404, '孩子当前没有在这张牌桌上');
    const table = await host.tablePublic(tableId);
    if (!table || (table.status !== 'bidding' && table.status !== 'playing')) {
      throw new HttpError(404, '孩子当前没有在这张牌桌上');
    }
    if (table.frozen) throw new HttpError(409, '这张牌桌已暂停，暂时无法观看。');
    const tableSeats = new Set((table.seats as Array<{ id: string }> | undefined)?.map(player => player.id));
    const seats = (await activeSeats(ctx.db, seat.roomId)).filter(player => tableSeats.has(player.id))
      .map(({ id, name, kind }) => ({ id, name, kind }));
    const online = ctx.onlineSeatIds(seat.roomId).filter(id => tableSeats.has(id));
    if ((await host.tableLock(account.cooId))?.tableId !== tableId) {
      throw new HttpError(404, '孩子当前没有在这张牌桌上');
    }
    res.setHeader('Cache-Control', 'private, no-store');
    json(res, 200, { table, seats, online, now: ctx.now() }, req);
    return true;
  }

  if (method === 'POST' && url.pathname === '/v1/parent/play') {
    const body = await readJson(req);
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (key) {
      ctx.checkParentKeyRate(req);
      const account = await ctx.coo.verifyOwnerKey(key);
      if (!account) throw new HttpError(401, '这个家长链接不对，或已经失效了');
      const fresh = await ctx.coo.createSession(account.id);
      if (!fresh) throw new HttpError(403, '这个家长账户被停用了');
      res.setHeader('set-cookie', ctx.parentCookie(fresh.token, req));
      json(res, 200, await parentPlay(ctx, account, body));
      return true;
    }
    const session = await ctx.parentSession(req);
    json(res, 200, await parentPlay(ctx, session.account, body));
    return true;
  }

  if (method === 'POST' && url.pathname === '/v1/parent/rename') {
    const session = await ctx.parentSession(req);
    const body = await readJson(req);
    json(res, 200, await parentRename(ctx, session.account, body));
    return true;
  }

  if (method === 'POST' && url.pathname === '/v1/parent/logout') {
    const token = ctx.cookieOf(req, 'parlor_parent');
    if (token) await ctx.coo.revokeSession(token);
    res.setHeader('set-cookie', ctx.clearParentCookie(req));
    json(res, 200, { ok: true });
    return true;
  }

  if (method === 'POST' && url.pathname === '/v1/parent/leave') {
    ctx.requireWebPost(req);
    const { account } = await ctx.parentSession(req);
    json(res, 200, await ctx.leaveOwnSeat(account.cooId, await readJson(req)));
    return true;
  }

  return false;
}

/** 旧单厅 `/v1/owner` 跳转的弃用生效时间（RFC 9745 §2.1 结构化日期 `@<Unix 秒>`，2026-11-23T00:00:00Z）。 */
const LEGACY_OWNER_DEPRECATION = '@1795392000';

export async function serveLegacyOwnerRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ParentRouteContext,
): Promise<void> {
  // 0.13.x 的家长链接是 /v1/owner?token=<每厅 ownerToken>。迁移把哈希存进
  // room_seats.legacy_owner_token_hash；这里认出来就换一个 HttpOnly 会话，跳到新页面。
  const token = url.searchParams.get('token') ?? '';
  if (!token) throw new HttpError(410, '旧家长链接缺 token；请从扩展面板重新拿');
  const hash = createHash('sha256').update(token).digest('hex');
  const seat = await ctx.db.prepare(
    'SELECT room_id, coo_id FROM room_seats WHERE legacy_owner_token_hash = ? LIMIT 1',
  ).get(hash) as { room_id: string; coo_id: string } | undefined;
  if (!seat) throw new HttpError(410, '这个旧家长链接已经失效；请从扩展面板重新拿');
  const account = await ctx.ensureAccount(req, seat.coo_id);
  const session = await ctx.coo.createSession(account.account.id);
  if (!session) throw new HttpError(403, '这个家长账户被停用了');
  res.writeHead(302, {
    'set-cookie': ctx.parentCookie(session.token, req),
    location: '/parent',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    deprecation: LEGACY_OWNER_DEPRECATION,
  });
  res.end();
}
