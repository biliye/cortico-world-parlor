/**
 * 多桌 + 动作回执 + 桌面版本：一房多张桌、一人只坐一张、动作按 tableId 分流、
 * 重试拿原回执、旧版本打不进新回合。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WorldServer } from '../src/room/world-server.ts';

const A = 'coo-t2aaaaaa';
const B = 'coo-t2bbbbbb';
const C = 'coo-t2cccccc';
const D = 'coo-t2dddddd';
const E = 'coo-t2eeeeee';

let server: WorldServer | undefined;

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
});

const start = async (): Promise<WorldServer> => {
  server = new WorldServer({ allowGuestJoin: false, dbFile: ':memory:', port: 0, inviteCode: 'inv' });
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

const get = async (base: string, path: string, token: string) => {
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

const enter = async (app: WorldServer, cooId: string, name: string): Promise<string> => {
  const joined = await post(app.url, '/v1/join', { name }, { ...cooHeaders(cooId), 'x-parlor-invite': 'inv' });
  expect(joined.status).toBe(200);
  return joined.body.token as string;
};

const act = async (app: WorldServer, token: string, body: unknown) => (
  post(app.url, '/v1/action', body, { authorization: `Bearer ${token}` })
);

interface TableRef { id: string; revision: number; status: string }

const myTable = async (app: WorldServer, token: string): Promise<TableRef | null> => {
  const snap = await get(app.url, '/v1/room?limit=1', token);
  const priv = snap.body.tablePrivate as { tableId?: string; revision?: number } | null;
  if (!priv?.tableId) return null;
  const tables = snap.body.tables as TableRef[];
  const table = tables.find((entry) => entry.id === priv.tableId);
  return { id: priv.tableId, revision: priv.revision ?? table?.revision ?? 0, status: table?.status ?? 'unknown' };
};

describe('多桌', () => {
  it('一房两张桌互不串牌；一人同时只坐一张', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const b = await enter(app, B, '小满');
    const c = await enter(app, C, '小柚');
    const d = await enter(app, D, '柚子');

    const ddz = await act(app, a, { type: 'table_open', game: 'ddz', requestId: 'open-ddz' });
    expect(ddz.status).toBe(200);
    const ddzId = ddz.body.tableId as string;
    expect((await act(app, b, { type: 'table_join', table: ddzId, requestId: 'join-ddz' })).status).toBe(200);
    expect((await act(app, a, { type: 'table_start', table: ddzId, requestId: 'start-ddz' })).status).toBe(200);

    const dice = await act(app, c, { type: 'table_open', game: 'dice', requestId: 'open-dice' });
    expect(dice.status).toBe(200);
    const diceId = dice.body.tableId as string;
    expect((await act(app, d, { type: 'table_join', table: diceId, requestId: 'join-dice' })).status).toBe(200);
    expect((await act(app, c, { type: 'table_start', table: diceId, requestId: 'start-dice' })).status).toBe(200);

    // 两张桌都在快照里；各自只看到自己的私视图。
    const aSnap = await get(app.url, '/v1/room?limit=1', a);
    expect((aSnap.body.tables as TableRef[]).length).toBe(2);
    expect((aSnap.body.tablePrivate as { tableId: string }).tableId).toBe(ddzId);
    const cSnap = await get(app.url, '/v1/room?limit=1', c);
    expect((cSnap.body.tablePrivate as { tableId: string }).tableId).toBe(diceId);

    // 一人一桌：B 已经在斗地主，不能再坐骰子桌。
    expect((await act(app, b, { type: 'table_join', table: diceId, requestId: 'double-join' })).status).toBe(409);

    // 骰子桌结算不影响斗地主：A 的私视图还在、状态没结束。
    const cRef = await myTable(app, c);
    expect((await act(app, c, {
      type: 'table_action', action: 'stand', table: diceId, revision: cRef!.revision, requestId: 'dice-c-stand',
    })).status).toBe(200);
    const dRef = await myTable(app, d);
    expect((await act(app, d, {
      type: 'table_action', action: 'stand', table: diceId, revision: dRef!.revision, requestId: 'dice-d-stand',
    })).status).toBe(200);
    const aAfter = await get(app.url, '/v1/room?limit=1', a);
    expect((aAfter.body.tablePrivate as { tableId: string }).tableId).toBe(ddzId);
    expect((aAfter.body.tables as { id: string; status: string }[])
      .find((table) => table.id === diceId)?.status).toBe('ended');
  });

  it('两张桌都开着时，坐下必须指定桌号', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const c = await enter(app, C, '小柚');
    const e = await enter(app, E, '小叶子');

    const first = await act(app, a, { type: 'table_open', game: 'dice', requestId: 'open-1' });
    const second = await act(app, c, { type: 'table_open', game: 'dice', requestId: 'open-2' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    expect((await act(app, e, { type: 'table_join', requestId: 'join-any' })).status).toBe(400);
    expect((await act(app, e, {
      type: 'table_join', table: first.body.tableId as string, requestId: 'join-first',
    })).status).toBe(200);
  });

  it('事件带 tableId：另一桌的动作不会混进本桌', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const b = await enter(app, B, '小满');
    const opened = await act(app, a, { type: 'table_open', game: 'ddz', requestId: 'open' });
    const id = opened.body.tableId as string;
    await act(app, b, { type: 'table_join', table: id, requestId: 'join' });
    await act(app, a, { type: 'table_start', table: id, requestId: 'start' });

    const history = await get(app.url, '/v1/history?since=0&limit=200', b);
    const starts = (history.body.events as { type: string; data?: { tableId?: string } }[])
      .filter((event) => event.type === 'parlor.table.start');
    expect(starts.length).toBe(1);
    expect(starts[0].data?.tableId).toBe(id);
  });
});

describe('动作回执与桌面版本', () => {
  it('同一个 requestId 重试拿原回执；换参数冲突', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const b = await enter(app, B, '小满');
    const opened = await act(app, a, { type: 'table_open', game: 'ddz', requestId: 'open' });
    const id = opened.body.tableId as string;
    await act(app, b, { type: 'table_join', table: id, requestId: 'join' });
    await act(app, a, { type: 'table_start', table: id, requestId: 'start' });

    const ref = await myTable(app, a);
    const body = {
      type: 'ddz_action', move: 'bid', call: false, table: id, revision: ref!.revision, requestId: 'bid-r1',
    };
    const first = await act(app, a, body);
    expect(first.status).toBe(200);
    const again = await act(app, a, body);
    expect(again.status).toBe(200);
    expect(again.body.seq).toBe(first.body.seq);
    expect(again.body.revision).toBe(first.body.revision);

    const conflict = await act(app, a, { ...body, call: true });
    expect(conflict.status).toBe(409);
  });

  it('退桌重试拿原回执：人已经不在桌上了也不报错', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const opened = await act(app, a, { type: 'table_open', game: 'dice', requestId: 'open' });
    const id = opened.body.tableId as string;
    const first = await act(app, a, { type: 'table_leave', table: id, requestId: 'leave-1' });
    expect(first.status).toBe(200);
    const again = await act(app, a, { type: 'table_leave', table: id, requestId: 'leave-1' });
    expect(again.status).toBe(200);
    expect(again.body.seq).toBe(first.body.seq);
  });

  it('旧桌面版本打不进新回合', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const b = await enter(app, B, '小满');
    const opened = await act(app, a, { type: 'table_open', game: 'ddz', requestId: 'open' });
    const id = opened.body.tableId as string;
    await act(app, b, { type: 'table_join', table: id, requestId: 'join' });
    await act(app, a, { type: 'table_start', table: id, requestId: 'start' });

    const aRef = await myTable(app, a);
    const bRef = await myTable(app, b);
    expect((await act(app, a, {
      type: 'ddz_action', move: 'bid', call: false, table: id, revision: aRef!.revision, requestId: 'a-bid',
    })).status).toBe(200);

    const bCurrent = await myTable(app, b);
    // B 手里还是 A 出牌前的版本：拒绝。
    expect((await act(app, b, {
      type: 'ddz_action', move: 'bid', call: false, table: id, revision: bRef!.revision, requestId: 'b-stale',
    })).status).toBe(409);
    // 用当前版本可以正常叫。
    expect((await act(app, b, {
      type: 'ddz_action', move: 'bid', call: true, table: id, revision: bCurrent!.revision, requestId: 'b-fresh',
    })).status).toBe(200);
  });
});
