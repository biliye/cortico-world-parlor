import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Db } from '../src/room/db.ts';
import { RoomHost } from '../src/room/room-host.ts';
import { createRoom, getRoom, renameSeat } from '../src/room/room-seat-db.ts';
import { LedgerDb } from '../src/room/ledger-db.ts';
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
  // 先手座位在生产是随机的；测试固定成 0（开桌的人先手），否则「谁先叫地主」的断言会翻车。
  const host = await RoomHost.create(db, 'lobby', { now: () => clock.now, randomSeat: () => 0 });
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
  it('斗地主局中改名同步公开/私有/桌列表/增量视图，手牌版本不变并正常结算', async () => {
    fixture = await setup();
    const { host, db, clock } = fixture;
    const a = await enter(host, A, '阿岚');
    await enter(host, B, '小满'); await enter(host, C, '小柚');
    const { tableId } = await host.openTable(A, { game: 'ddz' });
    await host.joinTable(B); await host.joinTable(C); await host.startTable(A);
    await act(host, A, { move: 'bid', call: true }, 'rename-bid');
    const before = await host.snapshot(A);
    const saved = await db.prepare('SELECT state_json FROM tables WHERE id = ?').get(tableId);
    await renameSeat(db, 'lobby', a.seat.id, '新阿岚');
    const after = await host.snapshot(A);
    const named = (view: unknown) => (view as { seats: Array<{ id: string; name: string }> }).seats.find(s => s.id === a.seat.id)?.name;
    expect(named(after.table)).toBe('新阿岚');
    expect(named(after.tables![0])).toBe('新阿岚');
    expect(after.tablePrivate?.name).toBe('新阿岚');
    expect(named((await host.tableSlice(B, tableId)).table)).toBe('新阿岚');
    expect(after.table?.text).toContain('地主 新阿岚');
    expect(after.tablePrivate?.hand).toEqual(before.tablePrivate?.hand);
    expect(after.table?.revision).toBe(before.table?.revision);
    expect(await db.prepare('SELECT state_json FROM tables WHERE id = ?').get(tableId)).toEqual(saved);
    expect(after.events).toEqual(before.events);
    for (let i = 0; i < 400 && (await host.tablePublic(tableId))?.status !== 'ended'; i++) {
      clock.now += 61_000;
      await host.tickClock();
    }
    expect((await host.tablePublic(tableId))?.status).toBe('ended');
    const end = (await host.history(A, { since: 0, limit: 200 })).find(e => e.type === 'parlor.table.end');
    expect(end?.text).toContain('新阿岚');
    expect(end?.text).not.toContain('地主 阿岚');
    expect((await new LedgerDb(db).publicInRoom('lobby', 5))[0].text).toContain('新阿岚');
  });

  it('斗地主两家过牌后，重新领出通知携带该手的已提交版本，可直接出牌', async () => {
    fixture = await setup();
    const { host } = fixture;
    const a = await enter(host, A, '阿岚');
    await enter(host, B, '小满');
    await enter(host, C, '小柚');
    await host.openTable(A, { game: 'ddz' });
    await host.joinTable(B);
    await host.joinTable(C);
    await host.startTable(A);
    await act(host, A, { move: 'bid', call: true }, 'ddz-bid');
    const hand = (await host.tablePrivate(a.seat.id))!.hand as string[];
    await act(host, A, { move: 'play', cards: [hand[0]] }, 'ddz-play');
    await act(host, B, { move: 'pass' }, 'ddz-pass-b');
    const passed = await act(host, C, { move: 'pass' }, 'ddz-pass-c');
    const latest = (await host.history(A, { since: 0, limit: 200 }))
      .filter(event => event.type === 'parlor.table.turn').at(-1)!;
    const notified = latest.data!.table as Record<string, unknown>;
    expect(latest.text).toContain('这一轮你先出');
    expect(notified).toMatchObject({ tableId: latest.data!.tableId, revision: passed.revision });
    const remaining = (await host.tablePrivate(a.seat.id))!.hand as string[];
    await expect(host.tableAction(A, { move: 'play', cards: [remaining[0]] }, {
      revision: notified.revision as number, requestId: 'ddz-lead-again',
    })).resolves.toMatchObject({ revision: passed.revision + 1 });
  });

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
    expect(await host.tablePrivate(a.seat.id)).toBeNull();
    expect((await host.tablePublic())?.text).toContain('结束');
  });

  it('一局骰子结完：只记一条战绩，没有押注也没有底池', async () => {
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

    const ledger = new LedgerDb(fixture.db);
    const summary = await ledger.summaryFor(A);
    expect(summary.games).toBe(1);
    expect(summary.byGame[0]).toMatchObject({ game: 'dice', label: '骰子', games: 1 });
    const result = await host.tablePublic();
    const winners = Array.isArray(result?.winners) ? result.winners : [];
    expect(winners.length).toBeGreaterThan(0);
    // 牌桌不产生任何持有量：谁也没押，谁也没分底池。
    expect(await ledger.heldGifts(A)).toEqual({});
    expect(await ledger.heldGifts(B)).toEqual({});
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

  it('等人桌连续 30 分钟无活动收起，10 分钟仍保留，锁跟着解除', async () => {
    fixture = await setup();
    const { host, clock } = fixture;
    await enter(host, A, '阿岚');
    await host.openTable(A, { game: 'dice' });
    await host.tickClock();
    expect((await host.tablePublic())?.status).toBe('open');

    clock.now += 10 * 60_000 + 1;
    await host.tickClock();
    expect((await host.tablePublic())?.status).toBe('open');
    clock.now += 20 * 60_000;
    await host.tickClock();
    expect(await host.tablePublic()).toBeUndefined();
    expect(await host.tableLock(A)).toBeNull();
    expect((await host.history(A, { since: 0, limit: 100 })).some((event) => event.type === 'parlor.table.cancel')).toBe(true);
  });

  it('入座、退座和有效桌聊重置等待期限，查看不续期，重启沿用存下的期限', async () => {
    const file = fileDb();
    fixture = await setup(file);
    const { host, clock, db } = fixture;
    await enter(host, A, '阿岚'); await enter(host, B, '小满');
    const opened = await host.openTable(A, { game: 'dice' });
    clock.now += 29 * 60_000;
    await host.joinTable(B);
    clock.now += 29 * 60_000;
    await host.tickClock();
    expect((await host.tablePublic())?.status).toBe('open');
    await host.leaveTable(B);
    clock.now += 29 * 60_000;
    await host.tableSay(A, '再等一会儿');
    const saved = await db.prepare('SELECT deadline_at FROM tables WHERE id = ?').get(opened.tableId) as { deadline_at: number };
    expect(saved.deadline_at).toBe(clock.now + 30 * 60_000);
    const resumed = await RoomHost.create(db, 'lobby', { now: () => clock.now });
    clock.now += 29 * 60_000;
    await resumed.tickClock();
    expect((await resumed.tablePublic())?.status).toBe('open');
    await resumed.snapshot(A);
    await expect(resumed.tableSay(A, '')).rejects.toThrow();
    clock.now += 60_000;
    await resumed.tickClock();
    expect(await resumed.tablePublic()).toBeUndefined();
  });
});

describe('客厅牌桌（斗地主）与桌聊', () => {
  it('桌聊记录点名对象并支持短号，桌外人不在接收范围', async () => {
    fixture = await setup();
    const { host, clock } = fixture;
    await enter(host, A, '阿岚');
    const b = await enter(host, B, '小满');
    const c = await enter(host, C, '小柚');
    await host.openTable(A, { game: 'ddz' });
    await host.joinTable(B);
    const said = await host.tableSay(A, '@小满 @小柚 一起看看');
    expect(said.mentions).toEqual([b.seat.id]);
    expect(said.scope).toMatchObject({ kind: 'table' });
    if (said.scope.kind === 'table') expect(said.scope.seats).not.toContain(c.seat.id);
    clock.now += 100;
    const shortHandle = (await host.snapshot(B)).seat.handle;
    expect(shortHandle).toBeTruthy();
    const handle = await host.tableSay(A, `@#${shortHandle} 短号点名`);
    expect(handle.mentions).toEqual([b.seat.id]);
  });

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
  it('短停机续局：牌与轮次都不变，还能接着打', async () => {
    const file = fileDb();
    fixture = await setup(file);
    const { host } = fixture;
    await enter(host, A, '阿岚');
    await enter(host, B, '小满');
    const opened = await host.openTable(A, { game: 'dice' });
    await host.joinTable(B);
    await host.startTable(A);

    // 模拟进程重启：关库、重开、新的 RoomHost（引擎已不在内存里）。
    await fixture.close();
    const db = await openTestDb(file);
    const restarted = await RoomHost.create(db, 'lobby', { now: () => 1_760_000_100_000 });
    fixture = { db, host: restarted, clock: { now: 1_760_000_100_000 }, close: () => closeTestDb(db) };

    expect(opened.tableId).toBeTruthy();
    expect((await restarted.tablePublic())?.status).toBe('playing');
    expect((await restarted.snapshot(A, { limit: 1 })).tablePrivate?.text).toContain('你的点数');
    const events = await restarted.history(A, { since: 0, limit: 200 });
    expect(events.some((event) => event.type === 'parlor.table.resume')).toBe(true);

    // 恢复之后还能接着打，并正常结算。
    await act(restarted, A, { type: 'stand' }, 'resume-a');
    await act(restarted, B, { type: 'stand' }, 'resume-b');
    expect((await restarted.tablePublic())?.status).toBe('ended');
  });

  it('停机超过 30 分钟：这局作废，写一条 refund 终态', async () => {
    const file = fileDb();
    fixture = await setup(file);
    const { host } = fixture;
    await enter(host, A, '阿岚');
    await enter(host, B, '小满');
    const opened = await host.openTable(A, { game: 'dice' });
    await host.joinTable(B);
    await host.startTable(A);

    await fixture.close();
    const db = await openTestDb(file);
    const later = 1_760_000_000_000 + 31 * 60_000;
    const restarted = await RoomHost.create(db, 'lobby', { now: () => later });
    fixture = { db, host: restarted, clock: { now: later }, close: () => closeTestDb(db) };

    expect(await restarted.tablePublic()).toBeUndefined();
    const events = await restarted.history(A, { since: 0, limit: 200 });
    expect(events.some((event) => event.text.includes('停机超过'))).toBe(true);
    // 作废只留一条终态：没有钱要退，也没有新的账本条目。
    const fin = await db.prepare('SELECT kind FROM table_finalizations WHERE table_id = ?').get(opened.tableId) as { kind: string };
    expect(fin.kind).toBe('refund');
    expect((await new LedgerDb(db).summaryFor(A)).games).toBe(0);
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
    expect(snapshot.ledger?.games).toBe(0);
    expect(Array.isArray(snapshot.ledgerRoom)).toBe(true);
  });
});

describe('客厅牌桌（快局大富翁）', () => {
  const D = 'coo-dddddddd';

  it('四人开局后能落库一手并拒绝旧版本', async () => {
    fixture = await setup();
    const { host, clock, db } = fixture;
    await db.prepare(
      'INSERT INTO coos(id, kind, display_name, secret_hash, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    ).run(D, 'pet', '小禾', null, clock.now);

    await enter(host, A, '阿岚');
    await enter(host, B, '小满');
    await enter(host, C, '小柚');
    await enter(host, D, '小禾');

    const opened = await host.openTable(A, { game: 'monopoly2d' }, 'm2d-open');
    await host.joinTable(B);
    await host.joinTable(C);
    await host.joinTable(D);
    const started = await host.startTable(A);

    // 先手是服务端抽的：从四份私视图里找出当前席位。
    let actor = '';
    let turnNo = 0;
    for (const id of [A, B, C, D]) {
      const snapshot = await host.snapshot(id, { limit: 1 });
      const priv = snapshot.tablePrivate as { canAct?: boolean; turnNo?: number } | null | undefined;
      if (priv?.canAct === true) {
        actor = id;
        turnNo = Number(priv.turnNo);
        break;
      }
    }
    expect(actor).not.toBe('');
    expect(turnNo).toBe(1);

    const rolled = await act(host, actor, { type: 'monopoly2d_action', move: 'roll', turnNo }, 'm2d-roll-1');
    expect(rolled.revision).toBeGreaterThan(started.revision);

    // 旧版本一律拒：这一手已经过去了。
    await expect(host.tableAction(actor, { type: 'monopoly2d_action', move: 'roll', turnNo }, {
      revision: started.revision,
      requestId: 'm2d-stale',
    })).rejects.toThrow(/旧桌面|过去的/);

    // 落库的状态能再读出来：桌号、阶段与公开金币都在。
    const snapshot = await host.snapshot(A, {});
    expect(snapshot.table?.game).toBe('monopoly2d');
    expect(['await_roll', 'await_buy']).toContain(String((snapshot.table as { phase?: string } | null)?.phase));
    expect(Array.isArray((snapshot.table as { cells?: unknown[] } | null)?.cells)).toBe(true);
  });

  it('重启宿主后从落库快照恢复，不重掷', async () => {
    fixture = await setup();
    const { host, clock, db } = fixture;
    await db.prepare(
      'INSERT INTO coos(id, kind, display_name, secret_hash, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    ).run(D, 'pet', '小禾', null, clock.now);
    for (const [id, name] of [[A, '阿岚'], [B, '小满'], [C, '小柚'], [D, '小禾']] as const) {
      await enter(host, id, name);
    }
    const opened = await host.openTable(A, { game: 'monopoly2d' });
    await host.joinTable(B);
    await host.joinTable(C);
    await host.joinTable(D);
    await host.startTable(A);

    let actor = '';
    let turnNo = 0;
    for (const id of [A, B, C, D]) {
      const snapshot = await host.snapshot(id, { limit: 1 });
      const priv = snapshot.tablePrivate as { canAct?: boolean; turnNo?: number } | null | undefined;
      if (priv?.canAct === true) { actor = id; turnNo = Number(priv.turnNo); break; }
    }
    await act(host, actor, { type: 'monopoly2d_action', move: 'roll', turnNo }, 'm2d-roll-2');
    const before = await host.snapshot(A, {});
    const beforeTable = before.table as { seats?: Array<{ pos: number; cash: number }>; turnNo?: number } | null;

    const restarted = await RoomHost.create(db, 'lobby', { now: () => clock.now + 1_000 });
    const after = await restarted.snapshot(A, {});
    const afterTable = after.table as { seats?: Array<{ pos: number; cash: number }>; turnNo?: number } | null;
    expect(afterTable?.turnNo).toBe(beforeTable?.turnNo);
    expect(afterTable?.seats?.map((seat) => seat.pos)).toEqual(beforeTable?.seats?.map((seat) => seat.pos));
    expect(opened.tableId).toBeTruthy();
  });
});

describe('客厅牌桌（五子棋）', () => {
  it('五子棋桌落库后重启能接着下，旧版本被拒', async () => {
    fixture = await setup();
    const { host, clock, db } = fixture;
    await enter(host, A, '阿岚');
    await enter(host, B, '小满');

    // 开桌写的是与线上同一条存储路径：桌号、游戏和最后一手都要能原样读回。
    const opened = await host.openTable(A, { game: 'gomoku' });
    await host.joinTable(B);
    const started = await host.startTable(A);

    const before = await host.snapshot(A, { limit: 1 });
    const priv = before.tablePrivate as { canAct?: boolean } | null | undefined;
    expect(priv?.canAct).toBe(true);
    await host.tableAction(A, { type: 'gomoku_action', row: 7, col: 7 }, {
      revision: started.revision,
      requestId: 'gomoku-black-1',
    });
    await expect(host.tableAction(A, { type: 'gomoku_action', row: 8, col: 8 }, {
      revision: started.revision,
      requestId: 'gomoku-stale',
    })).rejects.toThrow(/旧桌面|过去的/);

    // 落库的状态能再读出来：桌号、游戏与已下的那一手都在。
    const restarted = await RoomHost.create(db, 'lobby', { now: () => clock.now + 1_000 });
    const after = await restarted.snapshot(A, {});
    const table = after.table as { id?: string; game?: string; last?: { row: number; col: number } } | null;
    expect(table?.id).toBe(opened.tableId);
    expect(table?.game).toBe('gomoku');
    expect(table?.last).toEqual(expect.objectContaining({ row: 7, col: 7 }));
  });
});

describe('再来一局', () => {
  it('先并入本厅同玩法的空桌，坐满后才新开一张', async () => {
    fixture = await setup();
    const { host } = fixture;
    await enter(host, A, '阿岚'); await enter(host, B, '小满'); await enter(host, C, '小柚');

    const first = await host.rematchTable(A, { game: 'gomoku' }, 'rm-1');
    expect(first).toMatchObject({ game: 'gomoku', created: true, joined: true });

    // 第二个人点同款按钮：并进同一张桌，不再开第二张。
    const second = await host.rematchTable(B, { game: 'gomoku' }, 'rm-2');
    expect(second).toMatchObject({ tableId: first.tableId, created: false, joined: true });

    // 已经在这张桌上的人再点一次：原样返回，既不开新桌也不报错。
    const again = await host.rematchTable(A, { game: 'gomoku' }, 'rm-3');
    expect(again).toMatchObject({ tableId: first.tableId, created: false, joined: false });

    // 五子棋两席已经满了，第三个人只能开一张新的。
    const third = await host.rematchTable(C, { game: 'gomoku' }, 'rm-4');
    expect(third.created).toBe(true);
    expect(third.tableId).not.toBe(first.tableId);
  });

  it('已在别的玩法桌上时按一人一桌拒绝，不硬塞进第二张', async () => {
    fixture = await setup();
    const { host } = fixture;
    await enter(host, A, '阿岚');
    await host.openTable(A, { game: 'ddz' }, 'open-ddz');
    await expect(host.rematchTable(A, { game: 'gomoku' }, 'rm-x'))
      .rejects.toThrow(/一人同时只参与一张/);
  });

  it('不在任何桌上又不指定玩法时明确报错，不瞎开一张', async () => {
    fixture = await setup();
    const { host } = fixture;
    await enter(host, A, '阿岚');
    await expect(host.rematchTable(A, {}, 'rm-none')).rejects.toThrow(/指定玩法/);
  });
});
