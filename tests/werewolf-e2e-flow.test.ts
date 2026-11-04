import { describe, expect, it } from 'vitest';
import { WerewolfTable } from '../src/room/games/werewolf-table.ts';
import type { TableEvent, TableStep } from '../src/room/table-engine.ts';

/**
 * 狼人杀端到端对局流：从上桌、开局、夜里行动、白天发言、投票放逐（含平票 PK）
 * 到终局亮身份，一条龙按剧本走完，五角色全部出场。
 *
 * 与 werewolf-table.test.ts（单点规则）和 werewolf-sim.test.ts（随机冲刷）互补，
 * 这里是「导演式」对局：驱动方读各席位私视图拿角色，再按剧本点名谁做什么，
 * 每一步断言公开事件序列与可见性边界。补的缺口：
 * - 女巫首夜自救成功路径、同一夜第二瓶药被拒；
 * - 狼刀/白天投票投已出局玩家被拒；预言家查「好人」的引擎级断言；
 * - 屠边狼胜（神职线、村民线）的引擎级终局；
 * - 开局前离桌再上桌（座号回收）、开局后不能离桌/上新客；
 * - 等人桌 updateClientVersion 全矩阵（0.35.5 重上桌能力续连的引擎侧）；
 * - 平票复投窗口与开枪窗口的存档恢复续打（恢复前后事件流逐条一致）。
 */

const T = 40;
const READ = Math.max(1, Math.round(T / 3));
const NAMES = ['一号', '二号', '三号', '四号', '五号', '六号', '七号', '八号', '九号'];

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
const idByNo = (rig: Rig, no: number): string =>
  (view(rig, 's1').seats as Array<{ seatNo: number; id: string }>).find((seat) => seat.seatNo === no)!.id;
const aliveIds = (rig: Rig): string[] => (view(rig, 's1').seats as Array<{ id: string; alive: boolean }>)
  .filter((seat) => seat.alive).map((seat) => seat.id);
const aliveWolves = (rig: Rig): string[] => rig.ids.filter((id) => roleOf(rig, id) === 'wolf' && view(rig, id).alive);
const aliveSeer = (rig: Rig): string | undefined => rig.ids.find((id) => roleOf(rig, id) === 'seer' && view(rig, id).alive);
const aliveWitch = (rig: Rig): string | undefined => rig.ids.find((id) => roleOf(rig, id) === 'witch' && view(rig, id).alive);

const collect = (rig: Rig, step: TableStep | null): void => {
  if (!step) return;
  rig.steps.push(step);
  rig.events.push(...step.events);
};

const act = (rig: Rig, id: string, body: Record<string, unknown>): TableStep =>
  rig.table.act(id, { windowId: view(rig, id).windowId, ...body }, rig.clock.now);

const startGame = (rig: Rig): void => {
  collect(rig, rig.table.start('s1', rig.clock.now));
  rig.clock.now += T + 1;
  collect(rig, rig.table.tick(rig.clock.now));
  expect(view(rig, 's1').phase).toBe('night');
};

/**
 * 夜A：按 killVotes 给每个狼交刀票（键缺省 = 该狼超时不交，null = 弃刀）；
 * chat 给了就每狼各交一条；inspectTarget 给预言家（null = 显式不查，缺省 = 超时）。
 * 到点锁刀口进入夜B（半段 b）。
 */
const nightA = (
  rig: Rig,
  opts: {
    chat?: string | ((id: string) => string);
    killVotes?: Record<string, number | null>;
    inspectTarget?: number | null;
  } = {},
): void => {
  for (const id of aliveWolves(rig)) {
    if (opts.chat !== undefined) {
      const text = typeof opts.chat === 'function' ? opts.chat(id) : opts.chat;
      collect(rig, act(rig, id, { move: 'wolf_chat', text }));
    }
    if (opts.killVotes && id in opts.killVotes) {
      const target = opts.killVotes[id];
      collect(rig, act(rig, id, { move: 'wolf_kill', ...(target === null ? {} : { target }) }));
    }
  }
  const seer = aliveSeer(rig);
  if (seer && opts.inspectTarget !== undefined) {
    collect(rig, act(rig, seer, { move: 'inspect', ...(opts.inspectTarget === null ? {} : { target: opts.inspectTarget }) }));
  }
  rig.clock.now += T + 1;
  collect(rig, rig.table.tick(rig.clock.now));
  expect(view(rig, 's1').phase).toBe('night');
};

/** 夜B：女巫交药（缺省 = 超时不动）。到点天亮。 */
const nightB = (rig: Rig, witch?: { choice: 'none' | 'save' | 'poison'; target?: number }): void => {
  const witchId = aliveWitch(rig);
  if (witchId && witch) collect(rig, act(rig, witchId, { move: 'witch', ...witch }));
  rig.clock.now += T + 1;
  collect(rig, rig.table.tick(rig.clock.now));
};

/** 顺序发言（白天/PK/遗言）：say 返回文本（'' = 过麦，'timeout' = 超时自动过麦）。 */
const speeches = (rig: Rig, say: (no: number, kind: string) => string | 'timeout'): void => {
  for (let guard = 0; guard < 120; guard++) {
    const v = view(rig, 's1');
    if (v.phase !== 'speech') return;
    if (v.stage === 'read') {
      rig.clock.now += READ + 1;
      collect(rig, rig.table.tick(rig.clock.now));
      continue;
    }
    const speakerId = (rig.table.public() as AnyView).turn as string;
    const said = say(seatNo(speakerId), v.speechKind ?? 'day');
    if (said === 'timeout') {
      rig.clock.now = view(rig, speakerId).deadline + 1;
      collect(rig, rig.table.tick(rig.clock.now));
      continue;
    }
    collect(rig, act(rig, speakerId, said === '' ? { move: 'pass_speech' } : { move: 'speak', text: said }));
  }
  throw new Error('发言循环没有收敛');
};

/** 投票窗口：votes 键 = 投票人座号，值 = 目标座号 | null（弃票）| 缺省（超时）。到点统一揭晓。 */
const vote = (rig: Rig, votes: Record<number, number | null | 'timeout'>): void => {
  expect(view(rig, 's1').phase).toBe('vote');
  for (const id of aliveIds(rig)) {
    const target = votes[seatNo(id)];
    if (target === 'timeout' || target === undefined) continue;
    collect(rig, act(rig, id, { move: 'vote', ...(target === null ? {} : { target }) }));
  }
  rig.clock.now += T + 1;
  collect(rig, rig.table.tick(rig.clock.now));
};

/** 猎人开枪窗口：target = 座号 | null（放弃）。 */
const shoot = (rig: Rig, target: number | null): void => {
  const v = view(rig, 's1');
  expect(v.phase).toBe('shoot');
  const hunterId = idByNo(rig, v.shootHunter as number);
  collect(rig, act(rig, hunterId, { move: 'shoot', ...(target === null ? {} : { target }) }));
};

const eventType = (rig: Rig, type: string): TableEvent[] => rig.events.filter((event) => event.type === type);

/** 公开事件流在终局前不带任何秘密字段（终局事件本身要亮身份，跳过）。 */
const assertPublicNoSecrets = (rig: Rig): void => {
  for (const event of rig.events) {
    if (event.type === 'parlor.table.end') continue;
    const text = JSON.stringify(event);
    expect(text, `公开事件 ${event.type} 泄了身份字段`).not.toMatch(/"role"/);
    expect(text, `公开事件 ${event.type} 泄了狼队秘密`).not.toMatch(/wolfChat|killVotes|lockedKill|teammates/);
    expect(text, `公开事件 ${event.type} 泄了查验/药`).not.toMatch(/inspections|potions|potionLog|knownKill/);
  }
};

/** 每个席位的视图只带自己的秘密：非狼不见狼聊/同伴/刀票，非预言家不见查验，非女巫不见药。 */
const assertViewsNoCrossLeak = (rig: Rig): void => {
  for (const id of rig.ids) {
    const v = view(rig, id);
    if (!v.role) continue;
    const text = JSON.stringify(v);
    if (v.role !== 'wolf') {
      expect(text, `${id}(${v.role}) 的视图泄了狼队秘密`).not.toMatch(/"wolfChat"|"killVotes"|"lockedKill"|"teammates"/);
    }
    if (v.role !== 'seer') expect(text, `${id}(${v.role}) 的视图泄了查验`).not.toContain('"inspections"');
    if (v.role !== 'witch') expect(text, `${id}(${v.role}) 的视图泄了药`).not.toMatch(/"potions"|"potionLog"/);
  }
};

/** 把同一张桌搬到新引擎上（存档恢复），时钟沿用。 */
const revive = (rig: Rig): WerewolfTable => {
  const revived = new WerewolfTable({
    host: { id: 's1', name: NAMES[0], kind: 'human', clientVersion: '0.29.0' },
    now: rig.clock.now,
    turnMs: T,
  });
  revived.restoreState(rig.table.exportState());
  rig.table = revived;
  return revived;
};

describe('狼人杀端到端·主对局（五角色全出场）', () => {
  it('好人胜主线：上桌→第1夜狼聊刀人被救→白天发言/投票放逐狼→第2夜查验+毒药→猎人开枪→终局亮身份', () => {
    const rig = makeRig(7, 1);
    startGame(rig);
    assertViewsNoCrossLeak(rig);

    // —— 第 1 夜：三狼各聊一条、同刀一个村民；预言家查出狼；女巫救 ——
    const wolves3 = aliveWolves(rig);
    expect(wolves3.length).toBe(3);
    const victimId = idWithRole(rig, 'villager');
    const seerId = idWithRole(rig, 'seer');
    const witchId = idWithRole(rig, 'witch');
    const chatters = new Set<string>();
    nightA(rig, {
      chat: (id) => { chatters.add(id); return `${seatNo(id)}号狼：今晚走 ${seatNo(victimId)} 号`; },
      killVotes: Object.fromEntries(wolves3.map((id) => [id, seatNo(victimId)])),
      inspectTarget: seatNo(wolves3[0]),
    });
    expect(chatters.size).toBe(3);
    // 狼聊只到狼：每个狼的视图里三条都在，村民的视图里一个字都没有。
    for (const id of wolves3) {
      expect((view(rig, id).wolfChat as unknown[]).length).toBe(3);
    }
    expect(JSON.stringify(view(rig, victimId))).not.toContain('wolfChat');
    assertViewsNoCrossLeak(rig);
    // 预言家查狼：结果立即进本人私视图与查验历史。
    expect(view(rig, seerId).inspections).toEqual([{ day: 1, target: seatNo(wolves3[0]), result: 'wolf' }]);
    expect(rig.table.privateText(seerId, rig.clock.now)).toContain(`第1夜查 ${seatNo(wolves3[0])}号=狼人`);
    // 女巫看到刀口并使用解药。
    expect(view(rig, witchId).knownKill).toBe(seatNo(victimId));
    expect(view(rig, witchId).potions).toEqual({ antidote: 1, poison: 1 });
    nightB(rig, { choice: 'save' });
    expect(view(rig, witchId).potions).toEqual({ antidote: 0, poison: 1 });
    expect(view(rig, witchId).potionLog).toEqual([{ day: 1, choice: 'save', target: seatNo(victimId) }]);
    // 天亮：平安夜。
    const dawn1 = eventType(rig, 'parlor.table.werewolf.dawn');
    expect(dawn1.length).toBe(1);
    expect(dawn1[0].text).toContain('平安夜');
    assertPublicNoSecrets(rig);

    // —— 第 1 天发言：九人依次；300 字边界、过麦、超时都走一遍 ——
    const order: number[] = [];
    for (let i = 0; i < 9; i++) {
      const v = view(rig, 's1');
      expect(v.phase).toBe('speech');
      expect(v.stage).toBe('speak');
      const speakerId = (rig.table.public() as AnyView).turn as string;
      order.push(seatNo(speakerId));
      if (i === 0) {
        collect(rig, act(rig, speakerId, { move: 'speak', text: '查'.repeat(300) })); // 恰好 300 字放行
      } else if (i === 1) {
        expect(() => act(rig, speakerId, { move: 'speak', text: '超'.repeat(301) })).toThrow(/最多 300 个字/);
        expect(view(rig, speakerId).canAct).toBe(true); // 拒绝不消耗机会，窗口原样保留
        collect(rig, act(rig, speakerId, { move: 'speak', text: '短发言' }));
      } else if (i === 2) {
        collect(rig, act(rig, speakerId, { move: 'pass_speech' }));
      } else if (i === 3) {
        rig.clock.now = view(rig, speakerId).deadline + 1; // 超时按过麦结算
        collect(rig, rig.table.tick(rig.clock.now));
      } else {
        collect(rig, act(rig, speakerId, { move: 'speak', text: `${seatNo(speakerId)}号发言` }));
      }
      rig.clock.now += READ + 1; // 阅读期过后轮到下一位
      collect(rig, rig.table.tick(rig.clock.now));
    }
    expect(order.length).toBe(9);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBe((order[i - 1] % 9) + 1); // 顺时针转一圈
    const daySpeeches = eventType(rig, 'parlor.table.werewolf.speech').filter((e) => (e.data as AnyView).kind === 'day');
    expect(daySpeeches.length).toBe(9);
    expect(daySpeeches[2].text).toContain('过麦');
    expect(daySpeeches[3].text).toContain('过麦');
    assertPublicNoSecrets(rig);

    // —— 第 1 天投票：其余八人齐投首狼（首狼自己弃票）→ 放逐 → 遗言 → 入夜 ——
    const w1 = wolves3[0];
    vote(rig, {
      ...Object.fromEntries(aliveIds(rig).filter((id) => id !== w1).map((id) => [seatNo(id), seatNo(w1)])),
      [seatNo(w1)]: null,
    });
    const vote1 = eventType(rig, 'parlor.table.werewolf.vote').at(-1)!;
    expect((vote1.data as AnyView).exiled).toBe(seatNo(w1));
    expect(vote1.text).toContain('被放逐出局');
    expect(view(rig, w1).alive).toBe(false);
    const lastwords = eventType(rig, 'parlor.table.werewolf.speech_open').filter((e) => (e.data as AnyView).kind === 'lastwords');
    expect(lastwords.length).toBe(1);
    expect((lastwords[0].data as AnyView).seatNo).toBe(seatNo(w1));
    speeches(rig, (no, kind) => {
      expect(kind).toBe('lastwords');
      return no === seatNo(w1) ? `我是 ${no} 号，我是好人` : '';
    });
    expect(view(rig, 's1').phase).toBe('night'); // 放逐遗言后直接入夜，不原地重开白天
    expect(view(rig, 's1').day).toBe(2);
    assertPublicNoSecrets(rig);

    // —— 第 2 夜：预言家查村民=好人；两狼刀猎人；女巫毒一狼 ——
    const wolves2 = aliveWolves(rig);
    expect(wolves2.length).toBe(2);
    const hunterId = idWithRole(rig, 'hunter');
    const anotherVillager = rig.ids.find((id) => roleOf(rig, id) === 'villager' && id !== victimId)!;
    const poisonWolf = wolves2[0];
    nightA(rig, {
      chat: '只剩两位了，按约刀猎人',
      killVotes: Object.fromEntries(wolves2.map((id) => [id, seatNo(hunterId)])),
      inspectTarget: seatNo(anotherVillager),
    });
    const inspections = view(rig, seerId).inspections as Array<{ day: number; target: number; result: string }>;
    expect(inspections.length).toBe(2);
    expect(inspections[1]).toEqual({ day: 2, target: seatNo(anotherVillager), result: 'good' });
    expect(rig.table.privateText(seerId, rig.clock.now)).toContain('=好人');
    // 解药已尽：女巫看不到今夜刀口。
    expect(view(rig, witchId).knownKill).toBeUndefined();
    nightB(rig, { choice: 'poison', target: seatNo(poisonWolf) });
    // 天亮：猎人被刀 + 狼被毒，两死；猎人亮身份进开枪窗口。
    const dawn2 = eventType(rig, 'parlor.table.werewolf.dawn').at(-1)!;
    expect((dawn2.data as AnyView).deaths.sort()).toEqual([seatNo(hunterId), seatNo(poisonWolf)].sort());
    const hunterEvent = eventType(rig, 'parlor.table.werewolf.hunter');
    expect(hunterEvent.length).toBe(1);
    expect(hunterEvent[0].text).toContain('亮出了猎人身份');
    expect(view(rig, 's1').phase).toBe('shoot');
    assertPublicNoSecrets(rig);
    assertViewsNoCrossLeak(rig);

    // —— 猎人开枪带走最后一狼 → 狼人全灭，好人胜 ——
    const lastWolf = aliveWolves(rig)[0];
    shoot(rig, seatNo(lastWolf));
    expect(eventType(rig, 'parlor.table.werewolf.shot').at(-1)!.text).toContain('开枪带走了');
    const end = eventType(rig, 'parlor.table.end').at(-1)!;
    expect((end.data as AnyView).outcome).toBe('good');
    expect(end.text).toContain('好人阵营胜利');
    expect(view(rig, 's1').phase).toBe('ended');
    expect(rig.table.status).toBe('ended');
    // 终局亮身份：公开视图与私文本都给全名单。
    const pub = rig.table.public() as AnyView;
    expect(pub.result.outcome).toBe('good');
    expect(pub.revealed.length).toBe(9);
    expect(pub.revealed.filter((s: AnyView) => s.role === 'wolf').length).toBe(3);
    expect(rig.table.privateText('s1', rig.clock.now)).toContain('好人阵营胜利');
    expect(rig.table.privateText('s1', rig.clock.now)).toContain('全部身份');
    assertPublicNoSecrets(rig); // end 事件之外仍无泄密

    // —— 终局复盘：review 才给夜间明细，且只给桌上的人 ——
    const review = rig.table.tableLog({ review: true }, { seatId: 's1', onTable: true }) as AnyView;
    expect(review.nights.length).toBe(2);
    expect(review.nights[0].wolfChats.length).toBe(3);
    expect(review.nights[0].deaths).toEqual([]); // 被救，无死亡
    expect(review.nights[1].kill).toBe(seatNo(hunterId));
    expect(review.potionLog).toEqual([
      { day: 1, choice: 'save', target: seatNo(victimId) },
      { day: 2, choice: 'poison', target: seatNo(poisonWolf) },
    ]);
    const reviewNoSeat = rig.table.tableLog({ review: true }, { seatId: 's1', onTable: false }) as AnyView;
    expect(reviewNoSeat.nights).toBeUndefined();
  });

  it('屠边狼胜（神职线）：首夜刀预言家+毒猎人双亡各留遗言，白天放逐女巫后立即终局', () => {
    const rig = makeRig(11, 1);
    startGame(rig);
    const seerId = idWithRole(rig, 'seer');
    const hunterId = idWithRole(rig, 'hunter');
    const witchId = idWithRole(rig, 'witch');
    const wolfIds = aliveWolves(rig);

    // 第 1 夜：狼刀预言家（临死前照样查验）；女巫毒猎人。
    nightA(rig, {
      chat: '刀预言家',
      killVotes: Object.fromEntries(wolfIds.map((id) => [id, seatNo(seerId)])),
      inspectTarget: seatNo(wolfIds[0]),
    });
    nightB(rig, { choice: 'poison', target: seatNo(hunterId) });
    // 天亮双亡；被毒的猎人不给开枪窗口。
    expect(eventType(rig, 'parlor.table.werewolf.hunter').length).toBe(0);
    expect(view(rig, 's1').phase).toBe('speech');
    // 首夜出局者各有一次遗言，顺序 = 刀口在前、毒杀在后（开口事件逐位发，此刻只有第一位）。
    const firstLastwords = eventType(rig, 'parlor.table.werewolf.speech_open').filter((e) => (e.data as AnyView).kind === 'lastwords');
    expect(firstLastwords.length).toBe(1);
    expect((firstLastwords[0].data as AnyView).seatNo).toBe(seatNo(seerId));
    const spoken: number[] = [];
    speeches(rig, (no, kind) => {
      if (kind !== 'lastwords') return ''; // 遗言说完引擎接着开白天发言，一并过麦
      spoken.push(no);
      return no === seatNo(seerId) ? `${no}号查过 ${seatNo(wolfIds[0])} 是狼` : '';
    });
    expect(spoken).toEqual([seatNo(seerId), seatNo(hunterId)]);
    const allLastwords = eventType(rig, 'parlor.table.werewolf.speech_open').filter((e) => (e.data as AnyView).kind === 'lastwords');
    expect(allLastwords.map((e) => (e.data as AnyView).seatNo)).toEqual([seatNo(seerId), seatNo(hunterId)]);
    assertPublicNoSecrets(rig);

    // 白天发言（7 人过麦）→ 除女巫外全员投女巫（她本人超时弃票）→ 神职全灭，狼人立即胜利。
    speeches(rig, () => '');
    const witchNo = seatNo(witchId);
    vote(rig, Object.fromEntries(
      aliveIds(rig).filter((id) => id !== witchId).map((id) => [seatNo(id), witchNo]),
    ));
    const end = eventType(rig, 'parlor.table.end').at(-1)!;
    expect((end.data as AnyView).outcome).toBe('wolf');
    expect(end.text).toContain('屠边达成');
    expect(end.text).toContain('狼人阵营胜利');
    expect(((end.data as AnyView).winners as string[]).sort()).toEqual([...wolfIds].sort());
    // 村民线还活着：这是神职线屠边；全场没开过枪。
    const revealed = (end.data as AnyView).roles as Array<{ role: string; alive: boolean }>;
    expect(revealed.filter((s) => s.role === 'villager' && s.alive).length).toBe(3);
    expect(eventType(rig, 'parlor.table.werewolf.shot').length).toBe(0);
    expect(view(rig, 's1').phase).toBe('ended');
    assertPublicNoSecrets(rig);
  });

  it('屠边狼胜（村民线）：三个村民两夜内出局，狼人阵营立即胜利', () => {
    const rig = makeRig(3, 1);
    startGame(rig);
    const wolfIds = aliveWolves(rig);
    const villagers = rig.ids.filter((id) => roleOf(rig, id) === 'villager');

    // 第 1 夜刀村民甲，女巫不动；白天放逐村民乙。
    nightA(rig, {
      killVotes: Object.fromEntries(wolfIds.map((id) => [id, seatNo(villagers[0])])),
      inspectTarget: null,
    });
    nightB(rig, { choice: 'none' });
    speeches(rig, () => '');
    vote(rig, Object.fromEntries(
      aliveIds(rig).filter((id) => id !== villagers[1]).map((id) => [seatNo(id), seatNo(villagers[1])]),
    ));
    expect(view(rig, villagers[1]).alive).toBe(false);
    speeches(rig, () => ''); // 放逐者遗言
    expect(view(rig, 's1').phase).toBe('night');
    expect(view(rig, 's1').day).toBe(2);

    // 第 2 夜刀最后一个村民 → 村民全灭，狼胜（神职都还活着）。
    nightA(rig, { killVotes: Object.fromEntries(wolfIds.map((id) => [id, seatNo(villagers[2])])), inspectTarget: null });
    nightB(rig, { choice: 'none' });
    const end = eventType(rig, 'parlor.table.end').at(-1)!;
    expect((end.data as AnyView).outcome).toBe('wolf');
    expect(end.text).toContain('屠边达成');
    const revealed = (end.data as AnyView).roles as Array<{ role: string; alive: boolean }>;
    expect(revealed.filter((s) => s.role === 'villager' && s.alive).length).toBe(0);
    expect(revealed.filter((s) => s.role === 'seer' && s.alive).length).toBe(1);
    expect(revealed.filter((s) => s.role === 'witch' && s.alive).length).toBe(1);
    assertPublicNoSecrets(rig);
  });

  it('女巫首夜自救：自己被刀、用解药成功、平安夜；解药用尽后次夜不再看刀口', () => {
    const rig = makeRig(23, 1);
    startGame(rig);
    const witchId = idWithRole(rig, 'witch');
    const witchNo = seatNo(witchId);
    const wolfIds = aliveWolves(rig);

    // 第 1 夜：三狼齐刀女巫；女巫自救（首夜允许）。
    nightA(rig, { killVotes: Object.fromEntries(wolfIds.map((id) => [id, witchNo])), inspectTarget: null });
    expect(view(rig, witchId).knownKill).toBe(witchNo);
    expect(rig.table.privateText(witchId, rig.clock.now)).toContain('首夜自救');
    nightB(rig, { choice: 'save' });
    expect(eventType(rig, 'parlor.table.werewolf.dawn').at(-1)!.text).toContain('平安夜');
    expect(view(rig, witchId).alive).toBe(true);
    expect(view(rig, witchId).potions).toEqual({ antidote: 0, poison: 1 });

    // 中间隔一整个白天：全员过麦、投票全超时（无人放逐）→ 入第 2 夜。
    speeches(rig, () => '');
    vote(rig, {});
    expect(view(rig, 's1').day).toBe(2);
    // 第 2 夜：狼刀村民；女巫没有解药 → 看不到刀口、给不出救选项。
    const v2 = idWithRole(rig, 'villager');
    nightA(rig, { killVotes: Object.fromEntries(wolfIds.map((id) => [id, seatNo(v2)])), inspectTarget: null });
    expect(view(rig, witchId).knownKill).toBeUndefined();
    expect(rig.table.privateText(witchId, rig.clock.now)).not.toContain('救 ');
    nightB(rig, { choice: 'none' });
    expect(eventType(rig, 'parlor.table.werewolf.dawn').at(-1)!.text).toContain(`${seatNo(v2)}号`);
    expect(view(rig, v2).alive).toBe(false);
    assertPublicNoSecrets(rig);
  });
});

describe('狼人杀端到端·重上桌与续局', () => {
  const mkOpenTable = (versions: Record<string, string> = {}): WerewolfTable => {
    const table = new WerewolfTable({
      host: { id: 's1', name: NAMES[0], kind: 'human', clientVersion: '0.33.0' },
      now: 1_000_000,
      turnMs: T,
      rng: seeded(5),
    });
    for (let i = 2; i <= 9; i++) {
      const id = `s${i}`;
      table.join({
        id,
        name: NAMES[i - 1],
        kind: 'pet',
        clientVersion: versions[id] ?? '0.33.0',
      });
    }
    return table;
  };

  it('开局前：上桌、离桌、再上桌（座号回收）；重复上桌/开桌者普通离桌/满员都被拒', () => {
    const table = new WerewolfTable({
      host: { id: 's1', name: NAMES[0], kind: 'human', clientVersion: '0.33.0' },
      now: 1_000_000,
      turnMs: T,
    });
    const first = table.join({ id: 'a', name: '阿甲', kind: 'pet', clientVersion: '0.33.0' });
    expect((first.data as AnyView).seatNo).toBe(2);
    table.leave('a');
    const again = table.join({ id: 'a', name: '阿甲', kind: 'pet', clientVersion: '0.33.0' });
    expect((again.data as AnyView).seatNo).toBe(2); // 最小空座号被回收
    expect(() => table.join({ id: 'a', name: '阿甲', kind: 'pet', clientVersion: '0.33.0' })).toThrow(/已经在桌上/);
    table.join({ id: 'b', name: '阿乙', kind: 'pet', clientVersion: '0.33.0' });
    expect(() => table.join({ id: 'b', name: '阿乙', kind: 'pet', clientVersion: '0.33.0' })).toThrow(/已经在桌上/);
    expect(() => table.leave('s1')).toThrow(/收掉/);
    expect(() => table.leave('zz')).toThrow(/不在桌上/);
    for (const id of ['c', 'd', 'e', 'f', 'g', 'h']) {
      table.join({ id, name: `名-${id}`, kind: 'pet', clientVersion: '0.33.0' });
    }
    expect(table.seatIds().length).toBe(9);
    expect(() => table.join({ id: 'j', name: '阿十', kind: 'pet', clientVersion: '0.33.0' })).toThrow(/已经坐满/);
  });

  it('开局后：不能离桌、不能上新客；终局后动作、离桌、上桌都被拒', () => {
    const rig = makeRig(3, 1);
    startGame(rig);
    expect(() => rig.table.leave('s5')).toThrow(/不能中途离开/);
    expect(() => rig.table.join({ id: 'new', name: '新人', kind: 'pet', clientVersion: '0.33.0' })).toThrow(/已经开始了/);
    // 打到终局（村民线屠边）。
    const wolfIds = aliveWolves(rig);
    const villagers = rig.ids.filter((id) => roleOf(rig, id) === 'villager');
    nightA(rig, { killVotes: Object.fromEntries(wolfIds.map((id) => [id, seatNo(villagers[0])])), inspectTarget: null });
    nightB(rig, { choice: 'none' });
    speeches(rig, () => '');
    vote(rig, Object.fromEntries(aliveIds(rig).filter((id) => id !== villagers[1]).map((id) => [seatNo(id), seatNo(villagers[1])])));
    speeches(rig, () => '');
    nightA(rig, { killVotes: Object.fromEntries(wolfIds.map((id) => [id, seatNo(villagers[2])])), inspectTarget: null });
    nightB(rig, { choice: 'none' });
    expect(rig.table.status).toBe('ended');
    const w = aliveWolves(rig)[0];
    expect(() => act(rig, w, { move: 'wolf_chat', text: '结束了还说一句' })).toThrow(/没在玩/);
    expect(() => rig.table.leave('s5')).toThrow(/不能中途离开/);
    expect(() => rig.table.join({ id: 'late', name: '来晚的', kind: 'pet', clientVersion: '0.33.0' })).toThrow(/已经开始了/);
  });

  it('等人桌能力续连：旧版 Coo 自报新版本即解禁并进存档；已开局/真人/未知席位不收', () => {
    const table = mkOpenTable({ s5: '0.28.0' });
    const blockers = (table.view('s1') as AnyView).startBlockers as string[];
    expect(blockers.join('；')).toContain('5号');
    expect(table.updateClientVersion('s5', '0.33.0')).toBe(true);
    expect(((table.view('s1') as AnyView).startBlockers as string[]).length).toBe(0);
    // 能力版本进存档：换一个引擎恢复后仍是新版，开局闸依旧放行。
    const revived = new WerewolfTable({
      host: { id: 's1', name: NAMES[0], kind: 'human', clientVersion: '0.33.0' },
      now: 1_000_000,
      turnMs: T,
      rng: seeded(5),
    });
    revived.restoreState(table.exportState());
    expect(((revived.view('s1') as AnyView).startBlockers as string[]).length).toBe(0);
    expect(() => revived.start('s1', 1_000_000)).not.toThrow();
    expect(revived.updateClientVersion('s4', '0.34.0')).toBe(false); // 已开局不收
    // 真人席位与未知席位不收。
    const open = mkOpenTable();
    expect(open.updateClientVersion('s1', '0.34.0')).toBe(false);
    expect(open.updateClientVersion('nope', '0.34.0')).toBe(false);
  });

  it('存档续局：平票复投窗口带票导出→恢复→同一窗口接着投，终局与不打断的对照完全一致', () => {
    const drive = (interrupt: boolean): { events: TableEvent[]; exiled?: number } => {
      const rig = makeRig(11, 1);
      startGame(rig);
      const wolfIds = aliveWolves(rig);
      const villagers = rig.ids.filter((id) => roleOf(rig, id) === 'villager');
      // 第 1 夜刀村民甲；白天全体过麦；投票 3-3 平票进 PK。
      nightA(rig, { killVotes: Object.fromEntries(wolfIds.map((id) => [id, seatNo(villagers[0])])), inspectTarget: null });
      nightB(rig, { choice: 'none' });
      speeches(rig, () => '');
      const others = aliveIds(rig).filter((id) => id !== villagers[1] && id !== villagers[2]);
      vote(rig, {
        ...Object.fromEntries(others.slice(0, 3).map((id) => [seatNo(id), seatNo(villagers[1])])),
        ...Object.fromEntries(others.slice(3, 6).map((id) => [seatNo(id), seatNo(villagers[2])])),
        [seatNo(villagers[1])]: null,
        [seatNo(villagers[2])]: null,
      });
      const tieEvent = eventType(rig, 'parlor.table.werewolf.vote').at(-1)!;
      expect((tieEvent.data as AnyView).tie.sort()).toEqual([seatNo(villagers[1]), seatNo(villagers[2])].sort());
      speeches(rig, () => ''); // PK 发言两人
      // PK 复投：只有非 PK 席位能投。先交三票。
      const pkVoters = aliveIds(rig).filter((id) => id !== villagers[1] && id !== villagers[2]);
      for (const id of pkVoters.slice(0, 3)) {
        collect(rig, act(rig, id, { move: 'vote', target: seatNo(villagers[1]) }));
      }
      if (interrupt) revive(rig);
      // 剩下三票：两票投甲、一票投乙 → 5-1 放逐甲。
      for (const id of pkVoters.slice(3, 5)) {
        collect(rig, act(rig, id, { move: 'vote', target: seatNo(villagers[1]) }));
      }
      collect(rig, act(rig, pkVoters[5], { move: 'vote', target: seatNo(villagers[2]) }));
      rig.clock.now += T + 1;
      collect(rig, rig.table.tick(rig.clock.now));
      return { events: rig.events, exiled: ((eventType(rig, 'parlor.table.werewolf.vote').at(-1)!.data) as AnyView).exiled as number };
    };

    const straight = drive(false);
    const interrupted = drive(true);
    expect(interrupted.exiled).toBe(straight.exiled);
    expect(interrupted.events).toEqual(straight.events); // 恢复前后事件流逐条一致
  });

  it('存档续局：开枪窗口导出→恢复→猎人仍能开枪，枪响终局与不打断的对照完全一致', () => {
    const drive = (interrupt: boolean): { events: TableEvent[]; outcome: string } => {
      const rig = makeRig(7, 1);
      startGame(rig);
      const wolves3 = aliveWolves(rig);
      const victimId = idWithRole(rig, 'villager');
      const hunterId = idWithRole(rig, 'hunter');
      // 第 1 夜刀村民、女巫救；白天过麦；齐投放逐首狼。
      nightA(rig, { killVotes: Object.fromEntries(wolves3.map((id) => [id, seatNo(victimId)])), inspectTarget: null });
      nightB(rig, { choice: 'save' });
      speeches(rig, () => '');
      const w1 = wolves3[0];
      vote(rig, Object.fromEntries(aliveIds(rig).filter((id) => id !== w1).map((id) => [seatNo(id), seatNo(w1)])));
      speeches(rig, () => '');
      // 第 2 夜两狼刀猎人、女巫毒一狼。
      const wolves2 = aliveWolves(rig);
      nightA(rig, { killVotes: Object.fromEntries(wolves2.map((id) => [id, seatNo(hunterId)])), inspectTarget: null });
      nightB(rig, { choice: 'poison', target: seatNo(wolves2[0]) });
      expect(view(rig, 's1').phase).toBe('shoot');
      if (interrupt) revive(rig);
      shoot(rig, seatNo(aliveWolves(rig)[0]));
      expect(rig.table.status).toBe('ended');
      return { events: rig.events, outcome: ((eventType(rig, 'parlor.table.end').at(-1)!.data) as AnyView).outcome as string };
    };

    const straight = drive(false);
    const interrupted = drive(true);
    expect(interrupted.outcome).toBe(straight.outcome);
    expect(interrupted.events).toEqual(straight.events);
  });
});

describe('狼人杀端到端·动作校验补缺', () => {
  it('狼刀票不能投已出局玩家；女巫同一夜不能交第二瓶药；预言家显式不查后不能再查、夜B狼人不能装女巫', () => {
    const rig = makeRig(31, 1);
    startGame(rig);
    const wolfIds = aliveWolves(rig);
    const witchId = idWithRole(rig, 'witch');
    const seerId = idWithRole(rig, 'seer');
    const villagers = rig.ids.filter((id) => roleOf(rig, id) === 'villager');

    // 第 1 夜：狼刀村民甲；女巫先交「不动」，再想补毒 → 拒（一晚一动作）。
    nightA(rig, { killVotes: Object.fromEntries(wolfIds.map((id) => [id, seatNo(villagers[0])])), inspectTarget: null });
    collect(rig, act(rig, witchId, { move: 'witch', choice: 'none' }));
    expect(() => act(rig, witchId, { move: 'witch', choice: 'poison', target: seatNo(villagers[1]) })).toThrow(/已经交过/);
    nightB(rig);
    expect(view(rig, villagers[0]).alive).toBe(false);
    // 中间隔一整个白天：全员过麦、投票全超时（无人放逐）→ 入第 2 夜。
    speeches(rig, () => '');
    vote(rig, {});
    expect(view(rig, 's1').day).toBe(2);

    // 第 2 夜（半段 A）：狼刀票投已出局的村民甲 → 拒（槽还空着，拒绝不消耗）。
    const w = aliveWolves(rig)[0];
    expect(() => act(rig, w, { move: 'wolf_kill', target: seatNo(villagers[0]) })).toThrow(/只能投给还存活的玩家/);
    // 预言家显式不查后，同一夜不能再查；查自己也被拒。
    collect(rig, act(rig, seerId, { move: 'inspect' }));
    expect(() => act(rig, seerId, { move: 'inspect', target: seatNo(villagers[1]) })).toThrow(/已经交过/);
    expect((view(rig, seerId).inspections as unknown[]).length).toBe(0);
    // 狼补上真正的刀票再锁刀。
    for (const id of aliveWolves(rig)) collect(rig, act(rig, id, { move: 'wolf_kill', target: seatNo(villagers[1]) }));
    rig.clock.now += T + 1;
    collect(rig, rig.table.tick(rig.clock.now)); // 锁刀口进半段 B
    expect(() => act(rig, w, { move: 'witch', choice: 'none' })).toThrow(/只有女巫能做/);
    nightB(rig, { choice: 'none' });
    expect(view(rig, villagers[1]).alive).toBe(false);
    assertPublicNoSecrets(rig);
    assertViewsNoCrossLeak(rig);
  });

  it('预言家不能查自己；查到好人在查验历史里逐夜累计；全弃刀=空刀=平安夜', () => {
    const rig = makeRig(37, 1);
    startGame(rig);
    const seerId = idWithRole(rig, 'seer');
    const wolfIds = aliveWolves(rig);
    const villagerId = idWithRole(rig, 'villager');
    expect(() => act(rig, seerId, { move: 'inspect', target: seatNo(seerId) })).toThrow(/不能选自己/);
    nightA(rig, {
      killVotes: Object.fromEntries(wolfIds.map((id) => [id, null])),
      inspectTarget: seatNo(villagerId),
    });
    nightB(rig, { choice: 'none' });
    expect(view(rig, seerId).inspections).toEqual([{ day: 1, target: seatNo(villagerId), result: 'good' }]);
    expect(eventType(rig, 'parlor.table.werewolf.dawn').at(-1)!.text).toContain('平安夜');
  });

  it('白天投票不能投已出局玩家、不能投自己；放逐照常', () => {
    const rig = makeRig(41, 1);
    startGame(rig);
    const wolfIds = aliveWolves(rig);
    const villagers = rig.ids.filter((id) => roleOf(rig, id) === 'villager');
    nightA(rig, { killVotes: Object.fromEntries(wolfIds.map((id) => [id, seatNo(villagers[0])])), inspectTarget: null });
    nightB(rig, { choice: 'none' });
    speeches(rig, () => '');
    const voter = aliveIds(rig).find((id) => id !== villagers[1])!;
    expect(() => act(rig, voter, { move: 'vote', target: seatNo(villagers[0]) })).toThrow(/只能投给还存活的玩家/);
    expect(() => act(rig, villagers[1], { move: 'vote', target: seatNo(villagers[1]) })).toThrow(/不能投自己/);
    vote(rig, Object.fromEntries(aliveIds(rig).filter((id) => id !== villagers[1]).map((id) => [seatNo(id), seatNo(villagers[1])])));
    expect(view(rig, villagers[1]).alive).toBe(false);
    speeches(rig, () => '');
    expect(view(rig, 's1').day).toBe(2);
  });

  it('过期窗口号被拒：阶段推进后拿旧 windowId 提交不算数', () => {
    const rig = makeRig(43, 1);
    startGame(rig);
    const wolfIds = aliveWolves(rig);
    const villagers = rig.ids.filter((id) => roleOf(rig, id) === 'villager');
    const staleWindow = view(rig, wolfIds[0]).windowId as string;
    nightA(rig, { killVotes: Object.fromEntries(wolfIds.map((id) => [id, seatNo(villagers[0])])), inspectTarget: null });
    nightB(rig, { choice: 'none' });
    speeches(rig, () => '');
    vote(rig, Object.fromEntries(aliveIds(rig).filter((id) => id !== villagers[1]).map((id) => [seatNo(id), seatNo(villagers[1])])));
    speeches(rig, () => ''); // 放逐遗言
    expect(view(rig, 's1').day).toBe(2);
    const w = aliveWolves(rig)[0];
    expect(() => rig.table.act(w, { windowId: staleWindow, move: 'wolf_kill', target: seatNo(villagers[2]) }, rig.clock.now))
      .toThrow(/这个窗口已经结束了/);
  });
});
