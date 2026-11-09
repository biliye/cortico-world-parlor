/**
 * 狼人杀引擎：6／9／12 人局、真人与 Coo 同桌、窗口制多人行动。
 *
 * 与骰子/斗地主的单回合模型不同，这里有三种节奏：
 * - 顺序发言（白天/PK/遗言）：一次一个人，就是传统的 turn；
 * - 同时窗口（投票、夜间、开枪）：多人各有各的动作槽，谁交了都不顶别人；
 * - 固定时长的夜间两段（狼队、预言家与守卫 → 女巫）：对外只显示一个完整的夜晚。
 *
 * 对外可见性（设计稿第 6 节）：
 * - 秘密（身份/查验/狼聊/刀票/用药）只走 `view()`/`privateText()`，
 *   由宿主写成 seat 受众的 `parlor.table.turn`；事件流里只有公开信息；
 * - 窗口开始才产生「决策唤醒」（step.views），队友提交只刷新不叫醒
 *   （step.refreshViews，宿主写成 decision:false 的 turn 事件）。
 *
 * 存档：全部规则状态（含绝对截止时刻）进 `tables.state_json`；
 * 恢复不发牌、不重掷；`rearm` 把所有截止平移停机时长（短停机续局）。
 */
import { randomInt } from 'node:crypto';
import { serverClockLabel } from '../clock.ts';
import {
  GAME_RESPONSE_MAX_BYTES,
  TableError,
  secondsLeft,
  type TableEngine, type TableErrorCode, type TableEvent, type TableLogQuery, type TableSeat, type TableStatus, type TableStep,
} from '../table-engine.ts';
import {
  FACTION_LABELS, ROLE_CARD_LABELS, ROLE_LABELS, ROLE_SKILLS, WEREWOLF_MAX_DAYS, WEREWOLF_SEAT_COUNT,
  cleanSpeech, dealRoles, factionOf, isWerewolfSeatCount, judgeOutcome, tallyVotes, versionAtLeast,
  type WerewolfFaction, type WerewolfRole, type WerewolfSeatCount,
} from './werewolf.ts';

/** 狼人杀要每只 Coo 的 World 都带动作能力；旧版坐得上桌但开不了局。 */
export const WEREWOLF_MIN_CLIENT = '0.29.0';

type SeatKind = 'pet' | 'human';

interface WSeat {
  seatNo: number;
  id: string;
  name: string;
  kind: SeatKind;
  clientVersion?: string;
  role?: WerewolfRole;
  alive: boolean;
  deathDay?: number;
  deathPhase?: 'night' | 'day';
  deathCause?: 'wolf' | 'poison' | 'wolf_poison' | 'vote' | 'shot';
  shotUsed?: boolean;
}

type PhaseKind = 'reveal' | 'night' | 'speech' | 'vote' | 'shoot' | 'ended';

interface Phase {
  kind: PhaseKind;
  /** 夜间内部半段：a = 狼队+预言家，b = 女巫。只在 kind=night 有意义。 */
  half?: 'a' | 'b';
  /** 顺序发言的小类。 */
  speechKind?: 'day' | 'pk' | 'lastwords';
  /** 投票轮次：day = 白天投票，pk = 平票复投。 */
  voteVariant?: 'day' | 'pk';
  /** 发言队列（座号）与当前位置；shoot 时是猎人座号；pk 投票时是 PK 席位。 */
  queue: number[];
  index: number;
  stage: 'speak' | 'read' | 'act';
  /** 本人/本窗口截止。夜间对外只报天亮时刻（= b 段截止）。 */
  deadline: number;
  /** 阅读期截止（发言提交/过麦后）。 */
  readUntil: number;
  windowId: string;
}

interface SpeechEntry {
  day: number;
  kind: 'day' | 'pk' | 'lastwords';
  seatNo: number;
  text: string;
  passed: boolean;
}

interface VoteRound {
  day: number;
  variant: 'day' | 'pk';
  entries: Array<{ seatNo: number; target: number | null; timeout: boolean }>;
  exiled?: number;
  tie?: number[];
}

interface DeathRecord {
  seatNo: number;
  day: number;
  phase: 'night' | 'day';
  cause: 'wolf' | 'poison' | 'wolf_poison' | 'vote' | 'shot';
}

interface InspectionRecord { day: number; target: number; result: 'wolf' | 'good' }

interface NightRecord {
  day: number;
  kill: number | null;
  saved: boolean;
  guarded?: number | null;
  poison?: number;
  wolfChats: Array<{ seatNo: number; text: string }>;
  killVotes: Array<[number, number | null]>;
  inspections: Array<{ target: number; result: 'wolf' | 'good' }>;
  deaths: Array<{ seatNo: number; cause: string }>;
}

interface WorkingNight {
  day: number;
  wolfChats: Array<{ seatNo: number; text: string }>;
  killVotes: Map<number, number | null>;
  inspect: { target: number; result: 'wolf' | 'good' } | null;
  inspectDone: boolean;
  /** A 段锁定；B 段据此给女巫刀口。null = 空刀。 */
  kill: number | null;
  saved: boolean;
  guarded?: number | null;
  poison?: number;
  witchDone: boolean;
}

interface Durations {
  revealMs: number;
  nightMs: number;
  humanSpeechMs: number;
  cooSpeechMs: number;
  readMs: number;
  voteMs: number;
  shootMs: number;
}

const DEFAULT_DURATIONS: Durations = {
  revealMs: 15_000,
  nightMs: 60_000,
  humanSpeechMs: 180_000,
  cooSpeechMs: 60_000,
  readMs: 20_000,
  voteMs: 60_000,
  shootMs: 60_000,
};

/** 测试把 turnMs 当基准单位：比例不变、整体缩短。 */
const scaledDurations = (base: number): Durations => ({
  revealMs: base,
  nightMs: base,
  humanSpeechMs: base * 3,
  cooSpeechMs: base,
  readMs: Math.max(1, Math.round(base / 3)),
  voteMs: base,
  shootMs: base,
});

const SPEECH_LIMIT = 300;
const WOLF_CHAT_LIMIT = 150;
const WOLF_CHAT_MESSAGES = 2;

export interface WerewolfTableOptions {
  host: { id: string; name: string; kind?: 'pet' | 'human'; clientVersion?: string };
  now: number;
  requireHuman?: boolean;
  seatCount?: WerewolfSeatCount;
  /** 测试基准时长；不传用正式默认（真人 180 秒 / Coo 60 秒 / 阅读 20 秒）。 */
  turnMs?: number;
  rng?: () => number;
}

export class WerewolfTable implements TableEngine {
  readonly game = 'werewolf';
  readonly label = '狼人杀';
  readonly stateVersion = 1;
  status: TableStatus = 'open';
  readonly host: string;

  private readonly rng: () => number;
  private readonly durations: Durations;
  private requireHuman: boolean;
  private seatCount: WerewolfSeatCount;
  private readonly seats: WSeat[] = [];
  private phase: Phase = { kind: 'reveal', queue: [], index: 0, stage: 'act', deadline: 0, readUntil: 0, windowId: 'w0' };
  private day = 0;
  private dayStart = 1;
  private windowSeq = 0;
  private speeches: SpeechEntry[] = [];
  private voteRounds: VoteRound[] = [];
  private deaths: DeathRecord[] = [];
  private pendingLastWords: number[] = [];
  private pendingShoots: number[] = [];
  /** 遗言队列说完后的去向：true = 白天放逐后的遗言（接夜晚）；false = 天亮后的遗言（接白天发言）。 */
  private lastWordsFromExile = false;
  private night: WorkingNight | null = null;
  private nightLog: NightRecord[] = [];
  private inspections: InspectionRecord[] = [];
  private potions = { antidote: 1, poison: 1 };
  private potionLog: Array<{ day: number; choice: 'save' | 'poison'; target: number }> = [];
  /** 当前投票窗口的票（座号 → 目标/弃）。 */
  private ballots = new Map<number, number | null>();
  private result?: { outcome: 'good' | 'wolf' | 'draw'; winners: string[] };
  /** 刚动作过的席位与动作：给「回执附带私视图」用，不进存档。 */
  private lastAction?: { seatNo: number; kind: string };

  constructor(options: WerewolfTableOptions) {
    this.host = options.host.id;
    this.requireHuman = options.requireHuman === true;
    this.seatCount = options.seatCount ?? WEREWOLF_SEAT_COUNT;
    this.rng = options.rng ?? ((): number => randomInt(0, 0x7fffffff) / 0x7fffffff);
    this.durations = options.turnMs ? scaledDurations(options.turnMs) : DEFAULT_DURATIONS;
    this.seats.push({
      seatNo: 1,
      id: options.host.id,
      name: options.host.name,
      kind: options.host.kind === 'human' ? 'human' : 'pet',
      ...(options.host.clientVersion ? { clientVersion: options.host.clientVersion } : {}),
      alive: true,
    });
  }

  // —— 契约：席位 ——

  has(seatId: string): boolean {
    return this.seats.some((seat) => seat.id === seatId);
  }

  seatIds(): string[] {
    return this.seats.map((seat) => seat.id);
  }

  private seatOf(seatId: string): WSeat | undefined {
    return this.seats.find((seat) => seat.id === seatId);
  }

  private seatByNo(seatNo: number): WSeat | undefined {
    return this.seats.find((seat) => seat.seatNo === seatNo);
  }

  private aliveSeats(): WSeat[] {
    return this.seats.filter((seat) => seat.alive).sort((left, right) => left.seatNo - right.seatNo);
  }

  private allSeatIds(): string[] {
    return this.seats.map((seat) => seat.id);
  }

  private labelOf(seatNo: number): string {
    const seat = this.seatByNo(seatNo);
    return seat ? `${seatNo}号 ${seat.name}` : `${seatNo}号`;
  }

  /** 只更新等人桌本席位的能力；缺头不擦掉原记录，已开局不改。 */
  updateClientVersion(seatId: string, version: string): boolean {
    const seat = this.seatOf(seatId);
    if (this.status !== 'open' || !seat || seat.kind !== 'pet' || seat.clientVersion === version) return false;
    seat.clientVersion = version;
    return true;
  }

  private startBlockers(): string[] {
    const issues: string[] = [];
    if (this.seats.length !== this.seatCount) {
      issues.push(`狼人杀要正好 ${this.seatCount} 个人，现在 ${this.seats.length} 个`);
    }
    const pets = this.seats.filter((seat) => seat.kind === 'pet');
    if (this.requireHuman && !this.seats.some((seat) => seat.kind === 'human')) {
      issues.push('这张狼人杀桌要求至少一名真人入座');
    }
    if (!pets.length) issues.push('狼人杀要至少一只 Coo 同桌');
    const stale = pets.filter((seat) => !versionAtLeast(seat.clientVersion, WEREWOLF_MIN_CLIENT));
    if (stale.length) {
      issues.push(`这些 Coo 的客厅扩展还没有狼人杀能力（旧版 World）：${stale.map((seat) => `${seat.seatNo}号 ${seat.name}`).join('、')}。请先升级他们的扩展到 ≥ ${WEREWOLF_MIN_CLIENT} 再开局。`);
    }
    return issues;
  }

  join(seat: TableSeat): TableEvent {
    if (this.status !== 'open') throw new WerewolfError('not_open', '这张桌子已经开始了');
    if (this.has(seat.id)) throw new WerewolfError('seated', '你已经在桌上了');
    if (this.seats.length >= this.seatCount) {
      throw new WerewolfError('full', `狼人杀固定 ${this.seatCount} 席，已经坐满了`);
    }
    const kind = seat.kind === 'human' ? 'human' : 'pet';
    const used = new Set(this.seats.map((entry) => entry.seatNo));
    let seatNo = 1;
    while (used.has(seatNo)) seatNo += 1;
    this.seats.push({
      seatNo,
      id: seat.id,
      name: seat.name,
      kind,
      ...(seat.clientVersion ? { clientVersion: seat.clientVersion } : {}),
      alive: true,
    });
    return {
      type: 'parlor.table.join',
      scope: { kind: 'room' },
      text: `${seat.name} 坐到了狼人杀桌的 ${seatNo} 号位。`,
      data: { game: this.game, seat: seat.id, seatNo },
    };
  }

  /** 未开局时离桌；开局后不能离（宿主先挡，这里兜一层）。 */
  leave(seatId: string): TableEvent {
    if (this.status !== 'open') throw new WerewolfError('not_open', '这张桌子已经开始，不能中途离开');
    const index = this.seats.findIndex((seat) => seat.id === seatId);
    if (index < 0) throw new WerewolfError('not_seated', '你不在桌上');
    if (seatId === this.host) throw new WerewolfError('not_host', '开桌的人要走请把桌子收掉');
    const [seat] = this.seats.splice(index, 1);
    return {
      type: 'parlor.table.left',
      scope: { kind: 'room' },
      text: `${seat.name} 离开了狼人杀桌。`,
      data: { game: this.game, seat: seat.id },
    };
  }

  // —— 契约：开局 ——

  start(by: string, now: number): TableStep {
    if (this.status !== 'open') throw new WerewolfError('not_open', '这张桌子已经开始了');
    if (by !== this.host) throw new WerewolfError('not_host', '只有开桌的人可以开始');
    const blocked = this.startBlockers()[0];
    if (blocked) throw new WerewolfError('not_open', blocked);
    this.status = 'playing';
    const roles = dealRoles(this.rng, this.seatCount);
    this.seats.forEach((seat, index) => { seat.role = roles[index]; });
    this.day = 1;
    this.dayStart = 1 + Math.floor(this.rng() * this.seatCount);
    const names = this.seats.map((seat) => `${seat.seatNo}号 ${seat.name}`).join('、');
    const events: TableEvent[] = [
      {
        type: 'parlor.table.start',
        scope: { kind: 'room' },
        text: `狼人杀开局：${names}。先看身份 ${Math.round(this.durations.revealMs / 1000)} 秒，之后进入第 1 夜。`,
        data: { game: this.game },
      },
    ];
    this.beginReveal(now);
    return { events, views: this.seats.map((seat) => seat.id) };
  }

  private beginReveal(now: number): void {
    this.phase = {
      kind: 'reveal', queue: [], index: 0, stage: 'act',
      deadline: now + this.durations.revealMs, readUntil: 0,
      windowId: this.nextWindowId(),
    };
  }

  private nextWindowId(): string {
    this.windowSeq += 1;
    return `w${this.windowSeq}`;
  }

  // —— 契约：动作 ——

  /**
   * 窗口制入口。宿主（window 模式）不做整桌 revision 校验，这里在
   * 「最新已提交快照」上校验 windowId 与动作槽：窗口变了、槽占了的都拒绝。
   */
  act(seatId: string, input: unknown, now: number): TableStep {
    if (this.status !== 'playing') throw new WerewolfError('not_started', '这张桌子没在玩');
    const seat = this.seatOf(seatId);
    if (!seat) throw new WerewolfError('not_seated', '你不在桌上');
    const action = (input ?? {}) as { move?: unknown; windowId?: unknown; text?: unknown; target?: unknown };
    const move = typeof action.move === 'string' ? action.move : '';
    const windowId = typeof action.windowId === 'string' ? action.windowId : '';
    if (!windowId) throw new WerewolfError('bad_action', '缺少 windowId：先看一眼桌面（parlor_game_info {op:"state"}），动作要带上窗口号');
    if (windowId !== this.phase.windowId) {
      throw new WerewolfError('expired', '这个窗口已经结束了：桌面进入了新阶段，重新看一眼再提交');
    }
    // 设计稿 §4：服务端 now >= deadline 即超时，恰好到点不接受——不靠「tick 是否已执行」，
    // 免得截止后、下一秒 tick 前挤进来的动作偷偷改变结算结果。超时的默认动作由 tick 统一做。
    if (this.phase.deadline > 0 && now >= this.phase.deadline) {
      throw new WerewolfError('expired', '这个窗口的截止时刻已过：这次提交不算，服务器按超时处理');
    }
    switch (this.phase.kind) {
      case 'reveal':
        throw new WerewolfError('bad_action', '现在是看身份阶段，不用做任何操作');
      case 'night':
        return this.actNight(seat, move, action, now);
      case 'speech':
        return this.actSpeech(seat, move, action, now);
      case 'vote':
        return this.actVote(seat, move, action, now);
      case 'shoot':
        return this.actShoot(seat, move, action, now);
      default:
        throw new WerewolfError('bad_action', '这局已经结束了');
    }
  }

  private requireWindowNotDone(seat: WSeat, done: boolean): void {
    if (done) throw new WerewolfError('bad_action', '这个窗口里你的动作已经交过了，等下一次叫你');
    if (!seat.alive) throw new WerewolfError('not_turn', '你已经出局，不能行动');
  }

  private parseTarget(target: unknown): number | undefined {
    if (target === undefined || target === null) return undefined;
    const value = Number(target);
    if (!Number.isSafeInteger(value)) throw new WerewolfError('bad_action', `目标要用座号（1～${this.seatCount} 的整数）`);
    return value;
  }

  private requireAliveOther(target: number | undefined, actor: WSeat, what: string): number {
    if (target === undefined) throw new WerewolfError('bad_action', `${what}要给一个座号`);
    const victim = this.seatByNo(target);
    if (!victim) throw new WerewolfError('bad_action', `没有 ${target} 号这个座位`);
    if (!victim.alive) throw new WerewolfError('bad_action', `${this.labelOf(target)} 已经出局了`);
    if (victim.seatNo === actor.seatNo) throw new WerewolfError('bad_action', `${what}不能选自己`);
    return target;
  }

  private actNight(seat: WSeat, move: string, action: { text?: unknown; target?: unknown }, now: number): TableStep {
    const half = this.phase.half ?? 'a';
    if (half === 'a') {
      const role = seat.role;
      if (move === 'wolf_chat' || move === 'wolf_kill') {
        if (role !== 'wolf') throw new WerewolfError('not_turn', '这个动作只有狼人能做');
        const night = this.night!;
        this.requireWindowNotDone(seat, move === 'wolf_chat'
          ? this.wolfChatRemaining(seat) <= 0
          : night.killVotes.has(seat.seatNo));
        if (move === 'wolf_chat') {
          const text = cleanSpeech(action.text, WOLF_CHAT_LIMIT);
          night.wolfChats.push({ seatNo: seat.seatNo, text });
        } else {
          const target = this.parseTarget(action.target);
          if (target !== undefined && !this.seatByNo(target)?.alive) {
            throw new WerewolfError('bad_action', '刀票只能投给还存活的玩家');
          }
          night.killVotes.set(seat.seatNo, target ?? null);
        }
        this.lastAction = { seatNo: seat.seatNo, kind: move };
        // 同伴的私视图刷新（不叫醒）。
        return this.nightRefresh([seat.seatNo], this.aliveSeats().filter((entry) => entry.role === 'wolf').map((entry) => entry.seatNo));
      }
      if (move === 'guard') {
        if (role !== 'guard') throw new WerewolfError('not_turn', '这个动作只有守卫能做');
        this.requireWindowNotDone(seat, this.night!.guarded !== undefined);
        const target = this.parseTarget(action.target);
        if (target !== undefined) {
          if (!this.seatByNo(target)?.alive) throw new WerewolfError('bad_action', '只能守护还存活的玩家');
          if (target === this.nightLog.at(-1)?.guarded) {
            throw new WerewolfError('bad_action', '不能连续两晚守护同一人');
          }
        }
        this.night!.guarded = target ?? null;
        this.lastAction = { seatNo: seat.seatNo, kind: move };
        return this.nightRefresh([seat.seatNo], []);
      }
      if (move === 'inspect') {
        if (role !== 'seer') throw new WerewolfError('not_turn', '这个动作只有预言家能做');
        this.requireWindowNotDone(seat, this.night!.inspectDone);
        const target = this.parseTarget(action.target);
        if (target === undefined) {
          // 显式不查验：也算交过这个夜晚的槽。
          this.night!.inspectDone = true;
          this.lastAction = { seatNo: seat.seatNo, kind: move };
          return this.nightRefresh([seat.seatNo], []);
        }
        this.requireAliveOther(target, seat, '查验');
        const victim = this.seatByNo(target)!;
        const result: 'wolf' | 'good' = victim.role === 'wolf' ? 'wolf' : 'good';
        this.night!.inspect = { target, result };
        this.night!.inspectDone = true;
        this.inspections.push({ day: this.day, target, result });
        this.lastAction = { seatNo: seat.seatNo, kind: move };
        return this.nightRefresh([seat.seatNo], []);
      }
      throw new WerewolfError('bad_action', '夜晚阶段能做的动作：狼人 wolf_chat / wolf_kill，预言家 inspect，守卫 guard');
    }
    // —— B 段：女巫 ——
    if (move !== 'witch') throw new WerewolfError('bad_action', '这个阶段只有女巫能用药（move: witch）');
    if (seat.role !== 'witch') throw new WerewolfError('not_turn', '这个动作只有女巫能做');
    this.requireWindowNotDone(seat, this.night!.witchDone);
    const choice = typeof (action as { choice?: unknown }).choice === 'string' ? (action as { choice: string }).choice : '';
    if (choice !== 'none' && choice !== 'save' && choice !== 'poison') {
      throw new WerewolfError('bad_action', 'choice 只能是 none / save / poison');
    }
    if (choice === 'save') {
      if (this.potions.antidote <= 0) throw new WerewolfError('bad_action', '解药已经用掉了');
      if (this.night!.kill === null) throw new WerewolfError('bad_action', '今夜没有刀口，救不了人');
      if (this.day !== 1 && this.night!.kill === seat.seatNo) {
        throw new WerewolfError('bad_action', '自救只有第一夜可以，之后不能自救');
      }
      this.potions.antidote -= 1;
      this.night!.saved = true;
      this.potionLog.push({ day: this.day, choice: 'save', target: this.night!.kill });
    } else if (choice === 'poison') {
      if (this.potions.poison <= 0) throw new WerewolfError('bad_action', '毒药已经用掉了');
      const target = this.requireAliveOther(this.parseTarget(action.target), seat, '毒药');
      this.potions.poison -= 1;
      this.night!.poison = target;
      this.potionLog.push({ day: this.day, choice: 'poison', target });
    }
    this.night!.witchDone = true;
    this.lastAction = { seatNo: seat.seatNo, kind: move };
    return this.nightRefresh([seat.seatNo], []);
  }

  private actSpeech(seat: WSeat, move: string, action: { text?: unknown }, now: number): TableStep {
    const phase = this.phase;
    if (phase.stage !== 'speak') throw new WerewolfError('bad_action', '现在是阅读时间，等下一位发言');
    const current = phase.queue[phase.index];
    if (current !== seat.seatNo) {
      throw new WerewolfError('not_turn', `现在轮到 ${this.labelOf(current)} 发言，还没轮到你`);
    }
    const kindLabel = phase.speechKind === 'lastwords' ? '遗言' : phase.speechKind === 'pk' ? 'PK 发言' : '发言';
    if (move === 'pass_speech') {
      return this.closeSpeech(now, { seatNo: seat.seatNo, text: '', passed: true });
    }
    if (move !== 'speak') throw new WerewolfError('bad_action', `发言机会只能用 speak（说一句）或 pass_speech（过麦）；每次 ${kindLabel}只有一条`);
    let text: string;
    try {
      text = cleanSpeech(action.text, SPEECH_LIMIT);
    } catch (error) {
      // 非法正文不消耗机会：转成 bad_action 报给客户端，窗口原样保留。
      throw new WerewolfError('bad_action', (error as Error).message);
    }
    return this.closeSpeech(now, { seatNo: seat.seatNo, text, passed: false });
  }

  private actVote(seat: WSeat, move: string, action: { target?: unknown }, now: number): TableStep {
    if (move !== 'vote') throw new WerewolfError('bad_action', '投票窗口只能用 move: vote');
    if (!seat.alive) throw new WerewolfError('not_turn', '你已经出局，不能投票');
    // 平票复投只有非 PK 的存活者能投；PK 席位连弃票都不交。
    if (this.phase.voteVariant === 'pk' && this.phase.queue.includes(seat.seatNo)) {
      throw new WerewolfError('not_turn', '你在 PK 名单里，这一轮复投不参与投票');
    }
    if (this.ballots.has(seat.seatNo)) throw new WerewolfError('bad_action', '你已经投过了；提交后不能改');
    const target = this.parseTarget(action.target);
    if (target !== undefined) {
      const victim = this.seatByNo(target);
      if (!victim || !victim.alive) throw new WerewolfError('bad_action', '只能投给还存活的玩家');
      if (victim.seatNo === seat.seatNo) throw new WerewolfError('bad_action', '不能投自己');
      if (this.phase.voteVariant === 'pk' && !this.phase.queue.includes(target)) {
        throw new WerewolfError('bad_action', '平票复投只能投给进入 PK 的席位，或弃票');
      }
    }
    this.ballots.set(seat.seatNo, target ?? null);
    this.lastAction = { seatNo: seat.seatNo, kind: move };
    return { events: [], views: [], refreshViews: [seat.id] };
  }

  private actShoot(seat: WSeat, move: string, action: { target?: unknown }, now: number): TableStep {
    if (move !== 'shoot') throw new WerewolfError('bad_action', '这个窗口只能用 move: shoot 开枪或放弃');
    if (this.phase.queue[0] !== seat.seatNo) throw new WerewolfError('not_turn', '现在不是你的开枪窗口');
    const target = this.parseTarget(action.target);
    if (target === undefined) {
      // 放弃开枪。
      return this.resolveShoot(now, null, {
        type: 'parlor.table.werewolf.shot',
        scope: { kind: 'room' },
        text: `${this.labelOf(seat.seatNo)}（猎人）放弃了开枪。`,
        data: { game: this.game, hunter: seat.seatNo, gaveUp: true },
      });
    }
    this.requireAliveOther(target, seat, '开枪');
    return this.resolveShoot(now, target, {
      type: 'parlor.table.werewolf.shot',
      scope: { kind: 'room' },
      text: `${this.labelOf(seat.seatNo)}（猎人）开枪带走了 ${this.labelOf(target)}！`,
      data: { game: this.game, hunter: seat.seatNo, target },
    });
  }

  // —— 夜间与天亮 ——

  private nightRefresh(views: number[], refresh: number[]): TableStep {
    return { events: [], views: this.seatIdsByNo(views), refreshViews: this.seatIdsByNo(refresh) };
  }

  private seatIdsByNo(seatNos: number[]): string[] {
    return seatNos
      .map((seatNo) => this.seatByNo(seatNo))
      .filter((seat): seat is WSeat => !!seat)
      .map((seat) => seat.id);
  }

  /**
   * 天亮：结算死亡（刀/毒/刀毒同中）、亮死亡名单、排猎人开枪。
   * 一批死亡与可触发的开枪全部处理完，才判胜负、排遗言与白天。
   */
  private resolveNight(now: number): TableStep {
    const night = this.night!;
    const events: TableEvent[] = [];
    // 单独守护或救治能挡住狼刀，同时生效则仍然中刀。
    const protectedByGuard = night.kill !== null && night.guarded === night.kill;
    const wolfKilled = night.kill !== null && night.saved === protectedByGuard;
    const causeOf = (seatNo: number): DeathRecord['cause'] => {
      const killed = night.kill === seatNo && wolfKilled;
      const poisoned = night.poison === seatNo;
      if (killed && poisoned) return 'wolf_poison';
      if (killed) return 'wolf';
      return 'poison';
    };
    const dead: number[] = [];
    if (night.kill !== null && wolfKilled) dead.push(night.kill);
    if (night.poison !== undefined && !dead.includes(night.poison)) dead.push(night.poison);
    // 刀毒同中时只有一个死条目，cause 合并成 wolf_poison（见 causeOf）。
    for (const seatNo of dead) {
      this.kill(seatNo, this.day, 'night', causeOf(seatNo));
      // 遗言资格：首夜出局（含首夜被枪带走的，后面开枪时再补）各有一次。
      if (this.day === 1) this.pendingLastWords.push(seatNo);
    }
    this.nightLog.push({
      day: night.day,
      kill: night.kill,
      saved: night.saved,
      ...(night.guarded !== undefined ? { guarded: night.guarded } : {}),
      ...(night.poison !== undefined ? { poison: night.poison } : {}),
      wolfChats: night.wolfChats.map((entry) => ({ ...entry })),
      killVotes: [...night.killVotes.entries()],
      inspections: night.inspect ? [{ ...night.inspect }] : [],
      deaths: dead.map((seatNo) => ({ seatNo, cause: causeOf(seatNo) })),
    });
    if (dead.length > 0) {
      const list = dead.sort((left, right) => left - right).map((seatNo) => this.labelOf(seatNo)).join('、');
      events.push({
        type: 'parlor.table.werewolf.dawn',
        scope: { kind: 'room' },
        text: `天亮了。昨夜 ${list} 出局。`,
        data: { game: this.game, day: this.day, deaths: dead.sort((left, right) => left - right) },
      });
    } else {
      events.push({
        type: 'parlor.table.werewolf.dawn',
        scope: { kind: 'room' },
        text: '天亮了，昨夜是平安夜。',
        data: { game: this.game, day: this.day, deaths: [] },
      });
    }
    this.night = null;
    // 猎人触发：夜里被刀（非中毒）的猎人。
    for (const seatNo of dead) {
      const seat = this.seatByNo(seatNo)!;
      if (seat.role === 'hunter' && seat.deathCause !== 'poison' && seat.deathCause !== 'wolf_poison' && !seat.shotUsed) {
        this.pendingShoots.push(seatNo);
      }
    }
    return this.proceedAfterDeaths(now, events);
  }

  /** 击杀登记：出局、记因；白天放逐/枪杀在此一并处理。 */
  private kill(seatNo: number, day: number, phase: 'night' | 'day', cause: DeathRecord['cause']): void {
    const seat = this.seatByNo(seatNo)!;
    seat.alive = false;
    seat.deathDay = day;
    seat.deathPhase = phase;
    seat.deathCause = cause;
    this.deaths.push({ seatNo, day, phase, cause });
  }

  /**
   * 一批死亡后的推进：猎人窗口 → 判胜负 → 遗言 → 白天/入夜。
   * 事件由调用方累积进来。
   */
  private proceedAfterDeaths(now: number, events: TableEvent[]): TableStep {
    if (this.pendingShoots.length > 0) {
      const hunterNo = this.pendingShoots[0];
      const hunter = this.seatByNo(hunterNo)!;
      hunter.shotUsed = true;
      events.push({
        type: 'parlor.table.werewolf.hunter',
        scope: { kind: 'room' },
        text: `${this.labelOf(hunterNo)} 亮出了猎人身份！`,
        data: { game: this.game, hunter: hunterNo },
      });
      this.phase = {
        kind: 'shoot', queue: [hunterNo], index: 0, stage: 'act',
        deadline: now + this.durations.shootMs, readUntil: 0,
        windowId: this.nextWindowId(),
      };
      return { events, views: this.seatIdsByNo([hunterNo]), refreshViews: this.allSeatIds() };
    }
    return this.afterShoots(now, events);
  }

  /** 开枪全部处理完（或没有）：判胜负 → 遗言 → 白天。 */
  private afterShoots(now: number, events: TableEvent[]): TableStep {
    const alive = new Map(this.aliveSeats().map((seat) => [seat.seatNo, seat.role!]));
    const outcome = judgeOutcome(alive);
    if (outcome) return this.reveal(now, events, outcome);
    if (this.pendingLastWords.length > 0) {
      // 取走整个队列：放逐遗言走夜晚、天亮遗言走白天，都不许把残留带进下一天。
      const queue = [...this.pendingLastWords];
      this.pendingLastWords = [];
      return this.beginSpeech(now, events, 'lastwords', queue);
    }
    return this.beginDaySpeech(now, events);
  }

  private beginSpeech(now: number, events: TableEvent[], kind: 'day' | 'pk' | 'lastwords', queue: number[]): TableStep {
    const phase: Phase = {
      kind: 'speech', speechKind: kind, queue, index: 0, stage: 'speak',
      deadline: now + this.speechMsFor(queue[0]), readUntil: 0,
      windowId: this.nextWindowId(),
    };
    this.phase = phase;
    const label = kind === 'lastwords' ? '遗言' : kind === 'pk' ? 'PK 发言' : '发言';
    events.push({
      type: 'parlor.table.werewolf.speech_open',
      scope: { kind: 'room' },
      text: `轮到 ${this.labelOf(queue[0])} ${label}。`,
      data: { game: this.game, day: this.day, kind, seatNo: queue[0] },
    });
    return { events, views: this.seatIdsByNo([queue[0]]), refreshViews: this.allSeatIds() };
  }

  private beginDaySpeech(now: number, events: TableEvent[]): TableStep {
    // 每天起点向后一位，跳过已出局。
    const start = ((this.dayStart - 1 + (this.day - 1)) % this.seatCount) + 1;
    const queue: number[] = [];
    for (let offset = 0; offset < this.seatCount; offset++) {
      const seatNo = ((start - 1 + offset) % this.seatCount) + 1;
      const seat = this.seatByNo(seatNo)!;
      if (seat.alive) queue.push(seatNo);
    }
    this.pendingLastWords = [];
    if (queue.length === 0) return this.beginVote(now, events, 'day', []);
    return this.beginSpeech(now, events, 'day', queue);
  }

  /** 发言提交/过麦共用：写公开事件，进入阅读期。 */
  private closeSpeech(now: number, entry: { seatNo: number; text: string; passed: boolean }): TableStep {
    const phase = this.phase;
    const kind = phase.speechKind!;
    this.speeches.push({ day: this.day, kind, seatNo: entry.seatNo, text: entry.text, passed: entry.passed });
    const who = this.labelOf(entry.seatNo);
    const label = kind === 'lastwords' ? '遗言' : kind === 'pk' ? 'PK 发言' : '发言';
    const body = entry.passed ? `${who} 过麦，没有发言。` : `【第${this.day}天·${label}】${who}：${entry.text}`;
    const event: TableEvent = {
      type: 'parlor.table.werewolf.speech',
      scope: { kind: 'room' },
      text: body,
      data: { game: this.game, day: this.day, kind, seatNo: entry.seatNo, text: entry.text, passed: entry.passed,
        actorSeatId: this.seatByNo(entry.seatNo)!.id, actorName: this.seatByNo(entry.seatNo)!.name },
    };
    this.lastAction = { seatNo: entry.seatNo, kind: entry.passed ? 'pass_speech' : 'speak' };
    phase.stage = 'read';
    phase.readUntil = now + this.durations.readMs;
    return { events: [event], views: [], refreshViews: this.allSeatIds() };
  }

  /** 阅读期结束：下一位发言，或进入投票。 */
  private advanceSpeech(now: number): TableStep | null {
    const phase = this.phase;
    const events: TableEvent[] = [];
    phase.index += 1;
    if (phase.index < phase.queue.length) {
      const next = phase.queue[phase.index];
      phase.stage = 'speak';
      phase.deadline = now + this.speechMsFor(next);
      phase.windowId = this.nextWindowId();
      const label = phase.speechKind === 'lastwords' ? '遗言' : phase.speechKind === 'pk' ? 'PK 发言' : '发言';
      events.push({
        type: 'parlor.table.werewolf.speech_open',
        scope: { kind: 'room' },
        text: `轮到 ${this.labelOf(next)} ${label}。`,
        data: { game: this.game, day: this.day, kind: phase.speechKind, seatNo: next },
      });
      return { events, views: this.seatIdsByNo([next]), refreshViews: this.allSeatIds() };
    }
    if (phase.speechKind === 'day') return this.beginVote(now, events, 'day', []);
    if (phase.speechKind === 'pk') return this.beginVote(now, events, 'pk', phase.queue);
    // 遗言说完：白天放逐后的遗言接下一夜（设计稿流程「放逐→遗言→入夜」）；
    // 天亮后的首夜遗言接白天正常发言。不区分的话放逐后会在同一天原地再打一整轮。
    if (this.lastWordsFromExile) {
      this.lastWordsFromExile = false;
      return this.toNextNight(now, events);
    }
    return this.beginDaySpeech(now, events);
  }

  private speechMsFor(seatNo: number): number {
    const seat = this.seatByNo(seatNo);
    return seat?.kind === 'human' ? this.durations.humanSpeechMs : this.durations.cooSpeechMs;
  }

  // —— 投票 ——

  private beginVote(now: number, events: TableEvent[], variant: 'day' | 'pk', pkSeats: number[]): TableStep {
    this.ballots.clear();
    this.phase = {
      kind: 'vote', voteVariant: variant, queue: [...pkSeats], index: 0, stage: 'act',
      deadline: now + this.durations.voteMs, readUntil: 0,
      windowId: this.nextWindowId(),
    };
    const voters = variant === 'day'
      ? this.aliveSeats().map((seat) => seat.seatNo)
      : this.aliveSeats().filter((seat) => !pkSeats.includes(seat.seatNo)).map((seat) => seat.seatNo);
    events.push({
      type: 'parlor.table.werewolf.vote_open',
      scope: { kind: 'room' },
      text: variant === 'day'
        ? `第${this.day}天投票开始，${Math.round(this.durations.voteMs / 1000)} 秒后统一揭晓。`
        : `平票复投开始（只有非 PK 的存活者能投），${Math.round(this.durations.voteMs / 1000)} 秒后统一揭晓。`,
      data: { game: this.game, day: this.day, variant },
    });
    return { events, views: this.seatIdsByNo(voters), refreshViews: this.allSeatIds() };
  }

  /** 到点统一揭晓：放逐 / 平票 PK / 无人放逐。 */
  private resolveVote(now: number): TableStep {
    const variant = this.phase.voteVariant!;
    const entries = this.aliveSeats()
      .filter((seat) => variant === 'day' || !this.phase.queue.includes(seat.seatNo))
      .map((seat) => ({
        seatNo: seat.seatNo,
        target: this.ballots.get(seat.seatNo) ?? null,
        timeout: !this.ballots.has(seat.seatNo),
      }));
    this.ballots.clear();
    const allowed = variant === 'day'
      ? new Set(this.aliveSeats().map((seat) => seat.seatNo))
      : new Set(this.phase.queue);
    const tally = tallyVotes(new Map(entries.map((entry) => [entry.seatNo, entry.target])), allowed);
    const round: VoteRound = { day: this.day, variant, entries };
    const events: TableEvent[] = [];
    const detail = entries
      .map((entry) => `${entry.seatNo}号→${entry.target === null ? (entry.timeout ? '（超时弃票）' : '弃票') : `${entry.target}号`}`)
      .join('，');
    if (tally.exiled !== undefined) {
      round.exiled = tally.exiled;
      events.push({
        type: 'parlor.table.werewolf.vote',
        scope: { kind: 'room' },
        text: `第${this.day}天${variant === 'pk' ? '复投' : '投票'}结果：${detail}。${this.labelOf(tally.exiled)} 被放逐出局。`,
        data: { game: this.game, day: this.day, variant, entries, exiled: tally.exiled },
      });
      this.voteRounds.push(round);
      return this.resolveExile(now, events, tally.exiled);
    }
    if (tally.tie.length > 0) {
      round.tie = [...tally.tie];
      this.voteRounds.push(round);
      events.push({
        type: 'parlor.table.werewolf.vote',
        scope: { kind: 'room' },
        text: `第${this.day}天${variant === 'pk' ? '复投' : '投票'}结果：${detail}。最高票平票，${tally.tie.map((seatNo) => this.labelOf(seatNo)).join('、')} 进入 PK。`,
        data: { game: this.game, day: this.day, variant, entries, tie: tally.tie },
      });
      if (variant === 'pk') {
        // 复投再平：当天无人放逐。
        events.push({
          type: 'parlor.table.werewolf.vote',
          scope: { kind: 'room' },
          text: '复投仍然平票，今天没人被放逐。',
          data: { game: this.game, day: this.day, variant, nobody: true },
        });
        return this.toNextNight(now, events);
      }
      return this.beginSpeech(now, events, 'pk', [...tally.tie]);
    }
    this.voteRounds.push(round);
    events.push({
      type: 'parlor.table.werewolf.vote',
      scope: { kind: 'room' },
      text: `第${this.day}天${variant === 'pk' ? '复投' : '投票'}结果：${detail || '没有有效票'}。今天没人被放逐。`,
      data: { game: this.game, day: this.day, variant, entries, nobody: true },
    });
    return this.toNextNight(now, events);
  }

  /** 放逐结算：登记死亡 → 猎人 → 判胜负 → 遗言 → 入夜。 */
  private resolveExile(now: number, events: TableEvent[], seatNo: number): TableStep {
    this.kill(seatNo, this.day, 'day', 'vote');
    this.pendingLastWords.push(seatNo);
    // 这批遗言是白天放逐带来的：说完接下一夜，而不是原地再开一轮白天发言。
    this.lastWordsFromExile = true;
    const seat = this.seatByNo(seatNo)!;
    if (seat.role === 'hunter' && !seat.shotUsed) {
      this.pendingShoots.push(seatNo);
    }
    return this.proceedAfterDeaths(now, events);
  }

  private toNextNight(now: number, events: TableEvent[]): TableStep {
    if (this.day >= WEREWOLF_MAX_DAYS) {
      return this.reveal(now, events, 'draw');
    }
    return this.beginNight(now, events, this.day + 1);
  }

  private beginNight(now: number, events: TableEvent[], day: number): TableStep {
    this.day = day;
    this.night = {
      day,
      wolfChats: [],
      killVotes: new Map(),
      inspect: null,
      inspectDone: false,
      kill: null,
      saved: false,
      witchDone: false,
    };
    this.phase = {
      kind: 'night', half: 'a', queue: [], index: 0, stage: 'act',
      deadline: now + this.durations.nightMs, readUntil: 0,
      windowId: this.nextWindowId(),
    };
    events.push({
      type: 'parlor.table.werewolf.night',
      scope: { kind: 'room' },
      text: `第 ${day} 夜来临，天亮前所有人保持安静。`,
      data: { game: this.game, day },
    });
    const actors = this.aliveSeats()
      .filter((seat) => seat.role === 'wolf' || seat.role === 'seer' || seat.role === 'guard')
      .map((seat) => seat.seatNo);
    return { events, views: this.seatIdsByNo(actors), refreshViews: this.allSeatIds() };
  }

  // —— 猎人开枪 ——

  private resolveShoot(now: number, target: number | null, event: TableEvent): TableStep {
    const events: TableEvent[] = [event];
    const hunterNo = this.phase.queue[0];
    if (target !== null) {
      this.kill(target, this.day, 'day', 'shot');
      // 首夜被枪带走的也有遗言（首夜出局者包括首夜猎人带走者）。
      if (this.day === 1) this.pendingLastWords.push(target);
      const victim = this.seatByNo(target)!;
      if (victim.role === 'hunter' && !victim.shotUsed) this.pendingShoots.push(target);
    }
    this.pendingShoots.shift();
    if (this.pendingShoots.length > 0) {
      const next = this.pendingShoots[0];
      const nextHunter = this.seatByNo(next)!;
      nextHunter.shotUsed = true;
      events.push({
        type: 'parlor.table.werewolf.hunter',
        scope: { kind: 'room' },
        text: `${this.labelOf(next)} 亮出了猎人身份！`,
        data: { game: this.game, hunter: next },
      });
      this.phase = {
        kind: 'shoot', queue: [next], index: 0, stage: 'act',
        deadline: now + this.durations.shootMs, readUntil: 0,
        windowId: this.nextWindowId(),
      };
      return { events, views: this.seatIdsByNo([next]), refreshViews: this.allSeatIds() };
    }
    return this.afterShoots(now, events);
  }

  // —— 终局 ——

  private reveal(now: number, events: TableEvent[], outcome: 'good' | 'wolf' | 'draw'): TableStep {
    const winners = outcome === 'draw'
      ? []
      : this.seats.filter((seat) => factionOf(seat.role!) === (outcome === 'wolf' ? 'wolf' : 'good')).map((seat) => seat.id);
    this.result = { outcome, winners };
    this.status = 'ended';
    this.lastWordsFromExile = false;
    this.phase = { kind: 'ended', queue: [], index: 0, stage: 'act', deadline: 0, readUntil: 0, windowId: this.nextWindowId() };
    const verdict = outcome === 'good'
      ? '好人阵营胜利：狼人全部出局！'
      : outcome === 'wolf'
        ? '狼人阵营胜利：屠边达成（村民全出局，或神职全出局）。'
        : '平局：十二个白天过去仍不分胜负，或者全员同时出局。';
    events.push({
      type: 'parlor.table.end',
      scope: { kind: 'room' },
      text: `狼人杀终局。${verdict}`,
      data: {
        game: this.game,
        outcome,
        winners,
        tie: outcome === 'draw',
        roles: this.seats.map((seat) => ({ seatNo: seat.seatNo, name: seat.name, role: seat.role, alive: seat.alive })),
      },
    });
    return { events, views: this.allSeatIds(), refreshViews: [], ended: true };
  }

  // —— 契约：时钟 ——

  tick(now: number): TableStep | null {
    if (this.status !== 'playing') return null;
    const phase = this.phase;
    switch (phase.kind) {
      case 'reveal':
        if (now < phase.deadline) return null;
        return this.beginNight(now, [], 1);
      case 'night':
        if (now < phase.deadline) return null;
        return phase.half === 'a' ? this.closeNightA(now) : this.resolveNight(now);
      case 'speech':
        if (phase.stage === 'speak') {
          if (now < phase.deadline) return null;
          const seatNo = phase.queue[phase.index];
          return this.closeSpeech(now, { seatNo, text: '', passed: true });
        }
        if (now < phase.readUntil) return null;
        return this.advanceSpeech(now);
      case 'vote':
        if (now < phase.deadline) return null;
        return this.resolveVote(now);
      case 'shoot': {
        if (now < phase.deadline) return null;
        return this.resolveShoot(now, null, {
          type: 'parlor.table.werewolf.shot',
          scope: { kind: 'room' },
          text: `${this.labelOf(phase.queue[0])}（猎人）超时，放弃开枪。`,
          data: { game: this.game, hunter: phase.queue[0], gaveUp: true, timeout: true },
        });
      }
      default:
        return null;
    }
  }

  /**
   * 引擎自己知道的下一个「真的会推进」的时刻。夜晚分 A/B 两段：公开截止是天亮
   * （B 段结束），但 A 段结束时就要锁刀口——所以这里给的是阶段内部的截止，
   * 不是 `publicDeadline()`。发言段还有「读完三秒进入下一位」的 readUntil。
   */
  nextWakeAt(): number | undefined {
    if (this.status !== 'playing') return undefined;
    const phase = this.phase;
    switch (phase.kind) {
      case 'reveal':
      case 'night':
      case 'vote':
      case 'shoot':
        return phase.deadline;
      case 'speech':
        return phase.stage === 'speak' ? phase.deadline : phase.readUntil;
      default:
        return undefined;
    }
  }

  /** A 段到点：锁定刀口（相对多数唯一，否则空刀），进入 B 段。对外没有事件。 */
  private closeNightA(now: number): TableStep {
    const night = this.night!;
    const targets = new Set(this.aliveSeats().map((seat) => seat.seatNo));
    const tally = tallyVotes(night.killVotes, targets);
    night.kill = tally.exiled ?? null;
    this.phase = {
      ...this.phase,
      half: 'b',
      deadline: now + this.durations.nightMs,
      windowId: this.nextWindowId(),
    };
    const witch = this.aliveSeats().find((seat) => seat.role === 'witch');
    const witchCanAct = !!witch && (this.potions.antidote > 0 || this.potions.poison > 0);
    return {
      events: [],
      views: witchCanAct ? this.seatIdsByNo([witch!.seatNo]) : [],
      refreshViews: [],
    };
  }

  /** 每秒由宿主调用；窗口制下没有单一 turn，托管席位只在顺序发言/开枪时立刻代走。 */
  autoPlay(seatId: string, now: number): TableStep | null {
    if (this.status !== 'playing') return null;
    const seat = this.seatOf(seatId);
    if (!seat) return null;
    const phase = this.phase;
    if (phase.kind === 'speech' && phase.stage === 'speak' && phase.queue[phase.index] === seat.seatNo) {
      return this.closeSpeech(now, { seatNo: seat.seatNo, text: '', passed: true });
    }
    if (phase.kind === 'shoot' && phase.queue[0] === seat.seatNo) {
      return this.resolveShoot(now, null, {
        type: 'parlor.table.werewolf.shot',
        scope: { kind: 'room' },
        text: `${this.labelOf(seat.seatNo)}（猎人）被托管，放弃开枪。`,
        data: { game: this.game, hunter: seat.seatNo, gaveUp: true, auto: true },
      });
    }
    return null;
  }

  /**
   * 短停机续局：所有截止平移停机时长；当前窗口剩余不足 minHumanMs 时给足。
   * 连续重启只按本次停机平移，不叠加。
   */
  rearm(now: number, downtimeMs: number, minHumanMs: number): void {
    if (this.status !== 'playing') return;
    const shift = (at: number): number => {
      const remaining = at - (now - downtimeMs);
      return now + Math.max(remaining, minHumanMs);
    };
    this.phase.deadline = shift(this.phase.deadline);
    if (this.phase.readUntil > 0) this.phase.readUntil = shift(this.phase.readUntil);
  }

  /** 狼人杀进行中锁普通桌聊：发言走游戏动作，封住不限次数的旁路。 */
  chatLocked(): boolean {
    return this.status === 'playing';
  }

  // —— 视图 ——

  private wolfChatRemaining(seat: WSeat): number {
    const sent = this.night!.wolfChats.filter((entry) => entry.seatNo === seat.seatNo).length;
    return WOLF_CHAT_MESSAGES - sent;
  }

  /** 当前窗口里这个席位还欠不欠动作。 */
  private pendingMoveFor(seat: WSeat): string | null {
    if (this.status !== 'playing') return null;
    const phase = this.phase;
    if (phase.kind === 'speech' && phase.stage === 'speak' && phase.queue[phase.index] === seat.seatNo) {
      return 'speak';
    }
    if (phase.kind === 'vote' && seat.alive) {
      if (phase.voteVariant === 'pk' && phase.queue.includes(seat.seatNo)) return null;
      if (!this.ballots.has(seat.seatNo)) return 'vote';
      return null;
    }
    if (phase.kind === 'shoot' && phase.queue[0] === seat.seatNo) return 'shoot';
    if (phase.kind === 'night') {
      if (phase.half === 'a') {
        if (seat.role === 'wolf' && seat.alive) {
          const remaining = this.wolfChatRemaining(seat);
          if (remaining === WOLF_CHAT_MESSAGES) return 'wolf_chat';
          if (!this.night!.killVotes.has(seat.seatNo)) return 'wolf_kill';
          return remaining > 0 ? 'wolf_chat' : null;
        }
        if (seat.role === 'seer' && seat.alive && !this.night!.inspectDone) return 'inspect';
        if (seat.role === 'guard' && seat.alive && this.night!.guarded === undefined) return 'guard';
        return null;
      }
      if (phase.half === 'b' && seat.role === 'witch' && seat.alive && !this.night!.witchDone) {
        if (this.potions.antidote <= 0 && this.potions.poison <= 0) return null;
        return 'witch';
      }
    }
    return null;
  }

  view(seatId: string): unknown | null {
    const seat = this.seatOf(seatId);
    if (!seat) return null;
    const phase = this.phase;
    const isWolf = seat.role === 'wolf';
    const pending = this.pendingMoveFor(seat);
    const todaySpeeches = this.speeches.filter((entry) => entry.day === this.day);
    const lastRound = this.voteRounds[this.voteRounds.length - 1];
    const night = this.night;
    const myWindowId = pending ? phase.windowId : undefined;
    const deadline = this.myDeadline(seat);
    const fresh = this.lastAction?.seatNo === seat.seatNo
      && (this.lastAction.kind === 'inspect' || this.lastAction.kind === 'guard' || this.lastAction.kind === 'witch' || this.lastAction.kind === 'wolf_chat' || this.lastAction.kind === 'wolf_kill');
    return {
      game: this.game,
      seat: seat.id,
      seatNo: seat.seatNo,
      name: seat.name,
      kind: seat.kind,
      alive: seat.alive,
      status: this.status,
      day: this.day,
      phase: this.status === 'open' ? 'waiting' : phase.kind,
      phaseLabel: this.phaseLabel(),
      capacity: this.seatCount,
      ...(this.status === 'open' ? { requireHuman: this.requireHuman, startBlockers: this.startBlockers() } : {}),
      ...(phase.kind === 'speech' ? { stage: phase.stage, speechKind: phase.speechKind } : {}),
      ...(phase.kind === 'vote' && phase.voteVariant ? { voteVariant: phase.voteVariant } : {}),
      windowId: myWindowId ?? phase.windowId,
      ...(pending ? { canAct: true, myMove: pending } : { canAct: false }),
      ...(fresh ? { freshResult: true } : {}),
      ...(deadline ? { deadline } : {}),
      // 已交的动作不再随 pending 消失：投票交了票之后本人仍要能看到「已提交」与投给了谁
      //（设计稿 §5.3：提交后只固定显示本人选择）。submitted 只含本人的动作，不泄他人票。
      ...(this.submittedOf(seat).length ? { submitted: this.submittedOf(seat) } : {}),
      ...(phase.kind === 'vote' && this.ballots.has(seat.seatNo) ? { myVote: this.ballots.get(seat.seatNo) ?? null } : {}),
      ...(seat.role ? {
        role: seat.role,
        roleLabel: ROLE_CARD_LABELS[seat.role],
        roleSkill: ROLE_SKILLS[seat.role],
        faction: factionOf(seat.role),
        factionLabel: FACTION_LABELS[factionOf(seat.role)],
      } : {}),
      ...(isWolf ? {
        teammates: this.seats.filter((entry) => entry.role === 'wolf' && entry.seatNo !== seat.seatNo)
          .map((entry) => ({ seatNo: entry.seatNo, name: entry.name, alive: entry.alive })),
        ...(night && seat.alive ? {
          wolfChat: night.wolfChats.map((entry) => ({ seatNo: entry.seatNo, name: this.seatByNo(entry.seatNo)?.name ?? '', text: entry.text })),
          ...(phase.half === 'a' ? { wolfChatRemaining: this.wolfChatRemaining(seat) } : {}),
          killVotes: [...night.killVotes.entries()].map(([voter, target]) => ({ seatNo: voter, target })),
          ...(night.kill !== null && phase.half === 'b' ? { lockedKill: night.kill } : {}),
        } : {}),
      } : {}),
      ...(seat.role === 'seer' ? { inspections: this.inspections.map((entry) => ({ ...entry })) } : {}),
      ...(seat.role === 'guard' ? { previousGuard: this.nightLog.at(-1)?.guarded ?? null } : {}),
      ...(seat.role === 'witch' ? {
        potions: { ...this.potions },
        potionLog: this.potionLog.map((entry) => ({ ...entry })),
        ...(night && this.potions.antidote > 0
          ? { knownKill: night.kill }
          : {}),
      } : {}),
      ...(phase.kind === 'shoot' ? { shootHunter: phase.queue[0] } : {}),
      ...(phase.kind === 'vote' && phase.voteVariant === 'pk' ? { pkSeats: [...phase.queue] } : {}),
      seats: this.seats
        .map((entry) => ({
          seatNo: entry.seatNo, id: entry.id, name: entry.name, kind: entry.kind,
          alive: entry.alive, ...(entry.alive ? {} : { deathDay: entry.deathDay }),
        }))
        .sort((left, right) => left.seatNo - right.seatNo),
      speeches: todaySpeeches.map((entry) => ({ ...entry })),
      ...(lastRound ? { lastVotes: lastRound } : {}),
      deaths: this.deaths.map((entry) => ({ seatNo: entry.seatNo, day: entry.day, phase: entry.phase })),
      ...(this.result ? { result: { ...this.result }, roles: this.seats.map((entry) => ({ seatNo: entry.seatNo, role: entry.role, alive: entry.alive })) } : {}),
    };
  }

  /** 本人相关的截止：发言者看发言截止，窗口行动者看窗口截止，其他人看公开截止。 */
  private myDeadline(seat: WSeat): number | undefined {
    const phase = this.phase;
    if (phase.kind === 'night') {
      // 夜间本人截止 = 所在半段的截止；不参与的人只看天亮（公开截止）。
      const actor = this.pendingMoveFor(seat) !== null;
      return actor ? phase.deadline : this.publicDeadline();
    }
    if (phase.kind === 'speech' && phase.stage === 'speak' && phase.queue[phase.index] === seat.seatNo) {
      return phase.deadline;
    }
    return this.publicDeadline();
  }

  private publicDeadline(): number | undefined {
    const phase = this.phase;
    if (this.status !== 'playing') return undefined;
    // 夜晚对外只有「第 N 夜」一个截止 = 天亮时刻。A 段进行中天亮还没开始计时，
    // 但它是固定时长，所以公开截止 = A 段截止 + 一个夜长。
    if (phase.kind === 'night') return phase.half === 'b' ? phase.deadline : phase.deadline + this.durations.nightMs;
    if (phase.kind === 'speech') return phase.stage === 'speak' ? phase.deadline : phase.readUntil;
    if (phase.kind === 'vote' || phase.kind === 'shoot') return phase.deadline;
    if (phase.kind === 'reveal') return phase.deadline;
    return undefined;
  }

  private submittedOf(seat: WSeat): string[] {
    const done: string[] = [];
    const phase = this.phase;
    if (phase.kind === 'night') {
      const night = this.night!;
      if (this.wolfChatRemaining(seat) < WOLF_CHAT_MESSAGES) done.push('wolf_chat');
      if (night.killVotes.has(seat.seatNo)) done.push('wolf_kill');
      if (night.inspectDone && seat.role === 'seer') done.push('inspect');
      if (night.guarded !== undefined && seat.role === 'guard') done.push('guard');
      if (night.witchDone && seat.role === 'witch') done.push('witch');
    }
    if (phase.kind === 'vote' && this.ballots.has(seat.seatNo)) done.push('vote');
    return done;
  }

  public(): unknown {
    const phase = this.phase;
    const turn = phase.kind === 'speech' && phase.stage === 'speak'
      ? this.seatByNo(phase.queue[phase.index])?.id
      : phase.kind === 'shoot'
        ? this.seatByNo(phase.queue[0])?.id
        : undefined;
    return {
      game: this.game,
      status: this.status,
      host: this.host,
      day: this.day,
      phase: this.status === 'open' ? 'waiting' : phase.kind,
      phaseLabel: this.phaseLabel(),
      capacity: this.seatCount,
      ...(this.status === 'open' ? { requireHuman: this.requireHuman, startBlockers: this.startBlockers() } : {}),
      ...(turn ? { turn } : {}),
      deadline: this.publicDeadline(),
      seats: this.seats
        .map((entry) => ({
          id: entry.id, seatNo: entry.seatNo, name: entry.name, kind: entry.kind, alive: entry.alive, bot: false,
        }))
        .sort((left, right) => left.seatNo - right.seatNo),
      speeches: this.speeches.map((entry) => ({ ...entry })),
      votes: this.voteRounds.map((round) => ({ ...round })),
      deaths: this.deaths.map((entry) => ({ seatNo: entry.seatNo, day: entry.day, phase: entry.phase })),
      ...(this.result
        ? {
          result: { ...this.result },
          revealed: this.seats
            .map((entry) => ({ seatNo: entry.seatNo, name: entry.name, role: entry.role, alive: entry.alive })),
        }
        : {}),
    };
  }

  private phaseLabel(): string {
    if (this.status === 'open') return '等待入座';
    const phase = this.phase;
    switch (phase.kind) {
      case 'reveal': return '看身份';
      case 'night': return phase.half === 'a' ? '夜晚' : '夜晚';
      case 'speech': return phase.stage === 'read' ? '阅读' : phase.speechKind === 'lastwords' ? '遗言' : phase.speechKind === 'pk' ? 'PK 发言' : '白天发言';
      case 'vote': return phase.voteVariant === 'pk' ? 'PK 复投' : '投票';
      case 'shoot': return '猎人开枪';
      default: return this.status === 'ended' ? '已结束' : '等待开局';
    }
  }

  // —— 历史查询 ——

  tableLog(query: TableLogQuery, requestor: { seatId: string; onTable: boolean }): unknown {
    const day = typeof query.day === 'number' ? query.day : undefined;
    const seatNo = typeof query.seatNo === 'number' ? query.seatNo : undefined;
    const limit = Math.min(Math.max(1, Number(query.limit) || 100), 200);
    const ended = this.status === 'ended';
    const review = query.review === true;
    const speeches = this.speeches
      .filter((entry) => (day === undefined || entry.day === day) && (seatNo === undefined || entry.seatNo === seatNo));
    const votes = this.voteRounds.filter((round) => day === undefined || round.day === day);
    const deaths = this.deaths
      .filter((entry) => (day === undefined || entry.day === day) && (seatNo === undefined || entry.seatNo === seatNo))
      .map((entry) => ({
        seatNo: entry.seatNo,
        day: entry.day,
        phase: entry.phase,
        // 终局前不公开死因；终局后对参与者完整公开（复盘）。
        ...(ended && review && requestor.onTable ? { cause: entry.cause } : {}),
      }));
    const sections: Record<string, unknown[]> = {
      speeches,
      votes,
      deaths,
      ...(ended && review && requestor.onTable
        ? {
          nights: this.nightLog.filter((record) => day === undefined || record.day === day)
            .map((record) => ({
              ...record,
              wolfChats: record.wolfChats.map((entry) => ({ ...entry, name: this.seatByNo(entry.seatNo)?.name ?? '' })),
            })),
          potionLog: this.potionLog.filter((entry) => day === undefined || entry.day === day),
        }
        : {}),
    };
    const page: Record<string, unknown[]> = {};
    for (const key of Object.keys(sections)) page[key] = [];
    const log = {
      game: this.game,
      status: this.status,
      day: this.day,
      ...page,
      ...(this.result ? { result: { ...this.result } } : {}),
    };
    // Cursor points to the next item in a section. Appending newer entries doesn't move it.
    const keys = Object.keys(sections);
    const cursor = query.cursor === undefined ? null : /^([A-Za-z]+):(\d+)$/.exec(query.cursor);
    const start = cursor ? keys.indexOf(cursor[1]) : 0;
    const index = cursor ? Number(cursor[2]) : -1;
    if (query.cursor !== undefined && (!cursor || start < 0 || !Number.isSafeInteger(index)
      || index >= sections[keys[start]].length)) {
      throw new WerewolfError('bad_action', '历史游标无效；请沿用原来的桌号和筛选条件');
    }
    let count = 0;
    let bytes = Buffer.byteLength(JSON.stringify(log));
    for (let section = start; section < keys.length; section++) {
      const key = keys[section];
      const entries = sections[key];
      for (let i = cursor && section === start ? index : entries.length - 1; i >= 0; i--) {
        const entryBytes = Buffer.byteLength(JSON.stringify(entries[i])) + 1;
        // Reserve space for the envelope and nextCursor.
        if (count >= limit || bytes + entryBytes > GAME_RESPONSE_MAX_BYTES - 1024) {
          if (!count) throw new WerewolfError('bad_action', '单条历史记录超出大小限制');
          return { ...log, hasMore: true, nextCursor: `${key}:${i}` };
        }
        page[key].unshift(entries[i]);
        bytes += entryBytes;
        count++;
      }
    }
    return { ...log, hasMore: false, nextCursor: null };
  }

  // —— 契约：文案 ——

  privateText(seatId: string, now: number): string | null {
    const seat = this.seatOf(seatId);
    if (!seat) return null;
    if (this.status === 'open') {
      return `${this.publicText()}\n尚未分配角色。坐满 ${this.seatCount} 席且至少有一只 Coo 后，由开桌者开始。每只 Coo 的扩展都须支持狼人杀。\n${this.startBlockers().join('；')}\n未开局可用 parlor_table {op:"leave"} 退桌；开桌者退桌即收桌。`;
    }
    const history = seat.role === 'seer'
      ? `查验历史（仅自己可见）：${this.inspections.length ? this.inspections.map((entry) => `第${entry.day}夜查 ${entry.target}号=${entry.result === 'wolf' ? '狼人' : '好人'}`).join('；') : '还没有查验记录'}。`
      : '';
    if (this.status === 'ended') return [this.endedText(seat), history].filter(Boolean).join('\n');
    const phase = this.phase;
    const lines: string[] = [];
    const clock = (at?: number): string => (at ? `${serverClockLabel(at)}（还剩 ${secondsLeft(at, now)} 秒）` : '到点自动推进');
    const pending = this.pendingMoveFor(seat);
    if (seat.role) {
      lines.push(`【狼人杀·第${this.day}天·${this.phaseLabel()}】你的身份：${ROLE_CARD_LABELS[seat.role]}（${FACTION_LABELS[factionOf(seat.role)]}）。`);
      if (seat.role === 'wolf') {
        const mates = this.seats.filter((entry) => entry.role === 'wolf' && entry.seatNo !== seat.seatNo)
          .map((entry) => `${entry.seatNo}号 ${entry.name}${entry.alive ? '' : '（出局）'}`);
        lines.push(`同伴：${mates.length ? mates.join('、') : '没有了'}。`);
      }
    } else {
      lines.push(`【狼人杀】第${this.day}天·${this.phaseLabel()}。`);
    }
    if (history) lines.push(history);
    const aliveList = this.aliveSeats().map((entry) => `${entry.seatNo}号 ${entry.name}`).join('、');
    const deadList = this.seats.filter((entry) => !entry.alive)
      .map((entry) => `${entry.seatNo}号 ${entry.name}`)
      .join('、');
    lines.push(`存活：${aliveList || '没人'}。已出局：${deadList || '还没有'}。`);
    switch (phase.kind) {
      case 'reveal': {
        lines.push(`先记住自己的身份（${Math.round(this.durations.revealMs / 1000)} 秒后进入第 1 夜）：${ROLE_SKILLS[seat.role!]}`);
        break;
      }
      case 'night': {
        if (phase.half === 'a') {
          if (seat.role === 'wolf' && seat.alive) {
            const night = this.night!;
            const remaining = this.wolfChatRemaining(seat);
            lines.push(`狼人时间，刀口将在 ${clock(phase.deadline)} 锁定。`);
            if (remaining > 0) {
              lines.push(`狼队私聊（还可发 ${remaining} 条，每条 150 字内，交刀票后也可发）：parlor_game_action {action:"wolf_chat",params:{windowId:"${phase.windowId}", text:"…"}}`);
            }
            if (!night.killVotes.has(seat.seatNo)) {
              lines.push(`刀票（一人一票，可投任意存活玩家，不带 target = 弃刀）：parlor_game_action {action:"wolf_kill",params:{windowId:"${phase.windowId}", target:座号}}`);
            }
            if (night.wolfChats.length > 0) {
              lines.push(`本夜狼聊：${night.wolfChats.map((entry) => `${entry.seatNo}号「${entry.text}」`).join('；')}`);
            }
            if (night.killVotes.size > 0) {
              lines.push(`已交刀票：${[...night.killVotes.entries()].map(([voter, target]) => `${voter}号→${target === null ? '弃刀' : `${target}号`}`).join('，')}`);
            }
          } else if (pending === 'guard') {
            const previous = this.nightLog.at(-1)?.guarded;
            lines.push(`守卫时间（${clock(phase.deadline)}）：parlor_game_action {action:"guard",params:{windowId:"${phase.windowId}", target:座号}}。可守自己，不带 target 为空守。`);
            if (previous != null) lines.push(`昨夜守了 ${previous} 号，今夜不能再守此人。`);
          } else if (pending === 'inspect') {
            lines.push(`查验（${clock(phase.deadline)}）：parlor_game_action {action:"inspect",params:{windowId:"${phase.windowId}", target:座号}}；不带 target = 今夜不查验。`);
            lines.push('结果提交后立即显示在本人私视图，之后用 parlor_game_info {op:"state"} 随时回看。');
          } else {
            lines.push('夜里有人在行动；你不需要做任何事，天亮会公布结果。');
          }
        } else if (pending === 'witch') {
          const night = this.night!;
          const options: string[] = ['{choice:"none"} 什么都不用'];
          if (this.potions.antidote > 0) {
            options.push(night.kill === null
              ? '{choice:"save"}（今夜没有刀口，用不了）'
              : `{choice:"save"} 救 ${night.kill}号${night.kill === seat.seatNo && this.day === 1 ? '（首夜自救）' : ''}`);
          }
          if (this.potions.poison > 0) {
            options.push('{choice:"poison", target:座号} 毒一名其他存活玩家');
          }
          lines.push(`女巫时间（${clock(phase.deadline)}），本夜只能选一项：parlor_game_action {action:"witch",params:{windowId:"${phase.windowId}", choice:…}}`);
          lines.push(`可选项：${options.join('；')}。药量：解药 ${this.potions.antidote}、毒药 ${this.potions.poison}。`);
          if (this.potions.antidote > 0 && night.kill !== null) lines.push(`今夜刀口：${night.kill}号。`);
        } else {
          lines.push('夜里有人在行动；你不需要做任何事，天亮会公布结果。');
        }
        break;
      }
      case 'speech': {
        if (phase.stage === 'speak' && pending === 'speak') {
          const label = phase.speechKind === 'lastwords' ? '遗言' : phase.speechKind === 'pk' ? 'PK 发言' : '发言';
          lines.push(`轮到你${label}（${clock(phase.deadline)}）。只此一条、最多 300 字：`);
          lines.push(`parlor_game_action {action:"speak",params:{windowId:"${phase.windowId}", text:"…"}}`);
          lines.push(`不想说：parlor_game_action {action:"pass_speech",params:{windowId:"${phase.windowId}"}}`);
        } else {
          lines.push(phase.stage === 'read' ? '发言间隙，大家在阅读。' : '现在不是你的发言机会。');
        }
        break;
      }
      case 'vote': {
        if (pending === 'vote') {
          const scope = phase.voteVariant === 'pk' ? '只能投给进入 PK 的席位' : '不能投自己';
          lines.push(`投票（${clock(phase.deadline)}）：parlor_game_action {action:"vote",params:{windowId:"${phase.windowId}", target:座号}}；不带 target = 弃票。${scope}，提交后不能改，到点统一揭晓。`);
        } else {
          lines.push(this.ballots.has(seat.seatNo) ? '你的票已经交了；到点统一揭晓。' : '这一轮你没有投票权。');
        }
        break;
      }
      case 'shoot': {
        if (pending === 'shoot') {
          lines.push(`你是猎人，可以开枪带走一名其他存活玩家（${clock(phase.deadline)}）：`);
          lines.push(`parlor_game_action {action:"shoot",params:{windowId:"${phase.windowId}", target:座号}}；不带 target = 放弃。`);
        } else {
          lines.push('猎人的开枪窗口进行中。');
        }
        break;
      }
      default:
        break;
    }
    if (this.speeches.some((entry) => entry.day === this.day)) {
      lines.push('—— 今天到目前的发言 ——');
      for (const entry of this.speeches.filter((item) => item.day === this.day)) {
        lines.push(entry.passed
          ? `${entry.seatNo}号：（过麦）`
          : `${entry.seatNo}号 ${this.seatByNo(entry.seatNo)?.name ?? ''}：${entry.text}`);
      }
    }
    if (this.voteRounds.length > 0) {
      const last = this.voteRounds[this.voteRounds.length - 1];
      lines.push(`—— 最近一次票型（第${last.day}天${last.variant === 'pk' ? '复投' : ''}）——`);
      lines.push(last.entries.map((entry) => `${entry.seatNo}号→${entry.target === null ? '弃' : `${entry.target}号`}`).join('，')
        + (last.exiled !== undefined ? `。放逐：${last.exiled}号` : last.tie ? `。平票：${last.tie.join('/')}号` : '。无人放逐'));
    }
    const more = this.speeches.filter((entry) => entry.day < this.day).length;
    if (more > 0) lines.push(`此前各天的完整发言与票型用 parlor_game_info {op:"history"} 查（或 parlor_game_info {op:"state"} 看最近一轮）。`);
    return lines.join('\n');
  }

  private endedText(seat: WSeat): string {
    const outcome = this.result?.outcome ?? 'draw';
    const verdict = outcome === 'good' ? '好人阵营胜利' : outcome === 'wolf' ? '狼人阵营胜利' : '平局';
    const mine = seat.role ? `你是 ${ROLE_CARD_LABELS[seat.role]}（${FACTION_LABELS[factionOf(seat.role)]}）。` : '';
    const roles = this.seats.map((entry) => `${entry.seatNo}号 ${entry.name}=${ROLE_LABELS[entry.role!]}${entry.alive ? '' : '（出局）'}`).join('，');
    return `【狼人杀·终局】${verdict}。${mine}\n全部身份：${roles}。感谢参与；这局的夜间复盘用 parlor_game_info {op:"history",review:true} 看。`;
  }

  publicText(): string {
    if (this.status === 'open') {
      const rule = this.requireHuman ? '本桌要求至少一名真人入座。' : '本桌允许全 Coo 局。';
      return `【狼人杀桌·等待入座】${this.seats.length}/${this.seatCount} 席：${this.seats.map((seat) => `${seat.seatNo}号 ${seat.name}`).join('、')}。${rule}`;
    }
    if (this.status === 'playing') {
      const alive = this.aliveSeats();
      return `【狼人杀桌】第${this.day}天·${this.phaseLabel()}，存活 ${alive.length} 人：${alive.map((seat) => `${seat.seatNo}号 ${seat.name}`).join('、')}。`;
    }
    const outcome = this.result?.outcome ?? 'draw';
    const verdict = outcome === 'good' ? '好人阵营胜利' : outcome === 'wolf' ? '狼人阵营胜利' : '平局';
    return `【狼人杀桌】已结束：${verdict}。身份：${this.seats.map((seat) => `${seat.seatNo}号=${ROLE_LABELS[seat.role!]}`).join('，')}。`;
  }

  // —— 存档 ——

  exportState(): unknown {
    return {
      version: this.stateVersion,
      status: this.status,
      host: this.host,
      requireHuman: this.requireHuman,
      seatCount: this.seatCount,
      day: this.day,
      dayStart: this.dayStart,
      windowSeq: this.windowSeq,
      phase: { ...this.phase, queue: [...this.phase.queue] },
      seats: this.seats.map((seat) => ({ ...seat })),
      speeches: this.speeches.map((entry) => ({ ...entry })),
      voteRounds: this.voteRounds.map((round) => ({ ...round, entries: round.entries.map((entry) => ({ ...entry })) })),
      deaths: this.deaths.map((entry) => ({ ...entry })),
      pendingLastWords: [...this.pendingLastWords],
      pendingShoots: [...this.pendingShoots],
      lastWordsFromExile: this.lastWordsFromExile,
      night: this.night
        ? {
          ...this.night,
          // 旧版本恢复存档时仍用此字段判断是否已发过狼聊。
          wolfChatDone: [...new Set(this.night.wolfChats.map((entry) => entry.seatNo))],
          killVotes: [...this.night.killVotes.entries()],
          inspect: this.night.inspect ? { ...this.night.inspect } : null,
        }
        : null,
      nightLog: this.nightLog.map((record) => ({ ...record })),
      inspections: this.inspections.map((entry) => ({ ...entry })),
      potions: { ...this.potions },
      potionLog: this.potionLog.map((entry) => ({ ...entry })),
      ballots: [...this.ballots.entries()],
      result: this.result ? { ...this.result } : null,
    };
  }

  restoreState(state: unknown): void {
    const raw = state as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') throw new Error('狼人杀存档不是对象');
    if (raw.version !== this.stateVersion) throw new Error(`不认识的狼人杀存档版本：${String(raw.version)}`);
    if (raw.host !== this.host) throw new Error('狼人杀存档的主持席位对不上');
    if (raw.status !== 'open' && raw.status !== 'playing' && raw.status !== 'ended') {
      throw new Error(`狼人杀存档的状态不对：${String(raw.status)}`);
    }
    const seatCount = raw.seatCount === undefined ? WEREWOLF_SEAT_COUNT : raw.seatCount;
    if (!isWerewolfSeatCount(seatCount)) throw new Error('狼人杀存档的开局人数不对');
    const seats = raw.seats as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(seats) || seats.length === 0 || seats.length > seatCount) {
      throw new Error('狼人杀存档缺席位或席位数量不对');
    }
    const parsed: WSeat[] = seats.map((entry) => {
      const seatNo = Number(entry.seatNo);
      if (!Number.isSafeInteger(seatNo) || seatNo < 1 || seatNo > seatCount) throw new Error('狼人杀存档的座号不对');
      if (typeof entry.id !== 'string' || typeof entry.name !== 'string') throw new Error('狼人杀存档的席位形状不对');
      const role = entry.role === undefined ? undefined : entry.role as WerewolfRole;
      if (role !== undefined && !(role in ROLE_LABELS)) throw new Error(`狼人杀存档的角色不对：${String(entry.role)}`);
      return {
        seatNo,
        id: entry.id,
        name: entry.name,
        kind: entry.kind === 'human' ? 'human' as const : 'pet' as const,
        ...(typeof entry.clientVersion === 'string' ? { clientVersion: entry.clientVersion } : {}),
        ...(role !== undefined ? { role } : {}),
        alive: entry.alive === true,
        ...(Number.isSafeInteger(entry.deathDay) ? { deathDay: entry.deathDay as number } : {}),
        ...(entry.deathPhase === 'night' || entry.deathPhase === 'day' ? { deathPhase: entry.deathPhase } : {}),
        ...(entry.deathCause !== undefined && typeof entry.deathCause === 'string'
          ? { deathCause: entry.deathCause as DeathRecord['cause'] } : {}),
        ...(entry.shotUsed === true ? { shotUsed: true } : {}),
      };
    });
    const ids = new Set(parsed.map((seat) => seat.id));
    if (ids.size !== parsed.length) throw new Error('狼人杀存档的席位有重复');
    this.seats.splice(0, this.seats.length, ...parsed);
    this.status = raw.status as TableStatus;
    // 旧存档开桌时采用的是必须有真人的规则。
    this.requireHuman = raw.requireHuman !== false;
    this.seatCount = seatCount;
    this.day = Number(raw.day);
    this.dayStart = Number(raw.dayStart);
    this.windowSeq = Number(raw.windowSeq);
    if (!Number.isSafeInteger(this.day) || !Number.isSafeInteger(this.dayStart) || !Number.isSafeInteger(this.windowSeq)) {
      throw new Error('狼人杀存档的日夜计数不对');
    }
    const phase = raw.phase as Record<string, unknown> | undefined;
    if (!phase || typeof phase !== 'object') throw new Error('狼人杀存档缺阶段');
    this.phase = {
      kind: phase.kind as PhaseKind,
      ...(phase.half === 'a' || phase.half === 'b' ? { half: phase.half } : {}),
      ...(phase.speechKind === 'day' || phase.speechKind === 'pk' || phase.speechKind === 'lastwords'
        ? { speechKind: phase.speechKind } : {}),
      ...(phase.voteVariant === 'day' || phase.voteVariant === 'pk' ? { voteVariant: phase.voteVariant } : {}),
      queue: Array.isArray(phase.queue) ? phase.queue.map(Number) : [],
      index: Number(phase.index) || 0,
      stage: phase.stage === 'speak' ? 'speak' : phase.stage === 'read' ? 'read' : 'act',
      deadline: Number(phase.deadline) || 0,
      readUntil: Number(phase.readUntil) || 0,
      windowId: typeof phase.windowId === 'string' ? phase.windowId : 'w0',
    };
    this.speeches = Array.isArray(raw.speeches)
      ? (raw.speeches as Array<Record<string, unknown>>).map((entry) => ({
        day: Number(entry.day), kind: entry.kind as SpeechEntry['kind'],
        seatNo: Number(entry.seatNo), text: String(entry.text ?? ''), passed: entry.passed === true,
      }))
      : [];
    this.voteRounds = Array.isArray(raw.voteRounds)
      ? (raw.voteRounds as Array<Record<string, unknown>>).map((round) => ({
        day: Number(round.day), variant: round.variant as VoteRound['variant'],
        entries: Array.isArray(round.entries)
          ? (round.entries as Array<Record<string, unknown>>).map((entry) => ({
            seatNo: Number(entry.seatNo),
            target: entry.target === null || entry.target === undefined ? null : Number(entry.target),
            timeout: entry.timeout === true,
          }))
          : [],
        ...(Number.isSafeInteger(round.exiled) ? { exiled: round.exiled as number } : {}),
        ...(Array.isArray(round.tie) ? { tie: (round.tie as unknown[]).map(Number) } : {}),
      }))
      : [];
    this.deaths = Array.isArray(raw.deaths)
      ? (raw.deaths as Array<Record<string, unknown>>).map((entry) => ({
        seatNo: Number(entry.seatNo), day: Number(entry.day),
        phase: entry.phase === 'day' ? 'day' as const : 'night' as const,
        cause: entry.cause as DeathRecord['cause'],
      }))
      : [];
    this.pendingLastWords = Array.isArray(raw.pendingLastWords) ? (raw.pendingLastWords as unknown[]).map(Number) : [];
    this.pendingShoots = Array.isArray(raw.pendingShoots) ? (raw.pendingShoots as unknown[]).map(Number) : [];
    this.lastWordsFromExile = raw.lastWordsFromExile === true;
    this.night = raw.night && typeof raw.night === 'object'
      ? {
        day: Number((raw.night as Record<string, unknown>).day),
        wolfChats: ((raw.night as Record<string, unknown>).wolfChats as Array<Record<string, unknown>> ?? []).map((entry) => ({
          seatNo: Number(entry.seatNo), text: String(entry.text ?? ''),
        })),
        killVotes: new Map(((((raw.night as Record<string, unknown>).killVotes) as Array<[unknown, unknown]>) ?? [])
          .map(([voter, target]) => [Number(voter), target === null || target === undefined ? null : Number(target)] as [number, number | null])),
        inspect: (raw.night as Record<string, unknown>).inspect
          ? {
            target: Number(((raw.night as Record<string, unknown>).inspect as Record<string, unknown>).target),
            result: ((raw.night as Record<string, unknown>).inspect as Record<string, unknown>).result as 'wolf' | 'good',
          }
          : null,
        inspectDone: (raw.night as Record<string, unknown>).inspectDone === true,
        kill: ((raw.night as Record<string, unknown>).kill === null || (raw.night as Record<string, unknown>).kill === undefined)
          ? null
          : Number((raw.night as Record<string, unknown>).kill),
        saved: (raw.night as Record<string, unknown>).saved === true,
        guarded: (raw.night as WorkingNight).guarded,
        poison: Number.isSafeInteger((raw.night as Record<string, unknown>).poison)
          ? Number((raw.night as Record<string, unknown>).poison)
          : undefined,
        witchDone: (raw.night as Record<string, unknown>).witchDone === true,
      }
      : null;
    this.nightLog = Array.isArray(raw.nightLog) ? (raw.nightLog as NightRecord[]).map((record) => ({ ...record })) : [];
    this.inspections = Array.isArray(raw.inspections)
      ? (raw.inspections as Array<Record<string, unknown>>).map((entry) => ({
        day: Number(entry.day), target: Number(entry.target), result: entry.result as 'wolf' | 'good',
      }))
      : [];
    const potions = raw.potions as Record<string, unknown> | undefined;
    this.potions = { antidote: Number(potions?.antidote ?? 1), poison: Number(potions?.poison ?? 1) };
    this.potionLog = Array.isArray(raw.potionLog)
      ? (raw.potionLog as Array<Record<string, unknown>>).map((entry) => ({
        day: Number(entry.day), choice: entry.choice as 'save' | 'poison', target: Number(entry.target),
      }))
      : [];
    this.ballots = new Map((Array.isArray(raw.ballots) ? raw.ballots as Array<[unknown, unknown]> : [])
      .map(([voter, target]) => [Number(voter), target === null || target === undefined ? null : Number(target)] as [number, number | null]));
    this.result = raw.result && typeof raw.result === 'object'
      ? {
        outcome: (raw.result as Record<string, unknown>).outcome as 'good' | 'wolf' | 'draw',
        winners: Array.isArray((raw.result as Record<string, unknown>).winners)
          ? ((raw.result as Record<string, unknown>).winners as unknown[]).map(String)
          : [],
      }
      : undefined;
    this.lastAction = undefined;
  }
}

export class WerewolfError extends TableError {
  constructor(code: TableErrorCode, message: string) {
    super(code, message);
    this.name = 'WerewolfError';
  }
}
