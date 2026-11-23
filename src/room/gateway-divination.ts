/** 网关问卦阁路由：抽签、红榜、阁内闲聊与解签已读回执（/v1/divination/*）。 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CooAccountDb, ParentAccount } from './coo-account-db.ts';
import type { Db } from './db.ts';
import type { DivinationDb } from './divination-db.ts';
import { DIVINATION_NAME, DIVINATION_ROOM } from './divination-protocol.ts';
import { bearer, headerValue, HttpError, json, readJson } from './http.ts';
import { GLOBAL_HEADER } from './identity-protocol.ts';
import type { RoomHost } from './room-host.ts';
import { activeSeatForCoo } from './room-seat-db.ts';
import type { WebPlayerDb } from './web-player-db.ts';

export interface DivinationRouteContext {
  db: Db;
  coo: CooAccountDb;
  webPlayers: WebPlayerDb;
  divination: DivinationDb;
  hallId: string;
  cookieOf(req: IncomingMessage, name: string): string;
  cooOrSeat(req: IncomingMessage): Promise<string>;
  host(roomId: string): Promise<RoomHost>;
  checkChatRate(key: string): void;
  ensurePlayerCoo(account: ParentAccount, requested?: string): Promise<{ cooId: string; secret: string; name: string }>;
}

async function resolveAccount(req: IncomingMessage, ctx: DivinationRouteContext): Promise<ParentAccount | undefined> {
  const web = ctx.cookieOf(req, 'parlor_web');
  const session = web ? await ctx.webPlayers.session(web) : undefined;
  if (session) return session.account_id ? ctx.coo.byId(session.account_id) : undefined;
  const parent = ctx.cookieOf(req, 'parlor_parent');
  return parent ? (await ctx.coo.verifySession(parent))?.account : undefined;
}

async function resolveChatter(
  req: IncomingMessage,
  ctx: DivinationRouteContext,
  account?: ParentAccount,
): Promise<{ id: string; name: string; cooId: string | null } | null> {
  if (account) {
    const cooId = await ctx.coo.playerCooOf(account.id);
    const name = cooId ? await ctx.coo.cooDisplayName(cooId) : null;
    return { id: account.id, name: name || account.displayName, cooId };
  }
  if (!bearer(req) && !headerValue(req, 'x-parlor-coo') && !headerValue(req, GLOBAL_HEADER)) return null;
  const cooId = await ctx.cooOrSeat(req);
  if (await ctx.webPlayers.isGuest(cooId)) return null;
  const seat = await activeSeatForCoo(ctx.db, cooId);
  return seat ? { id: cooId, name: seat.name, cooId } : null;
}

export async function serveDivinationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  ctx: DivinationRouteContext,
): Promise<void> {
  res.setHeader('cache-control', 'no-store');
  const account = await resolveAccount(req, ctx);
  if (req.method === 'GET' && path === 'unread') {
    json(res, 200, { canReceive: !!account, draw: account ? await ctx.divination.unread(account.id) : null });
    return;
  }
  if (req.method === 'GET' && path === 'room') {
    const [today, chat, chatter] = await Promise.all([
      ctx.divination.today(account?.id), ctx.divination.chat(), resolveChatter(req, ctx, account),
    ]);
    json(res, 200, { ...today, chat, canDraw: !!account, canChat: !!chatter });
    return;
  }
  if (req.method === 'POST' && path === 'chat') {
    const chatter = await resolveChatter(req, ctx, account);
    if (!chatter) throw new HttpError(403, '请登录正式茶馆账号后发言');
    const seat = chatter.cooId && await activeSeatForCoo(ctx.db, chatter.cooId);
    if (seat && await (await ctx.host(seat.roomId)).chatLockedFor(seat.cooId)) {
      throw new HttpError(409, '狼人杀进行中，请等这局结束再来闲聊');
    }
    ctx.checkChatRate(chatter.id);
    await ctx.divination.say(chatter.name, (await readJson(req)).text);
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && (path === 'draw' || path === 'seen')) {
    if (!account) throw new HttpError(401, '请先用家长身份进入茶馆');
    const body = await readJson(req);
    if (path === 'seen') {
      await ctx.divination.seen(account.id, body.id);
      json(res, 200, { ok: true });
      return;
    }
    const { draw, letter, day } = await ctx.divination.draw(account, body.requestId, ctx.hallId, async () => {
      const existing = await ctx.coo.playerCooOf(account.id);
      const name = account.displayName || '家长';
      if (existing) return { id: existing, name: await ctx.coo.cooDisplayName(existing) || name };
      const player = await ctx.ensurePlayerCoo(account, name);
      return { id: player.cooId, name: player.name };
    });
    if (letter) {
      try {
        const target = await activeSeatForCoo(ctx.db, account.cooId);
        if (target) {
          await (await ctx.host(target.roomId)).whisperNotice('system-owner', DIVINATION_NAME, target,
            letter.text, { seq: letter.seq, ts: letter.ts, room: DIVINATION_ROOM, action: letter.action });
        }
      } catch { /* 在线提醒失败时，签和信已在同一事务提交。 */ }
    }
    json(res, 200, { draw, day });
    return;
  }
  throw new HttpError(404, '没有这个问卦阁接口');
}
