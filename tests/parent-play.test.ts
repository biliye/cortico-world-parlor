/**
 * 家长下场：ownerKey 换的会话可以给自己领一个 human 席位。
 * 关键约束：同一个家长链接在任何浏览器都是同一个玩家身份（cooId 不变），
 * 但账本/筹码与孩子那份分开；孩子自己的席位不受影响。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldServer } from '../src/room/world-server.ts';

const COO = 'coo-parenttest1';

let dir: string | undefined;
let server: WorldServer | undefined;

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const start = async (): Promise<WorldServer> => {
  dir = mkdtempSync(join(tmpdir(), 'parlor-parent-'));
  server = new WorldServer({
    dbFile: join(dir, 'parlor.db'),
    port: 0,
    inviteCode: 'inv',
    defaultRoomId: 'lobby',
  });
  await server.listen();
  return server;
};

const cooHeaders = (cooId: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-parlor-coo': cooId,
  'x-parlor-coo-secret': `secret-${cooId}-0123456789`,
});

type Json = Record<string, unknown>;

const post = async (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Json, headers: response.headers };
};

const getWith = async (base: string, path: string, headers: Record<string, string>) => {
  const response = await fetch(`${base}${path}`, { headers });
  return { status: response.status, body: await response.json() as Json };
};

const cookieOf = (response: Response): string => (response.headers.get('set-cookie') || '').split(';')[0];

describe('家长下场', () => {
  it('同一链接固定一个玩家身份；孩子席位与账本不受影响', async () => {
    const app = await start();
    // 孩子：一个 Coo 进默认客厅，第一次进会拿到 ownerKey。
    const joined = await post(app.url, '/v1/rooms/lobby/join', { name: '小满' }, { ...cooHeaders(COO), 'x-parlor-invite': 'inv' });
    expect(joined.status).toBe(200);
    const ownerKey = joined.body.ownerKey as string;
    expect(ownerKey).toBeTruthy();
    const childToken = joined.body.token as string;
    const childSeatId = (joined.body.seat as { id: string }).id;

    // 家长：用 key 换会话。
    const session = await fetch(`${app.url}/v1/parent/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ownerKey }),
    });
    expect(session.status).toBe(200);
    const cookie = cookieOf(session);
    expect(cookie).toContain('parlor_parent=');

    // 没有会话不能下场。
    const denied = await post(app.url, '/v1/parent/play', {});
    expect(denied.status).toBe(401);

    // 第一次下场：新 human 席位，能读快照。
    const first = await post(app.url, '/v1/parent/play', {}, { cookie });
    expect(first.status).toBe(200);
    const playerCooId = (first.body.identity as { cooId: string }).cooId;
    const playerSeat = first.body.seat as { id: string; kind: string; name: string };
    expect(playerSeat.kind).toBe('human');
    // 默认名跟着孩子走：「<孩子名>家的家长」。
    expect(playerSeat.name).toBe('小满家的家长');
    expect(first.body.player).toBe(true);
    const firstToken = first.body.token as string;
    const snap = await getWith(app.url, '/v1/room', { authorization: `Bearer ${firstToken}` });
    expect(snap.status).toBe(200);
    expect((snap.body.seat as { id: string }).id).toBe(playerSeat.id);
    expect((snap.body.ledger as { chips: number }).chips).toBe(1000);

    // 第二次下场：同一个玩家身份，换一张新令牌；旧令牌作废。
    const second = await post(app.url, '/v1/parent/play', {}, { cookie });
    expect(second.status).toBe(200);
    expect((second.body.identity as { cooId: string }).cooId).toBe(playerCooId);
    expect((second.body.seat as { id: string }).id).toBe(playerSeat.id);
    expect(second.body.token).not.toBe(firstToken);
    const stale = await getWith(app.url, '/v1/room', { authorization: `Bearer ${firstToken}` });
    expect(stale.status).toBe(401);
    const fresh = await getWith(app.url, '/v1/room', { authorization: `Bearer ${second.body.token as string}` });
    expect(fresh.status).toBe(200);

    // 孩子还在自己的席位上，令牌照常。
    const child = await getWith(app.url, '/v1/room', { authorization: `Bearer ${childToken}` });
    expect(child.status).toBe(200);
    expect((child.body.seat as { id: string }).id).toBe(childSeatId);
    // 家长页仍然看孩子，不看家长的玩家席位。
    const view = await getWith(app.url, '/v1/parent/view', { cookie });
    expect(view.status).toBe(200);
    expect((view.body.seat as { id: string }).id).toBe(childSeatId);
  });

  it('家长换客厅：同一个玩家身份原子切过去', async () => {
    const app = await start();
    const joined = await post(app.url, '/v1/rooms/lobby/join', { name: '小满' }, { ...cooHeaders(COO), 'x-parlor-invite': 'inv' });
    const ownerKey = joined.body.ownerKey as string;
    const session = await fetch(`${app.url}/v1/parent/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ownerKey }),
    });
    const cookie = cookieOf(session);

    const created = await post(app.url, '/v1/rooms', { name: '二厅', visibility: 'public' }, cooHeaders(COO));
    const roomId = (created.body.room as { id: string }).id;

    const first = await post(app.url, '/v1/parent/play', {}, { cookie });
    const playerCooId = (first.body.identity as { cooId: string }).cooId;

    const moved = await post(app.url, '/v1/parent/play', { room: roomId }, { cookie });
    expect(moved.status).toBe(200);
    expect(moved.body.room).toBe(roomId);
    expect((moved.body.identity as { cooId: string }).cooId).toBe(playerCooId);
    const token = moved.body.token as string;
    const snap = await getWith(app.url, `/v1/rooms/${roomId}/room`, { authorization: `Bearer ${token}` });
    expect(snap.status).toBe(200);
    expect((snap.body.seat as { id: string }).id).toBe((moved.body.seat as { id: string }).id);
  });

  it('房间 join 不再能绕过邀请码：新身份要码，已有身份不用', async () => {
    const app = await start();
    const stranger = cooHeaders('coo-newguest001');
    const denied = await post(app.url, '/v1/rooms/lobby/join', { name: '路人' }, stranger);
    expect(denied.status).toBe(403);
    const allowed = await post(app.url, '/v1/rooms/lobby/join', { name: '路人' }, { ...stranger, 'x-parlor-invite': 'inv' });
    expect(allowed.status).toBe(200);
    // 已经有身份的人再进不带码也认（这里撞上「已经在客厅里」，说明邀请码这关过了）。
    const again = await post(app.url, '/v1/rooms/lobby/join', { name: '路人' }, stranger);
    expect(again.status).toBe(409);
  });
});
