/**
 * 牌桌增量（M2 第二段）：
 * - `GET /v1/table` 只给桌列表、我的桌、我的私视图，不给席位/事件/账本/信箱；
 * - 动作回执直接带桌与私视图，客户端拿回执就能重画；
 * - 两条都复用 public()/private() 的公开/私有投影：旁人看不到我的暗牌。
 *
 * 权限断言是这一层的重点：增量接口如果绕开投影，泄露的就是暗牌本身。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { pgServerStorage } from './helpers/pg.ts';
import { WorldServer } from '../src/room/world-server.ts';

const A = 'coo-aaaaaaaa';
const B = 'coo-bbbbbbbb';
const C = 'coo-cccccccc';

let server: WorldServer | undefined;

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
});

const start = async (): Promise<WorldServer> => {
  server = await WorldServer.create({ allowGuestJoin: true, ...(await pgServerStorage(':memory:')), port: 0, inviteCode: 'inv' });
  await server.listen();
  return server;
};

const secretFor = (cooId: string): string => `secret-${cooId}-0123456789`;

const cooHeaders = (cooId: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-parlor-coo': cooId,
  'x-parlor-coo-secret': secretFor(cooId),
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

const roomTable = async (app: WorldServer, token: string) => get(app.url, '/v1/rooms/lobby/table', token);

type Private = { hand?: string[]; handCards?: unknown[]; seat?: string; tableId?: string; revision?: number };
type Public = { id?: string; tableId?: string; revision?: number; status?: string; seats?: unknown[] };

describe('牌桌增量：GET /v1/table', () => {
  it('只给桌列表、我的桌与我的私视图；席位、事件、账本、信箱都不在里面', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const b = await enter(app, B, '小满');
    await act(app, a, { type: 'table_open', requestId: 'open-1', game: 'ddz' });
    await act(app, b, { type: 'table_join', requestId: 'join-2' });

    const slice = await roomTable(app, a);
    expect(slice.status).toBe(200);
    expect(Array.isArray(slice.body.tables)).toBe(true);
    expect((slice.body.tables as Public[]).length).toBe(1);
    expect((slice.body.table as Public).status).toBe('open');
    // 没开局也有私视图（「等待」那段话），但它只属于我自己这个座位。
    const priv = slice.body.tablePrivate as Private;
    expect(priv.tableId).toBe((slice.body.table as Public).id);

    for (const key of ['seats', 'events', 'ledger', 'ledgerRoom', 'mailUnread', 'online']) {
      expect(key in slice.body, `增量接口不该带 ${key}`).toBe(false);
    }
  });

  it('开局后：本人拿得到自己的手牌，旁人的私视图是 null', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const b = await enter(app, B, '小满');
    const c = await enter(app, C, '小柚');
    await act(app, a, { type: 'table_open', requestId: 'open-3', game: 'ddz' });
    await act(app, b, { type: 'table_join', requestId: 'join-4' });
    await act(app, a, { type: 'table_start', requestId: 'start-5' });

    const mine = await roomTable(app, a);
    const priv = mine.body.tablePrivate as Private;
    expect(priv).not.toBeNull();
    expect(priv.tableId).toBe((mine.body.table as Public).id);
    expect(Array.isArray(priv.hand)).toBe(true);
    expect(priv.hand!.length).toBeGreaterThan(0);
    expect(priv.seat).toBeTruthy();

    // C 在客厅里但不在桌上：看得到桌，看不到任何人的私视图。
    const spectator = await roomTable(app, c);
    expect(spectator.status).toBe(200);
    expect((spectator.body.tables as Public[]).length).toBe(1);
    expect(spectator.body.tablePrivate).toBeNull();
  });

  it('两个玩家各拿各的手牌，互不包含', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const b = await enter(app, B, '小满');
    await act(app, a, { type: 'table_open', requestId: 'open-6', game: 'ddz' });
    await act(app, b, { type: 'table_join', requestId: 'join-7' });
    await act(app, a, { type: 'table_start', requestId: 'start-8' });

    const handA = (await roomTable(app, a)).body.tablePrivate as Private;
    const handB = (await roomTable(app, b)).body.tablePrivate as Private;
    expect(handA.seat).not.toBe(handB.seat);
    expect(handA.hand!.length).toBeGreaterThan(0);
    expect(handB.hand!.length).toBeGreaterThan(0);
    // 洗出来的两副手牌不该一模一样（DDZ 每个座位各发各的）。
    expect(handB.hand!.join(',') === handA.hand!.join(',')).toBe(false);
  });

  it('问别人的桌：桌本身给（公开视图），私视图仍是我自己那张桌的', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const b = await enter(app, B, '小满');
    await act(app, a, { type: 'table_open', requestId: 'open-9', game: 'dice' });
    await act(app, b, { type: 'table_join', requestId: 'join-10' });
    await act(app, a, { type: 'table_start', requestId: 'start-11' });

    const snap = await get(app.url, '/v1/room?limit=1', b);
    const tableId = (snap.body.table as Public).id as string;
    const asked = await get(app.url, `/v1/rooms/lobby/table?table=${encodeURIComponent(tableId)}`, b);
    expect(asked.status).toBe(200);
    expect((asked.body.table as Public).id).toBe(tableId);
    const priv = asked.body.tablePrivate as Private;
    expect(priv.tableId).toBe(tableId);

    // 问一张不存在的桌：table 是 null，私视图照旧给（B 自己的）。
    const missing = await get(app.url, '/v1/rooms/lobby/table?table=t-nope', b);
    expect(missing.status).toBe(200);
    expect(missing.body.table).toBeNull();
    expect((missing.body.tablePrivate as Private).tableId).toBe(tableId);
  });
});

describe('牌桌增量：动作回执直接带桌视图', () => {
  it('开桌/坐下/开局回执带 tables；排牌动作回执带 table 与 tablePrivate', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const b = await enter(app, B, '小满');

    const opened = await act(app, a, { type: 'table_open', requestId: 'open-20', game: 'dice' });
    expect(opened.status).toBe(200);
    expect(Array.isArray(opened.body.tables)).toBe(true);
    expect((opened.body.table as Public).status).toBe('open');
    expect((opened.body.tablePrivate as Private).tableId).toBe((opened.body.table as Public).id);

    const joined = await act(app, b, { type: 'table_join', requestId: 'join-21' });
    expect(joined.status).toBe(200);
    expect((joined.body.table as Public).seats as unknown[]).toHaveLength(2);

    const started = await act(app, a, { type: 'table_start', requestId: 'start-22' });
    expect(started.status).toBe(200);
    expect((started.body.table as Public).status).toBe('playing');
    const priv = started.body.tablePrivate as Private;
    expect(priv).not.toBeNull();
    expect(priv.tableId).toBe((started.body.table as Public).id);
    // 骰子的私视图带自己的暗骰与「轮到你」；公开视图里没有这些。
    expect(Array.isArray((priv as unknown as { dice: number[] }).dice)).toBe(true);

    const revision = priv.revision as number;
    const acted = await act(app, a, {
      type: 'table_action', action: 'stand',
      table: priv.tableId, revision, requestId: 'act-23',
    });
    expect(acted.status).toBe(200);
    // 回执里的 revision 必须真的往前走：客户端拿它做迟到判据。
    expect((acted.body.table as Public).revision as number).toBeGreaterThan(revision);
    expect((acted.body.tablePrivate as Private).revision as number)
      .toBeGreaterThan(revision);
  });

  it('离桌回执把那张桌标成 null，桌列表里也没有它了', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    await act(app, a, { type: 'table_open', requestId: 'open-30', game: 'dice' });
    const left = await act(app, a, { type: 'table_leave', requestId: 'leave-31' });
    expect(left.status).toBe(200);
    expect(left.body.closed).toBe(true);
    expect(left.body.table).toBeNull();
    expect(left.body.tablePrivate).toBeNull();
    expect(left.body.tables).toEqual([]);
  });

  it('不碰桌的动作（说话）回执不带桌视图：老形状不变', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const said = await act(app, a, { type: 'say', text: '有人吗' });
    expect(said.status).toBe(200);
    for (const key of ['table', 'tables', 'tablePrivate']) {
      expect(key in said.body, `说话回执不该带 ${key}`).toBe(false);
    }
  });
});
