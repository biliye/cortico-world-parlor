/**
 * 家长下场：ownerKey 换的会话可以给自己领一个 human 席位。
 * 关键约束：同一个家长链接在任何浏览器都是同一个玩家身份（cooId 不变），
 * 但账本/筹码与孩子那份分开；孩子自己的席位不受影响。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { pgServerStorage } from './helpers/pg.ts';
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
  server = await WorldServer.create({ allowGuestJoin: true,
    ...(await pgServerStorage(join(dir, 'parlor.db'))),
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
  it('家长用只读会话观战孩子当前桌，满厅仍可看且不入座', async () => {
    const app = await start();
    const headers = { ...cooHeaders(COO), 'x-parlor-invite': 'inv' };
    const room = 'lobby';
    const child = await post(app.url, `/v1/rooms/${room}/join`, { name: '小满' }, headers);
    expect(child.status).toBe(200);
    const second = await post(app.url, `/v1/rooms/${room}/join`, { name: '对手' }, {
      ...cooHeaders('coo-parenttest2'), 'x-parlor-invite': 'inv',
    });
    expect(second.status).toBe(200);
    const childSeat = { authorization: `Bearer ${child.body.token as string}` };
    const secondSeat = { authorization: `Bearer ${second.body.token as string}` };
    const act = (body: Json, seat = childSeat) => post(app.url, `/v1/rooms/${room}/action`, body, seat);
    const opened = await act({ type: 'table_open', game: 'gomoku', requestId: 'open-watch' });
    expect(opened.status).toBe(200);
    const table = opened.body.tableId as string;
    expect((await act({ type: 'table_join', table, requestId: 'join-watch' }, secondSeat)).status).toBe(200);
    expect((await act({ type: 'table_start', table, requestId: 'start-watch' })).status).toBe(200);
    const capacity = child.body.maxSeats as number;
    for (let i = 2; i < capacity; i++) {
      const filler = await post(app.url, `/v1/rooms/${room}/join`, { name: `茶客 ${i}` }, {
        ...cooHeaders(`coo-watchfiller${i}`), 'x-parlor-invite': 'inv',
      });
      expect(filler.status).toBe(200);
    }
    const session = await post(app.url, '/v1/parent/session', { key: child.body.ownerKey });
    expect(session.status).toBe(200);
    const auth = { cookie: (session.headers.get('set-cookie') ?? '').split(';')[0] };
    expect((await getWith(app.url, '/v1/parent/view', auth)).body.watchTableId).toBe(table);
    const endpoint = '/v1/parent/table?table=' + encodeURIComponent(table);
    expect((await getWith(app.url, endpoint, {})).status).toBe(401);
    expect((await getWith(app.url, '/v1/parent/table?table=other', auth)).status).toBe(404);
    const watched = await getWith(app.url, endpoint, auth);
    expect(watched.status).toBe(200);
    expect(watched.body).toMatchObject({ table: { tableId: table, status: 'playing', board: expect.any(Array) } });
    expect(Object.keys(watched.body).sort()).toEqual(['now', 'table']);
    const roomView = await getWith(app.url, `/v1/rooms/${room}/room`, childSeat);
    expect((roomView.body.seats as unknown[]).length).toBe(capacity);
    const resigning = (watched.body.table as { turn: string }).turn === (child.body.seat as { id: string }).id
      ? childSeat : secondSeat;
    const revision = (watched.body.table as { revision: number }).revision;
    expect((await act({ type: 'game_action', table, revision, action: 'resign', params: {}, requestId: 'end-watch' }, resigning)).status).toBe(200);
    expect((await getWith(app.url, endpoint, auth)).status).toBe(404);
  });

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

    // 账户的默认显示名跟着孩子走：「<孩子名>的家长」。
    const me = await getWith(app.url, '/v1/parent/me', { cookie });
    expect(me.status).toBe(200);
    expect((me.body.account as { displayName: string }).displayName).toBe('小满的家长');

    // 没有会话不能下场。
    const denied = await post(app.url, '/v1/parent/play', {});
    expect(denied.status).toBe(401);

    // 带钥匙一次做完换会话 + 下场（网页「我下场玩」走这条，少一个来回）。
    const direct = await fetch(`${app.url}/v1/parent/play`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ownerKey }),
    });
    expect(direct.status).toBe(200);
    expect(cookieOf(direct)).toContain('parlor_parent=');
    const directBody = await direct.json() as Json;
    expect((directBody.seat as { kind: string }).kind).toBe('human');
    const badKey = await post(app.url, '/v1/parent/play', { key: 'not-a-key' });
    expect(badKey.status).toBe(401);

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
    // 0.38.0 起没有筹码：快照里只剩战绩，不再有余额字段。
    expect('chips' in (snap.body.ledger as Record<string, unknown>)).toBe(false);

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

  it('家长改名字：账户、玩家身份、当前席位一起改；同厅重名 409', async () => {
    const app = await start();
    const joined = await post(app.url, '/v1/rooms/lobby/join', { name: '小满' }, { ...cooHeaders(COO), 'x-parlor-invite': 'inv' });
    const ownerKey = joined.body.ownerKey as string;
    const session = await fetch(`${app.url}/v1/parent/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ownerKey }),
    });
    const cookie = cookieOf(session);

    // 还没下场：改名只动账户，但会把玩家身份按这个名字建出来。
    const early = await post(app.url, '/v1/parent/rename', { name: '小满的妈妈' }, { cookie });
    expect(early.status).toBe(200);
    expect((early.body.account as { displayName: string }).displayName).toBe('小满的妈妈');
    expect(early.body.seat).toBeNull();
    const played = await post(app.url, '/v1/parent/play', {}, { cookie });
    expect((played.body.seat as { name: string }).name).toBe('小满的妈妈');

    // 下场后改名：当前席位跟着变，席位令牌不动。
    const renamed = await post(app.url, '/v1/parent/rename', { name: '小满的爸爸' }, { cookie });
    expect(renamed.status).toBe(200);
    expect((renamed.body.seat as { name: string }).name).toBe('小满的爸爸');
    const snap = await getWith(app.url, '/v1/room', { authorization: `Bearer ${played.body.token as string}` });
    expect((snap.body.seat as { name: string }).name).toBe('小满的爸爸');

    // 同厅已经有「小满」（孩子），不能改成同名。
    const clash = await post(app.url, '/v1/parent/rename', { name: '小满' }, { cookie });
    expect(clash.status).toBe(409);
    // 空名字与超长名字都拒绝。
    expect((await post(app.url, '/v1/parent/rename', { name: '   ' }, { cookie })).status).toBe(400);
    expect((await post(app.url, '/v1/parent/rename', { name: '一'.repeat(25) }, { cookie })).status).toBe(400);
    // 没有会话不行。
    expect((await post(app.url, '/v1/parent/rename', { name: '谁' })).status).toBe(401);
  });

  it('房间 join 不再能绕过邀请码：新身份要码，已有身份不用', async () => {
    const app = await start();
    const stranger = cooHeaders('coo-newguest001');
    const denied = await post(app.url, '/v1/rooms/lobby/join', { name: '路人' }, stranger);
    expect(denied.status).toBe(403);
    const allowed = await post(app.url, '/v1/rooms/lobby/join', { name: '路人' }, { ...stranger, 'x-parlor-invite': 'inv' });
    expect(allowed.status).toBe(200);
    // 已认证身份再次加入续用同一个席位，换令牌而不重建席位。
    const again = await post(app.url, '/v1/rooms/lobby/join', { name: '路人' }, stranger);
    expect(again.status).toBe(200);
    expect((again.body.seat as { id: string }).id).toBe((allowed.body.seat as { id: string }).id);
    expect(again.body.token).not.toBe(allowed.body.token);
    expect((await getWith(app.url, '/v1/rooms/lobby/room', { authorization: `Bearer ${allowed.body.token}` })).status).toBe(401);
  });
});
