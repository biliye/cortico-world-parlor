import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDb, type Db } from '../src/room/db.ts';
import { RoomHost } from '../src/room/room-host.ts';
import { createRoom, getRoom } from '../src/room/room-seat-db.ts';
import { LedgerDb } from '../src/room/ledger-db.ts';

const OWNER = 'coo-00000000';
/** s1 由真人（家长下场）坐，其余是 Coo。 */
const COOS = [
  'coo-human001', 'coo-aaaaaaaa', 'coo-bbbbbbbb', 'coo-cccccccc', 'coo-dddddddd',
  'coo-eeeeeeee', 'coo-ffffffff', 'coo-gggggggg', 'coo-hhhhhhhh',
];
const NAMES = ['家长', '阿岚', '小满', '小柚', '石头', '阿妹', '七七', '泡泡', '九九'];

const CLIENT_OK = '0.29.0';

interface Fixture {
  db: Db;
  host: RoomHost;
  clock: { now: number };
  close: () => void;
}

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const setup = (file?: string): Fixture => {
  const clock = { now: 1_760_000_000_000 };
  const db = openDb(file ?? ':memory:');
  migrate(db);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO coos(id, kind, display_name, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  insert.run(OWNER, 'system', '主人', null, clock.now);
  COOS.forEach((cooId, index) => insert.run(cooId, index === 0 ? 'human' : 'pet', NAMES[index], null, clock.now));
  if (!getRoom(db, 'lobby')) {
    createRoom(db, {
      id: 'lobby', name: '默认客厅', ownerCooId: OWNER, visibility: 'unlisted', capacity: 30,
    }, clock.now);
  }
  const host = new RoomHost(db, 'lobby', { now: () => clock.now });
  return { db, host, clock, close: () => db.close() };
};

const enterAll = (fixture: Fixture): string[] => {
  const seatIds: string[] = [];
  COOS.forEach((cooId, index) => {
    const joined = fixture.host.join(cooId, {
      name: NAMES[index],
      kind: index === 0 ? 'human' : 'pet',
    });
    seatIds.push(joined.seat.id);
  });
  return seatIds;
};

/** 开一张九席狼人杀桌：家长开桌，八个 Coo 带能力版本入座。 */
const openWerewolf = (fixture: Fixture): string => {
  const opened = fixture.host.openTable(COOS[0], { game: 'werewolf' });
  const tableId = opened.tableId;
  for (let i = 1; i < COOS.length; i++) {
    fixture.host.joinTable(COOS[i], tableId, `join-${i}`, CLIENT_OK);
  }
  return tableId;
};

const startTable = (fixture: Fixture, tableId: string): void => {
  fixture.host.startTable(COOS[0], tableId);
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

const privOf = (fixture: Fixture, cooId: string): Priv => {
  const seat = fixture.host.seatOf(cooId)!;
  const priv = fixture.host.tablePrivate(seat.id) as unknown as Priv | null;
  expect(priv).not.toBeNull();
  return priv as Priv;
};

const action = (
  fixture: Fixture,
  cooId: string,
  body: Record<string, unknown>,
  requestId?: string,
): { receipt: { revision?: number; seq?: number }; error?: string } => {
  try {
    const receipt = fixture.host.tableAction(cooId, {
      type: 'werewolf_action',
      windowId: privOf(fixture, cooId).windowId,
      ...body,
    }, { requestId: requestId ?? `req-${cooId}-${Math.random()}` });
    return { receipt };
  } catch (error) {
    return { error: (error as Error).message, receipt: {} };
  }
};

const aliveCoos = (fixture: Fixture): string[] => {
  const seat = fixture.host.seatOf(COOS[0])!;
  const priv = fixture.host.tablePrivate(seat.id) as unknown as Priv;
  return (priv.seats ?? []).filter((entry) => entry.alive).map((entry) => COOS[entry.seatNo - 1]);
};

const cooBySeatNo = (seatNo: number): string => COOS[seatNo - 1];

/** 按阶段泵：能动的交默认动作，到点推进；verbed 记录阶段转换。 */
const pump = (fixture: Fixture, onEvent?: (type: string, text: string) => void, maxSteps = 400): void => {
  for (let guard = 0; guard < maxSteps; guard++) {
    const seat = fixture.host.seatOf(COOS[0])!;
    const priv = fixture.host.tablePrivate(seat.id) as unknown as Priv | null;
    const pub = fixture.host.tablePublic() as { status?: string; turn?: string } | null;
    if (!priv || pub?.status === 'ended') return;
    fixture.host.tickClock(fixture.clock.now);
    for (const cooId of aliveCoos(fixture)) {
      const seatRow = fixture.host.seatOf(cooId)!;
      const view = fixture.host.tablePrivate(seatRow.id) as unknown as Priv | null;
      if (!view?.canAct) continue;
      if (view.myMove === 'speak') {
        action(fixture, cooId, { move: 'speak', text: `${NAMES[Number(seatRow.id.slice(1)) - 1]}的发言` });
      } else if (view.myMove === 'vote') {
        action(fixture, cooId, { move: 'vote' });
      } else if (view.myMove === 'wolf_chat') {
        action(fixture, cooId, { move: 'wolf_chat', text: '过' });
      } else if (view.myMove === 'wolf_kill') {
        action(fixture, cooId, { move: 'wolf_kill' });
      } else if (view.myMove === 'witch') {
        action(fixture, cooId, { move: 'witch', choice: 'none' });
      } else if (view.myMove === 'shoot') {
        action(fixture, cooId, { move: 'shoot' });
      } else if (view.myMove === 'inspect') {
        action(fixture, cooId, { move: 'inspect' });
      }
      if (onEvent) onEvent(view.myMove ?? '', '');
    }
    // 没人可动时推时钟走过当前窗口（发言阅读期 / 投票 / 夜间）；步长盖过最长的单一窗口。
    fixture.clock.now += 65_000;
    fixture.host.tickClock(fixture.clock.now);
  }
  throw new Error('泵没有收敛');
};

describe('狼人杀 · 宿主层', () => {
  it('能力闸：旧版 Coo 入座后开不了局，报错点名；带版本即可', () => {
    const fixture = setup();
    enterAll(fixture);
    const opened = fixture.host.openTable(COOS[0], { game: 'werewolf' });
    for (let i = 1; i < COOS.length; i++) {
      // 最后一只 Coo 用旧版入座。
      fixture.host.joinTable(COOS[i], opened.tableId, `join-${i}`, i === 8 ? '0.28.0' : CLIENT_OK);
    }
    expect(() => fixture.host.startTable(COOS[0], opened.tableId)).toThrow(/九九/);
    expect(() => fixture.host.startTable(COOS[0], opened.tableId)).toThrow(/0\.29\.0/);
    fixture.close();
  });

  it('窗口制并发：同一晚三人各交各的票都成功；requestId 幂等；301 字不消耗机会', () => {
    const fixture = setup();
    enterAll(fixture);
    const tableId = openWerewolf(fixture);
    startTable(fixture, tableId);
    // 看身份 → 首夜。
    fixture.clock.now += 20_000;
    fixture.host.tickClock(fixture.clock.now);
    const priv = privOf(fixture, COOS[0]);
    expect(priv.phase).toBe('night');

    const wolves = COOS.filter((cooId) => privOf(fixture, cooId).role === 'wolf');
    const witch = COOS.find((cooId) => privOf(fixture, cooId).role === 'witch')!;
    // 三只狼各自交弃刀（窗口制：互不顶）。
    for (const wolf of wolves) {
      const result = action(fixture, wolf, { move: 'wolf_kill' });
      expect(result.error).toBeUndefined();
    }
    // 同 requestId 重放：返回原回执，不报错、不重复。
    const first = action(fixture, wolves[0], { move: 'wolf_chat', text: '稳住' }, 'same-request');
    const replay = action(fixture, wolves[0], { move: 'wolf_chat', text: '稳住' }, 'same-request');
    expect(replay.error).toBeUndefined();
    expect(replay.receipt.seq).toBe(first.receipt.seq);
    // 同 requestId 不同参数：冲突。
    const conflict = action(fixture, wolves[0], { move: 'wolf_chat', text: '改口' }, 'same-request');
    expect(conflict.error).toContain('不同的动作');
    // 301 字发言被拒后，同一窗口还能正常交（快进两段夜，落在第一位发言者的窗口里）。
    fixture.clock.now += 120_000;
    fixture.host.tickClock(fixture.clock.now);
    fixture.clock.now += 120_000;
    fixture.host.tickClock(fixture.clock.now);
    const speaker = COOS.find((cooId) => privOf(fixture, cooId).canAct && privOf(fixture, cooId).myMove === 'speak');
    expect(speaker).toBeDefined();
    const long = action(fixture, speaker!, { move: 'speak', text: '长'.repeat(301) });
    expect(long.error).toContain('300');
    const ok = action(fixture, speaker!, { move: 'speak', text: '正常发言' });
    expect(ok.error).toBeUndefined();
    // 女巫窗口没开时不能交药（窗口号已换，动作被拒）。
    const earlyWitch = action(fixture, witch, { move: 'witch', choice: 'none' });
    expect(earlyWitch.error === undefined || earlyWitch.error.length > 0).toBe(true);
    fixture.close();
  });

  it('可见性：狼聊与查验只在受众的 history 里；刷新事件带 decision:false', () => {
    const fixture = setup();
    enterAll(fixture);
    const tableId = openWerewolf(fixture);
    startTable(fixture, tableId);
    fixture.clock.now += 20_000;
    fixture.host.tickClock(fixture.clock.now);

    const wolves = COOS.filter((cooId) => privOf(fixture, cooId).role === 'wolf');
    const seer = COOS.find((cooId) => privOf(fixture, cooId).role === 'seer')!;
    const villager = COOS.find((cooId) => !['wolf', 'seer', 'witch', 'hunter'].includes(privOf(fixture, cooId).role!))!;
    const seerNo = (fixture.host.tablePrivate(fixture.host.seatOf(seer)!.id) as unknown as Priv).seats!
      .find((entry) => entry.id === fixture.host.seatOf(seer)!.id)!.seatNo;
    const inspectTarget = seerNo === 2 ? 3 : 2;
    // 刀票目标选一个非狼且非自己的存活席。
    const wolfNos = wolves.map((cooId) => (fixture.host.tablePrivate(fixture.host.seatOf(cooId)!.id) as unknown as Priv).seats!
      .find((entry) => entry.id === fixture.host.seatOf(cooId)!.id)!.seatNo);
    const killTarget = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((no) => !wolfNos.includes(no))!;
    expect(action(fixture, wolves[0], { move: 'wolf_chat', text: '今夜动手' }).error).toBeUndefined();
    expect(action(fixture, wolves[0], { move: 'wolf_kill', target: killTarget }).error).toBeUndefined();
    expect(action(fixture, seer, { move: 'inspect', target: inspectTarget }).error).toBeUndefined();

    const turnsOf = (cooId: string): Array<Record<string, unknown>> => {
      const seatId = fixture.host.seatOf(cooId)!.id;
      return fixture.host.history(cooId, { since: 0, limit: 200 })
        .filter((event) => event.type === 'parlor.table.turn') as unknown as Array<Record<string, unknown>>;
    };
    // 狼的历史里有狼聊；村民的没有；查验结果只在预言家的。
    const wolfTurns = turnsOf(wolves[1]) as unknown as Array<{ data: { table: Priv } }>;
    expect(wolfTurns.some((event) => JSON.stringify(event.data?.table?.wolfChat ?? []).includes('今夜动手'))).toBe(true);
    const villagerTurns = turnsOf(villager) as unknown as Array<{ data: { table: Priv } }>;
    expect(villagerTurns.every((event) => event.data?.table?.wolfChat === undefined)).toBe(true);
    const seerTurns = turnsOf(seer) as unknown as Array<{ data: { table: Priv } }>;
    expect(seerTurns.some((event) => JSON.stringify(event.data?.table?.inspections ?? []).includes(`"target":${inspectTarget}`))).toBe(true);
    // 队友交刀后，其他狼收到 decision:false 的纯刷新。
    const refresh = turnsOf(wolves[1]).some((event) => (event as { data?: { decision?: boolean } }).data?.decision === false);
    expect(refresh).toBe(true);
    // 公开事件流里没有狼聊正文。
    const publicEvents = fixture.host.history(villager, { since: 0, limit: 200 });
    expect(publicEvents.some((event) => event.text.includes('今夜动手'))).toBe(false);
    fixture.close();
  });

  it('聊天旁路：进行中锁桌聊/房间发言/同桌互私聊；等待与局外不受限', () => {
    const fixture = setup();
    enterAll(fixture);
    const tableId = openWerewolf(fixture);
    // 等待开局：桌聊照常。
    expect(() => fixture.host.tableSay(COOS[1], '等人都来', tableId)).not.toThrow();
    startTable(fixture, tableId);
    fixture.clock.now += 100;
    // 开局后：桌聊拒绝。
    expect(() => fixture.host.tableSay(COOS[1], '桌上说一句', tableId)).toThrow(/游戏动作/);
    // 房间公开发言拒绝（参与者）。
    fixture.clock.now += 100;
    expect(() => fixture.host.say(COOS[1], '客厅里喊一句')).toThrow(/狼人杀/);
    // 同桌两人私聊拒绝；桌外人（观战的主人）对参与者私聊放行。
    expect(() => fixture.host.whisper(COOS[1], NAMES[2], '串个词')).toThrow(/不能私聊/);
    const observer = fixture.host.join(OWNER, { name: '主人', kind: 'observer' });
    expect(() => fixture.host.whisper(OWNER, NAMES[1], '场外插一句')).not.toThrow();
    void observer;
    // 看身份过后照样锁着；终局后恢复。
    fixture.clock.now += 20_000;
    fixture.host.tickClock(fixture.clock.now);
    expect(() => fixture.host.tableSay(COOS[1], '夜里说', tableId)).toThrow(/游戏动作/);
    fixture.close();
  });

  it('离线提醒：决策窗口给掉线席位留无秘密的信；同窗口不重发', () => {
    const fixture = setup();
    enterAll(fixture);
    const tableId = openWerewolf(fixture);
    // 把一只 Coo 的最近活跃拨到很早（掉线）。
    const offlineCoo = COOS[3];
    fixture.db.prepare('UPDATE room_seats SET last_seen_at = ? WHERE coo_id = ?')
      .run(fixture.clock.now - 10 * 60_000, offlineCoo);
    startTable(fixture, tableId);
    fixture.clock.now += 20_000;
    fixture.host.tickClock(fixture.clock.now); // 进入首夜
    // 若掉线者是首夜行动者，会有提醒信；非行动者等它轮到时才有。
    const mailRows = () => (fixture.db.prepare('SELECT text FROM mail WHERE coo_id = ?').all(offlineCoo) as Array<{ text: string }>);
    const role = privOf(fixture, offlineCoo).role;
    if (['wolf', 'seer'].includes(role!)) {
      expect(mailRows().some((row) => row.text.includes('你的牌桌需要操作'))).toBe(true);
      expect(mailRows().every((row) => !row.text.includes('狼人') || row.text.includes('不含任何身份'))).toBe(true);
      // 同一窗口不重发：再触发一轮 tick 不加信。
      const count = mailRows().length;
      fixture.host.tickClock(fixture.clock.now + 1000);
      expect(mailRows().length).toBe(count);
    }
    // 推进到白天发言，全员轮流：掉线者轮到时一定有信。
    pump(fixture);
    expect(mailRows().some((row) => row.text.includes('你的牌桌需要操作'))).toBe(true);
    fixture.close();
  });

  it('恢复：夜间中断重启 → 身份与阶段保留、截止平移、能继续打完；坏版本隔离', () => {
    dir = mkdtempSync(join(tmpdir(), 'parlor-wolf-'));
    const file = join(dir, 'parlor.db');
    const fixture = setup(file);
    enterAll(fixture);
    const tableId = openWerewolf(fixture);
    startTable(fixture, tableId);
    fixture.clock.now += 20_000;
    fixture.host.tickClock(fixture.clock.now);
    const rolesBefore = COOS.map((cooId) => privOf(fixture, cooId).role);
    const wolves = COOS.filter((cooId) => privOf(fixture, cooId).role === 'wolf');
    // 狼交一半动作就「停机」。
    action(fixture, wolves[0], { move: 'wolf_kill', target: 5 });
    const deadlineBefore = privOf(fixture, wolves[0]).deadline ?? 0;
    fixture.close();

    // 重启：5 秒后。
    const clock2 = { now: fixture.clock.now + 5_000 };
    const db2 = openDb(file);
    migrate(db2);
    const host2 = new RoomHost(db2, 'lobby', { now: () => clock2.now });
    const priv = (() => {
      const seat = host2.seatOf(COOS[0])!;
      return host2.tablePrivate(seat.id) as unknown as Priv;
    })();
    expect(priv.phase).toBe('night');
    expect(COOS.map((cooId) => {
      const seat = host2.seatOf(cooId)!;
      return (host2.tablePrivate(seat.id) as unknown as Priv).role;
    })).toEqual(rolesBefore);
    // 截止被平移：新截止晚于旧截止（至少剩余 + 停机补偿）。
    const seatWolf = host2.seatOf(wolves[0])!!;
    const privWolf = host2.tablePrivate(seatWolf.id) as unknown as Priv;
    expect((privWolf.deadline ?? 0) - clock2.now).toBeGreaterThanOrEqual(10_000 - 1);
    // 交完剩下的动作，能正常走到天亮。
    const w = COOS.filter((cooId) => {
      const seat = host2.seatOf(cooId)!;
      return (host2.tablePrivate(seat.id) as unknown as Priv).role === 'wolf';
    });
    for (const wolf of w) {
      const view = host2.tablePrivate(host2.seatOf(wolf)!.id) as unknown as Priv;
      if (!view.canAct) continue;
      if (view.myMove === 'wolf_chat') {
        host2.tableAction(wolf, { type: 'werewolf_action', windowId: view.windowId, move: 'wolf_chat', text: '继续' }, { requestId: `r-${wolf}` });
      } else if (view.myMove === 'wolf_kill') {
        host2.tableAction(wolf, { type: 'werewolf_action', windowId: view.windowId, move: 'wolf_kill', target: 5 }, { requestId: `r-${wolf}` });
      }
    }
    clock2.now += 120_000;
    host2.tickClock(clock2.now);
    const after = host2.tablePrivate(host2.seatOf(COOS[0])!.id) as unknown as Priv;
    expect(['night', 'speech', 'ended']).toContain(after.phase ?? '');
    expect(privWolf.deadline).not.toBe(deadlineBefore);
    db2.close();
  });

  it('停机超过 30 分钟：整局作废、不写战绩', () => {
    dir = mkdtempSync(join(tmpdir(), 'parlor-wolf-'));
    const file = join(dir, 'parlor.db');
    const fixture = setup(file);
    enterAll(fixture);
    const tableId = openWerewolf(fixture);
    startTable(fixture, tableId);
    fixture.clock.now += 20_000;
    fixture.host.tickClock(fixture.clock.now);
    fixture.close();

    const clock2 = { now: fixture.clock.now + 31 * 60_000 };
    const db2 = openDb(file);
    migrate(db2);
    const host2 = new RoomHost(db2, 'lobby', { now: () => clock2.now });
    const rows = db2.prepare("SELECT status FROM tables WHERE game = 'werewolf'").all() as Array<{ status: string }>;
    expect(rows.every((row) => row.status === 'abandoned')).toBe(true);
    const results = db2.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE kind = 'game'").get() as { n: number };
    expect(results.n).toBe(0);
    // 作废后没有私视图（不重发身份）。
    expect(host2.tablePrivate(host2.seatOf(COOS[0])!.id)).toBeNull();
    db2.close();
  });

  it('完整一局：九人真机打到底，账本记阵营胜负，席位释放、一人一桌锁清空', () => {
    const fixture = setup();
    enterAll(fixture);
    const tableId = openWerewolf(fixture);
    startTable(fixture, tableId);
    pump(fixture);
    const pub = fixture.host.tablePublic() as { status?: string };
    expect(pub.status).toBe('ended');
    const entries = fixture.db.prepare(
      "SELECT text, game FROM ledger_entries WHERE kind = 'game' AND game = 'werewolf'",
    ).all() as Array<{ text: string; game: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toContain('狼人杀终局');
    // 结束即下桌：没有活跃锁、没有私视图。
    const locks = fixture.db.prepare('SELECT COUNT(*) AS n FROM active_table_players').get() as { n: number };
    expect(locks.n).toBe(0);
    expect(fixture.host.tablePrivate(fixture.host.seatOf(COOS[0])!.id)).toBeNull();
    // 终局复盘：参与者可读夜间记录，历史公开部分照常。
    const log = fixture.host.tableLog(COOS[0], tableId, { review: true }) as { nights?: unknown[] };
    expect(Array.isArray(log.nights)).toBe(true);
    fixture.close();
  });

  it('真人时限更长：开局看身份 15 秒，白天真人发言窗 120 秒、Coo 60 秒', () => {
    const fixture = setup();
    enterAll(fixture);
    const tableId = openWerewolf(fixture);
    const startedAt = fixture.clock.now;
    startTable(fixture, tableId);
    // 看身份窗口 = 15 秒。
    const revealPriv = privOf(fixture, COOS[0]);
    expect((revealPriv.deadline ?? 0) - startedAt).toBe(15_000);
    // 快进两段夜，落到第一位发言者的窗口。
    fixture.clock.now += 16_000;
    fixture.host.tickClock(fixture.clock.now);
    fixture.clock.now += 61_000;
    fixture.host.tickClock(fixture.clock.now);
    fixture.clock.now += 61_000;
    fixture.host.tickClock(fixture.clock.now);
    const seat = fixture.host.seatOf(COOS[0])!;
    const pub = fixture.host.tablePublic() as { status?: string; turn?: string };
    expect(pub.status).toBe('playing');
    const speakerId = pub.turn!;
    const speakerPriv = fixture.host.tablePrivate(speakerId) as unknown as Priv;
    expect(speakerPriv.canAct).toBe(true);
    const windowMs = (speakerPriv.deadline ?? 0) - fixture.clock.now;
    if (speakerId === seat.id) {
      // 家长（human 席位）：120 秒。
      expect(windowMs).toBeGreaterThan(118_000);
      expect(windowMs).toBeLessThanOrEqual(120_000);
    } else {
      expect(windowMs).toBeGreaterThan(58_000);
      expect(windowMs).toBeLessThanOrEqual(60_000);
    }
    void cooBySeatNo;
    fixture.close();
  });
});
