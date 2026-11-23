/** 网关网页账号与游客邀请路由（/v1/web/*）。 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CooAccountDb, ParentAccount } from './coo-account-db.ts';
import { withTransaction, type Db } from './db.ts';
import type { IdentityRegistry } from './global-identity.ts';
import { bearer, HttpError, json, readJson } from './http.ts';
import type { Seat } from './protocol.ts';
import type { RoomHost } from './room-host.ts';
import { activeSeatForCoo, hashSeatToken, seatByTokenHash, type RoomRow, type SeatRow } from './room-seat-db.ts';
import { lockCooRows } from './storage/locks.ts';
import { isWebSeatToken, type WebPlayerDb } from './web-player-db.ts';

export interface WebPlayerRouteContext {
  db: Db;
  coo: CooAccountDb;
  webPlayers: WebPlayerDb;
  registry: IdentityRegistry;
  identityAuthority?: string;
  audienceUrl(): string;
  cookieOf(req: IncomingMessage, name: string): string;
  webCookie(req: IncomingMessage, token: string, expiresAt?: number): string;
  requireWebPost(req: IncomingMessage): void;
  checkOperator(req: IncomingMessage): void;
  checkLoginIpRate(req: IncomingMessage): void;
  checkRedeemIpRate(req: IncomingMessage): void;
  checkLoginNameRate(name: string): void;
  checkCredentialRate(accountId: string): void;
  parentSession(req: IncomingMessage): Promise<{ account: ParentAccount; sessionId: string; expiresAt: number }>;
  ensurePlayerCoo(account: ParentAccount, requested?: string): Promise<{ cooId: string; secret: string; name: string }>;
  logoutWebPlayer(cookie: string): Promise<void>;
  guestRoom(): Promise<RoomRow>;
  ensureHall(): Promise<RoomRow>;
  assertRoomEntry(roomId: string, cooId: string): Promise<void>;
  host(roomId: string): Promise<RoomHost>;
  seatOfRow(roomId: string, seat: SeatRow): Promise<Seat>;
  markDirty(roomId: string): void;
  pokeClock(): void;
}

async function webInviteIssuer(req: IncomingMessage, cookie: string, ctx: WebPlayerRouteContext): Promise<string> {
  const session = await ctx.webPlayers.session(cookie);
  const parentCookie = ctx.cookieOf(req, 'parlor_parent');
  const parent = parentCookie ? await ctx.coo.verifySession(parentCookie) : null;
  const token = bearer(req);
  if (!token) {
    const issuer = session ? session.account_id : parent?.account.id;
    if (issuer) return issuer;
  } else {
    const played = await seatByTokenHash(ctx.db, hashSeatToken(token));
    if (played && isWebSeatToken(token) && session?.account_id && session.coo_id === played.cooId) {
      if ((await ctx.webPlayers.seatSession(played.tokenHash))?.token_hash === session.token_hash) return session.account_id;
    } else if (played && !isWebSeatToken(token) && parent && played.cooId === await ctx.coo.playerCooOf(parent.account.id)) {
      return parent.account.id;
    }
  }
  throw new HttpError(403, '请用正式会馆账号或家长钥匙登录后发码');
}

export async function serveWebPlayerRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  ctx: WebPlayerRouteContext,
): Promise<void> {
  const path = url.pathname.slice('/v1/web/'.length);
  res.setHeader('cache-control', 'no-store');
  if (method === 'POST') ctx.requireWebPost(req);
  const cookie = ctx.cookieOf(req, 'parlor_web');
  if (path === 'credentials' && (method === 'GET' || method === 'POST')) {
    const { account } = await ctx.parentSession(req);
    if (method === 'GET') {
      const loginName = await ctx.webPlayers.credentialName(account.id);
      const player = await ctx.coo.playerCooOf(account.id);
      json(res, 200, { loginName, suggestedName: (player && await ctx.coo.cooDisplayName(player)) || account.displayName });
      return;
    }
    ctx.checkCredentialRate(account.id);
    const body = await readJson(req);
    const loginName = await ctx.webPlayers.setCredentials(account.id, body, async () => {
      await ctx.db.prepare('SELECT id FROM accounts WHERE id=? FOR UPDATE').get(account.id);
      const parent = (await ctx.parentSession(req)).account;
      const existing = await ctx.coo.playerCooOf(parent.id);
      if (existing) return existing;
      if (ctx.identityAuthority && ctx.identityAuthority !== 'self') {
        throw new HttpError(409, '请先从 Coo 面板下场一次，再设置登录名和密码');
      }
      const player = await ctx.ensurePlayerCoo(parent);
      if (ctx.identityAuthority === 'self') await ctx.registry.enroll(player.cooId, player.secret, player.name, 'human');
      return player.cooId;
    });
    ctx.pokeClock();
    json(res, 200, { loginName });
    return;
  }

  if (method === 'POST' && (path === 'login' || path === 'redeem')) {
    if (path === 'login') ctx.checkLoginIpRate(req);
    else ctx.checkRedeemIpRate(req);
    const body = await readJson(req);
    if (path === 'login') {
      const name = typeof body.loginName === 'string' ? body.loginName.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 48) : '';
      ctx.checkLoginNameRate(name);
    } else if (await ctx.webPlayers.session(cookie)) {
      throw new HttpError(409, '请先退出当前会馆登录');
    }
    const session = path === 'login' ? await ctx.webPlayers.login(body) : await ctx.webPlayers.redeem(body, async (id, name) => {
      const secret = randomBytes(32).toString('base64url');
      if (ctx.identityAuthority === 'self') await ctx.registry.enroll(id, secret, name, 'human');
      else if (await ctx.coo.registerCoo(id, secret, 'human', name) !== 'ok') throw new HttpError(500, '无法建立游客身份');
    });
    await ctx.logoutWebPlayer(cookie);
    res.setHeader('set-cookie', ctx.webCookie(req, session.token, session.expiresAt));
    json(res, 200, { ok: true });
    return;
  }
  if (path === 'logout' && method === 'POST') {
    await ctx.logoutWebPlayer(cookie);
    res.setHeader('set-cookie', ctx.webCookie(req, ''));
    json(res, 200, { ok: true });
    return;
  }

  if (path.startsWith('operator/invites')) {
    ctx.checkOperator(req);
    if (path === 'operator/invites' && method === 'GET') {
      json(res, 200, { invites: await ctx.webPlayers.invitations(undefined, (url.searchParams.get('q') ?? '').trim().slice(0, 100)) });
      return;
    }
    const id = /^operator\/invites\/([a-f0-9-]{36})\/revoke$/.exec(path)?.[1];
    if (id && method === 'POST') {
      await ctx.webPlayers.revoke(id);
      ctx.pokeClock();
      json(res, 200, { ok: true });
      return;
    }
  }
  const invites = /^(parent\/)?invites(?:\/([a-f0-9-]{36})\/revoke)?$/.exec(path);
  if (invites && (method === 'POST' || (method === 'GET' && !invites[2]))) {
    const issuer = invites[1] ? (await ctx.parentSession(req)).account.id : await webInviteIssuer(req, cookie, ctx);
    if (method === 'GET') {
      json(res, 200, { invites: await ctx.webPlayers.invitations(issuer) });
    } else if (invites[2]) {
      await ctx.webPlayers.revoke(invites[2], issuer);
      ctx.pokeClock();
      json(res, 200, { ok: true });
    } else {
      const issued = await ctx.webPlayers.issue(issuer, (await ctx.guestRoom()).id);
      const link = new URL('/play?entry=guest', ctx.audienceUrl());
      link.hash = new URLSearchParams({ invite: issued.code }).toString();
      json(res, 200, { ...issued, link: link.href });
    }
    return;
  }

  if (path === 'me' && method === 'GET') {
    const session = await ctx.webPlayers.session(cookie);
    if (!session) throw new HttpError(401, '请登录会馆');
    json(res, 200, {
      name: await ctx.coo.cooDisplayName(session.coo_id),
      guest: !session.account_id,
      expiresAt: Number(session.expires_at),
      seated: !!await activeSeatForCoo(ctx.db, session.coo_id),
    });
    return;
  }
  if (path === 'play' && method === 'POST') {
    const body = await readJson(req);
    const hall = await ctx.ensureHall();
    const result = await withTransaction(ctx.db, async () => {
      const session = await ctx.webPlayers.session(cookie, true);
      if (!session) throw new HttpError(401, '网页会话已失效，请重新登录或领取邀请');
      const player = session.coo_id;
      await lockCooRows(ctx.db, [player]);
      const current = await activeSeatForCoo(ctx.db, player);
      if (current && body.takeover !== true) throw new HttpError(409, '已有席位，请点「接管席位」继续');
      const wanted = typeof body.room === 'string' ? body.room.trim() : '';
      const roomId = current?.roomId ?? session.guest_room_id ?? (wanted || hall.id);
      if (session.guest_room_id && roomId !== session.guest_room_id) throw new HttpError(403, '游客仅可进入获邀客厅');
      await ctx.assertRoomEntry(roomId, player);
      const host = await ctx.host(roomId);
      const token = 'web_' + randomBytes(32).toString('base64url');
      let name = await ctx.coo.cooDisplayName(player);
      if (!current && !session.account_id && body.name !== undefined) {
        name = ctx.webPlayers.guestName(body.name);
        await ctx.coo.renameCooDisplay(player, name);
      }
      const joined = current ? await host.reissueSeatToken(player, token)
        : await host.join(player, { token, name, kind: 'human', tier: 'off' });
      await ctx.webPlayers.bindSeat(session, token);
      return {
        room: roomId, token, guest: !session.account_id, tableId: (await host.tableLock(player))?.tableId,
        seat: await ctx.seatOfRow(roomId, joined.seat),
        identity: { cooId: player, cooSecret: 'seat-only' },
      };
    });
    ctx.markDirty(result.room);
    json(res, 200, result);
    return;
  }
  throw new HttpError(404, '没有这个会馆登录接口');
}
