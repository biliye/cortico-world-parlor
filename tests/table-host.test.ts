import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDb, type Db } from '../src/room/db.ts';
import { RoomHost } from '../src/room/room-host.ts';
import { createRoom, getRoom } from '../src/room/room-seat-db.ts';
import { LedgerDb } from '../src/room/ledger-db.ts';
import { START_CHIPS } from '../src/room/ledger.ts';

const A = 'coo-aaaaaaaa';
const B = 'coo-bbbbbbbb';
const C = 'coo-cccccccc';
const OWNER = 'coo-00000000';

interface Fixture {
  db: Db;
  host: RoomHost;
  clock: { now: number };
  close: () => void;
}

const setup = (file?: string): Fixture => {
  const clock = { now: 1_760_000_000_000 };
  const db = openDb(file ?? ':memory:');
  migrate(db);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO coos(id, kind, display_name, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const [id, kind, name] of [
    [OWNER, 'system', '主人'],
    [A, 'pet', '阿岚'],
    [B, 'pet', '小满'],
    [C, 'pet', '小柚'],
  ] as const) {
    insert.run(id, kind, name, null, clock.now);
  }
  if (!getRoom(db, 'lobby')) {
    createRoom(db, {
      id: 'lobby', name: '默认客厅', ownerCooId: OWNER, visibility: 'unlisted', capacity: 8,
    }, clock.now);
  }
  if (!getRoom(db, 'other')) {
    createRoom(db, {
      id: 'other', name: '隔壁厅', ownerCooId: OWNER, visibility: 'public', capacity: 8,
    }, clock.now);
  }
  const host = new RoomHost(db, 'lobby', { now: () => clock.now });
  return { db, host, clock, close: () => db.close() };
};

const enter = (host: RoomHost, cooId: string, name: string) => host.join(cooId, { name });

const texts = (events: { text: string; type: string }[]): string[] => events.map((event) => event.text);

let fixture: Fixture | undefined;
let dir: string | undefined;

afterEach(() => {
  fixture?.close();
  fixture = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const fileDb = (): string => {
  dir = mkdtempSync(join(tmpdir(), 'parlor-table-'));
  return join(dir, 'parlor.db');
};

describe('客厅牌桌（骰子）', () => {
  it('开桌/坐下/开始/停牌/结算；暗骰只在本人私视图里', () => {
    fixture = setup();
    const { host, clock } = fixture;
    const a = enter(host, A, '阿岚');
    const b = enter(host, B, '小满');

    const opened = host.openTable(A, { game: 'dice' });
    expect(opened.event.text).toContain('开了一张骰子桌');
    host.joinTable(B);
    const started = host.startTable(A);
    expect(started.seats).toEqual(['阿岚', '小满']);
    expect(started.turn).toBe('阿岚');

    // 开局与动作事件是公开的，但不带任何人的暗骰。
    const publicEvents = host.history(B, { since: 0, limit: 200 });
    const start = publicEvents.find((event) => event.type === 'parlor.table.start');
    expect(start?.data).toEqual({ game: 'dice' });

    // A 的私视图在 A 的历史里，B 看不到。
    const aView = host.history(a.seat.cooId, { since: 0, limit: 200 })
      .filter((event) => event.type === 'parlor.table.turn');
    expect(aView.length).toBeGreaterThan(0);
    expect(aView[0].text).toContain('你的点数');
    expect(aView[0].scope).toEqual({ kind: 'seat', seatId: a.seat.id });
    const bView = host.history(b.seat.cooId, { since: 0, limit: 200 })
      .filter((event) => event.type === 'parlor.table.turn');
    expect(bView.length).toBe(0);

    // 两人依次停牌，骰子桌结束并写一条公开战绩。
    clock.now += 100;
    host.tableAction(A, { type: 'stand' });
    clock.now += 100;
    host.tableAction(B, { type: 'stand' });
    const all = host.history(B, { since: 0, limit: 200 });
    expect(all.some((event) => event.type === 'parlor.table.end')).toBe(true);
    expect(host.tablePublic()?.status).toBe('ended');
    expect(host.tablePrivate(a.seat.id)?.text).toContain('结束了');
  });

  it('押注：开局各扣一份，赢家拿走底池', () => {
    fixture = setup();
    const { host, clock } = fixture;
    enter(host, A, '阿岚');
    enter(host, B, '小满');
    host.openTable(A, { game: 'dice', stake: 5 });
    host.joinTable(B);
    host.startTable(A);

    const ledger = new LedgerDb(fixture.db);
    expect(ledger.balanceOf(A)).toBe(START_CHIPS - 5);
    expect(ledger.balanceOf(B)).toBe(START_CHIPS - 5);

    clock.now += 100;
    host.tableAction(A, { type: 'stand' });
    clock.now += 100;
    host.tableAction(B, { type: 'stand' });

    const summary = ledger.summaryFor(A);
    expect(summary.games).toBe(1);
    expect(summary.byGame[0]).toMatchObject({ game: 'dice', label: '骰子', games: 1 });
    // 两人一人赢：赢家 = START_CHIPS + 5，输家 = START_CHIPS - 5。
    const balances = [ledger.balanceOf(A), ledger.balanceOf(B)].sort((x, y) => x - y);
    expect(balances).toEqual([START_CHIPS - 5, START_CHIPS + 5]);
    expect(summary.chips === START_CHIPS + 5 || summary.chips === START_CHIPS - 5).toBe(true);
  });

  it('游戏锁：未开局也锁，退桌/收桌后才放行', () => {
    fixture = setup();
    const { host } = fixture;
    enter(host, A, '阿岚');
    enter(host, B, '小满');
    host.openTable(A, { game: 'dice' });
    host.joinTable(B);

    expect(() => host.leave(A)).toThrow(/先退桌|收起来/);
    expect(() => host.leave(B)).toThrow(/先退桌/);
    expect(() => host.switchTo(B, 'other', {})).toThrow(/先退桌/);

    // 非开桌的人退桌，自己解锁；开桌的人还在锁里。
    host.leaveTable(B);
    expect(() => host.leave(B)).not.toThrow();
    expect(() => host.leave(A)).toThrow(/收起来/);

    // 开桌的人离桌 = 收桌，整张桌子结束。
    const closed = host.leaveTable(A);
    expect(closed.closed).toBe(true);
    expect(host.tablePublic()).toBeUndefined();
    expect(() => host.leave(A)).not.toThrow();
  });

  it('开局后谁都不能退桌或换房', () => {
    fixture = setup();
    const { host } = fixture;
    enter(host, A, '阿岚');
    enter(host, B, '小满');
    host.openTable(A, { game: 'dice' });
    host.joinTable(B);
    host.startTable(A);

    expect(() => host.leaveTable(A)).toThrow(/已经开始/);
    expect(() => host.leave(A)).toThrow(/牌局还没结束/);
    expect(() => host.switchTo(B, 'other', {})).toThrow(/牌局还没结束/);
  });

  it('开桌 10 分钟没开局自动收起，锁跟着解除', () => {
    fixture = setup();
    const { host, clock } = fixture;
    enter(host, A, '阿岚');
    host.openTable(A, { game: 'dice' });
    host.tickClock();
    expect(host.tablePublic()?.status).toBe('open');

    clock.now += 10 * 60_000 + 1;
    host.tickClock();
    expect(host.tablePublic()).toBeUndefined();
    expect(host.tableLock(A)).toBeNull();
    expect(host.history(A, { since: 0, limit: 100 }).some((event) => event.type === 'parlor.table.cancel')).toBe(true);
  });
});

describe('客厅牌桌（斗地主）与桌聊', () => {
  it('开桌补脚本陪练；桌内说话只有同桌看得到', () => {
    fixture = setup();
    const { host, clock } = fixture;
    const a = enter(host, A, '阿岚');
    const b = enter(host, B, '小满');
    enter(host, C, '小柚');

    host.openTable(A, { game: 'ddz' });
    host.joinTable(B);
    const started = host.startTable(A);
    expect(started.seats).toEqual(['阿岚', '小满', '陪练甲（脚本）']);

    clock.now += 100;
    const said = host.tableSay(A, '这把我要地主');
    expect(said.scope).toMatchObject({ kind: 'table' });

    const bEvents = texts(host.history(b.seat.cooId, { since: 0, limit: 200 }));
    expect(bEvents).toContain('这把我要地主');
    // 不在桌上的第三人看不到桌内话。
    const cEvents = texts(host.history(C, { since: 0, limit: 200 }));
    expect(cEvents).not.toContain('这把我要地主');
    expect(() => host.tableSay(C, '我也想插一句')).toThrow(/不在这一桌/);

    // 脚本轮到时会自动叫地主（1.5 秒后由时钟代打）。
    clock.now += 100;
    host.tableAction(A, { move: 'bid', call: false });
    clock.now += 100;
    host.tableAction(B, { move: 'bid', call: false });
    clock.now += 2_000;
    host.tickClock();
    const events = host.history(a.seat.cooId, { since: 0, limit: 200 });
    expect(events.some((event) => event.data?.seat === 'bot1')).toBe(true);
  });

  it('牌局结束后桌内说话被拒，公开结果留在快照里', () => {
    fixture = setup();
    const { host, clock } = fixture;
    enter(host, A, '阿岚');
    enter(host, B, '小满');
    host.openTable(A, { game: 'dice' });
    host.joinTable(B);
    host.startTable(A);
    clock.now += 100;
    host.tableAction(A, { type: 'stand' });
    clock.now += 100;
    host.tableAction(B, { type: 'stand' });

    expect(() => host.tableSay(A, '结束了还说')).toThrow(/已经结束/);
    const snapshot = host.snapshot(A, {});
    expect(snapshot.table?.status).toBe('ended');
    expect(snapshot.ledger?.games).toBe(1);
  });
});

describe('重启与持久化', () => {
  it('服务重启后还挂着的桌子作废，押注原路退回', () => {
    const file = fileDb();
    fixture = setup(file);
    const { host } = fixture;
    enter(host, A, '阿岚');
    enter(host, B, '小满');
    host.openTable(A, { game: 'dice', stake: 5 });
    host.joinTable(B);
    host.startTable(A);
    const before = new LedgerDb(fixture.db);
    expect(before.balanceOf(A)).toBe(START_CHIPS - 5);

    // 模拟进程重启：关库、重开、新的 RoomHost（引擎已不在内存里）。
    fixture.close();
    const db = openDb(file);
    migrate(db);
    const restarted = new RoomHost(db, 'lobby', { now: () => 1_760_000_100_000 });
    fixture = { db, host: restarted, clock: { now: 1_760_000_100_000 }, close: () => db.close() };

    const ledger = new LedgerDb(db);
    expect(ledger.balanceOf(A)).toBe(START_CHIPS);
    expect(ledger.balanceOf(B)).toBe(START_CHIPS);
    expect(restarted.tablePublic()).toBeUndefined();
    const events = restarted.history(A, { since: 0, limit: 200 });
    expect(events.some((event) => event.text.includes('服务重启'))).toBe(true);
    expect(restarted.readMail(A, 10, false).items.some((item) => item.text.includes('退回'))).toBe(true);
  });

  it('快照带着牌桌、私视图与账本摘要', () => {
    fixture = setup();
    const { host } = fixture;
    enter(host, A, '阿岚');
    enter(host, B, '小满');
    host.openTable(A, { game: 'dice' });
    host.joinTable(B);
    host.startTable(A);

    const snapshot = host.snapshot(A, {});
    expect(snapshot.table).toMatchObject({ game: 'dice', status: 'playing', host: expect.any(String) });
    expect(snapshot.tablePrivate?.text).toContain('你的点数');
    expect(snapshot.ledger?.chips).toBe(START_CHIPS);
    expect(Array.isArray(snapshot.ledgerRoom)).toBe(true);
  });
});
