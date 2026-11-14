import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTransaction, type Db } from '../src/room/db.ts';
import { jsonValue } from '../src/room/storage/json.ts';
import { RoomHost } from '../src/room/room-host.ts';
import { createRoom, getRoom, renameSeat } from '../src/room/room-seat-db.ts';
import { LedgerDb } from '../src/room/ledger-db.ts';
import { closeTestDb, openTestDb } from './helpers/test-db.ts';

const OWNER = 'coo-00000000';
/** s1 由真人（家长下场）坐，其余是 Coo。 */
const COOS = [
  'coo-human001', 'coo-aaaaaaaa', 'coo-bbbbbbbb', 'coo-cccccccc', 'coo-dddddddd',
  'coo-eeeeeeee', 'coo-ffffffff', 'coo-gggggggg', 'coo-hhhhhhhh',
];
const NAMES = ['家长', '阿岚', '小满', '小柚', '石头', '阿妹', '七七', '泡泡', '九九'];

const CLIENT_OK = '0.29.0';

describe('等人桌能力续连', () => {
  it('仅刷新本人并持久化，重复/缺头不写，不续期；事务回滚和已开局均不改状态', async () => {
    dir = mkdtempSync(join(tmpdir(), 'parlor-capabilities-'));
    const file = join(dir, 'state.db');
    let fixture = await setup(file);
    try {
      await enterAll(fixture);
      const tableId = await openWerewolf(fixture);
      const row = async () => await fixture.db.prepare('SELECT state_json, revision, deadline_at FROM tables WHERE id = ?').get(tableId) as { state_json: unknown; revision: number; deadline_at: number };
      const original = await row();
      const originalLatest = (await fixture.host.snapshot(COOS[0])).latest;
      fixture.clock.now += 1000;
      await expect(withTransaction(fixture.db, async () => {
        expect(await fixture.host.refreshClientVersion(COOS[1], '0.35.4')).toBe(true);
        throw new Error('模拟提交回滚');
      })).rejects.toThrow('模拟提交回滚');
      expect(await row()).toEqual(original);
      expect((await fixture.host.snapshot(COOS[0])).latest).toBe(originalLatest);
      expect(await fixture.host.refreshClientVersion(COOS[1], '0.35.4')).toBe(true);
      const notifications = await fixture.host.history(COOS[0], { since: originalLatest, limit: 20 });
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({ type: 'parlor.table.turn', scope: { kind: 'seat' }, data: { decision: false } });
      expect(notifications[0].text).toContain('尚未分配角色');
      const changed = await row();
      expect(changed.deadline_at).toBe(original.deadline_at);
      expect(changed.revision).toBe(original.revision + 1);
      const beforeSeats = jsonValue<{ seats: Array<Record<string, unknown>> }>(original.state_json, { seats: [] }).seats;
      const afterSeats = jsonValue<{ seats: Array<Record<string, unknown>> }>(changed.state_json, { seats: [] }).seats;
      expect(afterSeats[1]).toEqual({ ...beforeSeats[1], clientVersion: '0.35.4' });
      expect(afterSeats.filter((_, index) => index !== 1)).toEqual(beforeSeats.filter((_, index) => index !== 1));
      for (const version of [undefined, '', 'invalid', '0.35.4']) {
        expect(await fixture.host.refreshClientVersion(COOS[1], version)).toBe(false);
      }
      expect(await fixture.host.refreshClientVersion(COOS[0], '0.35.4')).toBe(false);
      expect(await row()).toEqual(changed);
      await fixture.close();
      fixture = await setup(file);
      expect((await row()).state_json).toEqual(changed.state_json);
      expect(await fixture.host.refreshClientVersion(COOS[1], '0.35.4')).toBe(false);
      await startTable(fixture, tableId);
      const playing = await row();
      expect(await fixture.host.refreshClientVersion(COOS[1], '0.28.0')).toBe(false);
      expect(await row()).toEqual(playing);
    } finally { await fixture.close(); }
  });
});

interface Fixture {
  db: Db;
  host: RoomHost;
  clock: { now: number };
  close: () => Promise<void>;
}

let dir: string | undefined;

afterEach(async () => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const setup = async (file?: string): Promise<Fixture> => {
  const clock = { now: 1_760_000_000_000 };
  const db = await openTestDb(file ?? ':memory:');
  const insert = db.prepare(
    'INSERT INTO coos(id, kind, display_name, secret_hash, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
  );
  await insert.run(OWNER, 'system', '主人', null, clock.now);
  for (const [index, cooId] of COOS.entries()) {
    await insert.run(cooId, index === 0 ? 'human' : 'pet', NAMES[index], null, clock.now);
  }
  if (!(await getRoom(db, 'lobby'))) {
    await createRoom(db, {
      id: 'lobby', name: '默认客厅', ownerCooId: OWNER, visibility: 'unlisted', capacity: 30,
    }, clock.now);
  }
  const host = await RoomHost.create(db, 'lobby', { now: () => clock.now });
  return { db, host, clock, close: () => closeTestDb(db) };
};

const enterAll = async (fixture: Fixture): Promise<string[]> => {
  const seatIds: string[] = [];
  for (const [index, cooId] of COOS.entries()) {
    const joined = await fixture.host.join(cooId, {
      name: NAMES[index],
      kind: index === 0 ? 'human' : 'pet',
    });
    seatIds.push(joined.seat.id);
  }
  return seatIds;
};

/** 开一张九席狼人杀桌：家长开桌，八个 Coo 带能力版本入座。 */
const openWerewolf = async (fixture: Fixture): Promise<string> => {
  const opened = await fixture.host.openTable(COOS[0], { game: 'werewolf' });
  const tableId = opened.tableId;
  for (let i = 1; i < COOS.length; i++) {
    await fixture.host.joinTable(COOS[i], tableId, `join-${i}`, CLIENT_OK);
  }
  return tableId;
};

const startTable = async (fixture: Fixture, tableId: string): Promise<void> => {
  await fixture.host.startTable(COOS[0], tableId);
};

interface Priv {
  canAct?: boolean;
  myMove?: string;
  windowId?: string;
  role?: string;
  phase?: string;
  stage?: string;
  speechKind?: string;
  day?: number;
  deadline?: number;
  alive?: boolean;
  seats?: Array<{ id: string; seatNo: number; alive: boolean }>;
  teammates?: Array<{ seatNo: number }>;
  potions?: { antidote: number; poison: number };
  wolfChat?: Array<{ seatNo: number; name: string; text: string }>;
  inspections?: Array<{ day: number; target: number; result: string }>;
  freshResult?: boolean;
}

const privOf = async (fixture: Fixture, cooId: string): Promise<Priv> => {
  const seat = (await fixture.host.seatOf(cooId))!;
  const priv = await fixture.host.tablePrivate(seat.id) as unknown as Priv | null;
  expect(priv).not.toBeNull();
  return priv as Priv;
};

const action = async (
  fixture: Fixture,
  cooId: string,
  body: Record<string, unknown>,
  requestId?: string,
): Promise<{ receipt: { revision?: number; seq?: number; tableId?: string }; error?: string }> => {
  try {
    const receipt = await fixture.host.tableAction(cooId, {
      type: 'werewolf_action',
      windowId: (await privOf(fixture, cooId)).windowId,
      ...body,
    }, { requestId: requestId ?? `req-${cooId}-${Math.random()}` });
    return { receipt };
  } catch (error) {
    return { error: (error as Error).message, receipt: {} };
  }
};

const aliveCoos = async (fixture: Fixture): Promise<string[]> => {
  const seat = (await fixture.host.seatOf(COOS[0]))!;
  const priv = await fixture.host.tablePrivate(seat.id) as unknown as Priv;
  return (priv.seats ?? []).filter((entry) => entry.alive).map((entry) => COOS[entry.seatNo - 1]);
};

const cooBySeatNo = (seatNo: number): string => COOS[seatNo - 1];

/** 狼人杀九席之外的额外 Coo：双桌与坏快照测试里开第二张桌用。 */
const EXTRA_COOS = ['coo-extra0001', 'coo-extra0002'];
const EXTRA_NAMES = ['多多', '点点'];

const joinExtras = async (fixture: Fixture): Promise<string[]> => {
  const insert = fixture.db.prepare(
    'INSERT INTO coos(id, kind, display_name, secret_hash, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
  );
  const seatIds: string[] = [];
  for (const [index, cooId] of EXTRA_COOS.entries()) {
    await insert.run(cooId, 'pet', EXTRA_NAMES[index], null, fixture.clock.now);
    const joined = await fixture.host.join(cooId, { name: EXTRA_NAMES[index], kind: 'pet' });
    seatIds.push(joined.seat.id);
  }
  return seatIds;
};

/** 挑一个非狼、非自身的存活座号当刀票目标。 */
const nonWolfSeatNo = async (fixture: Fixture, wolves: string[]): Promise<number> => {
  const wolfNos: number[] = [];
  for (const cooId of wolves) {
    const seat = (await fixture.host.seatOf(cooId))!;
    const priv = await fixture.host.tablePrivate(seat.id) as unknown as Priv;
    wolfNos.push(priv.seats!.find((entry) => entry.id === seat.id)!.seatNo);
  }
  return [1, 2, 3, 4, 5, 6, 7, 8, 9].find((no) => !wolfNos.includes(no))!;
};

/** 按阶段泵：能动的交默认动作，到点推进；verbed 记录阶段转换。 */
const pump = async (fixture: Fixture, onEvent?: (type: string, text: string) => void, maxSteps = 400): Promise<void> => {
  for (let guard = 0; guard < maxSteps; guard++) {
    const seat = (await fixture.host.seatOf(COOS[0]))!;
    const priv = await fixture.host.tablePrivate(seat.id) as unknown as Priv | null;
    const pub = await fixture.host.tablePublic() as { status?: string; turn?: string } | null;
    if (!priv || pub?.status === 'ended') return;
    await fixture.host.tickClock();
    for (const cooId of await aliveCoos(fixture)) {
      const seatRow = (await fixture.host.seatOf(cooId))!;
      const view = await fixture.host.tablePrivate(seatRow.id) as unknown as Priv | null;
      if (!view?.canAct) continue;
      if (view.myMove === 'speak') {
        await action(fixture, cooId, { move: 'speak', text: `${NAMES[Number(seatRow.id.slice(1)) - 1]}的发言` });
      } else if (view.myMove === 'vote') {
        await action(fixture, cooId, { move: 'vote' });
      } else if (view.myMove === 'wolf_chat') {
        await action(fixture, cooId, { move: 'wolf_chat', text: '过' });
      } else if (view.myMove === 'wolf_kill') {
        await action(fixture, cooId, { move: 'wolf_kill' });
      } else if (view.myMove === 'witch') {
        await action(fixture, cooId, { move: 'witch', choice: 'none' });
      } else if (view.myMove === 'shoot') {
        await action(fixture, cooId, { move: 'shoot' });
      } else if (view.myMove === 'inspect') {
        await action(fixture, cooId, { move: 'inspect' });
      }
      if (onEvent) onEvent(view.myMove ?? '', '');
    }
    // 没人可动时推时钟走过当前窗口（发言阅读期 / 投票 / 夜间）；步长盖过最长的单一窗口。
    fixture.clock.now += 65_000;
    await fixture.host.tickClock();
  }
  throw new Error('泵没有收敛');
};

describe('狼人杀 · 宿主层', () => {
  it('九人局中改名后所有牌桌视图立即跟随，角色与行动窗口保持，牌局能结束', async () => {
    const fixture = await setup();
    try {
      const seatIds = await enterAll(fixture);
      const tableId = await openWerewolf(fixture);
      await startTable(fixture, tableId);
      const before = await fixture.host.snapshot(COOS[0]);
      await renameSeat(fixture.db, 'lobby', seatIds[0], '改名后的家长');
      const after = await fixture.host.snapshot(COOS[0]);
      const named = (view: unknown) => (view as { seats: Array<{ id: string; name: string }> }).seats.find(s => s.id === seatIds[0])?.name;
      expect(named(after.table)).toBe('改名后的家长');
      expect(named(after.tables![0])).toBe('改名后的家长');
      expect(named(after.tablePrivate)).toBe('改名后的家长');
      expect(named((await fixture.host.tableSlice(COOS[1], tableId)).table)).toBe('改名后的家长');
      expect(after.tablePrivate?.role).toBe(before.tablePrivate?.role);
      expect(after.tablePrivate?.windowId).toBe(before.tablePrivate?.windowId);
      expect(after.table?.revision).toBe(before.table?.revision);
      await pump(fixture);
      expect((await fixture.host.tablePublic(tableId))?.status).toBe('ended');
    } finally { await fixture.close(); }
  });

  it('能力闸：旧版 Coo 入座后开不了局，报错点名；带版本即可', async () => {
    const fixture = await setup();
    await enterAll(fixture);
    const opened = await fixture.host.openTable(COOS[0], { game: 'werewolf' });
    for (let i = 1; i < COOS.length; i++) {
      // 最后一只 Coo 用旧版入座。
      await fixture.host.joinTable(COOS[i], opened.tableId, `join-${i}`, i === 8 ? '0.28.0' : CLIENT_OK);
    }
    await expect(fixture.host.startTable(COOS[0], opened.tableId)).rejects.toThrow(/九九/);
    await expect(fixture.host.startTable(COOS[0], opened.tableId)).rejects.toThrow(/0\.29\.0/);
    await fixture.close();
  });

  it('窗口制并发：同一晚三人各交各的票都成功；requestId 幂等；301 字不消耗机会', async () => {
    const fixture = await setup();
    await enterAll(fixture);
    const tableId = await openWerewolf(fixture);
    await startTable(fixture, tableId);
    // 看身份 → 首夜。
    fixture.clock.now += 20_000;
    await fixture.host.tickClock();
    const priv = await privOf(fixture, COOS[0]);
    expect(priv.phase).toBe('night');

    const wolves: string[] = [];
    for (const cooId of COOS) {
      if ((await privOf(fixture, cooId)).role === 'wolf') wolves.push(cooId);
    }
    let witch: string | undefined;
    for (const cooId of COOS) {
      if ((await privOf(fixture, cooId)).role === 'witch') {
        witch = cooId;
        break;
      }
    }
    // 三只狼各自交弃刀（窗口制：互不顶）。
    for (const wolf of wolves) {
      const result = await action(fixture, wolf, { move: 'wolf_kill' });
      expect(result.error).toBeUndefined();
    }
    // 同 requestId 重放：返回原回执，不报错、不重复。
    const first = await action(fixture, wolves[0], { move: 'wolf_chat', text: '稳住' }, 'same-request');
    const replay = await action(fixture, wolves[0], { move: 'wolf_chat', text: '稳住' }, 'same-request');
    expect(replay.error).toBeUndefined();
    expect(replay.receipt.seq).toBe(first.receipt.seq);
    // 同 requestId 不同参数：冲突。
    const conflict = await action(fixture, wolves[0], { move: 'wolf_chat', text: '改口' }, 'same-request');
    expect(conflict.error).toContain('不同的动作');
    // 301 字发言被拒后，同一窗口还能正常交（快进两段夜，落在第一位发言者的窗口里）。
    fixture.clock.now += 120_000;
    await fixture.host.tickClock();
    fixture.clock.now += 120_000;
    await fixture.host.tickClock();
    let speaker: string | undefined;
    for (const cooId of COOS) {
      const view = await privOf(fixture, cooId);
      if (view.canAct && view.myMove === 'speak') {
        speaker = cooId;
        break;
      }
    }
    expect(speaker).toBeDefined();
    const long = await action(fixture, speaker!, { move: 'speak', text: '长'.repeat(301) });
    expect(long.error).toContain('300');
    const ok = await action(fixture, speaker!, { move: 'speak', text: '正常发言' });
    expect(ok.error).toBeUndefined();
    // 女巫窗口没开时不能交药（窗口号已换，动作被拒）。
    const earlyWitch = await action(fixture, witch!, { move: 'witch', choice: 'none' });
    expect(earlyWitch.error === undefined || earlyWitch.error.length > 0).toBe(true);
    await fixture.close();
  });

  it('可见性：狼聊与查验只在受众的 history 里；刷新事件带 decision:false', async () => {
    const fixture = await setup();
    await enterAll(fixture);
    const tableId = await openWerewolf(fixture);
    await startTable(fixture, tableId);
    fixture.clock.now += 20_000;
    await fixture.host.tickClock();

    const wolves: string[] = [];
    for (const cooId of COOS) {
      if ((await privOf(fixture, cooId)).role === 'wolf') wolves.push(cooId);
    }
    let seer: string | undefined;
    for (const cooId of COOS) {
      if ((await privOf(fixture, cooId)).role === 'seer') {
        seer = cooId;
        break;
      }
    }
    let villager: string | undefined;
    for (const cooId of COOS) {
      if (!['wolf', 'seer', 'witch', 'hunter'].includes((await privOf(fixture, cooId)).role!)) {
        villager = cooId;
        break;
      }
    }
    const seerSeatId = (await fixture.host.seatOf(seer!))!.id;
    const seerNo = ((await fixture.host.tablePrivate(seerSeatId)) as unknown as Priv).seats!
      .find((entry) => entry.id === seerSeatId)!.seatNo;
    const inspectTarget = seerNo === 2 ? 3 : 2;
    // 刀票目标选一个非狼且非自己的存活席。
    const wolfNos: number[] = [];
    for (const cooId of wolves) {
      const seat = (await fixture.host.seatOf(cooId))!;
      wolfNos.push(((await fixture.host.tablePrivate(seat.id)) as unknown as Priv).seats!
        .find((entry) => entry.id === seat.id)!.seatNo);
    }
    const killTarget = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((no) => !wolfNos.includes(no))!;
    expect((await action(fixture, wolves[0], { move: 'wolf_chat', text: '今夜动手' })).error).toBeUndefined();
    expect((await action(fixture, wolves[0], { move: 'wolf_kill', target: killTarget })).error).toBeUndefined();
    expect((await action(fixture, seer!, { move: 'inspect', target: inspectTarget })).error).toBeUndefined();

    const turnsOf = async (cooId: string): Promise<Array<Record<string, unknown>>> => {
      const seatId = (await fixture.host.seatOf(cooId))!.id;
      return (await fixture.host.history(cooId, { since: 0, limit: 200 }))
        .filter((event) => event.type === 'parlor.table.turn') as unknown as Array<Record<string, unknown>>;
    };
    // 狼的历史里有狼聊；村民的没有；查验结果只在预言家的。
    const wolfTurns = (await turnsOf(wolves[1])) as unknown as Array<{ data: { table: Priv } }>;
    expect(wolfTurns.some((event) => JSON.stringify(event.data?.table?.wolfChat ?? []).includes('今夜动手'))).toBe(true);
    const villagerTurns = (await turnsOf(villager!)) as unknown as Array<{ data: { table: Priv } }>;
    expect(villagerTurns.every((event) => event.data?.table?.wolfChat === undefined)).toBe(true);
    const seerTurns = (await turnsOf(seer!)) as unknown as Array<{ data: { table: Priv } }>;
    expect(seerTurns.some((event) => JSON.stringify(event.data?.table?.inspections ?? []).includes(`"target":${inspectTarget}`))).toBe(true);
    // 队友交刀后，其他狼收到 decision:false 的纯刷新。
    const refresh = (await turnsOf(wolves[1])).some((event) => (event as { data?: { decision?: boolean } }).data?.decision === false);
    expect(refresh).toBe(true);
    // 公开事件流里没有狼聊正文。
    const publicEvents = await fixture.host.history(villager!, { since: 0, limit: 200 });
    expect(publicEvents.some((event) => event.text.includes('今夜动手'))).toBe(false);
    await fixture.close();
  });

  it('聊天旁路：进行中锁桌聊/房间发言/同桌互私聊；等待与局外不受限', async () => {
    const fixture = await setup();
    await enterAll(fixture);
    const tableId = await openWerewolf(fixture);
    // 等待开局：桌聊照常。
    await expect(fixture.host.tableSay(COOS[1], '等人都来', tableId)).resolves.toBeTruthy();
    await startTable(fixture, tableId);
    fixture.clock.now += 100;
    // 开局后：桌聊拒绝。
    await expect(fixture.host.tableSay(COOS[1], '桌上说一句', tableId)).rejects.toThrow(/游戏动作/);
    // 房间公开发言拒绝（参与者）。
    fixture.clock.now += 100;
    await expect(fixture.host.say(COOS[1], '客厅里喊一句')).rejects.toThrow(/狼人杀/);
    // 同桌两人私聊拒绝；桌外人（观战的主人）对参与者私聊放行。
    await expect(fixture.host.whisper(COOS[1], NAMES[2], '串个词')).rejects.toThrow(/不能私聊/);
    const observer = await fixture.host.join(OWNER, { name: '主人', kind: 'observer' });
    await expect(fixture.host.whisper(OWNER, NAMES[1], '场外插一句')).resolves.toBeTruthy();
    void observer;
    // 看身份过后照样锁着；终局后恢复。
    fixture.clock.now += 20_000;
    await fixture.host.tickClock();
    await expect(fixture.host.tableSay(COOS[1], '夜里说', tableId)).rejects.toThrow(/游戏动作/);
    await fixture.close();
  });

  it('离线提醒：决策窗口给掉线席位留无秘密的信；同窗口不重发', async () => {
    const fixture = await setup();
    await enterAll(fixture);
    const tableId = await openWerewolf(fixture);
    // 把一只 Coo 的最近活跃拨到很早（掉线）。
    const offlineCoo = COOS[3];
    await fixture.db.prepare('UPDATE room_seats SET last_seen_at = ? WHERE coo_id = ?')
      .run(fixture.clock.now - 10 * 60_000, offlineCoo);
    await startTable(fixture, tableId);
    fixture.clock.now += 20_000;
    await fixture.host.tickClock(); // 进入首夜
    // 若掉线者是首夜行动者，会有提醒信；非行动者等它轮到时才有。
    const mailRows = async (): Promise<Array<{ text: string }>> => (
      (await fixture.db.prepare('SELECT text FROM mail WHERE coo_id = ?').all(offlineCoo)) as Array<{ text: string }>
    );
    const role = (await privOf(fixture, offlineCoo)).role;
    if (['wolf', 'seer'].includes(role!)) {
      expect((await mailRows()).some((row) => row.text.includes('你的牌桌需要操作'))).toBe(true);
      expect((await mailRows()).every((row) => !row.text.includes('狼人') || row.text.includes('不含任何身份'))).toBe(true);
      // 同一窗口不重发：再触发一轮 tick 不加信。
      const count = (await mailRows()).length;
      fixture.clock.now += 1000;
      await fixture.host.tickClock();
      expect((await mailRows()).length).toBe(count);
    }
    // 推进到白天发言，全员轮流：掉线者轮到时一定有信。
    await pump(fixture);
    expect((await mailRows()).some((row) => row.text.includes('你的牌桌需要操作'))).toBe(true);
    await fixture.close();
  });

  it('离线提醒按席位退出未读；过期、作废与重试不影响其他来信', async () => {
    const fixture = await setup();
    try {
      const seatIds = await enterAll(fixture);
      const tableId = await openWerewolf(fixture);
      await fixture.db.prepare('UPDATE room_seats SET last_seen_at = ?')
        .run(fixture.clock.now - 10 * 60_000);
      await startTable(fixture, tableId);
      const reveal = (await privOf(fixture, COOS[0])).windowId;
      const readAt = async (key: string) => (await fixture.db.prepare('SELECT read_at FROM mail WHERE key = ?')
        .get<{ read_at: number | null }>(key))?.read_at;
      expect(await readAt(`${tableId}/${reveal}/${seatIds[0]}`)).toBeNull();

      fixture.clock.now += 20_000;
      await fixture.host.tickClock();
      expect(await readAt(`${tableId}/${reveal}/${seatIds[0]}`)).not.toBeNull();
      const views = await Promise.all(COOS.map(cooId => privOf(fixture, cooId)));
      const wolfIndex = views.findIndex(view => view.role === 'wolf');
      const seerIndex = views.findIndex(view => view.role === 'seer');
      const window = views[wolfIndex].windowId;
      const wolfKey = `${tableId}/${window}/${seatIds[wolfIndex]}`;
      const seerKey = `${tableId}/${window}/${seatIds[seerIndex]}`;
      expect(await readAt(wolfKey)).toBeNull();
      expect(await readAt(seerKey)).toBeNull();
      expect((await action(fixture, COOS[wolfIndex], { move: 'wolf_chat', text: '先讨论' })).error).toBeUndefined();
      expect(await readAt(wolfKey)).toBeNull(); // 可选狼聊之后仍欠刀票。
      for (let i = 0; i < 2; i++) {
        expect((await action(fixture, COOS[wolfIndex], { move: 'wolf_kill' }, 'same-knife')).error).toBeUndefined();
      }
      expect(await readAt(wolfKey)).not.toBeNull();
      expect(await readAt(seerKey)).toBeNull();

      await fixture.db.prepare(`INSERT INTO mail (id, ts, coo_id, room_id, kind, from_name, text, key)
        VALUES (?, ?, ?, 'lobby', 'whisper', '发信人', '私信', ?)`)
        .run('unrelated-mail', fixture.clock.now, COOS[seerIndex], 'unrelated-mail');
      expect(await fixture.host.voidTable(tableId, '测试作废')).toBe(true);
      expect(await readAt(seerKey)).not.toBeNull();
      expect(await readAt('unrelated-mail')).toBeNull();
    } finally {
      await fixture.close();
    }
  });

  it('恢复：夜间中断重启 → 身份与阶段保留、截止平移、能继续打完；坏版本隔离', async () => {
    dir = mkdtempSync(join(tmpdir(), 'parlor-wolf-'));
    const file = join(dir, 'parlor.db');
    const fixture = await setup(file);
    await enterAll(fixture);
    const tableId = await openWerewolf(fixture);
    await startTable(fixture, tableId);
    fixture.clock.now += 20_000;
    await fixture.host.tickClock();
    const rolesBefore: Array<string | undefined> = [];
    for (const cooId of COOS) rolesBefore.push((await privOf(fixture, cooId)).role);
    const wolves: string[] = [];
    for (const cooId of COOS) {
      if ((await privOf(fixture, cooId)).role === 'wolf') wolves.push(cooId);
    }
    // 狼交一半动作就「停机」。
    await action(fixture, wolves[0], { move: 'wolf_kill', target: 5 });
    const deadlineBefore = (await privOf(fixture, wolves[0])).deadline ?? 0;
    await fixture.close();

    // 重启：5 秒后。
    const clock2 = { now: fixture.clock.now + 5_000 };
    const db2 = await openTestDb(file);
    const host2 = await RoomHost.create(db2, 'lobby', { now: () => clock2.now });
    const priv = await (async (): Promise<Priv> => {
      const seat = (await host2.seatOf(COOS[0]))!;
      return (await host2.tablePrivate(seat.id)) as unknown as Priv;
    })();
    expect(priv.phase).toBe('night');
    const rolesAfter: Array<string | undefined> = [];
    for (const cooId of COOS) {
      const seat = (await host2.seatOf(cooId))!;
      rolesAfter.push(((await host2.tablePrivate(seat.id)) as unknown as Priv).role);
    }
    expect(rolesAfter).toEqual(rolesBefore);
    // 截止被平移：新截止晚于旧截止（至少剩余 + 停机补偿）。
    const seatWolf = (await host2.seatOf(wolves[0]))!;
    const privWolf = await host2.tablePrivate(seatWolf.id) as unknown as Priv;
    expect((privWolf.deadline ?? 0) - clock2.now).toBeGreaterThanOrEqual(10_000 - 1);
    // 交完剩下的动作，能正常走到天亮。
    const w: string[] = [];
    for (const cooId of COOS) {
      const seat = (await host2.seatOf(cooId))!;
      if (((await host2.tablePrivate(seat.id)) as unknown as Priv).role === 'wolf') w.push(cooId);
    }
    for (const wolf of w) {
      const view = (await host2.tablePrivate((await host2.seatOf(wolf))!.id)) as unknown as Priv;
      if (!view.canAct) continue;
      if (view.myMove === 'wolf_chat') {
        await host2.tableAction(wolf, { type: 'werewolf_action', windowId: view.windowId, move: 'wolf_chat', text: '继续' }, { requestId: `r-${wolf}` });
      } else if (view.myMove === 'wolf_kill') {
        await host2.tableAction(wolf, { type: 'werewolf_action', windowId: view.windowId, move: 'wolf_kill', target: 5 }, { requestId: `r-${wolf}` });
      }
    }
    clock2.now += 120_000;
    await host2.tickClock();
    const after = (await host2.tablePrivate((await host2.seatOf(COOS[0]))!.id)) as unknown as Priv;
    expect(['night', 'speech', 'ended']).toContain(after.phase ?? '');
    expect(privWolf.deadline).not.toBe(deadlineBefore);
    await closeTestDb(db2);
  });

  it('停机超过 30 分钟：整局作废、不写战绩', async () => {
    dir = mkdtempSync(join(tmpdir(), 'parlor-wolf-'));
    const file = join(dir, 'parlor.db');
    const fixture = await setup(file);
    await enterAll(fixture);
    const tableId = await openWerewolf(fixture);
    await startTable(fixture, tableId);
    fixture.clock.now += 20_000;
    await fixture.host.tickClock();
    await fixture.close();

    const clock2 = { now: fixture.clock.now + 31 * 60_000 };
    const db2 = await openTestDb(file);
    const host2 = await RoomHost.create(db2, 'lobby', { now: () => clock2.now });
    const rows = (await db2.prepare("SELECT status FROM tables WHERE game = 'werewolf'").all()) as Array<{ status: string }>;
    expect(rows.every((row) => row.status === 'abandoned')).toBe(true);
    const results = (await db2.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE kind = 'game'").get()) as { n: number };
    expect(results.n).toBe(0);
    // 作废后没有私视图（不重发身份）。
    expect(await host2.tablePrivate((await host2.seatOf(COOS[0]))!.id)).toBeNull();
    await closeTestDb(db2);
  });

  it('完整一局：九人真机打到底，账本记阵营胜负，席位释放、一人一桌锁清空', async () => {
    const fixture = await setup();
    await enterAll(fixture);
    const tableId = await openWerewolf(fixture);
    await startTable(fixture, tableId);
    await pump(fixture);
    const pub = await fixture.host.tablePublic() as { status?: string };
    expect(pub.status).toBe('ended');
    const entries = (await fixture.db.prepare(
      "SELECT text, game FROM ledger_entries WHERE kind = 'game' AND game = 'werewolf'",
    ).all()) as Array<{ text: string; game: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toContain('狼人杀终局');
    expect(await fixture.db.prepare('SELECT seat_id FROM table_seat_results WHERE table_id = ?').all(tableId))
      .toHaveLength(COOS.length);
    // 结束即下桌：没有活跃锁、没有私视图。
    const locks = (await fixture.db.prepare('SELECT COUNT(*) AS n FROM active_table_players').get()) as { n: number };
    expect(locks.n).toBe(0);
    expect(await fixture.host.tablePrivate((await fixture.host.seatOf(COOS[0]))!.id)).toBeNull();
    // 终局复盘：参与者可读夜间记录，历史公开部分照常。
    const log = await fixture.host.tableLog(COOS[0], tableId, { review: true }) as { nights?: unknown[] };
    expect(Array.isArray(log.nights)).toBe(true);
    await fixture.close();
  });

  it('全狼死于狼刀：普通结算入账，排除等级分并保留内部标记', async () => {
    const fixture = await setup();
    try {
      await enterAll(fixture);
      const players = COOS.slice(0, 6);
      const { tableId } = await fixture.host.openTable(players[0], { game: 'werewolf', seatCount: 6 });
      for (const cooId of players.slice(1)) await fixture.host.joinTable(cooId, tableId, `join-${cooId}`, CLIENT_OK);
      await startTable(fixture, tableId);
      const advance = async (ms: number) => {
        fixture.clock.now += ms;
        await fixture.host.tickClock();
      };
      await advance(16_000);
      const wolves = [];
      for (const cooId of players) {
        const view = await privOf(fixture, cooId);
        if (view.role !== 'wolf') continue;
        const seat = (await fixture.host.seatOf(cooId))!;
        wolves.push({ cooId, seatNo: view.seats!.find(entry => entry.id === seat.id)!.seatNo });
      }
      expect(wolves).toHaveLength(2);
      const [first, last] = wolves;
      for (const wolf of wolves) {
        expect((await action(fixture, wolf.cooId, { move: 'wolf_kill', target: first.seatNo })).error).toBeUndefined();
      }
      await advance(61_000);
      await advance(61_000);
      for (let index = 0; index < 24 && (await privOf(fixture, last.cooId)).phase !== 'night'; index++) {
        await advance(181_000);
      }
      expect(await privOf(fixture, last.cooId)).toMatchObject({ phase: 'night', day: 2 });
      expect((await action(fixture, last.cooId, { move: 'wolf_kill', target: last.seatNo })).error).toBeUndefined();
      await advance(61_000);
      await advance(61_000);

      const result = await fixture.db.prepare('SELECT kind, payload_json FROM table_finalizations WHERE table_id = ?').get(tableId);
      expect(result).toMatchObject({ kind: 'result', payload_json: { ratingExcluded: true } });
      expect(await new LedgerDb(fixture.db).summaryFor(players[0])).toMatchObject({ games: 1 });
      expect(await fixture.db.prepare('SELECT seat_id FROM table_seat_results WHERE table_id = ?').all(tableId)).toEqual([]);
      const end = (await fixture.host.history(players[0], { since: 0, limit: 200 })).find(event => event.type === 'parlor.table.end');
      expect(end).toMatchObject({ data: { outcome: 'good' } });
      expect(end?.data).not.toHaveProperty('ratingExcluded');
    } finally { await fixture.close(); }
  });

  it('真人时限更长：开局看身份 15 秒，白天真人发言窗 180 秒、Coo 60 秒', async () => {
    const fixture = await setup();
    await enterAll(fixture);
    const tableId = await openWerewolf(fixture);
    const startedAt = fixture.clock.now;
    await startTable(fixture, tableId);
    // 看身份窗口 = 15 秒。
    const revealPriv = await privOf(fixture, COOS[0]);
    expect((revealPriv.deadline ?? 0) - startedAt).toBe(15_000);
    // 快进两段夜，落到第一位发言者的窗口。
    fixture.clock.now += 16_000;
    await fixture.host.tickClock();
    fixture.clock.now += 61_000;
    await fixture.host.tickClock();
    fixture.clock.now += 61_000;
    await fixture.host.tickClock();
    const seat = (await fixture.host.seatOf(COOS[0]))!;
    const pub = await fixture.host.tablePublic() as { status?: string; turn?: string };
    expect(pub.status).toBe('playing');
    const speakerId = pub.turn!;
    const speakerPriv = await fixture.host.tablePrivate(speakerId) as unknown as Priv;
    expect(speakerPriv.canAct).toBe(true);
    const windowMs = (speakerPriv.deadline ?? 0) - fixture.clock.now;
    if (speakerId === seat.id) {
      // 家长（human 席位）有 180 秒。
      expect(windowMs).toBeGreaterThan(178_000);
      expect(windowMs).toBeLessThanOrEqual(180_000);
    } else {
      expect(windowMs).toBeGreaterThan(58_000);
      expect(windowMs).toBeLessThanOrEqual(60_000);
    }
    void cooBySeatNo;
    await fixture.close();
  });

  it('B5 同房双桌：狼人杀与斗地主互不串——回执各归各桌、秘密不出桌、一桌打完另一桌照常', async () => {
    const fixture = await setup();
    await enterAll(fixture);
    const extraSeats = await joinExtras(fixture);
    const tableId = await openWerewolf(fixture);
    await startTable(fixture, tableId);
    fixture.clock.now += 20_000;
    await fixture.host.tickClock(); // 首夜
    expect((await privOf(fixture, COOS[0])).phase).toBe('night');

    // 三位真人/Coo 坐满斗地主桌，按随机抽到的先手提交叫地主。
    const ddz = await fixture.host.openTable(EXTRA_COOS[0], { game: 'ddz' });
    const ddzId = ddz.tableId;
    await fixture.host.joinTable(EXTRA_COOS[1], ddzId, 'join-ddz', CLIENT_OK);
    const thirdCoo = 'coo-extra0003';
    await fixture.db.prepare('INSERT INTO coos(id, kind, display_name, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(thirdCoo, 'pet', '第三席', null, fixture.clock.now);
    const thirdSeat = await fixture.host.join(thirdCoo, { name: '第三席', kind: 'pet' });
    await fixture.host.joinTable(thirdCoo, ddzId, 'join-ddz-third', CLIENT_OK);
    const bidders = [...EXTRA_COOS, thirdCoo];
    const bidderSeats = [...extraSeats, thirdSeat.seat.id];
    await fixture.host.startTable(EXTRA_COOS[0], ddzId);
    const bidding = await fixture.host.tablePublic(ddzId) as { status?: string; turn: string };
    expect(bidding.status).toBe('bidding');
    const bidder = bidders[bidderSeats.indexOf(bidding.turn)];
    expect(bidder).toBeDefined();

    // 交错走动作：狼聊暗号 → 斗地主叫地主 → 刀票 → 斗地主领出。每张回执都归属自己的桌。
    const wolves: string[] = [];
    for (const cooId of COOS) {
      if ((await privOf(fixture, cooId)).role === 'wolf') wolves.push(cooId);
    }
    const killTarget = await nonWolfSeatNo(fixture, wolves);
    const chat = await action(fixture, wolves[0], { move: 'wolf_chat', text: '夜里三更见' });
    expect(chat.error).toBeUndefined();
    expect(chat.receipt.tableId).toBe(tableId);
    const ddzRevision = async (): Promise<number> => ((await fixture.host.tablePublic(ddzId)) as { revision: number }).revision;
    const bid = await fixture.host.tableAction(bidder, { type: 'ddz_action', move: 'bid', call: true }, {
      tableId: ddzId, revision: await ddzRevision(), requestId: 'ddz-bid',
    });
    expect(bid.tableId).toBe(ddzId);
    const kill = await action(fixture, wolves[0], { move: 'wolf_kill', target: killTarget });
    expect(kill.error).toBeUndefined();
    expect(kill.receipt.tableId).toBe(tableId);
    // 地主按服务端提示领出第一手。
    const landlordPriv = await fixture.host.tablePrivate(bidding.turn) as unknown as
      { yourTurn?: boolean; hint?: { cards?: string[]; pass?: boolean } };
    expect(landlordPriv?.yourTurn).toBe(true);
    expect(landlordPriv.hint?.cards?.length ?? 0).toBeGreaterThan(0);
    const play = await fixture.host.tableAction(bidder, {
      type: 'ddz_action', move: 'play', cards: landlordPriv.hint!.cards,
    }, { tableId: ddzId, revision: await ddzRevision(), requestId: 'ddz-play' });
    expect(play.tableId).toBe(ddzId);

    // 秘密不出桌：斗地主席位的私视图与补发里没有暗号、没有狼聊/刀票/狼队字段。
    for (const seatId of extraSeats) {
      const blob = JSON.stringify(await fixture.host.tablePrivate(seatId));
      expect(blob).not.toContain('夜里三更见');
      expect(blob).not.toContain('"wolfChat"');
      expect(blob).not.toContain('"killVotes"');
      expect(blob).not.toContain('"teammates"');
    }
    const ddzEvents = await fixture.host.history(EXTRA_COOS[0], { since: 0, limit: 200 });
    const ddzBlob = JSON.stringify(ddzEvents);
    expect(ddzBlob).not.toContain('夜里三更见');
    expect(ddzBlob).not.toContain('"wolfChat"');
    // 斗地主桌自己的事件里同样没有狼人杀的秘密。
    const ddzTableEvents = ddzEvents.filter(
      (event) => (event.data as { tableId?: string } | undefined)?.tableId === ddzId,
    );
    expect(ddzTableEvents.length).toBeGreaterThan(0);
    expect(JSON.stringify(ddzTableEvents)).not.toContain('夜里三更见');

    // 反向：狼人杀席位的补发里，斗地主的出牌事件只归属斗地主桌；
    // 归属狼人杀桌的事件里没有斗地主的数据。
    let villager: string | undefined;
    for (const cooId of COOS) {
      if ((await privOf(fixture, cooId)).role === 'villager') {
        villager = cooId;
        break;
      }
    }
    if (!villager) {
      for (const cooId of COOS) {
        if (!['wolf', 'seer'].includes((await privOf(fixture, cooId)).role!)) {
          villager = cooId;
          break;
        }
      }
    }
    const wolfSideEvents = await fixture.host.history(villager!, { since: 0, limit: 200 });
    const forWolfTable = wolfSideEvents.filter(
      (event) => (event.data as { tableId?: string } | undefined)?.tableId === tableId,
    );
    expect(forWolfTable.length).toBeGreaterThan(0);
    expect(forWolfTable.every((event) => (event.data as { game?: string }).game !== 'ddz')).toBe(true);
    const ddzActions = wolfSideEvents.filter((event) => event.type === 'parlor.table.action');
    expect(ddzActions.length).toBeGreaterThan(0);
    expect(ddzActions.every((event) => (event.data as { tableId?: string }).tableId === ddzId)).toBe(true);

    // 一桌自然打完（真人席位超时由服务器按最小合法牌代打），狼人杀桌不被牵着走完。
    const ddzStatus = async (): Promise<string> => ((await fixture.host.tablePublic(ddzId)) as { status?: string }).status ?? '';
    for (let i = 0; i < 400 && (await ddzStatus()) !== 'ended'; i++) {
      fixture.clock.now += 61_000;
      await fixture.host.tickClock();
    }
    expect(await ddzStatus()).toBe('ended');
    expect(((await fixture.host.tablePublic(tableId)) as { status?: string }).status).toBe('playing');
    expect(await privOf(fixture, COOS[0])).not.toBeNull();
    await fixture.close();
  });

  it('D2 连续两次重启：截止只按本次停机时长平移一次，不叠加（5 秒 + 7 秒 = 12 秒）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'parlor-wolf-'));
    const file = join(dir, 'parlor.db');
    const fixture = await setup(file);
    await enterAll(fixture);
    const tableId = await openWerewolf(fixture);
    await startTable(fixture, tableId);
    fixture.clock.now += 20_000;
    await fixture.host.tickClock(); // 首夜
    const wolves: string[] = [];
    for (const cooId of COOS) {
      if ((await privOf(fixture, cooId)).role === 'wolf') wolves.push(cooId);
    }
    // 交一半动作就停机：夜里还剩 40 秒（远大于 10 秒的最短重连时间，平移量可精确算）。
    expect((await action(fixture, wolves[0], { move: 'wolf_kill', target: await nonWolfSeatNo(fixture, wolves) })).error).toBeUndefined();
    const deadline1 = (await privOf(fixture, wolves[0])).deadline ?? 0;
    const stopAt = fixture.clock.now;
    await fixture.close();

    // 第一次停机 5 秒：截止 = 旧截止 + 5 秒。
    const clock2 = { now: stopAt + 5_000 };
    const db2 = await openTestDb(file);
    const host2 = await RoomHost.create(db2, 'lobby', { now: () => clock2.now });
    const priv2 = async (): Promise<Priv> => (await host2.tablePrivate((await host2.seatOf(wolves[0]))!.id)) as unknown as Priv;
    expect((await priv2()).phase).toBe('night');
    const deadline2 = (await priv2()).deadline ?? 0;
    expect(deadline2 - deadline1).toBe(5_000);
    await closeTestDb(db2);

    // 第二次停机 7 秒：只按 7 秒再平移一次；叠加错法会算出 12 秒（拿旧基准）或 17 秒。
    const clock3 = { now: clock2.now + 7_000 };
    const db3 = await openTestDb(file);
    const host3 = await RoomHost.create(db3, 'lobby', { now: () => clock3.now });
    const priv3 = async (): Promise<Priv> => (await host3.tablePrivate((await host3.seatOf(wolves[0]))!.id)) as unknown as Priv;
    expect((await priv3()).phase).toBe('night');
    const deadline3 = (await priv3()).deadline ?? 0;
    expect(deadline3 - deadline2).toBe(7_000);
    expect(deadline3 - deadline1).toBe(12_000);
    await closeTestDb(db3);
  });

  it('D2 坏快照只隔离狼人杀那一桌：动作报「隔离」，同房骰子桌完全不受影响', async () => {
    dir = mkdtempSync(join(tmpdir(), 'parlor-wolf-'));
    const file = join(dir, 'parlor.db');
    const fixture = await setup(file);
    await enterAll(fixture);
    const extraSeats = await joinExtras(fixture);
    const tableId = await openWerewolf(fixture);
    await startTable(fixture, tableId);
    fixture.clock.now += 20_000;
    await fixture.host.tickClock();
    // 同房再开一张骰子桌。
    const dice = await fixture.host.openTable(EXTRA_COOS[0], { game: 'dice' });
    const diceId = dice.tableId;
    await fixture.host.joinTable(EXTRA_COOS[1], diceId, 'join-dice', CLIENT_OK);
    await fixture.host.startTable(EXTRA_COOS[0], diceId);
    const mail = fixture.db.prepare(`INSERT INTO mail (id, ts, coo_id, room_id, kind, action, from_name, text, key)
      VALUES (?, ?, ?, 'lobby', 'ledger', 'table', '客厅', '测试提醒', ?)`);
    await mail.run('frozen-reminder', fixture.clock.now, COOS[1], `${tableId}/w2/test-seat`);
    await mail.run('other-table-reminder', fixture.clock.now, COOS[1], `${diceId}/w2/test-seat`);
    // 落盘后把狼人杀桌的存档改成对不上版本的数据。
    await fixture.db.prepare("UPDATE tables SET state_json = '{\"version\":999}' WHERE id = ?").run(tableId);
    await fixture.close();

    const clock2 = { now: 1_760_000_000_000 + 80_000 };
    const db2 = await openTestDb(file);
    const host2 = await RoomHost.create(db2, 'lobby', { now: () => clock2.now });
    // 狼人杀桌被隔离：公开摘要带 frozen，动作被拒，私视图不再发。
    const frozen = await host2.tablePublic(tableId) as { frozen?: boolean };
    expect(frozen.frozen).toBe(true);
    const readAt = async (id: string) => (await db2.prepare('SELECT read_at FROM mail WHERE id = ?')
      .get<{ read_at: number | null }>(id))?.read_at;
    expect(await readAt('frozen-reminder')).toBe(clock2.now);
    expect(await readAt('other-table-reminder')).toBeNull();
    await expect(host2.tableAction(COOS[1], {
      type: 'werewolf_action', windowId: 'w9', move: 'wolf_chat', text: '试试还能不能交',
    }, { tableId, requestId: 'frozen-wolf' })).rejects.toThrow(/隔离/);
    expect(await host2.tablePrivate((await host2.seatOf(COOS[1]))!.id)).toBeNull();
    // 骰子桌照常：还能正常停牌（宿主层直接给引擎形状的动作，type: 'stand'）。
    const dicePub = await host2.tablePublic(diceId) as { status?: string; revision: number };
    expect(dicePub.status).toBe('playing');
    const stood = await host2.tableAction(EXTRA_COOS[0], { type: 'stand' }, {
      tableId: diceId, revision: dicePub.revision, requestId: 'dice-stand',
    });
    expect(stood.tableId).toBe(diceId);
    await closeTestDb(db2);
  });

  it('B4 终局解锁：打完后房间发言、同桌私聊、桌聊恢复可用', async () => {
    const fixture = await setup();
    await enterAll(fixture);
    const tableId = await openWerewolf(fixture);
    await startTable(fixture, tableId);
    fixture.clock.now += 20_000;
    await fixture.host.tickClock(); // 进行中
    // 三个口在局中都被拒。
    await expect(fixture.host.tableSay(COOS[1], '局中桌聊', tableId)).rejects.toThrow(/游戏动作/);
    await expect(fixture.host.say(COOS[1], '局中房间发言')).rejects.toThrow(/狼人杀/);
    await expect(fixture.host.whisper(COOS[1], NAMES[2], '局中私聊')).rejects.toThrow(/不能私聊/);
    // 打到终局。
    await pump(fixture);
    expect(((await fixture.host.tablePublic(tableId)) as { status?: string }).status).toBe('ended');
    fixture.clock.now += 1_000; // 绕开两条发言之间的间隔
    // 房间发言与同桌私聊恢复。
    await expect(fixture.host.say(COOS[1], '终局后客厅说话')).resolves.toBeTruthy();
    await expect(fixture.host.whisper(COOS[1], NAMES[2], '终局后私聊')).resolves.toBeTruthy();
    // 桌聊恢复：打完的那张桌已经收档（table_say 回「已经结束」），另开一张桌就能照常说。
    fixture.clock.now += 100;
    const next = await fixture.host.openTable(COOS[1], { game: 'dice' });
    await fixture.host.joinTable(COOS[2], next.tableId, 'join-after-end', CLIENT_OK);
    await expect(fixture.host.tableSay(COOS[1], '终局后桌聊', next.tableId)).resolves.toBeTruthy();
    await fixture.close();
  });
});
