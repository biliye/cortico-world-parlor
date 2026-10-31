import { describe, expect, it } from 'vitest';
import { WerewolfTable } from '../src/room/games/werewolf-table.ts';
import type { TableEvent, TableStep } from '../src/room/table-engine.ts';

/**
 * 狼人杀随机对局模拟：不是测某一条规则，而是让几百局完整对局在受控随机下
 * 冲刷状态机，断言无论走到哪条路径都必须成立的「不变量」：
 * - 恰好一个终局；发牌构成精确；出局者永不复活；天数 ≤ 12；
 * - 事件流在终局前不泄露任何 role 字段与狼聊正文；
 * - 任意事件点上 export→restore，续打（同一驱动随机流 + 同一时钟）事件流逐条一致。
 *
 * 引擎在发牌之后不再用 rng，所以「存档 + 驱动随机流 + 时钟」三者定死后续，
 * 恢复等价可以严格比较，而不是抽查字段。
 */

const T = 40; // 缩放时长基准（真人发言 = 2T、其余 = T、阅读 = T/3）
const NAMES = ['一号', '二号', '三号', '四号', '五号', '六号', '七号', '八号', '九号'];

/** 可存取内部状态的 mulberry32：恢复续打要连同随机流一起还原。 */
class Rng {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0; }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  getState(): number { return this.state; }
  setState(state: number): void { this.state = state >>> 0; }
}

type AnyView = Record<string, any>;

/** 三种策略：普通随机 / 全员消极（必须走到第 12 天平局）/ 狼队抱团推人。 */
type Policy = 'random' | 'passive' | 'wolf-bloc';

/** 一局模拟：owns 表、时钟与驱动随机流。 */
class Sim {
  readonly table: WerewolfTable;
  readonly clock = { now: 1_000_000 };
  readonly driver: Rng;
  readonly events: TableEvent[] = [];
  private readonly ids = Array.from({ length: 9 }, (_, i) => `s${i + 1}`);
  private readonly policy: Policy;
  private readonly everDead = new Set<number>();
  private readonly onStep?: (sim: Sim) => void;

  constructor(seed: number, policy: Policy, humans: number, onStep?: (sim: Sim) => void) {
    this.policy = policy;
    this.onStep = onStep;
    this.driver = new Rng(seed ^ 0x9e3779b9);
    const gameRng = new Rng(seed);
    this.table = new WerewolfTable({
      host: { id: 's1', name: NAMES[0], kind: humans >= 1 ? 'human' : 'pet', clientVersion: '0.29.0' },
      now: this.clock.now,
      turnMs: T,
      rng: (): number => gameRng.next(),
    });
    for (let i = 2; i <= 9; i++) {
      this.table.join({ id: `s${i}`, name: NAMES[i - 1], kind: i <= humans ? 'human' : 'pet', clientVersion: '0.29.0' });
    }
  }

  private collect(step: TableStep | null): void {
    if (step) this.events.push(...step.events);
    this.onStep?.(this);
  }

  private view(id: string): AnyView {
    return this.table.view(id) as AnyView;
  }

  private aliveNos(): number[] {
    return (this.view('s1').seats as Array<{ seatNo: number; alive: boolean }>)
      .filter((seat) => seat.alive).map((seat) => seat.seatNo);
  }

  /** 按 view 选一个合法动作；返回 null 表示这个动作留给超时。 */
  private decide(v: AnyView): Record<string, unknown> | null {
    const roll = (): number => this.driver.next();
    const meNo = v.seatNo as number;
    const randomAliveOther = (): number | null => {
      const pool = this.aliveNos().filter((no) => no !== meNo);
      if (pool.length === 0) return null;
      return pool[Math.floor(roll() * pool.length)];
    };
    switch (v.myMove as string) {
      case 'speak': {
        if (this.policy === 'passive' || roll() < 0.2) return { move: 'pass_speech' };
        return { move: 'speak', text: `${meNo}号第${v.day}天发言${Math.floor(roll() * 100000)}（模拟正文）。` };
      }
      case 'vote': {
        if (this.policy === 'passive') return { move: 'vote' };
        if (v.voteVariant === 'pk') {
          if (roll() < 0.15) return { move: 'vote' };
          const seats = (v.pkSeats as number[]) ?? [];
          if (seats.length === 0) return { move: 'vote' };
          return { move: 'vote', target: seats[Math.floor(roll() * seats.length)] };
        }
        if (this.policy === 'wolf-bloc' && v.role === 'wolf') {
          const mates = new Set(((v.teammates as Array<{ seatNo: number }>) ?? []).map((mate) => mate.seatNo));
          const targets = this.aliveNos().filter((no) => no !== meNo && !mates.has(no));
          if (targets.length === 0) return { move: 'vote' };
          return { move: 'vote', target: Math.min(...targets) };
        }
        if (roll() < 0.15) return { move: 'vote' };
        const target = randomAliveOther();
        return target === null ? { move: 'vote' } : { move: 'vote', target };
      }
      case 'wolf_chat': {
        if (this.policy === 'passive') return { move: 'wolf_chat', text: '今晚不动。' };
        return { move: 'wolf_chat', text: `[狼聊${Math.floor(roll() * 100000)}] ${meNo}号在说话。` };
      }
      case 'wolf_kill': {
        if (this.policy === 'passive') return { move: 'wolf_kill' }; // 弃刀
        const mates = new Set(((v.teammates as Array<{ seatNo: number }>) ?? []).map((mate) => mate.seatNo));
        const targets = this.aliveNos().filter((no) => no !== meNo && !mates.has(no));
        if (targets.length === 0) return { move: 'wolf_kill' };
        if (this.policy === 'wolf-bloc') return { move: 'wolf_kill', target: Math.min(...targets) };
        if (roll() < 0.08) return { move: 'wolf_kill' };
        return { move: 'wolf_kill', target: targets[Math.floor(roll() * targets.length)] };
      }
      case 'inspect': {
        if (this.policy === 'passive' || roll() < 0.15) return { move: 'inspect' };
        const target = randomAliveOther();
        return target === null ? { move: 'inspect' } : { move: 'inspect', target };
      }
      case 'witch': {
        if (this.policy === 'passive') return { move: 'witch', choice: 'none' };
        const potions = (v.potions ?? {}) as { antidote: number; poison: number };
        if (potions.antidote > 0 && v.knownKill !== null && v.knownKill !== undefined
          && (v.knownKill !== meNo || v.day === 1) && roll() < 0.5) {
          return { move: 'witch', choice: 'save' };
        }
        if (potions.poison > 0 && roll() < 0.18) {
          const target = randomAliveOther();
          if (target !== null) return { move: 'witch', choice: 'poison', target };
        }
        return { move: 'witch', choice: 'none' };
      }
      case 'shoot': {
        if (this.policy === 'passive' || roll() < 0.3) return { move: 'shoot' };
        const target = randomAliveOther();
        return target === null ? { move: 'shoot' } : { move: 'shoot', target };
      }
      default:
        return null;
    }
  }

  start(): void {
    this.collect(this.table.start('s1', this.clock.now));
  }

  /** 当前窗口的所有行动者交动作 → 推进到截止后一毫秒并 tick。 */
  stepWindow(): void {
    for (let round = 0; round < 3; round++) {
      let acted = false;
      for (const id of this.ids) {
        let v = this.view(id);
        let slots = 0;
        while (v.canAct && v.myMove && slots < 2) {
          const body = this.decide(v);
          if (!body) break;
          this.collect(this.table.act(id, { windowId: v.windowId, ...body }, this.clock.now));
          acted = true;
          slots += 1;
          v = this.view(id);
        }
      }
      if (!acted) break;
    }
    // 不变量：出局者永不复活（每个窗口检查一次）。
    for (const seat of this.view('s1').seats as Array<{ seatNo: number; alive: boolean }>) {
      if (this.everDead.has(seat.seatNo) && seat.alive) {
        throw new Error(`${seat.seatNo} 号在出局后复活了`);
      }
      if (!seat.alive) this.everDead.add(seat.seatNo);
    }
    const pub = this.table.public() as AnyView;
    if (pub.status !== 'playing') return;
    const deadline = pub.deadline as number | undefined;
    if (!deadline || deadline <= this.clock.now) throw new Error('公开截止缺失或不前进');
    this.clock.now = deadline + 1;
    this.collect(this.table.tick(this.clock.now));
  }

  runToEnd(): void {
    let guard = 0;
    while (this.table.status === 'playing') {
      if (++guard > 5000) throw new Error('模拟循环没有收敛（疑似状态机卡死）');
      this.stepWindow();
    }
  }
}

const shapes = (events: TableEvent[]): string => events
  .map((event) => `${event.type}|${event.text}|${JSON.stringify(event.data)}`).join('\n');

const checkCommonInvariants = (sim: Sim, tag: string): void => {
  const events = sim.events;
  const ends = events.filter((event) => event.type === 'parlor.table.end');
  expect(ends, `${tag} 终局事件恰好一条`).toHaveLength(1);
  const endIdx = events.findIndex((event) => event.type === 'parlor.table.end');
  const outcome = (ends[0].data as { outcome: string }).outcome;
  expect(['good', 'wolf', 'draw'], `${tag} 结局合法`).toContain(outcome);
  const roles = (ends[0].data as { roles: Array<{ role: string }> }).roles.map((entry) => entry.role).sort().join(',');
  expect(roles, `${tag} 发牌构成`).toBe('hunter,seer,villager,villager,villager,witch,wolf,wolf,wolf');
  expect((sim.table.public() as AnyView).day as number, `${tag} 天数 ≤ 12`).toBeLessThanOrEqual(12);
  for (const event of events.slice(0, endIdx)) {
    expect(JSON.stringify(event.data ?? {}), `${tag} 事件 ${event.type} 泄了 role`).not.toContain('"role"');
    expect(event.text, `${tag} 事件 ${event.type} 泄了狼聊`).not.toContain('[狼聊');
  }
  // 流程不变量：白天放逐(+遗言)之后必须先入夜，不能原地再开一轮白天发言/投票。
  let lastExileDay = -1;
  let nightAfterExile = true;
  for (const event of events.slice(0, endIdx)) {
    const data = (event.data ?? {}) as { exiled?: number; day?: number; kind?: string };
    if (event.type === 'parlor.table.werewolf.vote' && data.exiled !== undefined) {
      lastExileDay = data.day ?? -1;
      nightAfterExile = false;
    } else if (event.type === 'parlor.table.werewolf.night') {
      nightAfterExile = true;
    } else if ((event.type === 'parlor.table.werewolf.speech_open' && data.kind === 'day')
      || event.type === 'parlor.table.werewolf.vote_open') {
      expect(nightAfterExile, `${tag}: 第${lastExileDay}天放逐后没入夜就又开了白天流程`).toBe(true);
    }
  }
};

describe('狼人杀随机对局模拟', () => {
  it('random 策略 300 局：不变量全部成立，胜负两种结局都出现', { timeout: 300_000 }, () => {
    const outcomes = new Map<string, number>();
    let speeches = 0;
    let pks = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const sim = new Sim(seed, 'random', seed % 2 === 0 ? 2 : 1);
      sim.start();
      sim.runToEnd();
      checkCommonInvariants(sim, `random seed=${seed}`);
      const end = sim.events.find((event) => event.type === 'parlor.table.end')!;
      const outcome = (end.data as { outcome: string }).outcome;
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
      speeches += sim.events.filter((event) => event.type === 'parlor.table.werewolf.speech').length;
      pks += sim.events.filter((event) => event.type === 'parlor.table.werewolf.vote'
        && (event.data as { variant?: string }).variant === 'pk').length;
    }
    expect(outcomes.get('good') ?? 0).toBeGreaterThan(0);
    expect(outcomes.get('wolf') ?? 0).toBeGreaterThan(0);
    expect(speeches).toBeGreaterThan(300);
    expect(pks).toBeGreaterThan(0); // 平票 PK 路径在随机投票下必然出现
  });

  it('passive 策略 30 局：全员消极必须走到第 12 天平局', { timeout: 120_000 }, () => {
    for (let seed = 1; seed <= 30; seed++) {
      const sim = new Sim(seed * 17 + 3, 'passive', seed % 2 === 0 ? 2 : 1);
      sim.start();
      sim.runToEnd();
      checkCommonInvariants(sim, `passive seed=${seed * 17 + 3}`);
      const end = sim.events.find((event) => event.type === 'parlor.table.end')!;
      expect((end.data as { outcome: string }).outcome).toBe('draw');
      expect((sim.table.public() as AnyView).day).toBe(12);
    }
  });

  it('wolf-bloc 策略 120 局：狼队抱团也满足同一套不变量', { timeout: 300_000 }, () => {
    for (let seed = 1; seed <= 120; seed++) {
      const sim = new Sim(seed * 31 + 7, 'wolf-bloc', 1);
      sim.start();
      sim.runToEnd();
      checkCommonInvariants(sim, `wolf-bloc seed=${seed * 31 + 7}`);
    }
  });

  it('恢复等价：40 个事件检查点上 export→restore 续打，事件流逐条一致', { timeout: 300_000 }, () => {
    for (let seed = 100; seed <= 139; seed++) {
      const humans = seed % 3 === 0 ? 2 : 1;
      // 装在盒子里绕开 TS 对闭包赋值的收窄（回调里赋值后，外面仍当作 null）。
      const box: { snapshot: { state: unknown; driverState: number; now: number; cut: number } | null } = { snapshot: null };
      const sim = new Sim(seed, 'random', humans, (s) => {
        // 第 12 个事件点之后的第一步末尾抓快照（不打断原局）。
        if (box.snapshot === null && s.events.length >= 12) {
          box.snapshot = { state: s.table.exportState(), driverState: s.driver.getState(), now: s.clock.now, cut: s.events.length };
        }
      });
      sim.start();
      sim.runToEnd();
      const snapshot = box.snapshot;
      if (!snapshot || sim.events.length < 25) continue;
      // 恢复到快照点续打：同一驱动随机流 + 同一时钟。
      const rest = new Sim(seed, 'random', humans);
      rest.table.restoreState(snapshot.state);
      rest.driver.setState(snapshot.driverState);
      rest.clock.now = snapshot.now;
      rest.runToEnd();
      expect(shapes(rest.events), `seed=${seed} 恢复后续打事件流逐条一致`).toBe(shapes(sim.events.slice(snapshot.cut)));
      const outcomeA = ((sim.events.find((event) => event.type === 'parlor.table.end')!).data as { outcome: string }).outcome;
      const outcomeB = ((rest.events.find((event) => event.type === 'parlor.table.end')!).data as { outcome: string }).outcome;
      expect(outcomeB, `seed=${seed} 恢复后结局一致`).toBe(outcomeA);
    }
  });
});
