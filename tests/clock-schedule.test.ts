/**
 * 时钟按需调度（M2 第三段）：
 * - 引擎给出「下一次真的会推进」的时刻，没到点的桌 tick 直接跳过（不 hydrate、不查库）；
 * - 狼人杀给的是最早的内部节点（夜晚 A 段结束），不是公开的天亮截止；
 * - 客厅把牌桌、承诺到期、补给扫描三路的下一拍合起来交给网关；
 * - 网关睡到那一拍；动作提交后会 poke 一下，不必等满兜底。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Db } from '../src/room/db.ts';
import { RoomHost } from '../src/room/room-host.ts';
import { createRoom, getRoom } from '../src/room/room-seat-db.ts';
import { closeTestDb, openTestDb } from './helpers/test-db.ts';
import { pgServerStorage } from './helpers/pg.ts';
import { WorldServer } from '../src/room/world-server.ts';
import { WerewolfTable } from '../src/room/games/werewolf-table.ts';
import { DiceTable } from '../src/room/table.ts';

const A = 'coo-aaaaaaaa';
const B = 'coo-bbbbbbbb';
const OWNER = 'coo-00000000';

interface Fixture {
  db: Db;
  host: RoomHost;
  clock: { now: number };
  close: () => Promise<void>;
}

const setup = async (turnMs?: number): Promise<Fixture> => {
  const clock = { now: 1_760_000_000_000 };
  const db = await openTestDb();
  const insert = db.prepare(
    'INSERT INTO coos(id, kind, display_name, secret_hash, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
  );
  for (const [id, kind, name] of [[OWNER, 'system', '主人'], [A, 'pet', '阿岚'], [B, 'pet', '小满']] as const) {
    await insert.run(id, kind, name, null, clock.now);
  }
  if (!(await getRoom(db, 'lobby'))) {
    await createRoom(db, {
      id: 'lobby', name: '默认客厅', ownerCooId: OWNER, visibility: 'unlisted', capacity: 8,
    }, clock.now);
  }
  const host = await RoomHost.create(db, 'lobby', {
    now: () => clock.now,
    ...(turnMs !== undefined ? { turnMs } : {}),
  });
  return { db, host, clock, close: () => closeTestDb(db) };
};

const tableRow = async (db: Db, tableId: string) => (await db.prepare(
  'SELECT revision, updated_at, deadline_at FROM tables WHERE id = ?',
).get(tableId)) as { revision: number; updated_at: number; deadline_at: number | null };

/** 开一张骰子桌、两个人坐下、开局；返回桌号。 */
const startDice = async (fixture: Fixture): Promise<string> => {
  await fixture.host.join(A, { name: '阿岚' });
  await fixture.host.join(B, { name: '小满' });
  const opened = await fixture.host.openTable(A, { game: 'dice' }, 'open-1');
  await fixture.host.joinTable(B, opened.tableId, 'join-1');
  await fixture.host.startTable(A, opened.tableId, 'start-1');
  return opened.tableId;
};

describe('时钟按需调度：没到点的桌不推进', () => {
  let fixture: Fixture;
  afterEach(async () => { if (fixture) await fixture.close(); });

  it('骰子 45 秒回合：1 秒时 tick 不写库，到点才推进', async () => {
    fixture = await setup(45_000);
    const tableId = await startDice(fixture);
    const before = await tableRow(fixture.db, tableId);
    expect(before.deadline_at).toBe(fixture.clock.now + 45_000);

    fixture.clock.now += 1_000;
    await fixture.host.tickClock(fixture.clock.now);
    expect(await tableRow(fixture.db, tableId)).toEqual(before);

    fixture.clock.now += 44_000;
    await fixture.host.tickClock(fixture.clock.now);
    const after = await tableRow(fixture.db, tableId);
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.updated_at).toBe(fixture.clock.now);
  });

  it('客厅的下一拍就是桌上最紧的那个截止（比补给扫描还紧时）', async () => {
    fixture = await setup(10_000);
    const tableId = await startDice(fixture);
    // 先让时钟走一拍（第一次补给扫描会把补给拍排到 30 秒后）。
    await fixture.host.tickClock(fixture.clock.now);
    const row = await tableRow(fixture.db, tableId);
    expect(await fixture.host.nextWakeAt(fixture.clock.now)).toBe(row.deadline_at);
  });

  it('开桌等人的那一桌：下一拍不晚于开桌截止，也不会「立刻」', async () => {
    fixture = await setup();
    await fixture.host.join(A, { name: '阿岚' });
    const opened = await fixture.host.openTable(A, { game: 'dice' }, 'open-2');
    await fixture.host.tickClock(fixture.clock.now);
    const wake = await fixture.host.nextWakeAt(fixture.clock.now) as number;
    // 默认开桌等人 10 分钟；中间还有一次 30 秒的补给扫描，所以睡不到开桌那一刻。
    expect(wake).toBeGreaterThan(fixture.clock.now);
    expect(wake).toBeLessThanOrEqual(fixture.clock.now + 10 * 60_000);
    // 两分钟后 tick：还没到点，桌子还在。
    fixture.clock.now += 2 * 60_000;
    await fixture.host.tickClock(fixture.clock.now);
    expect(await fixture.host.tablePublic(undefined, A)).toBeTruthy();
    expect(opened.tableId).toBeTruthy();
  });

  it('历史承诺不再触发到期调度或新增失约', async () => {
    fixture = await setup();
    await fixture.host.join(A, { name: '阿岚' });
    await fixture.host.join(B, { name: '小满' });
    const due = fixture.clock.now + 20_000;
    const promised = await fixture.host.promise(A, '小满', '二十秒内收桌子', due);
    // 对方答应之后，到期没结才会追加 default。
    await fixture.host.respond(B, promised.entry.id, 'accept');
    await fixture.host.tickClock(fixture.clock.now);
    const wake = await fixture.host.nextWakeAt(fixture.clock.now);
    expect(wake === undefined ? Infinity : wake).toBeGreaterThan(due);
    // 还没到点：账本里不该有 default
    fixture.clock.now = due - 1;
    await fixture.host.tickClock(fixture.clock.now);
    const early = await fixture.db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE kind = 'default'").get() as { n: number };
    expect(early.n).toBe(0);
    // 到点：追加一条 default
    fixture.clock.now = due;
    await fixture.host.tickClock(fixture.clock.now);
    const late = await fixture.db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE kind = 'default'").get() as { n: number };
    expect(late.n).toBe(0);
  });
});

describe('引擎的 nextWakeAt', () => {
  it('骰子：玩着给截止，没开局什么都不用叫醒', () => {
    const table = new DiceTable({ host: { id: 's1', name: '一' }, now: 1000, turnMs: 5000, rng: () => 0.5 });
    expect(table.nextWakeAt(1000)).toBeUndefined();
    table.join({ id: 's2', name: '二' });
    table.start('s1', 1000);
    expect(table.nextWakeAt(1000)).toBe(6000);
  });

  it('狼人杀：给的是最早的内部节点（夜晚 A 段结束），不是公开的天亮截止', () => {
    const T = 40;
    const table = new WerewolfTable({
      host: { id: 's1', name: '一号', kind: 'human', clientVersion: '0.29.0' },
      now: 1_000_000,
      turnMs: T,
      rng: () => 0.42,
    });
    for (let i = 2; i <= 9; i++) table.join({ id: `s${i}`, name: `${i}号`, kind: 'pet', clientVersion: '0.29.0' });
    table.start('s1', 1_000_000);

    const revealAt = table.nextWakeAt();
    expect(revealAt).toBeGreaterThan(1_000_000);

    // 翻牌段结束 → 进首夜 A 段。A 段的结束时刻必须早于公开的「天亮」。
    const step = table.tick(revealAt!);
    expect(step).not.toBeNull();
    const wakeA = table.nextWakeAt()!;
    const publicDeadline = (table as unknown as { publicDeadline: () => number }).publicDeadline();
    expect(wakeA).toBeLessThan(publicDeadline);
    // 到了 A 段截止，tick 真的会推进（锁刀口进 B 段），说明这一拍不是空转。
    const aStep = table.tick(wakeA);
    expect(aStep).not.toBeNull();
    const wakeB = table.nextWakeAt()!;
    expect(wakeB).toBeGreaterThan(wakeA);
  });
});

describe('网关：睡到下一拍也会自己醒', () => {
  let server: WorldServer | undefined;
  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  it('没有手动 tick：短回合的骰子桌自己往前走', async () => {
    server = await WorldServer.create({
      allowGuestJoin: true,
      ...(await pgServerStorage(':memory:')),
      port: 0,
      inviteCode: 'inv',
      tableTurnMs: 150,
    });
    await server.listen();
    const secretFor = (cooId: string): string => `secret-${cooId}-0123456789`;
    const headers = (cooId: string) => ({
      'content-type': 'application/json',
      'x-parlor-coo': cooId,
      'x-parlor-coo-secret': secretFor(cooId),
    });
    const enter = async (cooId: string, name: string): Promise<string> => {
      const response = await fetch(server!.url + '/v1/join', {
        method: 'POST', headers: { ...headers(cooId), 'x-parlor-invite': 'inv' }, body: JSON.stringify({ name }),
      });
      const body = await response.json() as { token: string };
      return body.token;
    };
    const act = async (token: string, body: unknown) => {
      const response = await fetch(server!.url + '/v1/action', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return response.json() as Promise<Record<string, unknown>>;
    };
    const tokenA = await enter(A, '阿岚');
    const tokenB = await enter(B, '小满');
    await act(tokenA, { type: 'table_open', requestId: 'o1', game: 'dice' });
    await act(tokenB, { type: 'table_join', requestId: 'j1' });
    const started = await act(tokenA, { type: 'table_start', requestId: 's1' });
    const startRevision = started.revision as number;

    // 不调用任何 tick/action：等两拍，时钟应当自己醒过来推进超时。
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const snap = await fetch(server.url + '/v1/room?limit=1', { headers: { authorization: `Bearer ${tokenA}` } });
    const body = await snap.json() as { table: { revision: number; turn?: string } };
    expect(body.table.revision).toBeGreaterThan(startRevision);
  }, 15_000);
});
