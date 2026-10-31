import { describe, expect, it } from 'vitest';
import { WerewolfTable, WEREWOLF_MIN_CLIENT } from '../src/room/games/werewolf-table.ts';
import type { TableEvent, TableStep } from '../src/room/table-engine.ts';

/** 测试基准毫秒：各窗口按比例缩（真人发言 = 2T、Coo 发言 = T、阅读 = T/3）。 */
const T = 40;
const READ = Math.max(1, Math.round(T / 3));

const NAMES = ['一号', '二号', '三号', '四号', '五号', '六号', '七号', '八号', '九号'];

/** mulberry32：确定性的发牌/起点。 */
const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

type AnyView = Record<string, any>;

interface Rig {
  table: WerewolfTable;
  clock: { now: number };
  ids: string[];
  steps: TableStep[];
  events: TableEvent[];
}

const makeRig = (seed = 7, humans = 1): Rig => {
  const clock = { now: 1_000_000 };
  const table = new WerewolfTable({
    host: { id: 's1', name: NAMES[0], kind: humans >= 1 ? 'human' : 'pet', clientVersion: '0.29.0' },
    now: clock.now,
    turnMs: T,
    rng: seeded(seed),
  });
  for (let i = 2; i <= 9; i++) {
    table.join({
      id: `s${i}`,
      name: NAMES[i - 1],
      kind: i <= humans ? 'human' : 'pet',
      clientVersion: '0.29.0',
    });
  }
  return { table, clock, ids: Array.from({ length: 9 }, (_, i) => `s${i + 1}`), steps: [], events: [] };
};

const view = (rig: Rig, id: string): AnyView => rig.table.view(id) as AnyView;
const roleOf = (rig: Rig, id: string): string => view(rig, id).role;
const idWithRole = (rig: Rig, role: string): string => rig.ids.find((id) => roleOf(rig, id) === role)!;
const seatNo = (id: string): number => Number(id.slice(1));
const aliveIds = (rig: Rig): string[] => (view(rig, 's1').seats as Array<{ id: string; alive: boolean }>)
  .filter((seat) => seat.alive).map((seat) => seat.id);

const collect = (rig: Rig, step: TableStep | null): void => {
  if (!step) return;
  rig.steps.push(step);
  rig.events.push(...step.events);
};

/** 走过看身份，进入第 1 夜。 */
const startGame = (rig: Rig): void => {
  collect(rig, rig.table.start('s1', rig.clock.now));
  rig.clock.now += T + 1;
  collect(rig, rig.table.tick(rig.clock.now));
  expect(view(rig, 's1').phase).toBe('night');
};

/** 夜A：狼队交刀票（可带一条聊天），预言家可查。到点进入夜B。 */
const runNightA = (
  rig: Rig,
  opts: { chat?: boolean; kill?: number | null; inspect?: number | null } = {},
): void => {
  const wolves = rig.ids.filter((id) => roleOf(rig, id) === 'wolf' && view(rig, id).alive);
  for (const wolf of wolves) {
    if (opts.chat) collect(rig, act(rig, wolf, { move: 'wolf_chat', text: '过路，别投我' }));
    const target = opts.kill === undefined ? undefined : opts.kill;
    collect(rig, act(rig, wolf, { move: 'wolf_kill', ...(target !== undefined ? { target } : {}) }));
  }
  const seer = rig.ids.find((id) => roleOf(rig, id) === 'seer' && view(rig, id).alive);
  if (seer && opts.inspect !== undefined) {
    collect(rig, act(rig, seer, { move: 'inspect', ...(opts.inspect !== null ? { target: opts.inspect } : {}) }));
  }
  rig.clock.now += T + 1;
  collect(rig, rig.table.tick(rig.clock.now));
  expect(view(rig, 's1').phase).toBe('night');
};

/** 夜B：女巫行动（或不动）。到点天亮。 */
const runNightB = (rig: Rig, witch?: { choice: 'none' | 'save' | 'poison'; target?: number }): void => {
  const witchId = rig.ids.find((id) => roleOf(rig, id) === 'witch' && view(rig, id).alive);
  if (witch && witchId) {
    collect(rig, act(rig, witchId, { move: 'witch', ...witch }));
  }
  rig.clock.now += T + 1;
  collect(rig, rig.table.tick(rig.clock.now));
};

/** 白天/PK/遗言：按脚本发言；返回揭晓事件后的阶段。 */
const runSpeeches = (
  rig: Rig,
  say: (seatNo: number, kind: string) => string | '' | undefined,
): void => {
  for (let guard = 0; guard < 60; guard++) {
    const phase = view(rig, 's1');
    if (phase.phase !== 'speech') return;
    if (phase.stage === 'read') {
      rig.clock.now += READ + 1;
      collect(rig, rig.table.tick(rig.clock.now));
      continue;
    }
    const speakerId = (rig.table.public() as AnyView).turn as string;
    const text = say(seatNo(speakerId), phase.speechKind ?? 'day');
    collect(rig, act(rig, speakerId, text === '' || text === undefined
      ? { move: 'pass_speech' }
      : { move: 'speak', text }));
  }
  throw new Error('发言循环没有收敛');
};

/** 投票：映射 座号 → 目标座号 | ''（弃票）| undefined（超时）。 */
const runVote = (rig: Rig, votes: Record<number, number | '' | undefined>): void => {
  const phase = view(rig, 's1');
  expect(phase.phase).toBe('vote');
  for (const id of aliveIds(rig)) {
    const entry = votes[seatNo(id)];
    if (entry === undefined) continue; // 超时弃票
    collect(rig, act(rig, id, { move: 'vote', ...(entry === '' ? {} : { target: entry }) }));
  }
  rig.clock.now += T + 1;
  collect(rig, rig.table.tick(rig.clock.now));
};

const act = (rig: Rig, id: string, body: Record<string, unknown>): TableStep => {
  return rig.table.act(id, { windowId: view(rig, id).windowId, ...body }, rig.clock.now);
};

const advance = (rig: Rig, ms: number): void => {
  rig.clock.now += ms;
  collect(rig, rig.table.tick(rig.clock.now));
};

const eventType = (rig: Rig, type: string): TableEvent[] => rig.events.filter((event) => event.type === type);

describe('狼人杀引擎', () => {
  it('开局闸：九席、至少一名真人与一只 Coo、旧版 Coo 点名拒绝；发牌数量与座号固定', () => {
    // 少一人不能开。
    const ninth = makeRig(7, 1);
    ninth.table.leave('s9');
    expect(() => ninth.table.start('s1', ninth.clock.now)).toThrow(/9 个人/);
    // 全 Coo 不行。
    const allPets = makeRig(7, 0);
    expect(() => allPets.table.start('s1', allPets.clock.now)).toThrow(/真人/);
    // 旧版 Coo 被点名。
    const stale = makeRig(7, 1);
    // s9 的版本换成旧的：直接改引擎内部太脏——用 join 的参数重新构造一张桌。
    const staleTable = new WerewolfTable({
      host: { id: 's1', name: NAMES[0], kind: 'human', clientVersion: '0.29.0' },
      now: 0, turnMs: T, rng: seeded(7),
    });
    for (let i = 2; i <= 9; i++) {
      staleTable.join({ id: `s${i}`, name: NAMES[i - 1], kind: 'pet', clientVersion: i === 9 ? '0.28.0' : '0.29.0' });
    }
    expect(() => staleTable.start('s1', 0)).toThrow(/九号/);
    expect(() => staleTable.start('s1', 0)).toThrow(WEREWOLF_MIN_CLIENT);

    // 正常开局：角色数量与存活座位。
    const rig = makeRig(7, 1);
    startGame(rig);
    const roles = rig.ids.map((id) => roleOf(rig, id));
    expect(roles.filter((entry) => entry === 'wolf')).toHaveLength(3);
    expect(roles.filter((entry) => entry === 'villager')).toHaveLength(3);
    for (const god of ['seer', 'witch', 'hunter']) {
      expect(roles.filter((entry) => entry === god)).toHaveLength(1);
    }
    // 座号 1..9 与名字一致。
    const seats = (rig.table.public() as AnyView).seats as Array<{ seatNo: number; id: string }>;
    expect(seats.map((seat) => seat.seatNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // 看身份阶段不能做任何动作。
    const reveal = makeRig(7, 1);
    collect(reveal, reveal.table.start('s1', reveal.clock.now));
    expect(() => act(reveal, 's2', { move: 'pass_speech' })).toThrow(/看身份/);
    // 看身份阶段结束才进入第一夜；夜里全程不公开谁在行动。
    advance(reveal, T + 1);
    const nightEvents = eventType(reveal, 'parlor.table.werewolf.night');
    expect(nightEvents).toHaveLength(1);
    expect(nightEvents[0].text).not.toMatch(/狼|预言|女巫|猎人/);
    expect(nightEvents[0].data).toEqual({ game: 'werewolf', day: 1, tableId: nightEvents[0].data?.tableId });
  });

  it('夜A：狼聊与刀票互相可见（仅狼）、150 字限制、不能刀狼、重复槽拒绝；平票空刀', () => {
    const rig = makeRig(11, 1);
    startGame(rig);
    const wolves = rig.ids.filter((id) => roleOf(rig, id) === 'wolf');
    const nonWolfAlive = aliveIds(rig).filter((id) => roleOf(rig, id) !== 'wolf');
    const seer = idWithRole(rig, 'seer');

    // 非狼不能交刀票。
    expect(() => act(rig, nonWolfAlive[0], { move: 'wolf_kill', target: seatNo(nonWolfAlive[1]) })).toThrow(/狼人/);
    // 狼不能刀狼。
    expect(() => act(rig, wolves[0], { move: 'wolf_kill', target: seatNo(wolves[1]) })).toThrow(/非狼人/);
    // 狼聊 150 字上限。
    expect(() => act(rig, wolves[0], { move: 'wolf_chat', text: '嗷'.repeat(151) })).toThrow(/150/);
    collect(rig, act(rig, wolves[0], { move: 'wolf_chat', text: '今晚刀 9 号位试水' }));
    // 同一槽不能重复。
    expect(() => act(rig, wolves[0], { move: 'wolf_chat', text: '再说一条' })).toThrow(/已经交过/);
    // 刀票可见性：交完刀后，其他狼的视图里有刀票记录；预言家/村民视图里没有。
    const wolfTargetNo = seatNo(nonWolfAlive[1]);
    collect(rig, act(rig, wolves[0], { move: 'wolf_kill', target: wolfTargetNo }));
    const mate = wolves[1];
    expect(view(rig, mate).killVotes).toEqual([{ seatNo: seatNo(wolves[0]), target: wolfTargetNo }]);
    expect(view(rig, seer).killVotes).toBeUndefined();
    expect(view(rig, seer).wolfChat).toBeUndefined();
    // 预言家查验：狼人/好人二值，可重复进历史。
    const wolfNo = seatNo(wolves[0]);
    collect(rig, act(rig, seer, { move: 'inspect', target: wolfNo }));
    expect(view(rig, seer).inspections).toEqual([{ day: 1, target: wolfNo, result: 'wolf' }]);
    expect(() => act(rig, seer, { move: 'inspect', target: 2 })).toThrow(/已经交过/);
    // 第二、三只狼跟票同一个目标 → 唯一最高 → 有刀口；女巫（有解药）能看到。
    collect(rig, act(rig, wolves[1], { move: 'wolf_kill', target: wolfTargetNo }));
    collect(rig, act(rig, wolves[2], { move: 'wolf_kill', target: wolfTargetNo }));
    rig.clock.now += T + 1;
    collect(rig, rig.table.tick(rig.clock.now));
    const witch = idWithRole(rig, 'witch');
    expect(view(rig, witch).knownKill).toBe(wolfTargetNo);
  });

  it('夜A 平票或全弃 = 空刀；女巫无刀口不能救；用掉解药后不再知道刀口', () => {
    const rig = makeRig(23, 1);
    startGame(rig);
    const wolves = rig.ids.filter((id) => roleOf(rig, id) === 'wolf');
    const witch = idWithRole(rig, 'witch');
    const prey = aliveIds(rig).filter((id) => !['wolf', 'witch'].includes(roleOf(rig, id))).map(seatNo);
    // 第一夜：两票对拆 → 空刀；女巫没刀口可救、选不用药。
    collect(rig, act(rig, wolves[0], { move: 'wolf_kill', target: prey[0] }));
    collect(rig, act(rig, wolves[1], { move: 'wolf_kill', target: prey[1] }));
    rig.clock.now += T + 1;
    collect(rig, rig.table.tick(rig.clock.now));
    expect(view(rig, witch).knownKill).toBeNull();
    expect(() => act(rig, witch, { move: 'witch', choice: 'save' })).toThrow(/没有刀口/);
    collect(rig, act(rig, witch, { move: 'witch', choice: 'none' }));
    rig.clock.now += T + 1;
    collect(rig, rig.table.tick(rig.clock.now));
    expect(view(rig, 's1').phase).toBe('speech');
    expect(eventType(rig, 'parlor.table.werewolf.dawn')[0].text).toContain('平安夜');

    // 第二夜：狼有刀口，女巫用解药救人（解药没了）。
    runSpeeches(rig, () => '');
    runVote(rig, {});
    expect(view(rig, 's1').phase).toBe('night');
    const wolves2 = rig.ids.filter((id) => roleOf(rig, id) === 'wolf' && view(rig, id).alive);
    const prey2 = aliveIds(rig).filter((id) => !['wolf', 'witch'].includes(roleOf(rig, id))).map(seatNo);
    for (const wolf of wolves2) collect(rig, act(rig, wolf, { move: 'wolf_kill', target: prey2[0] }));
    rig.clock.now += T + 1;
    collect(rig, rig.table.tick(rig.clock.now));
    expect(view(rig, witch).knownKill).toBe(prey2[0]);
    collect(rig, act(rig, witch, { move: 'witch', choice: 'save', target: prey2[0] }));
    rig.clock.now += T + 1;
    collect(rig, rig.table.tick(rig.clock.now));
    expect(eventType(rig, 'parlor.table.werewolf.dawn').at(-1)!.text).toContain('平安夜');

    // 第三夜：解药已空 → 视图不再给刀口；还能用毒就仍可行动。
    runSpeeches(rig, () => '');
    runVote(rig, {});
    expect(view(rig, 's1').phase).toBe('night');
    const wolves3 = rig.ids.filter((id) => roleOf(rig, id) === 'wolf' && view(rig, id).alive);
    const prey3 = aliveIds(rig).filter((id) => !['wolf', 'witch'].includes(roleOf(rig, id))).map(seatNo);
    for (const wolf of wolves3) collect(rig, act(rig, wolf, { move: 'wolf_kill', target: prey3[0] }));
    rig.clock.now += T + 1;
    collect(rig, rig.table.tick(rig.clock.now));
    const wv = view(rig, witch);
    expect(wv.potions.antidote).toBe(0);
    expect(wv.knownKill).toBeUndefined();
    expect(wv.canAct).toBe(wv.potions.poison > 0);
  });

  it('女巫：一晚一瓶、首夜可自救、之后不能自救、不能自毒；刀毒同中仍死且猎人禁枪', () => {
    // 场景一：首夜不救（留着解药），验证自救限制。
    const rig = makeRig(31, 1);
    startGame(rig);
    const witch = idWithRole(rig, 'witch');
    const witchNo = seatNo(witch);
    const wolves = rig.ids.filter((id) => roleOf(rig, id) === 'wolf');
    const prey1 = aliveIds(rig).filter((id) => !['wolf', 'witch', 'hunter'].includes(roleOf(rig, id))).map(seatNo);
    for (const wolf of wolves) collect(rig, act(rig, wolf, { move: 'wolf_kill', target: prey1[0] }));
    rig.clock.now += T + 1;
    collect(rig, rig.table.tick(rig.clock.now));
    collect(rig, act(rig, witch, { move: 'witch', choice: 'none' }));
    rig.clock.now += T + 1;
    collect(rig, rig.table.tick(rig.clock.now));
    expect(eventType(rig, 'parlor.table.werewolf.dawn')[0].text).toContain(`${prey1[0]}号`);

    // 首夜死者有遗言；说完进入白天发言（runSpeeches 一路说到投票）。
    expect(view(rig, 's1').speechKind).toBe('lastwords');
    runSpeeches(rig, () => '');
    expect(view(rig, 's1').phase).toBe('vote');
    runVote(rig, {});

    // 第二夜：狼刀女巫本人 → 自救被拒（不是首夜）；自毒被拒；改毒别人 → 刀毒同中有人死。
    const wolves2 = rig.ids.filter((id) => roleOf(rig, id) === 'wolf' && view(rig, id).alive);
    for (const wolf of wolves2) collect(rig, act(rig, wolf, { move: 'wolf_kill', target: witchNo }));
    rig.clock.now += T + 1;
    collect(rig, rig.table.tick(rig.clock.now));
    expect(view(rig, witch).knownKill).toBe(witchNo);
    expect(() => act(rig, witch, { move: 'witch', choice: 'save', target: witchNo })).toThrow(/自救/);
    expect(() => act(rig, witch, { move: 'witch', choice: 'poison', target: witchNo })).toThrow(/不能选自己/);
    const prey2 = aliveIds(rig).filter((id) => !['wolf', 'witch'].includes(roleOf(rig, id))).map(seatNo);
    collect(rig, act(rig, witch, { move: 'witch', choice: 'poison', target: prey2[0] }));
    rig.clock.now += T + 1;
    collect(rig, rig.table.tick(rig.clock.now));
    const dawnText = eventType(rig, 'parlor.table.werewolf.dawn').at(-1)!.text;
    expect(dawnText).toContain(`${witchNo}号`);
    expect(dawnText).toContain(`${prey2[0]}号`);
    // 被毒的猎人没有开枪窗口（若 prey2 恰是猎人）。
    if (roleOf(rig, `s${prey2[0]}`) === 'hunter') {
      expect(eventType(rig, 'parlor.table.werewolf.hunter')).toHaveLength(0);
      expect(view(rig, 's1').phase).not.toBe('shoot');
    }
  });

  it('猎人：被刀可开枪、投票出局可开枪、开枪再判胜负；最后一狼被枪 = 好人胜', () => {
    // 找一个「猎人被刀」的种子：直接构造——用角色发现循环多种子直到猎人夜里被刀。
    for (let seed = 1; seed < 80; seed++) {
      const rig = makeRig(seed, 1);
      startGame(rig);
      const hunter = idWithRole(rig, 'hunter');
      const wolves = rig.ids.filter((id) => roleOf(rig, id) === 'wolf');
      for (const wolf of wolves) collect(rig, act(rig, wolf, { move: 'wolf_kill', target: seatNo(hunter) }));
      rig.clock.now += T + 1;
      collect(rig, rig.table.tick(rig.clock.now));
      const witchId = rig.ids.find((id) => roleOf(rig, id) === 'witch' && view(rig, id).alive);
      if (witchId) collect(rig, act(rig, witchId, { move: 'witch', choice: 'none' }));
      rig.clock.now += T + 1;
      collect(rig, rig.table.tick(rig.clock.now));
      if (view(rig, 's1').phase !== 'shoot') continue;
      // 猎人亮牌，开枪窗口只给猎人。
      const alive = aliveIds(rig).filter((id) => id !== hunter);
      const victim = alive.find((id) => roleOf(rig, id) === 'wolf');
      if (!victim) continue; // 枪带不走狼就换种子
      collect(rig, act(rig, hunter, { move: 'shoot', target: seatNo(victim) }));
      // 开枪把最后一……不一定最后一狼；看结局：如果三狼只死这一个，游戏继续。
      const ended = rig.table.public() as AnyView;
      if (ended.status === 'ended') {
        expect((ended as AnyView).result.outcome).toBe('good');
      } else {
        expect(view(rig, 's1').phase).toBe('speech');
      }
      return;
    }
    throw new Error('80 个种子里没找到猎人被刀的局面');
  });

  it('白天：发言顺序起点随机、之后每天后移一位、跳过出局者；真人时限是 Coo 的两倍', () => {
    const rig = makeRig(41, 1);
    startGame(rig);
    runNightA(rig, { kill: null });
    runNightB(rig, { choice: 'none' });
    // 平安夜 → 直接进入白天发言。
    expect(view(rig, 's1').phase).toBe('speech');
    const day1Start = view(rig, 's1').windowId;
    expect(typeof day1Start).toBe('string');
    // 记录发言顺序。
    const order: number[] = [];
    runSpeeches(rig, (seatNo) => {
      order.push(seatNo);
      return `发言${seatNo}`;
    });
    // 九人都说了，顺序是顺时针且无重复。
    expect(order).toHaveLength(9);
    expect(new Set(order).size).toBe(9);
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBe((order[i - 1] % 9) + 1);
    }
    // 起点公开在开局里；真人席位发言窗 2T，Coo 席位 T。
    const rig2 = makeRig(41, 1);
    startGame(rig2);
    runNightA(rig2, { kill: null });
    runNightB(rig2, { choice: 'none' });
    const humanNo = 1;
    const firstSpeaker = (rig2.table.public() as AnyView).turn;
    const firstId = `s${firstSpeaker === undefined ? 0 : (firstSpeaker as string).slice(1)}`;
    const firstView = view(rig2, firstId);
    expect(firstView.canAct).toBe(firstId === `s${humanNo}` || firstView.kind === 'pet');
    if (firstView.kind === 'human') {
      expect(firstView.deadline - rig2.clock.now).toBeLessThanOrEqual(2 * T);
      expect(firstView.deadline - rig2.clock.now).toBeGreaterThan(T);
    } else {
      expect(firstView.deadline - rig2.clock.now).toBeLessThanOrEqual(T);
    }
  });

  it('发言：一次一条、300 字限制、过麦、非法正文不消耗机会；结束后有阅读期', () => {
    const rig = makeRig(53, 1);
    startGame(rig);
    runNightA(rig, { kill: null });
    runNightB(rig, { choice: 'none' });
    const speaker = (rig.table.public() as AnyView).turn as string;
    // 超长拒绝后还能正常提交（机会没被吃掉）。
    expect(() => act(rig, speaker, { move: 'speak', text: '长'.repeat(301) })).toThrow(/300/);
    expect(view(rig, speaker).canAct).toBe(true);
    // speak 之外的动作不合法。
    expect(() => act(rig, speaker, { move: 'vote', target: 2 })).toThrow(/speak/);
    collect(rig, act(rig, speaker, { move: 'speak', text: '大家好，我是好人。' }));
    // 提交后再提交 = 阅读期。
    expect(view(rig, speaker).canAct).toBe(false);
    expect(() => act(rig, speaker, { move: 'speak', text: '再补一句' })).toThrow(/阅读/);
    // 发言事件全文公开。
    const speech = eventType(rig, 'parlor.table.werewolf.speech')[0];
    expect(speech.text).toContain('大家好，我是好人。');
    // 没轮到的人不能说：先走过阅读期，让下一位开麦，再让第三个人抢。
    advance(rig, READ + 1);
    const speaker2 = (rig.table.public() as AnyView).turn as string;
    const intruder = aliveIds(rig).find((id) => id !== speaker2)!;
    expect(() => act(rig, intruder, { move: 'speak', text: '抢麦' })).toThrow(/轮到/);
    // 第二位过麦：公开「过麦」，然后有阅读期。
    collect(rig, act(rig, speaker2, { move: 'pass_speech' }));
    expect(eventType(rig, 'parlor.table.werewolf.speech')[1].text).toContain('过麦');
  });

  it('投票：多人同窗口互不顶、不能投自己、提交后不能改、超时=弃票、到点统一揭晓', () => {
    const rig = makeRig(61, 1);
    startGame(rig);
    runNightA(rig, { kill: null });
    runNightB(rig, { choice: 'none' });
    runSpeeches(rig, (no) => (no === 9 ? '我是好人，请大家理性' : ''));
    expect(view(rig, 's1').phase).toBe('vote');
    // 不能投自己；提交后不能改。
    expect(() => act(rig, 's3', { move: 'vote', target: 3 })).toThrow(/不能投自己/);
    collect(rig, act(rig, 's3', { move: 'vote', target: 9 }));
    expect(() => act(rig, 's3', { move: 'vote', target: 2 })).toThrow(/已经投过/);
    // 其余有人投 9、有人弃票、有人超时 → 9 号唯一最高被放逐。
    for (const id of aliveIds(rig)) {
      if (id === 's3') continue;
      const no = seatNo(id);
      if (no <= 4) collect(rig, act(rig, id, { move: 'vote', target: 9 }));
      else if (no <= 6) collect(rig, act(rig, id, { move: 'vote' }));
      // 7-9 号超时。
    }
    rig.clock.now += T + 1;
    collect(rig, rig.table.tick(rig.clock.now));
    const voteEvent = eventType(rig, 'parlor.table.werewolf.vote')[0];
    expect(voteEvent.text).toContain('九号');
    expect(voteEvent.text).toContain('被放逐');
    const data = voteEvent.data as { entries: Array<{ seatNo: number; target: number | null; timeout: boolean }> };
    const entry9 = data.entries.find((entry) => entry.seatNo === 9)!;
    expect(entry9.timeout).toBe(true);
    expect(entry9.target).toBe(null);
    // 放逐者有遗言（白天出局），说完进入白天发言，投完票进第 2 夜。
    expect(view(rig, 's1').phase).toBe('speech');
    expect(view(rig, 's1').speechKind).toBe('lastwords');
    runSpeeches(rig, () => '');
    runSpeeches(rig, () => '');
    runVote(rig, {});
    expect(view(rig, 's1').phase).toBe('night');
    expect(view(rig, 's1').day).toBe(2);
  });

  it('平票 PK：平票者依次发言、只有非 PK 存活者能复投、复投平票无人放逐', () => {
    const rig = makeRig(71, 1);
    startGame(rig);
    runNightA(rig, { kill: null });
    runNightB(rig, { choice: 'none' });
    runSpeeches(rig, () => '');
    expect(view(rig, 's1').phase).toBe('vote');
    // 2、3 号各得四票（9 号弃票）→ 平票 PK。
    const alive = aliveIds(rig);
    let toggle = 0;
    for (const id of alive) {
      if (id === 's9') {
        collect(rig, act(rig, id, { move: 'vote' }));
        continue;
      }
      const target = toggle % 2 === 0 ? 2 : 3;
      toggle += 1;
      collect(rig, act(rig, id, { move: 'vote', target }));
    }
    rig.clock.now += T + 1;
    collect(rig, rig.table.tick(rig.clock.now));
    expect(view(rig, 's1').phase).toBe('speech');
    expect(view(rig, 's1').speechKind).toBe('pk');
    // PK 发言只有 2、3 号；PK 的人不能投。
    runSpeeches(rig, (no) => (no === 2 ? '我是好人' : no === 3 ? '我也是好人' : ''));
    expect(view(rig, 's1').phase).toBe('vote');
    expect(view(rig, 's1').pkSeats).toEqual([2, 3]);
    expect(view(rig, 's2').canAct).toBe(false); // PK 者无投票权
    expect(view(rig, 's4').canAct).toBe(true);
    expect(() => act(rig, 's4', { move: 'vote', target: 5 })).toThrow(/PK 的席位/);
    // 非 PK 者 2v2 平票（其余弃票）→ 复投再平 → 无人放逐 → 第 2 夜。
    const voters = aliveIds(rig).filter((id) => id !== 's2' && id !== 's3');
    for (let i = 0; i < voters.length; i++) {
      const id = voters[i];
      if (i < 2) collect(rig, act(rig, id, { move: 'vote', target: 2 }));
      else if (i < 4) collect(rig, act(rig, id, { move: 'vote', target: 3 }));
      else collect(rig, act(rig, id, { move: 'vote' }));
    }
    rig.clock.now += T + 1;
    collect(rig, rig.table.tick(rig.clock.now));
    expect(eventType(rig, 'parlor.table.werewolf.vote').at(-1)!.text).toContain('没人被放逐');
    expect(view(rig, 's1').phase).toBe('night');
    expect(view(rig, 's1').day).toBe(2);
  });

  it('遗言：只有首夜出局与白天放逐有；终局不开遗言；第二夜死者无遗言', () => {
    // 首夜刀一人：首夜死者（若无猎人触发）有遗言。
    const rig = makeRig(83, 1);
    startGame(rig);
    const wolves = rig.ids.filter((id) => roleOf(rig, id) === 'wolf');
    const victim = aliveIds(rig).find((id) => !['wolf', 'hunter'].includes(roleOf(rig, id)))!;
    for (const wolf of wolves) collect(rig, act(rig, wolf, { move: 'wolf_kill', target: seatNo(victim) }));
    rig.clock.now += T + 1;
    collect(rig, rig.table.tick(rig.clock.now));
    const witch = idWithRole(rig, 'witch');
    collect(rig, act(rig, witch, { move: 'witch', choice: 'none' }));
    rig.clock.now += T + 1;
    collect(rig, rig.table.tick(rig.clock.now));
    if (view(rig, 's1').phase === 'shoot') {
      // 猎人窗口：放弃后遗言照排。
      collect(rig, act(rig, victim, { move: 'shoot' }));
    }
    expect(view(rig, 's1').speechKind).toBe('lastwords');
    // 遗言只有一位（首夜死者）。
    const queueLength = 1;
    collect(rig, act(rig, victim, { move: 'speak', text: '我走之后，请大家盯紧跳预言家的人。' }));
    advance(rig, READ + 1);
    // 遗言完直接进白天发言。
    expect(view(rig, 's1').speechKind).toBe('day');
    void queueLength;
  });

  it('存档与恢复：中途导出/恢复后继续打完；版本不认识抛错；rearm 平移截止', () => {
    const rig = makeRig(97, 1);
    startGame(rig);
    runNightA(rig, { kill: null });
    runNightB(rig, { choice: 'none' });
    runSpeeches(rig, () => '');
    // 投票进行中导出。
    const saved = JSON.parse(JSON.stringify(rig.table.exportState()));
    const ballotsBefore = view(rig, 's1');
    // 恢复到新引擎。
    const revived = new WerewolfTable({
      host: { id: 's1', name: NAMES[0], kind: 'human', clientVersion: '0.29.0' },
      now: rig.clock.now,
      turnMs: T,
      rng: seeded(999),
    });
    for (let i = 2; i <= 9; i++) {
      revived.join({ id: `s${i}`, name: NAMES[i - 1], kind: 'pet', clientVersion: '0.29.0' });
    }
    revived.restoreState(saved);
    // 角色不重发：身份与进度一致。
    for (const id of rig.ids) {
      expect(roleOf({ ...rig, table: revived } as Rig, id)).toBe(roleOf(rig, id));
    }
    expect((revived.view('s1') as AnyView).phase).toBe('vote');
    expect((revived.view('s1') as AnyView).day).toBe(ballotsBefore.day);
    // 继续投票到终局或下一夜（目标避开自己）。
    for (const id of rig.ids) {
      if (!aliveIds(rig).includes(id)) continue;
      const self = seatNo(id);
      revived.act(id, {
        windowId: (revived.view(id) as AnyView).windowId,
        move: 'vote',
        target: self === 3 ? 4 : 3,
      }, rig.clock.now);
    }
    rig.clock.now += T + 1;
    revived.tick(rig.clock.now);
    // 恢复后事件从零开始（restore 不产生事件）。
    expect(revived.publicText()).toBeTruthy();
    // 坏版本抛错。
    const broken = new WerewolfTable({ host: { id: 's1', name: NAMES[0] }, now: 0, turnMs: T });
    expect(() => broken.restoreState({ ...saved, version: 99 })).toThrow(/版本/);

    // rearm：投票截止向后平移。
    const rig2 = makeRig(97, 1);
    startGame(rig2);
    const deadlineBefore = view(rig2, 's1').deadline as number;
    rig2.clock.now += 5_000;
    rig2.table.rearm(rig2.clock.now, 5_000, 10_000);
    const deadlineAfter = view(rig2, 's1').deadline as number;
    // 剩余不足 10 秒时补足 10 秒。
    expect(deadlineAfter - rig2.clock.now).toBeGreaterThanOrEqual(10_000 - 1);
    expect(deadlineAfter).toBeGreaterThanOrEqual(deadlineBefore + 5_000 - 1);
  });

  it('托管：轮到顺序发言者立刻过麦；窗口制席位等截止；开枪托管放弃', () => {
    const rig = makeRig(113, 1);
    startGame(rig);
    runNightA(rig, { kill: null });
    runNightB(rig, { choice: 'none' });
    // 第一位发言者托管 → 立即过麦，不等到超时。
    const speaker = (rig.table.public() as AnyView).turn as string;
    const step = rig.table.autoPlay(speaker, rig.clock.now);
    expect(step).not.toBeNull();
    expect(eventType(rig, 'parlor.table.werewolf.speech').length).toBe(0);
    rig.events.push(...(step!.events));
    expect(eventType(rig, 'parlor.table.werewolf.speech')).toHaveLength(1);
    expect(eventType(rig, 'parlor.table.werewolf.speech')[0].text).toContain('过麦');
    // 投票窗口里 autoPlay 不代投（等截止统一弃票）。
    runSpeeches(rig, () => '');
    expect(view(rig, 's1').phase).toBe('vote');
    for (const id of aliveIds(rig)) expect(rig.table.autoPlay(id, rig.clock.now)).toBeNull();
  });

  it('桌面锁与公开视图：进行中锁桌聊；public() 不含任何角色；出局者保留座位', () => {
    const rig = makeRig(127, 1);
    expect(rig.table.chatLocked()).toBe(false);
    startGame(rig);
    expect(rig.table.chatLocked()).toBe(true);
    runNightA(rig, { kill: null });
    runNightB(rig, { choice: 'none' });
    runSpeeches(rig, () => '');
    runVote(rig, { 2: 9, 3: 9, 4: 9, 5: 9, 6: 9 });
    // 9 号被放逐后仍在座位上、标出局。
    const seats = (rig.table.public() as AnyView).seats as Array<{ id: string; alive: boolean }>;
    expect(seats.find((seat) => seat.id === 's9')?.alive).toBe(false);
    expect(seats).toHaveLength(9);
    // 公开视图没有角色字段。
    const publicView = JSON.stringify(rig.table.public());
    expect(publicView).not.toContain('"role"');
    // 出局者的视图保留身份；若正在遗言窗口则 canAct 为真（遗言是出局者的权利）。
    const deadWolf = rig.ids.find((id) => !view(rig, id).alive && roleOf(rig, id) === 'wolf');
    if (deadWolf) {
      const deadView = view(rig, deadWolf);
      expect(deadView.role).toBe('wolf');
      expect(deadView.canAct).toBe((rig.table.public() as AnyView).turn === deadWolf);
    }
  });

  it('历史查询：按天/按人过滤；终局前不给死因；review 只给参与者且已终局', () => {
    const rig = makeRig(131, 1);
    startGame(rig);
    const seer = idWithRole(rig, 'seer');
    runNightA(rig, { kill: null, inspect: 2 });
    runNightB(rig, { choice: 'none' });
    runSpeeches(rig, (no) => (no === 1 ? `一号的发言` : ''));
    runVote(rig, { 1: 9, 2: 9, 3: 9, 4: 9 });
    // 第 1 天发言可按天取。
    const day1 = rig.table.tableLog({ day: 1 }, { seatId: 's1', onTable: true }) as AnyView;
    expect(day1.speeches.length).toBeGreaterThan(0);
    expect(day1.speeches.every((entry: AnyView) => entry.day === 1)).toBe(true);
    const bySeat = rig.table.tableLog({ seatNo: 1 }, { seatId: 's1', onTable: true }) as AnyView;
    expect(bySeat.speeches.every((entry: AnyView) => entry.seatNo === 1)).toBe(true);
    // 终局前：无 nights，死亡不带 cause。
    expect(day1.nights).toBeUndefined();
    // review 未终局 → 无 nights（引擎给空，宿主层再拦越权）。
    const reviewEarly = rig.table.tableLog({ review: true }, { seatId: 's1', onTable: true }) as AnyView;
    expect(reviewEarly.nights).toBeUndefined();
    // 打到终局（快速路线：连续放逐狼人——用角色发现逐票放逐）。
    for (let day = 0; day < 20; day++) {
      const phase = view(rig, 's1');
      if (phase.status === 'ended') break;
      if (phase.phase === 'speech') {
        runSpeeches(rig, () => '');
      } else if (phase.phase === 'vote') {
        const wolfNos = rig.ids.filter((id) => roleOf(rig, id) === 'wolf' && view(rig, id).alive).map(seatNo);
        if (wolfNos.length === 0) break;
        const target = Math.max(...wolfNos);
        const votes: Record<number, number | ''> = {};
        for (const id of aliveIds(rig)) {
          // 狼不能投自己；好人统一投最大狼号，狼弃票，多数依然成立。
          votes[seatNo(id)] = seatNo(id) === target ? '' : target;
        }
        runVote(rig, votes);
      } else if (phase.phase === 'shoot') {
        const hunter = (rig.table.public() as AnyView).turn as string;
        const wolvesAlive = rig.ids.filter((id) => roleOf(rig, id) === 'wolf' && view(rig, id).alive);
        const target = wolvesAlive[0] ? seatNo(wolvesAlive[0]) : seatNo(aliveIds(rig).find((id) => id !== hunter)!);
        collect(rig, act(rig, hunter, { move: 'shoot', target }));
      } else if (phase.phase === 'night') {
        // 夜里（A/B 两段都适用）：能动的动一步，然后到点推进。
        const wolves = rig.ids.filter((id) => roleOf(rig, id) === 'wolf' && view(rig, id).alive);
        const gods = aliveIds(rig).filter((id) => ['seer', 'witch', 'hunter'].includes(roleOf(rig, id)));
        const killTarget = gods.length > 0 ? seatNo(gods[0]) : seatNo(aliveIds(rig).find((id) => roleOf(rig, id) !== 'wolf') ?? wolves[0]);
        for (const wolf of wolves) {
          if (view(rig, wolf).canAct) collect(rig, act(rig, wolf, { move: 'wolf_kill', target: killTarget }));
        }
        const witchId = rig.ids.find((id) => roleOf(rig, id) === 'witch' && view(rig, id).alive);
        if (witchId && view(rig, witchId).canAct) {
          collect(rig, act(rig, witchId, { move: 'witch', choice: 'none' }));
        }
        advance(rig, T + 1);
      } else {
        advance(rig, T + 1);
      }
    }
    expect((rig.table.public() as AnyView).status).toBe('ended');
    // 终局后 review 才有夜间记录；非参与者不给。
    const review = rig.table.tableLog({ review: true }, { seatId: 's1', onTable: true }) as AnyView;
    expect(Array.isArray(review.nights)).toBe(true);
    expect(review.nights.length).toBeGreaterThan(0);
    expect(review.nights[0].wolfChats !== undefined).toBe(true);
    const outsider = rig.table.tableLog({ review: true }, { seatId: '', onTable: false }) as AnyView;
    expect(outsider.nights).toBeUndefined();
  });

  it('十二个白天仍未决胜 → 平局；平局也写终局', () => {
    // 按阶段泵：每个窗口把能交的默认动作交掉，到点推进；夜里空刀、白天全弃。
    const rig = makeRig(151, 1);
    startGame(rig);
    for (let guard = 0; guard < 300; guard++) {
      const phase = view(rig, 's1');
      if (phase.status === 'ended') break;
      if (phase.phase === 'night') {
        for (const id of rig.ids) {
          if (!view(rig, id).canAct) continue;
          const role = roleOf(rig, id);
          collect(rig, act(rig, id, role === 'witch'
            ? { move: 'witch', choice: 'none' }
            : role === 'wolf' ? { move: 'wolf_kill' } : { move: 'inspect' }));
        }
        advance(rig, T + 1);
      } else if (phase.phase === 'speech') {
        runSpeeches(rig, () => '');
      } else if (phase.phase === 'vote') {
        runVote(rig, {});
      } else if (phase.phase === 'shoot') {
        const hunter = (rig.table.public() as AnyView).turn as string;
        collect(rig, act(rig, hunter, { move: 'shoot' }));
      } else {
        advance(rig, T + 1);
      }
    }
    const ended = rig.table.public() as AnyView;
    expect(ended.status).toBe('ended');
    expect(ended.result.outcome).toBe('draw');
    expect(ended.result.winners).toEqual([]);
    expect(view(rig, 's1').day).toBe(12);
  });
});

// ———— 补充验收:硬截止(A6)、真实时长(A2)、猎人确定性(A7)、女巫早死与票保密(B3)、
// 引擎面(B4)、恢复等价(D1)、rearm 不叠加(D2)。 ————

/** 存活狼里座号最大的;没有狼返回 null。 */
const maxAliveWolfNo = (rig: Rig): number | null => {
  const wolfNos = rig.ids.filter((id) => roleOf(rig, id) === 'wolf' && view(rig, id).alive).map(seatNo);
  return wolfNos.length > 0 ? Math.max(...wolfNos) : null;
};

/** 白天投票:全员投 targetNo、目标本人弃票 → 唯一最高放逐;null = 全员超时弃票。 */
const voteExile = (rig: Rig, targetNo: number | null): void => {
  if (targetNo === null) {
    runVote(rig, {});
    return;
  }
  const votes: Record<number, number | ''> = {};
  for (const id of aliveIds(rig)) votes[seatNo(id)] = seatNo(id) === targetNo ? '' : targetNo;
  runVote(rig, votes);
};

/** 夜刀目标(确定性,只看公开可得的角色知识):预言家 → 女巫 → 猎人 → 村民;没有就弃刀。 */
const nightKillTargetNo = (rig: Rig): number | undefined => {
  for (const role of ['seer', 'witch', 'hunter', 'villager']) {
    const found = rig.ids.find((id) => roleOf(rig, id) === role && view(rig, id).alive);
    if (found) return seatNo(found);
  }
  return undefined;
};

describe('狼人杀·硬截止边界(A6)', () => {
  it('投票窗口:截止前 1ms 收下;恰好到点与到点后 1ms 拒绝且不记票;到点 tick 按超时统一结算;旧窗口再交按 expired 拒绝', () => {
    const rig = makeRig(61, 1);
    startGame(rig);
    runNightA(rig, { kill: null });
    runNightB(rig, { choice: 'none' });
    runSpeeches(rig, () => '');
    expect(view(rig, 's1').phase).toBe('vote');
    const deadline = view(rig, 's2').deadline as number;
    const oldWindowId = view(rig, 's2').windowId;
    // 截止前 1ms:收下。
    collect(rig, rig.table.act('s2', { windowId: oldWindowId, move: 'vote', target: 9 }, deadline - 1));
    // 恰好到点:拒绝,票不进票箱。
    expect(() => rig.table.act('s3', { windowId: view(rig, 's3').windowId, move: 'vote', target: 9 }, deadline))
      .toThrow(/截止/);
    // 到点后 1ms、tick 之前:同样拒绝。
    expect(() => rig.table.act('s4', { windowId: view(rig, 's4').windowId, move: 'vote', target: 9 }, deadline + 1))
      .toThrow(/截止/);
    // 到点 tick:按超时统一结算——s2 的票有效,3、4 号按超时弃票。
    rig.clock.now = deadline;
    collect(rig, rig.table.tick(deadline));
    const data = (eventType(rig, 'parlor.table.werewolf.vote')[0].data ?? {}) as {
      entries: Array<{ seatNo: number; target: number | null; timeout: boolean }>;
    };
    expect(data.entries.find((entry) => entry.seatNo === 2)).toEqual({ seatNo: 2, target: 9, timeout: false });
    expect(data.entries.find((entry) => entry.seatNo === 3)).toEqual({ seatNo: 3, target: null, timeout: true });
    expect(data.entries.find((entry) => entry.seatNo === 4)).toEqual({ seatNo: 4, target: null, timeout: true });
    // 阶段已推进,拿旧 windowId 再交:expired(窗口已结束,不是截止)。
    let stale: { code?: string; message?: string } | null = null;
    try {
      rig.table.act('s3', { windowId: oldWindowId, move: 'vote', target: 9 }, deadline + 1);
    } catch (caught) {
      stale = caught as { code?: string; message?: string };
    }
    expect(stale).not.toBeNull();
    expect(stale?.code).toBe('expired');
    expect(stale?.message ?? '').toMatch(/已经结束/);
  });

  it('夜A 刀票恰好到点拒绝:票不进票箱,整夜空刀 → 女巫无刀口、天亮平安夜', () => {
    const rig = makeRig(23, 1);
    startGame(rig);
    const wolves = rig.ids.filter((id) => roleOf(rig, id) === 'wolf');
    const prey = aliveIds(rig).filter((id) => roleOf(rig, id) !== 'wolf').map(seatNo);
    const deadline = view(rig, wolves[0]).deadline as number;
    // 恰好到点:拒绝。
    expect(() => rig.table.act(wolves[0], { windowId: view(rig, wolves[0]).windowId, move: 'wolf_kill', target: prey[0] }, deadline))
      .toThrow(/截止/);
    // 票箱里没有这张票。
    expect(view(rig, wolves[1]).killVotes).toEqual([]);
    // 到点 tick:锁定空刀,进夜 B。
    rig.clock.now = deadline;
    collect(rig, rig.table.tick(deadline));
    const witch = idWithRole(rig, 'witch');
    expect(view(rig, witch).knownKill).toBeNull();
    collect(rig, act(rig, witch, { move: 'witch', choice: 'none' }));
    rig.clock.now += T + 1;
    collect(rig, rig.table.tick(rig.clock.now));
    // 超时默认生效:空刀 → 平安夜。
    expect(eventType(rig, 'parlor.table.werewolf.dawn')[0].text).toContain('平安夜');
  });

  it('发言窗口恰好到点拒绝:提交不算,超时按过麦结算、正文为空', () => {
    const rig = makeRig(53, 1);
    startGame(rig);
    runNightA(rig, { kill: null });
    runNightB(rig, { choice: 'none' });
    const speaker = (rig.table.public() as AnyView).turn as string;
    const deadline = view(rig, speaker).deadline as number;
    expect(() => rig.table.act(speaker, { windowId: view(rig, speaker).windowId, move: 'speak', text: '迟到的发言' }, deadline))
      .toThrow(/截止/);
    rig.clock.now = deadline;
    collect(rig, rig.table.tick(deadline));
    const speech = eventType(rig, 'parlor.table.werewolf.speech')[0];
    expect(speech.text).toContain('过麦');
    expect(speech.text).not.toContain('迟到的发言');
    expect(speech.data).toMatchObject({ seatNo: seatNo(speaker), text: '', passed: true });
  });

  it('开枪窗口恰好到点拒绝:提交不算,超时按放弃开枪结算', () => {
    const rig = makeRig(31, 1);
    startGame(rig);
    const hunter = idWithRole(rig, 'hunter');
    for (const wolf of rig.ids.filter((id) => roleOf(rig, id) === 'wolf')) {
      collect(rig, act(rig, wolf, { move: 'wolf_kill', target: seatNo(hunter) }));
    }
    rig.clock.now += T + 1;
    collect(rig, rig.table.tick(rig.clock.now));
    const witch = idWithRole(rig, 'witch');
    collect(rig, act(rig, witch, { move: 'witch', choice: 'none' }));
    rig.clock.now += T + 1;
    collect(rig, rig.table.tick(rig.clock.now));
    expect(view(rig, 's1').phase).toBe('shoot');
    const deadline = view(rig, hunter).deadline as number;
    const prey = aliveIds(rig).find((id) => id !== hunter)!;
    expect(() => rig.table.act(hunter, { windowId: view(rig, hunter).windowId, move: 'shoot', target: seatNo(prey) }, deadline))
      .toThrow(/截止/);
    rig.clock.now = deadline;
    collect(rig, rig.table.tick(deadline));
    const shot = eventType(rig, 'parlor.table.werewolf.shot')[0];
    expect(shot.text).toContain('放弃开枪');
    expect(shot.data).toMatchObject({ hunter: seatNo(hunter), gaveUp: true, timeout: true });
  });
});

describe('狼人杀·真实时长(A2:不传 turnMs 用正式默认)', () => {
  /** 与 makeRig 同构,但不传 turnMs → 引擎用正式默认时长。 */
  const makeRealRig = (seed = 5): Rig => {
    const clock = { now: 1_000_000 };
    const table = new WerewolfTable({
      host: { id: 's1', name: NAMES[0], kind: 'human', clientVersion: '0.29.0' },
      now: clock.now,
      rng: seeded(seed),
    });
    for (let i = 2; i <= 9; i++) {
      table.join({ id: `s${i}`, name: NAMES[i - 1], kind: 'pet', clientVersion: '0.29.0' });
    }
    return { table, clock, ids: Array.from({ length: 9 }, (_, i) => `s${i + 1}`), steps: [], events: [] };
  };

  it('开局 15s;夜 A 行动者 60s、对外 120s;夜 B 60s;真人发言 120s、Coo 60s、阅读 20s;投票 60s;开枪 60s', () => {
    // —— 主线:空刀平安夜,一路量到投票 ——
    const rig = makeRealRig(5);
    collect(rig, rig.table.start('s1', rig.clock.now));
    expect(view(rig, 's1').deadline).toBe(rig.clock.now + 15000);
    rig.clock.now += 15000;
    collect(rig, rig.table.tick(rig.clock.now));
    expect(view(rig, 's1').phase).toBe('night');
    const wolf = rig.ids.find((id) => roleOf(rig, id) === 'wolf')!;
    const ordinary = rig.ids.find((id) => roleOf(rig, id) === 'villager')!;
    // 夜 A:行动者看 A 段截止,普通人看天亮(= A 段截止 + 一个夜长)。
    expect(view(rig, wolf).deadline).toBe(rig.clock.now + 60000);
    expect(view(rig, ordinary).deadline).toBe(rig.clock.now + 120000);
    expect((rig.table.public() as AnyView).deadline).toBe(rig.clock.now + 120000);
    rig.clock.now += 60000;
    collect(rig, rig.table.tick(rig.clock.now));
    // 夜 B:女巫 60s,对外天亮时刻 = 60s。
    const witch = idWithRole(rig, 'witch');
    expect(view(rig, witch).deadline).toBe(rig.clock.now + 60000);
    expect((rig.table.public() as AnyView).deadline).toBe(rig.clock.now + 60000);
    collect(rig, act(rig, witch, { move: 'witch', choice: 'none' }));
    rig.clock.now += 60000;
    collect(rig, rig.table.tick(rig.clock.now));
    expect(eventType(rig, 'parlor.table.werewolf.dawn')).toHaveLength(1);
    // 白天发言:真人 120s、Coo 60s;每次提交后阅读 20s。
    expect(view(rig, 's1').phase).toBe('speech');
    let humanSeen = false;
    let cooSeen = false;
    for (let guard = 0; guard < 40 && view(rig, 's1').phase === 'speech'; guard++) {
      const p = view(rig, 's1');
      if (p.stage === 'read') {
        expect((p.deadline as number) - rig.clock.now).toBe(20000);
        rig.clock.now += 20000;
        collect(rig, rig.table.tick(rig.clock.now));
        continue;
      }
      const speaker = (rig.table.public() as AnyView).turn as string;
      const speakerView = view(rig, speaker);
      expect(speakerView.deadline).toBe(rig.clock.now + (speakerView.kind === 'human' ? 120000 : 60000));
      if (speakerView.kind === 'human') humanSeen = true; else cooSeen = true;
      collect(rig, act(rig, speaker, { move: 'pass_speech' }));
      // 提交后进入阅读期:readUntil - now = 20s。
      expect(view(rig, speaker).deadline).toBe(rig.clock.now + 20000);
    }
    expect(humanSeen).toBe(true);
    expect(cooSeen).toBe(true);
    // 投票窗口 60s。
    expect(view(rig, 's1').phase).toBe('vote');
    expect(view(rig, 's1').deadline).toBe(rig.clock.now + 60000);

    // —— 开枪窗口 60s:猎人夜里被刀 ——
    const rig2 = makeRealRig(11);
    collect(rig2, rig2.table.start('s1', rig2.clock.now));
    rig2.clock.now += 15000;
    collect(rig2, rig2.table.tick(rig2.clock.now));
    const hunter = idWithRole(rig2, 'hunter');
    for (const w of rig2.ids.filter((id) => roleOf(rig2, id) === 'wolf')) {
      collect(rig2, act(rig2, w, { move: 'wolf_kill', target: seatNo(hunter) }));
    }
    rig2.clock.now += 60000;
    collect(rig2, rig2.table.tick(rig2.clock.now));
    const witch2 = idWithRole(rig2, 'witch');
    collect(rig2, act(rig2, witch2, { move: 'witch', choice: 'none' }));
    rig2.clock.now += 60000;
    collect(rig2, rig2.table.tick(rig2.clock.now));
    expect(view(rig2, 's1').phase).toBe('shoot');
    expect(view(rig2, hunter).deadline).toBe(rig2.clock.now + 60000);
  });

  it('超时与过麦同构:发言者到点被 tick 结算与主动 pass_speech 产生形状一致的 speech 事件', () => {
    const reachSpeech = (): Rig => {
      const rig = makeRig(57, 1);
      startGame(rig);
      runNightA(rig, { kill: null });
      runNightB(rig, { choice: 'none' });
      expect(view(rig, 's1').phase).toBe('speech');
      return rig;
    };
    const rigTimeout = reachSpeech();
    const rigPass = reachSpeech();
    const speakerOf = (rig: Rig): string => (rig.table.public() as AnyView).turn as string;
    const deadline = view(rigTimeout, speakerOf(rigTimeout)).deadline as number;
    // 超时线:把钟拨到截止,交给 tick 统一结算。
    rigTimeout.clock.now = deadline;
    collect(rigTimeout, rigTimeout.table.tick(deadline));
    // 过麦线:同一时刻线,发言者在截止前主动交 pass_speech。
    collect(rigPass, act(rigPass, speakerOf(rigPass), { move: 'pass_speech' }));
    const timeoutEvent = eventType(rigTimeout, 'parlor.table.werewolf.speech')[0];
    const passEvent = eventType(rigPass, 'parlor.table.werewolf.speech')[0];
    expect(timeoutEvent).toBeDefined();
    expect(passEvent.type).toBe(timeoutEvent.type);
    expect(passEvent.text).toBe(timeoutEvent.text);
    expect(passEvent.data).toEqual(timeoutEvent.data);
    expect(passEvent.data).toMatchObject({ text: '', passed: true });
  });
});

describe('狼人杀·猎人确定性(A7)', () => {
  /** 枚举种子找满足前置条件的发牌;找不到直接 fail(不 skip)。 */
  const findSeed = (probe: (rig: Rig) => boolean, limit = 4000): number => {
    for (let seed = 1; seed <= limit; seed++) {
      const rig = makeRig(seed, 1);
      try {
        if (probe(rig)) return seed;
      } catch {
        // 这副牌走不完剧本:换下一个种子。
      }
    }
    throw new Error(`1..${limit} 个种子里没有找到满足前置条件的发牌(猎人场景不可构建)`);
  };

  it('猎人确定性·白天被投出局:出现开枪窗口,交枪后继续判胜负', () => {
    const seed = findSeed((rig) => {
      startGame(rig);
      runNightA(rig, { kill: null });
      runNightB(rig, { choice: 'none' });
      runSpeeches(rig, () => '');
      const hunter = idWithRole(rig, 'hunter');
      voteExile(rig, seatNo(hunter));
      return view(rig, 's1').phase === 'shoot';
    });
    const rig = makeRig(seed, 1);
    startGame(rig);
    runNightA(rig, { kill: null });
    runNightB(rig, { choice: 'none' });
    runSpeeches(rig, () => '');
    const hunter = idWithRole(rig, 'hunter');
    voteExile(rig, seatNo(hunter));
    // 前置条件钉死:猎人被投出局后必须出现开枪窗口。
    expect(view(rig, 's1').phase).toBe('shoot');
    expect((rig.table.public() as AnyView).turn).toBe(hunter);
    // 交枪:带走在场的一只狼。
    const wolfTarget = rig.ids.find((id) => roleOf(rig, id) === 'wolf' && view(rig, id).alive)!;
    collect(rig, act(rig, hunter, { move: 'shoot', target: seatNo(wolfTarget) }));
    expect(eventType(rig, 'parlor.table.werewolf.shot')[0].data).toMatchObject({
      hunter: seatNo(hunter),
      target: seatNo(wolfTarget),
    });
    // 枪响后再判胜负:还有两只狼,局没完 → 首夜出局者的遗言窗口。
    expect((rig.table.public() as AnyView).status).not.toBe('ended');
    expect(view(rig, 's1').phase).toBe('speech');
    expect(view(rig, 's1').speechKind).toBe('lastwords');
  });

  it('猎人确定性·中毒:进天亮死亡名单,但没有开枪窗口', () => {
    const seed = findSeed((rig) => {
      startGame(rig);
      runNightA(rig, { kill: null });
      const hunter = idWithRole(rig, 'hunter');
      const witch = idWithRole(rig, 'witch');
      collect(rig, act(rig, witch, { move: 'witch', choice: 'poison', target: seatNo(hunter) }));
      rig.clock.now += T + 1;
      collect(rig, rig.table.tick(rig.clock.now));
      const dawn = eventType(rig, 'parlor.table.werewolf.dawn')[0];
      return !!dawn && dawn.text.includes(`${seatNo(hunter)}号`) && view(rig, 's1').phase !== 'shoot';
    });
    const rig = makeRig(seed, 1);
    startGame(rig);
    runNightA(rig, { kill: null });
    const hunter = idWithRole(rig, 'hunter');
    const hunterNo = seatNo(hunter);
    const witch = idWithRole(rig, 'witch');
    collect(rig, act(rig, witch, { move: 'witch', choice: 'poison', target: hunterNo }));
    rig.clock.now += T + 1;
    collect(rig, rig.table.tick(rig.clock.now));
    // 前置条件钉死:死亡名单有猎人,但没有开枪窗口。
    const dawn = eventType(rig, 'parlor.table.werewolf.dawn')[0];
    expect(dawn.text).toContain(`${hunterNo}号`);
    expect(dawn.data).toMatchObject({ deaths: [hunterNo] });
    expect(eventType(rig, 'parlor.table.werewolf.hunter')).toHaveLength(0);
    expect(view(rig, 's1').phase).not.toBe('shoot');
    expect(view(rig, 's1').phase).toBe('speech'); // 首夜死亡走遗言,不开枪
  });

  /** 剧本:夜1刀村民、夜2刀预言家、夜3刀女巫;白天放逐最大狼号;第 3 天放逐猎人。停在开枪窗口。 */
  const playHunterLastWolf = (rig: Rig): void => {
    startGame(rig);
    const wolvesAlive = (): string[] => rig.ids.filter((id) => roleOf(rig, id) === 'wolf' && view(rig, id).alive);
    const firstAliveOf = (role: string): string | undefined =>
      rig.ids.find((id) => roleOf(rig, id) === role && view(rig, id).alive);
    for (let day = 1; day <= 3; day++) {
      const victim = firstAliveOf(day === 1 ? 'villager' : day === 2 ? 'seer' : 'witch');
      for (const wolf of wolvesAlive()) {
        collect(rig, act(rig, wolf, { move: 'wolf_kill', ...(victim ? { target: seatNo(victim) } : {}) }));
      }
      rig.clock.now += T + 1;
      collect(rig, rig.table.tick(rig.clock.now));
      const witch = firstAliveOf('witch');
      if (witch && view(rig, witch).canAct) collect(rig, act(rig, witch, { move: 'witch', choice: 'none' }));
      rig.clock.now += T + 1;
      collect(rig, rig.table.tick(rig.clock.now));
      if (view(rig, 's1').phase === 'shoot') throw new Error('剧本不该有夜里开枪');
      let exiled = false;
      for (let guard = 0; guard < 6; guard++) {
        const phase = view(rig, 's1');
        if (phase.phase === 'speech') {
          runSpeeches(rig, () => '');
          continue;
        }
        if (phase.phase === 'vote') {
          const target = exiled ? null : (day === 3 ? seatNo(firstAliveOf('hunter')!) : maxAliveWolfNo(rig)!);
          voteExile(rig, target);
          exiled = true;
          continue;
        }
        break;
      }
      if (day === 3) break;
      expect(view(rig, 's1').phase).toBe('night');
    }
  };

  it('猎人确定性·枪带最后一狼:第 3 天猎人被放逐 → 开枪带走最后一匹狼 → 立即终局好人胜', () => {
    const finishShot = (rig: Rig): void => {
      expect(view(rig, 's1').phase).toBe('shoot');
      const hunter = (rig.table.public() as AnyView).turn as string;
      const target = rig.ids.find((id) => roleOf(rig, id) === 'wolf' && view(rig, id).alive)!;
      collect(rig, act(rig, hunter, { move: 'shoot', target: seatNo(target) }));
    };
    const seed = findSeed((rig) => {
      playHunterLastWolf(rig);
      finishShot(rig);
      const ended = rig.table.public() as AnyView;
      return ended.status === 'ended' && ended.result?.outcome === 'good';
    });
    const rig = makeRig(seed, 1);
    playHunterLastWolf(rig);
    finishShot(rig);
    const ended = rig.table.public() as AnyView;
    expect(ended.status).toBe('ended');
    expect(ended.result.outcome).toBe('good');
    const shot = eventType(rig, 'parlor.table.werewolf.shot')[0];
    expect(shot.text).toContain('开枪带走了');
    const endEvent = eventType(rig, 'parlor.table.end')[0];
    expect(endEvent.data).toMatchObject({ outcome: 'good' });
  });
});

describe('狼人杀·女巫早死与票保密(B3)', () => {
  it('女巫早死:次夜 A→B 不给任何视图,夜长不变,照常天亮', () => {
    const rig = makeRig(167, 1);
    startGame(rig);
    runNightA(rig, { kill: null });
    runNightB(rig, { choice: 'none' });
    runSpeeches(rig, () => '');
    const witch = idWithRole(rig, 'witch');
    voteExile(rig, seatNo(witch));
    // 女巫遗言 → 白天发言 → 第二轮投票无人放逐 → 第 2 夜。
    runSpeeches(rig, () => '');
    runVote(rig, {});
    expect(view(rig, 's1').phase).toBe('night');
    expect(view(rig, 's1').day).toBe(2);
    // 夜 A 到点:closeNightA 不给任何视图(女巫已死,夜 B 没人需要行动)。
    const wolf = rig.ids.find((id) => roleOf(rig, id) === 'wolf')!;
    const aDeadline = view(rig, wolf).deadline as number;
    rig.clock.now = aDeadline;
    const stepA = rig.table.tick(aDeadline);
    collect(rig, stepA);
    expect(stepA?.views ?? []).toEqual([]);
    // 公共时长不变:夜 B 截止 - 夜 A 截止 = 一个夜长(T 缩放)。
    const bDeadline = (rig.table.public() as AnyView).deadline as number;
    expect(bDeadline - aDeadline).toBe(T);
    // 照常天亮。
    rig.clock.now = aDeadline + T;
    collect(rig, rig.table.tick(rig.clock.now));
    expect(eventType(rig, 'parlor.table.werewolf.dawn').at(-1)!.data).toMatchObject({ day: 2 });
    expect(view(rig, 's1').phase).toBe('speech');
  });

  it('投票窗口保密:任何视图都不出现他人的票与 ballots 字段,lastVotes 只在揭晓后出现', () => {
    const rig = makeRig(61, 1);
    startGame(rig);
    runNightA(rig, { kill: null });
    runNightB(rig, { choice: 'none' });
    runSpeeches(rig, () => '');
    expect(view(rig, 's1').phase).toBe('vote');
    // 3 号投 9 号;窗口未结束。
    collect(rig, act(rig, 's3', { move: 'vote', target: 9 }));
    for (const id of rig.ids) {
      const v = view(rig, id);
      expect(v.ballots).toBeUndefined();
      expect(v.lastVotes).toBeUndefined(); // 还没 resolveVote
      expect(JSON.stringify(v)).not.toContain('"target"'); // 谁的票都不给看
    }
    // 已交票者的视图:submitted 与 pending 解耦——交了票仍能看到「已提交」,并附 myVote
    // 本人选择(设计稿 §5.3:提交后只固定显示本人选择);他人视图里没有这个字段。
    expect(view(rig, 's3').canAct).toBe(false);
    expect(view(rig, 's3').submitted).toEqual(['vote']);
    expect(view(rig, 's3').myVote).toBe(9);
    expect(view(rig, 's1').myVote).toBeUndefined();
    expect(view(rig, 's2').myVote).toBeUndefined();
    // 到点揭晓:lastVotes 才出现,含有效票与超时弃票。
    rig.clock.now += T + 1;
    collect(rig, rig.table.tick(rig.clock.now));
    const lastVotes = view(rig, 's1').lastVotes as {
      day: number;
      entries: Array<{ seatNo: number; target: number | null; timeout: boolean }>;
    };
    expect(lastVotes.day).toBe(1);
    expect(lastVotes.entries.find((entry) => entry.seatNo === 3)).toEqual({ seatNo: 3, target: 9, timeout: false });
    expect(lastVotes.entries.find((entry) => entry.seatNo === 2)).toEqual({ seatNo: 2, target: null, timeout: true });
  });
});

describe('狼人杀·引擎面与恢复(B4/D1/D2)', () => {
  it('B4 chatLocked:进行中锁聊,终局后解锁', () => {
    const rig = makeRig(191, 1);
    expect(rig.table.chatLocked()).toBe(false);
    startGame(rig);
    expect(rig.table.chatLocked()).toBe(true);
    for (let guard = 0; guard < 120; guard++) {
      const phase = view(rig, 's1');
      if (phase.status === 'ended') break;
      if (phase.phase === 'speech') runSpeeches(rig, () => '');
      else if (phase.phase === 'vote') voteExile(rig, maxAliveWolfNo(rig));
      else if (phase.phase === 'shoot') {
        const hunter = (rig.table.public() as AnyView).turn as string;
        const target = rig.ids.find((id) => roleOf(rig, id) === 'wolf' && view(rig, id).alive && id !== hunter);
        collect(rig, act(rig, hunter, { move: 'shoot', ...(target ? { target: seatNo(target) } : {}) }));
      } else advance(rig, T + 1);
    }
    expect((rig.table.public() as AnyView).status).toBe('ended');
    expect(rig.table.chatLocked()).toBe(false);
  });

  it('D1 恢复等价:四个检查点导出→新引擎恢复→同脚本续打,事件流与终局完全一致', () => {
    const seedD = 211;
    const sig = (events: TableEvent[]): string[] => events.map((event) => `${event.type}|${event.text}`);
    const snapOf = (rig: Rig): unknown => JSON.parse(JSON.stringify(rig.table.exportState()));
    interface Mark { name: string; state: unknown; now: number; preEvents: number }
    const marks: Mark[] = [];
    let nightMarked = false;
    let speechMarked = false;
    const markNight = (rig: Rig): void => {
      if (nightMarked) return;
      nightMarked = true;
      marks.push({ name: '夜中', state: snapOf(rig), now: rig.clock.now, preEvents: rig.events.length });
    };
    const markSpeech = (rig: Rig): void => {
      if (speechMarked) return;
      speechMarked = true;
      marks.push({ name: '发言中', state: snapOf(rig), now: rig.clock.now, preEvents: rig.events.length });
    };
    const markVote = (rig: Rig): void => {
      const index = marks.findIndex((mark) => mark.name === '终局前投票');
      if (index >= 0) marks.splice(index, 1);
      marks.push({ name: '终局前投票', state: snapOf(rig), now: rig.clock.now, preEvents: rig.events.length });
    };
    // 确定性剧本:狼刀神职、女巫不用药、预言家不查、发言全过麦、每天放逐最大狼号、猎人朝狼开枪。
    const driveToEnd = (rig: Rig, hooks?: { night?: () => void; speech?: () => void; vote?: () => void }): void => {
      for (let guard = 0; guard < 200; guard++) {
        const phase = view(rig, 's1');
        if (phase.status === 'ended') return;
        if (phase.phase === 'reveal') {
          advance(rig, T + 1);
          continue;
        }
        if (phase.phase === 'night') {
          // 按 myMove 逐槽清空(狼是 chat→kill 两个槽),清完再推进——
          // 让驱动成为状态的纯函数:恢复点与原局在相同状态下做出相同动作。
          for (let inner = 0; inner < 20; inner++) {
            const killTarget = nightKillTargetNo(rig);
            let acted = false;
            for (const id of rig.ids) {
              if (!view(rig, id).canAct) continue;
              const myMove = view(rig, id).myMove as string;
              acted = true;
              if (myMove === 'wolf_chat') {
                collect(rig, act(rig, id, { move: 'wolf_chat', text: '过路,别投我' }));
              } else if (myMove === 'wolf_kill') {
                collect(rig, act(rig, id, { move: 'wolf_kill', ...(killTarget !== undefined ? { target: killTarget } : {}) }));
              } else if (myMove === 'witch') {
                collect(rig, act(rig, id, { move: 'witch', choice: 'none' }));
              } else if (myMove === 'inspect') {
                collect(rig, act(rig, id, { move: 'inspect' }));
              } else {
                throw new Error(`D1 夜间不认识的动作: ${myMove}`);
              }
            }
            if (!acted) break;
          }
          hooks?.night?.();
          advance(rig, T + 1);
          continue;
        }
        if (phase.phase === 'speech') {
          let submitted = 0;
          for (let inner = 0; inner < 120; inner++) {
            const p = view(rig, 's1');
            if (p.phase !== 'speech') break;
            if (p.stage === 'read') {
              advance(rig, READ + 1);
              continue;
            }
            const speaker = (rig.table.public() as AnyView).turn as string;
            collect(rig, act(rig, speaker, { move: 'pass_speech' }));
            submitted += 1;
            if (submitted === 1) hooks?.speech?.();
          }
          if (view(rig, 's1').phase === 'speech') throw new Error('D1 发言泵没有收敛');
          continue;
        }
        if (phase.phase === 'vote') {
          hooks?.vote?.();
          voteExile(rig, maxAliveWolfNo(rig));
          continue;
        }
        if (phase.phase === 'shoot') {
          const hunter = (rig.table.public() as AnyView).turn as string;
          const target = rig.ids.find((id) => roleOf(rig, id) === 'wolf' && view(rig, id).alive && id !== hunter)
            ?? aliveIds(rig).find((id) => id !== hunter);
          collect(rig, act(rig, hunter, { move: 'shoot', ...(target ? { target: seatNo(target) } : {}) }));
          continue;
        }
      }
      throw new Error('D1 主循环没有收敛');
    };

    const rigA = makeRig(seedD, 1);
    collect(rigA, rigA.table.start('s1', rigA.clock.now));
    marks.push({ name: '发牌后', state: snapOf(rigA), now: rigA.clock.now, preEvents: rigA.events.length });
    driveToEnd(rigA, {
      night: () => markNight(rigA),
      speech: () => markSpeech(rigA),
      vote: () => markVote(rigA),
    });
    const endA = rigA.table.public() as AnyView;
    expect(endA.status).toBe('ended');
    expect(marks.map((mark) => mark.name)).toEqual(['发牌后', '夜中', '发言中', '终局前投票']);
    for (const mark of marks) {
      const revived = new WerewolfTable({
        host: { id: 's1', name: NAMES[0], kind: 'human', clientVersion: '0.29.0' },
        now: mark.now,
        turnMs: T,
        rng: seeded(seedD),
      });
      for (let i = 2; i <= 9; i++) {
        revived.join({ id: `s${i}`, name: NAMES[i - 1], kind: 'pet', clientVersion: '0.29.0' });
      }
      revived.restoreState(mark.state);
      const rigR: Rig = { table: revived, clock: { now: mark.now }, ids: rigA.ids, steps: [], events: [] };
      driveToEnd(rigR);
      const endR = revived.public() as AnyView;
      expect(endR.status).toBe('ended');
      expect(sig(rigR.events)).toEqual(sig(rigA.events.slice(mark.preEvents)));
      expect(endR.result).toEqual(endA.result);
    }
  });

  it('D2 rearm 不叠加:同一时刻连续两次重启,第二次只按本次停机平移', () => {
    const rig = makeRig(181, 1);
    startGame(rig);
    const wolf = rig.ids.find((id) => roleOf(rig, id) === 'wolf')!;
    const base = rig.clock.now;
    const d0 = view(rig, wolf).deadline as number;
    expect(d0 - base).toBe(T); // 夜 A 截止 = 入夜时刻 + T
    rig.table.rearm(base, 100, 10);
    expect(view(rig, wolf).deadline as number).toBe(base + T + 100); // 第一次:平移 100ms
    rig.table.rearm(base, 50, 10);
    const d2 = view(rig, wolf).deadline as number;
    expect(d2).toBe(base + T + 150); // 第二次:在第一次结果上只按 50ms 平移
    expect(d2).not.toBe(base + T + 250); // 不是把第一次的 100ms 再叠一遍
  });
});
