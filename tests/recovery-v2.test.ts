/**
 * 恢复与故障：长停机只退一次、坏快照只隔离那一桌、移除正在打牌的人由脚本托管到结算，
 * 被移出的人还能用自己的身份读账本。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldServer } from '../src/room/world-server.ts';
import { LedgerDb } from '../src/room/ledger-db.ts';
import { START_CHIPS } from '../src/room/ledger.ts';

const O = 'coo-rc000001';
const U = 'coo-rc000002';
const V = 'coo-rc000003';

let dir: string | undefined;
let server: WorldServer | undefined;

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const fileDb = (): string => {
  dir = mkdtempSync(join(tmpdir(), 'parlor-recover-'));
  return join(dir, 'parlor.db');
};

const start = async (file: string, now: () => number): Promise<WorldServer> => {
  server = new WorldServer({
    allowGuestJoin: false, dbFile: file, port: 0, inviteCode: 'inv', now,
  });
  await server.listen();
  return server;
};

const cooHeaders = (cooId: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-parlor-coo': cooId,
  'x-parlor-coo-secret': `secret-${cooId}-0123456789`,
});

const post = async (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

const get = async (base: string, path: string, headers: Record<string, string>) => {
  const response = await fetch(`${base}${path}`, { headers });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

const enter = async (app: WorldServer, cooId: string, name: string): Promise<string> => {
  const joined = await post(app.url, '/v1/join', { name }, { ...cooHeaders(cooId), 'x-parlor-invite': 'inv' });
  expect(joined.status).toBe(200);
  return joined.body.token as string;
};

const until = async (check: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('等待超时');
};

const myTable = async (app: WorldServer, token: string) => {
  const snap = await get(app.url, '/v1/room?limit=1', bearer(token));
  const priv = snap.body.tablePrivate as { tableId?: string; revision?: number } | null;
  if (!priv?.tableId) return null;
  return { id: priv.tableId, revision: priv.revision as number };
};

const roomAction = async (app: WorldServer, room: string, token: string, body: unknown) => (
  post(app.url, `/v1/rooms/${room}/action`, body, bearer(token))
);

const myTableIn = async (app: WorldServer, room: string, token: string) => {
  const snap = await get(app.url, `/v1/rooms/${room}/room?limit=1`, bearer(token));
  const priv = snap.body.tablePrivate as { tableId?: string; revision?: number } | null;
  if (!priv?.tableId) return null;
  return { id: priv.tableId, revision: priv.revision as number };
};

const invitationTo = async (app: WorldServer, room: string, cooId: string, token: string): Promise<void> => {
  const invite = await post(app.url, '/v1/invite', { to: cooId, room }, cooHeaders(O));
  expect(invite.status).toBe(200);
  expect((await post(app.url, `/v1/invitations/${invite.body.invitationId as string}/accept`, {}, bearer(token))).status)
    .toBe(200);
};

describe('恢复与故障', () => {
  it('长停机只退一次；重复重启不会重复补偿', async () => {
    const file = fileDb();
    const t0 = 1_770_000_000_000;
    const app = await start(file, () => t0);
    const u = await enter(app, U, '小U');
    const v = await enter(app, V, '小V');
    const opened = await post(app.url, '/v1/action', { type: 'table_open', game: 'dice', stake: 5, requestId: 'open' }, bearer(u));
    const id = opened.body.tableId as string;
    await post(app.url, '/v1/action', { type: 'table_join', table: id, requestId: 'join' }, bearer(v));
    await post(app.url, '/v1/action', { type: 'table_start', table: id, requestId: 'start' }, bearer(u));
    expect(new LedgerDb(app.dbHandle).balanceOf(U)).toBe(START_CHIPS - 5);

    await app.close();
    server = undefined;

    // 停机 31 分钟：作废退款一次。
    const later = t0 + 31 * 60_000;
    const restarted = await start(file, () => later);
    expect(new LedgerDb(restarted.dbHandle).balanceOf(U)).toBe(START_CHIPS);
    expect(new LedgerDb(restarted.dbHandle).balanceOf(V)).toBe(START_CHIPS);
    await restarted.close();
    server = undefined;

    // 再停再起：旧桌已经 abandoned，不会再退第二次。
    const again = await start(file, () => later + 31 * 60_000);
    expect(new LedgerDb(again.dbHandle).balanceOf(U)).toBe(START_CHIPS);
    expect(new LedgerDb(again.dbHandle).balanceOf(V)).toBe(START_CHIPS);
  });

  it('坏快照只隔离那一桌，不猜、不重发牌', async () => {
    const file = fileDb();
    const t0 = 1_770_000_000_000;
    const app = await start(file, () => t0);
    const u = await enter(app, U, '小U');
    const v = await enter(app, V, '小V');
    const opened = await post(app.url, '/v1/action', { type: 'table_open', game: 'ddz', requestId: 'open' }, bearer(u));
    const id = opened.body.tableId as string;
    await post(app.url, '/v1/action', { type: 'table_join', table: id, requestId: 'join' }, bearer(v));
    await post(app.url, '/v1/action', { type: 'table_start', table: id, requestId: 'start' }, bearer(u));
    app.dbHandle.prepare('UPDATE tables SET state_json = ? WHERE id = ?').run('{"broken":true}', id);
    await app.close();
    server = undefined;

    const restarted = await start(file, () => t0 + 60_000);
    // 席位令牌落库：重启后原令牌仍然有效（不该为了看快照重新加入）。
    const token = u;
    const snap = await get(restarted.url, '/v1/room?limit=1', bearer(token));
    const table = (snap.body.tables as { id: string; frozen?: boolean }[]).find((entry) => entry.id === id);
    expect(table?.frozen).toBe(true);
    expect((await post(restarted.url, '/v1/action', {
      type: 'ddz_action', move: 'bid', call: false, table: id, revision: 1, requestId: 'frozen-act',
    }, bearer(token))).status).toBe(409);
  });

  it('移除正在打牌的人：脚本托管到结算，筹码照算，身份级账本还看得到', async () => {
    const file = fileDb();
    const t0 = 1_770_000_000_000;
    const clock = { now: t0 };
    const app = await start(file, () => clock.now);
    await enter(app, O, '房主');
    const lobbyU = await enter(app, U, '小U');
    const lobbyV = await enter(app, V, '小V');

    // 房主建私密厅，把 U、V 拉进来（接受邀请后换厅，换厅会给新令牌）。
    const created = await post(app.url, '/v1/rooms', { name: '牌厅', visibility: 'private' }, cooHeaders(O));
    const room = (created.body.room as { id: string }).id;
    await invitationTo(app, room, U, lobbyU);
    await invitationTo(app, room, V, lobbyV);
    const movedU = await post(app.url, '/v1/rooms/lobby/switch', { to: room }, bearer(lobbyU));
    const movedV = await post(app.url, '/v1/rooms/lobby/switch', { to: room }, bearer(lobbyV));
    expect(movedU.status).toBe(200);
    expect(movedV.status).toBe(200);
    const u = movedU.body.token as string;
    const v = movedV.body.token as string;

    // U 开桌、V 坐下、U 开局：U 是自己回合，房主现在把 U 移出。
    const opened = await roomAction(app, room, u, { type: 'table_open', game: 'dice', stake: 5, requestId: 'open' });
    expect(opened.status).toBe(200);
    const tableId = opened.body.tableId as string;
    expect((await roomAction(app, room, v, { type: 'table_join', table: tableId, requestId: 'join' })).status).toBe(200);
    expect((await roomAction(app, room, u, { type: 'table_start', table: tableId, requestId: 'start' })).status).toBe(200);

    const removed = await post(app.url, `/v1/rooms/${room}/access`, { action: 'revoke', cooId: U }, cooHeaders(O));
    expect(removed.status).toBe(200);
    expect(removed.body.removedSeat).toBe(true);
    expect(removed.body.tables).toContain(tableId);

    // 轮到 U 时由脚本托管（1 秒一次的时钟直接代打），随后轮到 V。
    await until(async () => {
      const snap = await get(app.url, `/v1/rooms/${room}/room?limit=1`, bearer(v));
      const priv = snap.body.tablePrivate as { yourTurn?: boolean; revision?: number } | null;
      return priv?.yourTurn === true;
    });
    const vRef = await myTableIn(app, room, v);
    expect(vRef).not.toBeNull();
    expect((await roomAction(app, room, v, {
      type: 'table_action', action: 'stand', table: tableId, revision: vRef!.revision, requestId: 'v-stand',
    })).status).toBe(200);

    await until(async () => {
      const snap = await get(app.url, `/v1/rooms/${room}/room?limit=1`, bearer(v));
      const table = (snap.body.tables as { id: string; status: string }[]).find((entry) => entry.id === tableId);
      return table?.status === 'ended';
    });

    // 结算仍算 U 一份：账本参与人里有他，身份级账本能读到这一局。
    const ledger = new LedgerDb(app.dbHandle);
    const gameEntry = ledger.byEffectId(`${tableId}/result`);
    expect(gameEntry?.participants).toContain(U);
    expect(gameEntry?.participants).toContain(V);
    const meLedger = await get(app.url, '/v1/me/ledger', cooHeaders(U));
    expect(meLedger.status).toBe(200);
    expect((meLedger.body.ledger as { games: number }).games).toBe(1);

    // 席位没了也能看信箱（身份级），且一人一桌的锁已经释放：回到大厅还能开新桌。
    const inbox = await get(app.url, '/v1/me/mail?limit=5&peek=1', cooHeaders(U));
    expect(inbox.status).toBe(200);
    const lobbyAgain = await post(app.url, '/v1/rooms/lobby/join', { name: '小U' }, {
      ...cooHeaders(U), 'x-parlor-invite': 'inv',
    });
    expect(lobbyAgain.status).toBe(200);
    const newTable = await post(app.url, '/v1/action', {
      type: 'table_open', game: 'dice', requestId: 'open-after-removal',
    }, bearer(lobbyAgain.body.token as string));
    expect(newTable.status).toBe(200);
  });
});
