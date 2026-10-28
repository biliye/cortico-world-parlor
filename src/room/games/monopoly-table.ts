/**
 * 大富翁桌：把纯规则包成 TableEngine。
 *
 * 这里只负责三件规则之外的事：截止时间、托管（含脚本席位）、把状态变成给人看的话。
 * 骰点在这里掷，但掷完立刻进存档（activity-store），重试不会重掷。
 */
import { randomInt } from 'node:crypto';
import { serverClockLabel } from '../clock.ts';
import {
  TableError, secondsLeft,
  type TableEngine, type TableEvent, type TableSeat, type TableStep, type TableStatus, type TableSummary,
} from '../table-engine.ts';
import {
  BOARD, ITEM_KINDS, ITEM_LABELS, MONOPOLY_RULES, MonopolyError, MonopolyGame,
  cellAt, isItemKind, phaseAction,
  type ItemKind, type MonopolyEnd, type MonopolyState, type Outcome, type Phase,
} from './monopoly-rules.ts';

export type MonopolyPace = 'standard' | 'quick';

export const PACE_LABELS: Readonly<Record<MonopolyPace, string>> = {
  standard: '标准（每回合 30 分钟）',
  quick: '试玩（每回合 5 分钟）',
};

export const PACE_TURN_MS: Readonly<Record<MonopolyPace, number>> = {
  standard: 30 * 60_000,
  quick: 5 * 60_000,
};

/** 整局兜底：服务照常跑，到点按当前资产结算。 */
export const GAME_LIMIT_MS = 48 * 60 * 60_000;
/** 脚本陪练出手前的停顿，让人看得见它在走。 */
export const BOT_DELAY_MS = 3000;

export interface MonopolySeat extends TableSeat {
  /** 脚本陪练：不是房间席位，自己按托管规则出手。 */
  bot?: boolean;
}

export interface MonopolyTableSnapshot {
  version: 1;
  host: string;
  seats: MonopolySeat[];
  pace: MonopolyPace;
  status: TableStatus;
  game: MonopolyState;
  deadline: number;
  turnStartedAt: number;
  startedAt: number;
  endsAt: number;
  auto: string[];
  bots: string[];
  ended: MonopolyEnd | null;
  lastFacts: string[];
}

export interface MonopolyTableOptions {
  host: string;
  /** 开局就定下来的席位；脚本陪练也在里面，带 `bot: true`。 */
  seats: MonopolySeat[];
  pace?: MonopolyPace;
  now: number;
  rng?: () => [number, number];
  /** 测试用：固定轮序。 */
  shuffle?: (list: readonly string[]) => string[];
  /** 测试用：覆盖每回合时限与整局上限。 */
  turnMs?: number;
  gameLimitMs?: number;
}

const dice = (): [number, number] => [randomInt(1, 7), randomInt(1, 7)];

const shuffle = (list: readonly string[]): string[] => (
  list.map((value) => ({ value, key: randomInt(0, 1 << 30) }))
    .sort((left, right) => left.key - right.key)
    .map((entry) => entry.value)
);

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** 桌子这一层的自检：席位、时间、状态与局面必须对得上。 */
function validateSnapshot(snapshot: MonopolyTableSnapshot): void {
  if (!snapshot || typeof snapshot !== 'object') throw new TableError('bad_action', '桌子存档不是对象');
  if (snapshot.version !== 1) throw new TableError('bad_action', '存档版本不认识');
  if (!Array.isArray(snapshot.seats) || snapshot.seats.length < 2 || snapshot.seats.length > 6) {
    throw new TableError('bad_action', '存档里的席位数不对');
  }
  const ids = snapshot.seats.map((seat) => (seat && typeof seat.id === 'string' ? seat.id : ''));
  if (ids.some((id) => id.length === 0) || new Set(ids).size !== ids.length) {
    throw new TableError('bad_action', '存档里的席位坏了');
  }
  if (!ids.includes(snapshot.host)) throw new TableError('bad_action', '存档里的发起人不在桌上');
  if (snapshot.pace !== 'standard' && snapshot.pace !== 'quick') throw new TableError('bad_action', '存档里的节奏不认识');
  if (snapshot.status !== 'playing' && snapshot.status !== 'ended') throw new TableError('bad_action', '存档里的桌子状态坏了');
  if (!finite(snapshot.deadline) || !finite(snapshot.turnStartedAt)
    || !finite(snapshot.startedAt) || !finite(snapshot.endsAt)) {
    throw new TableError('bad_action', '存档里的时间字段坏了');
  }
  if (snapshot.endsAt <= snapshot.startedAt) throw new TableError('bad_action', '存档里的整局时限坏了');
  if (!Array.isArray(snapshot.auto) || snapshot.auto.some((id) => !ids.includes(id))) {
    throw new TableError('bad_action', '存档里的托管名单坏了');
  }
  if (!Array.isArray(snapshot.bots) || snapshot.bots.some((id) => !ids.includes(id))) {
    throw new TableError('bad_action', '存档里的脚本名单坏了');
  }
  if (snapshot.status === 'ended' && !snapshot.ended) throw new TableError('bad_action', '存档说结束了却没有结局');
  if (snapshot.status === 'playing' && snapshot.ended) throw new TableError('bad_action', '存档说还在玩却已有结局');
  if (!snapshot.game || !Array.isArray(snapshot.game.order)) throw new TableError('bad_action', '存档里没有局面');
  if (snapshot.game.order.length !== ids.length || snapshot.game.order.some((id) => !ids.includes(id))) {
    throw new TableError('bad_action', '存档里的轮序和席位对不上');
  }
  if (!Array.isArray(snapshot.lastFacts) || snapshot.lastFacts.some((fact) => typeof fact !== 'string')) {
    throw new TableError('bad_action', '存档里的最近事实坏了');
  }
}

const mapError = (error: unknown): TableError => {
  if (error instanceof TableError) return error;
  if (error instanceof MonopolyError) {
    if (error.code === 'not_your_turn') return new TableError('not_turn', error.message);
    if (error.code === 'not_available') return new TableError('bad_action', error.message);
    if (error.code === 'not_affordable') return new TableError('bad_action', error.message);
    return new TableError('bad_action', error.message);
  }
  return new TableError('bad_action', error instanceof Error ? error.message : String(error));
};

/** 一条紧凑的地图：给模型看位置与价格，不铺表格。 */
export function compactBoard(): string {
  return BOARD.map((cell) => {
    if (cell.kind === 'property') return `${cell.index}${cell.name}${cell.group} ${cell.price}`;
    if (cell.kind === 'subsidy' || cell.kind === 'fee') return `${cell.index}${cell.name} ${cell.amount}`;
    return `${cell.index}${cell.name}`;
  }).join('·');
}

export class MonopolyTable implements TableEngine {
  readonly game = 'monopoly';
  readonly label = '大富翁';
  readonly host: string;
  status: TableStatus = 'playing';

  private readonly seats: MonopolySeat[];
  private readonly pace: MonopolyPace;
  private readonly turnMs: number;
  private readonly endsAtLimit: number;
  private readonly rng: () => [number, number];
  private readonly engine: MonopolyGame;
  private readonly bots = new Set<string>();
  private readonly auto = new Set<string>();
  private startedAt: number;
  private endsAt: number;
  private deadline: number;
  private turnStartedAt: number;
  private ended: MonopolyEnd | null = null;
  private lastFacts: string[] = [];

  constructor(options: MonopolyTableOptions, restore?: MonopolyTableSnapshot) {
    this.host = options.host;
    this.seats = options.seats.map((seat) => ({ ...seat }));
    this.pace = restore?.pace ?? options.pace ?? 'standard';
    this.turnMs = options.turnMs ?? PACE_TURN_MS[this.pace];
    this.endsAtLimit = options.gameLimitMs ?? GAME_LIMIT_MS;
    this.rng = options.rng ?? dice;
    for (const seat of this.seats) if (seat.bot === true) this.bots.add(seat.id);

    if (restore) {
      this.status = restore.status;
      this.engine = MonopolyGame.restore(
        restore.game,
        new Map(this.seats.map((seat) => [seat.id, seat.name])),
      );
      this.deadline = restore.deadline;
      this.turnStartedAt = restore.turnStartedAt;
      this.startedAt = restore.startedAt;
      this.endsAt = restore.endsAt;
      this.ended = restore.ended;
      this.lastFacts = [...restore.lastFacts];
      for (const seatId of restore.auto) this.auto.add(seatId);
      for (const seatId of restore.bots) this.bots.add(seatId);
      return;
    }

    if (this.seats.length < 2) throw new TableError('not_open', '至少要两个席位才能开大富翁');
    this.startedAt = options.now;
    this.endsAt = options.now + this.endsAtLimit;
    this.engine = MonopolyGame.start({
      seats: this.seats.map((seat) => ({ seatId: seat.id, name: seat.name })),
      shuffle: options.shuffle ?? shuffle,
    });
    this.deadline = options.now + this.turnMs;
    this.turnStartedAt = options.now;
  }

  static restore(snapshot: MonopolyTableSnapshot, options: MonopolyTableOptions): MonopolyTable {
    validateSnapshot(snapshot);
    return new MonopolyTable(options, snapshot);
  }

  has(seatId: string): boolean {
    return this.seats.some((seat) => seat.id === seatId);
  }

  seatIds(): string[] {
    return this.seats.map((seat) => seat.id);
  }

  isBot(seatId: string): boolean {
    return this.bots.has(seatId);
  }

  isAuto(seatId: string): boolean {
    return this.auto.has(seatId);
  }

  /** 席位在开局时就定死了；没有中途坐下这回事。 */
  join(seat: TableSeat): TableEvent {
    if (this.has(seat.id)) throw new TableError('seated', '你已经在这局里了');
    throw new TableError('not_open', '大富翁开局后不能再加人；要加人请下一局');
  }

  start(by: string, now: number): TableStep {
    void by;
    void now;
    throw new TableError('not_open', '大富翁在开桌时就开局了，不需要再开始一次');
  }

  act(seatId: string, action: unknown, now: number): TableStep {
    if (!this.has(seatId)) throw new TableError('not_seated', '你不在这一局里');
    const input = (action ?? {}) as Record<string, unknown>;
    const type = typeof input.type === 'string' ? input.type : '';

    if (this.status !== 'playing') throw new TableError('not_started', '这局已经结束了');
    // 硬截止由动作入口自己判：tick 只是兜底，晚到的动作不能因为定时器还没跑就生效。
    if (now >= this.endsAt) throw new TableError('expired', '整局时限已到，这局会按当前资产结算');
    if (type === 'set_auto') return this.setAuto(seatId, input.on === true, now);
    if (this.engine.currentSeatId !== seatId) throw new TableError('not_turn', '还没轮到你');
    if (now >= this.deadline) throw new TableError('expired', '这一回合已经截止，服务器会按默认动作托管');

    let out: Outcome;
    try {
      switch (type) {
        case 'roll': out = this.engine.roll(seatId, this.rng()); break;
        case 'use_item': out = this.engine.useItem(seatId, input); break;
        case 'buy': out = this.engine.buy(seatId); break;
        case 'upgrade': out = this.engine.upgrade(seatId); break;
        case 'take_item': out = this.engine.takeItem(seatId, input); break;
        case 'pass': out = this.engine.pass(seatId, this.rng()); break;
        default: throw new TableError('bad_action', '不认识的动作：roll / use_item / buy / upgrade / take_item / pass / set_auto');
      }
    } catch (error) {
      throw mapError(error);
    }
    return this.apply(out, now);
  }

  tick(now: number): TableStep | null {
    if (this.status !== 'playing') return null;
    if (now >= this.endsAt) return this.apply(this.engine.finish('time'), now);
    const seatId = this.engine.currentSeatId;
    const bot = this.bots.has(seatId);
    const auto = this.auto.has(seatId);
    if (bot || auto) {
      const delay = bot ? BOT_DELAY_MS : 0;
      if (now - this.turnStartedAt < delay) return null;
      return this.timeout(now);
    }
    if (now < this.deadline) return null;
    return this.timeout(now);
  }

  view(seatId: string): unknown | null {
    const seat = this.seats.find((entry) => entry.id === seatId);
    if (!seat) return null;
    const state = this.engine.snapshot();
    const me = state.players[seatId]!;
    const legal = this.engine.legal();
    const mine = state.properties.filter((property) => property.owner === seatId);
    return {
      game: this.game,
      seat: seatId,
      name: seat.name,
      status: this.status,
      round: state.round,
      rounds: MONOPOLY_RULES.rounds,
      phase: state.phase,
      turn: this.engine.currentSeatId,
      yourTurn: this.engine.currentSeatId === seatId,
      deadline: this.deadline || undefined,
      endsAt: this.endsAt,
      cash: me.cash,
      pos: me.pos,
      position: cellAt(me.pos).name,
      items: { ...me.items },
      bankrupt: me.bankrupt,
      properties: mine.map((property) => ({
        index: property.index,
        name: cellAt(property.index).name,
        level: property.level,
        rent: this.rentLabel(property.index),
      })),
      pending: legal.pending,
      legal: this.engine.currentSeatId === seatId ? legal : undefined,
      players: state.order.map((id) => this.publicPlayer(state, id)),
      last: [...this.lastFacts].slice(-3),
      ...(state.ended ? { ended: state.ended } : {}),
    };
  }

  public(): TableSummary {
    const state = this.engine.snapshot();
    return {
      game: this.game,
      label: this.label,
      status: this.status,
      host: this.host,
      round: state.round,
      rounds: MONOPOLY_RULES.rounds,
      phase: state.phase,
      turn: this.engine.currentSeatId,
      deadline: this.deadline || undefined,
      endsAt: this.endsAt,
      seats: this.seats.map((seat) => ({
        id: seat.id,
        name: seat.name,
        ...(seat.bot ? { bot: true } : {}),
        ...(this.auto.has(seat.id) ? { auto: true } : {}),
      })),
      players: state.order.map((id) => this.publicPlayer(state, id)),
      properties: state.properties.map((property) => ({
        index: property.index,
        name: cellAt(property.index).name,
        owner: property.owner,
        level: property.level,
      })),
      last: [...this.lastFacts].slice(-4),
      ...(this.ended ? { winners: this.ended.winners, tie: this.ended.tie, ended: this.ended } : {}),
      text: this.publicText(),
    };
  }

  privateText(seatId: string, now: number): string | null {
    const seat = this.seats.find((entry) => entry.id === seatId);
    if (!seat) return null;
    const state = this.engine.snapshot();
    const me = state.players[seatId]!;
    const yourTurn = this.engine.currentSeatId === seatId && this.status === 'playing';
    const header = this.status === 'ended'
      ? `【大富翁｜已结束】`
      : `【大富翁｜第 ${state.round}/${MONOPOLY_RULES.rounds} 轮｜${yourTurn ? '轮到你' : `等 ${this.engine.nameOf(this.engine.currentSeatId)}`}】`;

    const mine = state.properties.filter((property) => property.owner === seatId);
    const owned = mine.length > 0
      ? mine.map((property) => `${cellAt(property.index).name}${property.level > 0 ? ' Lv1' : ''}`).join('、')
      : '还没有地';
    const held = ITEM_KINDS.filter((item) => me.items[item] > 0)
      .map((item) => `${ITEM_LABELS[item]}×${me.items[item]}`).join(' ') || '没有';
    const lines = [
      header,
      `你：现金 ${me.cash}，在 ${cellAt(me.pos).name}（${me.pos} 号格）${me.bankrupt ? '，已破产' : ''}。地产 ${mine.length} 块：${owned}。道具：${held}。`,
    ];

    if (this.status === 'playing') {
      if (yourTurn) {
        lines.push(`现在：${this.promptFor(state.phase)}`);
        lines.push(`截止 ${serverClockLabel(this.deadline)}，还剩 ${Math.max(0, Math.ceil((this.deadline - now) / 60_000))} 分钟；超时按「${phaseAction(state.phase)}」处理。`);
        lines.push(`地图：${compactBoard()}`);
      } else {
        lines.push(`下一个截止：${serverClockLabel(this.deadline)}（轮到 ${this.engine.nameOf(this.engine.currentSeatId)}）。`);
      }
      lines.push(`别人：${state.order.filter((id) => id !== seatId).map((id) => {
        const other = state.players[id]!;
        const count = state.properties.filter((property) => property.owner === id).length;
        return `${this.engine.nameOf(id)} ${other.cash}/${count} 块${other.bankrupt ? '（破产）' : ''}`;
      }).join('、')}。`);
      if (this.lastFacts.length > 0) lines.push(`最近：${this.lastFacts.slice(-2).join(' ')}`);
    } else if (this.ended) {
      lines.push(this.endSummary());
    }
    return lines.join('\n');
  }

  publicText(): string {
    const state = this.engine.snapshot();
    if (this.status === 'ended' && this.ended) return `【大富翁】${this.endSummary()}`;
    const turn = this.engine.nameOf(this.engine.currentSeatId);
    const funds = state.order.map((id) => {
      const player = state.players[id]!;
      const count = state.properties.filter((property) => property.owner === id).length;
      return `${this.engine.nameOf(id)} ${player.cash}/${count} 块${player.bankrupt ? '（破产）' : ''}${this.auto.has(id) ? '（托管）' : ''}`;
    }).join('、');
    return `【大富翁｜第 ${state.round}/${MONOPOLY_RULES.rounds} 轮】轮到 ${turn}（${this.publicPromptFor(state.phase)}）。${funds}。截止 ${serverClockLabel(this.deadline)}。`;
  }

  snapshot(): MonopolyTableSnapshot {
    return {
      version: 1,
      host: this.host,
      seats: this.seats.map((seat) => ({ ...seat })),
      pace: this.pace,
      status: this.status,
      game: this.engine.snapshot(),
      deadline: this.deadline,
      turnStartedAt: this.turnStartedAt,
      startedAt: this.startedAt,
      endsAt: this.endsAt,
      auto: [...this.auto],
      bots: [...this.bots],
      ended: this.ended,
      lastFacts: [...this.lastFacts],
    };
  }

  /** 给回执用：这一手之后这个人看到的私视图。 */
  receiptText(seatId: string, now: number): string | null {
    return this.privateText(seatId, now);
  }

  // —— 内部 ——

  private setAuto(seatId: string, on: boolean, now: number): TableStep {
    if (on) this.auto.add(seatId);
    else this.auto.delete(seatId);
    const name = this.engine.nameOf(seatId);
    const event: TableEvent = {
      type: 'parlor.table.action',
      scope: { kind: 'room' },
      text: on ? `${name} 把这局设成了托管：轮到自己时按默认动作走。` : `${name} 取消了这局的托管。`,
      data: { game: this.game, seat: seatId, auto: on },
    };
    // 刚开的托管从下一位开始算「立即」，别把人正在想的那一回合抢走。
    if (on && this.engine.currentSeatId !== seatId) this.turnStartedAt = now;
    return { events: [event], views: [] };
  }

  private timeout(now: number): TableStep {
    const out = this.engine.timeout(this.rng());
    return this.apply(out, now, true);
  }

  private apply(out: Outcome, now: number, managed = false): TableStep {
    const state = this.engine.snapshot();
    const events: TableEvent[] = [];
    const seatId = out.nextTurn?.seatId ?? this.engine.currentSeatId;
    const data = { game: this.game, round: state.round, turn: seatId };

    for (const fact of out.facts) {
      events.push({
        type: 'parlor.table.action',
        scope: { kind: 'room' },
        text: fact,
        data: { ...data, managed },
      });
    }

    this.lastFacts = [...this.lastFacts, ...out.facts].slice(-8);

    const views: string[] = [];
    if (out.ended) {
      this.status = 'ended';
      this.ended = out.ended;
      this.deadline = 0;
      events.push({
        type: 'parlor.table.end',
        scope: { kind: 'room' },
        text: this.endSummary(),
        data: {
          game: this.game,
          gameLabel: this.label,
          winners: out.ended.winners,
          tie: out.ended.tie,
          reason: out.ended.reason,
          ranking: out.ended.ranking,
        },
      });
      return { events, views, ended: true };
    }

    if (out.nextTurn) {
      this.deadline = now + this.turnMs;
      this.turnStartedAt = now;
      const next = out.nextTurn.seatId;
      // 脚本席位不是房间席位，不推私视图（和斗地主的脚本陪练一致）。
      if (!this.bots.has(next)) views.push(next);
    }
    // 同一回合里的第二步（掷骰 → 落地选择）不单独推私视图：
    // 走工具回执把视图带回去，避免自己把自己再叫醒一次。
    return { events, views };
  }

  /** 公开文本只说在等什么，不列具体道具——列了等于把别人手上的牌念出来。 */
  private publicPromptFor(phase: Phase): string {
    const legal = this.engine.legal();
    if (phase === 'buy' && legal.pending !== null) return `等你决定买不买 ${cellAt(legal.pending).name}`;
    if (phase === 'upgrade' && legal.pending !== null) return `等你决定升不升级 ${cellAt(legal.pending).name}`;
    if (phase === 'workshop') return '在工坊挑道具';
    return '准备掷骰';
  }

  private promptFor(phase: Phase): string {
    const state = this.engine.snapshot();
    const legal = this.engine.legal();
    if (phase === 'prepare') {
      const options: string[] = ['parlor_monopoly {action:"roll"} 掷骰'];
      if (legal.items.includes('signpost')) options.push('{action:"use_item", item:"signpost", steps:1-6} 路标卡');
      if (legal.items.includes('pass')) options.push('{action:"use_item", item:"pass"} 通行卡');
      if (legal.items.includes('repair')) {
        const targets = legal.repairTargets.map((target) => `${target.index} ${cellAt(target.index).name}(${target.cost})`).join('、');
        options.push(`{action:"use_item", item:"repair", target:格号} 修缮卡，可修：${targets}`);
      }
      return `${options.join('；')}。`;
    }
    if (phase === 'buy' && legal.pending !== null) {
      const cell = cellAt(legal.pending);
      return `等你决定买不买 ${cell.name}（${cell.price} 金币）：{action:"buy"} 或 {action:"pass"}。`;
    }
    if (phase === 'upgrade' && legal.pending !== null) {
      const cell = cellAt(legal.pending);
      return `等你决定升不升级 ${cell.name}（${cell.upgrade} 金币）：{action:"upgrade"} 或 {action:"pass"}。`;
    }
    if (phase === 'workshop') {
      const missing = ITEM_KINDS.filter((item) => state.players[this.engine.currentSeatId]!.items[item] < MONOPOLY_RULES.itemsPerKind);
      return `工坊：可以补一张（${missing.map((item) => ITEM_LABELS[item]).join('、')}）：{action:"take_item", item:"…"} 或 {action:"pass"}。`;
    }
    return '等着结算。';
  }

  private endSummary(): string {
    const ended = this.ended;
    if (!ended) return '';
    const label = ended.reason === 'last-standing' ? '只剩一名未破产玩家'
      : ended.reason === 'rounds' ? `走满 ${MONOPOLY_RULES.rounds} 轮`
        : ended.reason === 'time' ? '整局时限到' : `连续 ${MONOPOLY_RULES.idleRoundsToEnd} 轮没人主动动作`;
    const top = ended.ranking.map((entry, index) => (
      `${index + 1}. ${this.engine.nameOf(entry.seatId)} ${entry.assets}`
      + `（现金 ${entry.cash} + 地产 ${entry.propertyValue}）${entry.bankrupt ? '（破产）' : ''}`
    )).join('，');
    const winners = ended.winners.map((seatId) => this.engine.nameOf(seatId)).join('、');
    return `结束（${label}）。${ended.tie ? `并列第一：${winners}` : `赢家：${winners}`}。${top}。`;
  }

  private publicPlayer(state: MonopolyState, seatId: string): Record<string, unknown> {
    const player = state.players[seatId]!;
    const owned = state.properties.filter((property) => property.owner === seatId);
    return {
      id: seatId,
      name: this.engine.nameOf(seatId),
      cash: player.cash,
      pos: player.pos,
      position: cellAt(player.pos).name,
      properties: owned.length,
      bankrupt: player.bankrupt,
      ...(this.auto.has(seatId) ? { auto: true } : {}),
    };
  }

  private rentLabel(index: number): number {
    const property = this.engine.property(index);
    if (!property) return 0;
    const cell = cellAt(index);
    const level = property.level > 0 ? MONOPOLY_RULES.upgradedRentMultiplier : 1;
    const group = this.ownsGroup(index) ? MONOPOLY_RULES.groupRentMultiplier : 1;
    return Math.ceil((cell.rent ?? 0) * level * group);
  }

  private ownsGroup(index: number): boolean {
    const cell = cellAt(index);
    if (!cell.group) return false;
    const owner = this.engine.property(index)?.owner;
    if (!owner) return false;
    return BOARD.filter((entry) => entry.group === cell.group)
      .every((entry) => this.engine.property(entry.index)?.owner === owner);
  }
}

/** 给外部（内核、家长页）读一眼：还剩多少秒。 */
export const monopolySecondsLeft = (deadline: number, now: number): number => secondsLeft(deadline, now);

export const isMonopolyItem = isItemKind;
export type { ItemKind };
