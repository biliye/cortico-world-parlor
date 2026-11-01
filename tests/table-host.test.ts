import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Db } from '../src/room/db.ts';
import { RoomHost } from '../src/room/room-host.ts';
import { createRoom, getRoom } from '../src/room/room-seat-db.ts';
import { LedgerDb } from '../src/room/ledger-db.ts';
import { START_CHIPS } from '../src/room/ledger.ts';
import { closeTestDb, openTestDb } from './helpers/test-db.ts';

const A = 'coo-aaaaaaaa';
const B = 'coo-bbbbbbbb';
const C = 'coo-cccccccc';
const OWNER = 'coo-00000000';

interface Fixture {
  db: Db;
  host: RoomHost;
  clock: { now: number };
  close: () => Promise<void>;
}

const setup = async (file?: string): Promise<Fixture> => {
  const clock = { now: 1_760_000_000_000 };
  const db = await openTestDb(file);
  const insert = db.prepare(
    'INSERT INTO coos(id, kind, display_name, secret_hash, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
  );
  for (const [id, kind, name] of [
    [OWNER, 'system', '主人'],
    [A, 'pet', '阿岚'],
    [B, 'pet', '小满'],
    [C, 'pet', '小柚'],
  ] as const) {
    await insert.run(id, kind, name, null, clock.now);
  }
  if (!(await getRoom(db, 'lobby'))) {
    await createRoom(db, {
      id: 'lobby', name: '默认客厅', ownerCooId: OWNER, visibility: 'unlisted', capacity: 8,
    }, clock.now);
  }
  if (!(await getRoom(db, 'other'))) {
    await createRoom(db, {
      id: 'other', name: '隔壁厅', ownerCooId: OWNER, visibility: 'public', capacity: 8,
    }, clock.now);
  }
  const host = await RoomHost.create(db, 'lobby', { now: () => clock.now });
  return { db, host, clock, close: () => closeTestDb(db) };
};

const enter = async (host: RoomHost, cooId: string, name: string) => host.join(cooId, { name });

/** 牌桌动作现在带幂等键与桌面版本；测试里每步现取一次版本。 */
const act = async (host: RoomHost, cooId: string, action: unknown, requestId: string) => {
  const revision = (await host.snapshot(cooId, { limit: 1 })).tablePrivate?.revision;
  expect(typeof revision).toBe('number');
  return host.tableAction(cooId, action, { revision: revision as number, requestId });
};

const texts = (events: { text: string; type: string }[]): string[] => events.map((event) => event.text);

let fixture: Fixture | undefined;
let dir: string | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const fileDb = (): string => {
  dir = mkdtempSync(join(tmpdir(), 'parlor-table-'));
  return join(dir, 'parlor.db');
};

describe('客厅牌桌（骰子）', () => {
  it('开桌/坐下/开始/停牌/结算；暗骰只在本人私视图里', async () => {
    fixture = await setup();
    const { host, clock } = fixture;
    const a = await enter(host, A, '阿岚');
    const b = await enter(host, B, '小满');

    const opened = await host.openTable(A, { game: 'dice' });
    expect(opened.event.text).toContain('开了一张骰子桌');
    await host.joinTable(B);
    const started = await host.startTable(A);
    expect(started.seats).toEqual(['阿岚', '小满']);
    expect(started.turn).toBe('阿岚');

    // 开局与动作事件是公开的，但不带任何人的暗骰。
    const publicEvents = await host.history(B, { since: 0, limit: 200 });
    const start = publicEvents.find((event) => event.type === 'parlor.table.start');
    expect(start?.data).toMatchObject({ game: 'dice' });
    expect(typeof start?.data?.tableId).toBe('string');

    // A 的私视图在 A 的历史里，B 看不到。
    const aView = (await host.history(a.seat.cooId, { since: 0, limit: 200 }))
      .filter((event) => event.type === 'parlor.table.turn');
    expect(aView.length).toBeGreaterThan(0);
    expect(aView[0].text).toContain('你的点数');
    expect(aView[0].scope).toEqual({ kind: 'seat', seatId: a.seat.id });
    const bView = (await host.history(b.seat.cooId, { since: 0, limit: 200 }))
      .filter((event) => event.type === 'parlor.table.turn');
    expect(bView.length).toBe(0);

    // 两人依次停牌，骰子桌结束并写一条公开战绩。
    clock.now += 100;
    await act(host, A, { type: 'stand' }, 'stand-a');
    clock.now += 100;
    await act(host, B, { type: 'stand' }, 'stand-b');
    const all = await host.history(B, { since: 0, limit: 200 });
    expect(all.some((event) => event.type === 'parlor.table.end')).toBe(true);
    expect((await host.tablePublic())?.status).toBe('ended');
    // 结束就是下桌：不再有私视图；结果仍留在公开摘要与事件里。
    expect(host.tablePrivate(a.seat.id)).toBeNull();
    expect((await host.tablePublic())?.text).toContain('结束');
  });

  it('押注：开局各扣一份，赢家拿走底池', async () => {
    fixture = await setup();
    const { host, clock } = fixture;
    await enter(host, A, '阿岚');
    await enter(host, B, '小满');
    await host.openTable(A, { game: 'dice', stake: 5 });
    await host.joinTable(B);
    await host.startTable(A);

    const ledger = new LedgerDb(fixture.db);
    expect(await ledger.balanceOf(A)).toBe(START_CHIPS - 5);
    expect(await ledger.balanceOf(B)).toBe(START_CHIPS - 5);

    clock.now += 100;
    await act(host, A, { type: 'stand' }, 'stand-a');
    clock.now += 100;
    await act(host, B, { type: 'stand' }, 'stand-b');

    const summary = await ledger.summaryFor(A);
    expect(summary.games).toBe(1);
    expect(summary.byGame[0]).toMatchObject({ game: 'dice', label: '骰子', games: 1 });
    // 两人一人赢：赢家 = START_CHIPS + 5，输家 = START_CHIPS - 5。
    const balances = [await ledger.balanceOf(A), await ledger.balanceOf(B)].sort((x, y) => x - y);
    expect(balances).toEqual([START_CHIPS - 5, START_CHIPS + 5]);
    expect(summary.chips === START_CHIPS + 5 || summary.chips === START_CHIPS - 5).toBe(true);
  });

  it('游戏锁：未开局也锁，退桌/收桌后才放行', async () => {
    fixture = await setup();
    const { host } = fixture;
    await enter(host, A, '阿岚');
    await enter(host, B, '小满');
    await host.openTable(A, { game: 'dice' });
    await host.joinTable(B);

    await expect(host.leave(A)).rejects.toThrow(/先退桌|收起来/);
    await expect(host.leave(B)).rejects.toThrow(/先退桌/);
    await expect(host.switchTo(B, 'other', {})).rejects.toThrow(/先退桌/);

    // 非开桌的人退桌，自己解锁；开桌的人还在锁里。
    await host.leaveTable(B);
    await expect(host.leave(B)).resolves.not.toThrow();
    await expect(host.leave(A)).rejects.toThrow(/收起来/);

    // 开桌的人离桌 = 收桌，整张桌子结束。
    const closed = await host.leaveTable(A);
    expect(closed.closed).toBe(true);
    expect(await host.tablePublic()).toBeUndefined();
    await expect(host.leave(A)).resolves.not.toThrow();
  });

  it('开局后谁都不能退桌或换房', async () => {
    fixture = await setup();
    const { host } = fixture;
    await enter(host, A, '阿岚');
    await enter(host, B, '小满');
    await host.openTable(A, { game: 'dice' });
    await host.joinTable(B);
    await host.startTable(A);

    await expect(host.leaveTable(A)).rejects.toThrow(/已经开始/);
    await expect(host.leave(A)).rejects.toThrow(/牌局还没结束/);
    await expect(host.switchTo(B, 'other', {})).rejects.toThrow(/牌局还没结束/);
  });

  it('开桌 10 分钟没开局自动收起，锁跟着解除', async () => {
    fixture = await setup();
    const { host, clock } = fixture;
    await enter(host, A, '阿岚');
    await host.openTable(A, { game: 'dice' });
    await host.tickClock();
    expect((await host.tablePublic())?.status).toBe('open');

    clock.now += 10 * 60_000 + 1;
    await host.tickClock();
    expect(await host.tablePublic()).toBeUndefined();
    expect(await host.tableLock(A)).toBeNull();
    expect((await host.history(A, { since: 0, limit: 100 })).some((event) => event.type === 'parlor.table.cancel')).toBe(true);
  });
});

describe('客厅牌桌（斗地主）与桌聊', () => {
  it('开桌补脚本陪练；桌内说话只有同桌看得到', async () => {
    fixture = await setup();
    const { host, clock } = fixture;
    const a = await enter(host, A, '阿岚');
    const b = await enter(host, B, '小满');
    await enter(host, C, '小柚');

    await host.openTable(A, { game: 'ddz' });
    await host.joinTable(B);
    const started = await host.startTable(A);
    expect(started.seats).toEqual(['阿岚', '小满', '陪练甲（脚本）']);

    clock.now += 100;
    const said = await host.tableSay(A, '这把我要地主');
    expect(said.scope).toMatchObject({ kind: 'table' });

    const bEvents = texts(await host.history(b.seat.cooId, { since: 0, limit: 200 }));
    expect(bEvents).toContain('这把我要地主');
    // 不在桌上的第三人看不到桌内话。
    const cEvents = texts(await host.history(C, { since: 0, limit: 200 }));
    expect(cEvents).not.toContain('这把我要地主');
    await expect(host.tableSay(C, '我也想插一句')).rejects.toThrow(/不在任何牌桌上/);

    // 脚本轮到时会自动叫地主（1.5 秒后由时钟代打）。
    clock.now += 100;
    await act(host, A, { move: 'bid', call: false }, 'bid-a');
    clock.now += 100;
    await act(host, B, { move: 'bid', call: false }, 'bid-b');
    clock.now += 2_000;
    await host.tickClock();
    const events = await host.history(a.seat.cooId, { since: 0, limit: 200 });
    expect(events.some((event) => event.data?.seat === 'bot1')).toBe(true);
  });

  it('牌局结束后桌内说话被拒，公开结果留在快照里', async () => {
    fixture = await setup();
    const { host, clock } = fixture;
    await enter(host, A, '阿岚');
    await enter(host, B, '小满');
    await host.openTable(A, { game: 'dice' });
    await host.joinTable(B);
    await host.startTable(A);
    clock.now += 100;
    await act(host, A, { type: 'stand' }, 'stand-a');
    clock.now += 100;
    await act(host, B, { type: 'stand' }, 'stand-b');

    // 打完就下桌：桌聊也按「不在桌上」拒绝（不是「这桌结束了」）。
    await expect(host.tableSay(A, '结束了还说')).rejects.toThrow(/不在任何牌桌上/);
    const snapshot = await host.snapshot(A, {});
    expect(snapshot.table?.status).toBe('ended');
    expect(snapshot.tablePrivate).toBeNull();
    expect(snapshot.ledger?.games).toBe(1);
  });
});

describe('重启与持久化', () => {
  it('短停机续局：牌、轮次和扣款都不变，还能接着打', async () => {
    const file = fileDb();
    fixture = await setup(file);
    const { host } = fixture;
    await enter(host, A, '阿岚');
    await enter(host, B, '小满');
    await host.openTable(A, { game: 'dice', stake: 5 });
    await host.joinTable(B);
    await host.startTable(A);
    expect(await new LedgerDb(fixture.db).balanceOf(A)).toBe(START_CHIPS - 5);

    // 模拟进程重启：关库、重开、新的 RoomHost（引擎已不在内存里）。
    await fixture.close();
    const db = await openTestDb(file);
    const restarted = await RoomHost.create(db, 'lobby', { now: () => 1_760_000_100_000 });
    fixture = { db, host: restarted, clock: { now: 1_760_000_100_000 }, close: () => closeTestDb(db) };

    const ledger = new LedgerDb(db);
    expect(await ledger.balanceOf(A)).toBe(START_CHIPS - 5);
    expect((await restarted.tablePublic())?.status).toBe('playing');
    expect((await restarted.snapshot(A, { limit: 1 })).tablePrivate?.text).toContain('你的点数');
    const events = await restarted.history(A, { since: 0, limit: 200 });
    expect(events.some((event) => event.type === 'parlor.table.resume')).toBe(true);

    // 恢复之后还能接着打，并正常结算。
    await act(restarted, A, { type: 'stand' }, 'resume-a');
    await act(restarted, B, { type: 'stand' }, 'resume-b');
    expect((await restarted.tablePublic())?.status).toBe('ended');
  });

  it('停机超过 30 分钟：这局作废，按开局明细退回', async () => {
    const file = fileDb();
    fixture = await setup(file);
    const { host } = fixture;
    await enter(host, A, '阿岚');
    await enter(host, B, '小满');
    await host.openTable(A, { game: 'dice', stake: 5 });
    await host.joinTable(B);
    await host.startTable(A);

    await fixture.close();
    const db = await openTestDb(file);
    const later = 1_760_000_000_000 + 31 * 60_000;
    const restarted = await RoomHost.create(db, 'lobby', { now: () => later });
    fixture = { db, host: restarted, clock: { now: later }, close: () => closeTestDb(db) };

    const ledger = new LedgerDb(db);
    expect(await ledger.balanceOf(A)).toBe(START_CHIPS);
    expect(await ledger.balanceOf(B)).toBe(START_CHIPS);
    expect(await restarted.tablePublic()).toBeUndefined();
    const events = await restarted.history(A, { since: 0, limit: 200 });
    expect(events.some((event) => event.text.includes('停机超过'))).toBe(true);
    expect((await restarted.readMail(A, 10, false)).items.some((item) => item.text.includes('退回'))).toBe(true);
  });

  it('快照带着牌桌、私视图与账本摘要', async () => {
    fixture = await setup();
    const { host } = fixture;
    await enter(host, A, '阿岚');
    await enter(host, B, '小满');
    await host.openTable(A, { game: 'dice' });
    await host.joinTable(B);
    await host.startTable(A);

    const snapshot = await host.snapshot(A, {});
    expect(snapshot.table).toMatchObject({ game: 'dice', status: 'playing', host: expect.any(String) });
    expect(snapshot.tablePrivate?.text).toContain('你的点数');
    expect(snapshot.ledger?.chips).toBe(START_CHIPS);
    expect(Array.isArray(snapshot.ledgerRoom)).toBe(true);
  });
});
