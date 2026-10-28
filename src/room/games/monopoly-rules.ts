/**
 * 大富翁规则：纯规则，不碰网络、不碰模型、不读时钟、不掷骰。
 * 骰点由调用方注入（先落盘再结算），时钟与持久化在 table / activity-store 那边。
 * 地图与数值是冻结的常量表；改数值要同时改 mapVersion，免得一局中途换了数。
 *
 * 一回合的相位：prepare（可先用一张道具）→ buy | upgrade | workshop（落地选择）→ 下一位。
 * 没有任何可选动作时直接结束，不要求再点一次「结束」。
 */

export type GroupId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export type CellKind = 'start' | 'property' | 'workshop' | 'subsidy' | 'park' | 'fee' | 'maintenance';
export type ItemKind = 'signpost' | 'pass' | 'repair';

export const ITEM_KINDS: readonly ItemKind[] = ['signpost', 'pass', 'repair'];

export const ITEM_LABELS: Readonly<Record<ItemKind, string>> = {
  signpost: '路标卡',
  pass: '通行卡',
  repair: '修缮卡',
};

export const isItemKind = (value: unknown): value is ItemKind => (
  typeof value === 'string' && (ITEM_KINDS as readonly string[]).includes(value)
);

export interface Cell {
  index: number;
  name: string;
  kind: CellKind;
  group?: GroupId;
  /** property：购地标价。 */
  price?: number;
  /** property：基础租金。 */
  rent?: number;
  /** property：升级费用。 */
  upgrade?: number;
  /** subsidy / fee：金额。 */
  amount?: number;
  /** maintenance：每块已升级土地交这么多。 */
  perUpgrade?: number;
}

const PROPERTY = (index: number, name: string, group: GroupId, price: number, rent: number, upgrade: number): Cell => (
  { index, name, kind: 'property', group, price, rent, upgrade }
);

/** 客厅街区 v1：24 格顺时针，12 块地成 6 组。两颗骰走 2–12 格。 */
export const BOARD: readonly Cell[] = Object.freeze([
  { index: 0, name: '客厅门口', kind: 'start' },
  PROPERTY(1, '早餐铺', 'A', 160, 40, 80),
  PROPERTY(2, '面包房', 'A', 160, 40, 80),
  { index: 3, name: '街角工坊', kind: 'workshop' },
  { index: 4, name: '邻里补助', kind: 'subsidy', amount: 80 },
  PROPERTY(5, '花店', 'B', 200, 60, 100),
  { index: 6, name: '小公园', kind: 'park' },
  PROPERTY(7, '小书店', 'B', 200, 60, 100),
  { index: 8, name: '街区维护', kind: 'fee', amount: 80 },
  PROPERTY(9, '茶馆', 'C', 240, 80, 120),
  PROPERTY(10, '唱片店', 'C', 240, 80, 120),
  { index: 11, name: '公共检修', kind: 'maintenance', perUpgrade: 20 },
  { index: 12, name: '中央广场', kind: 'park' },
  PROPERTY(13, '影院', 'D', 280, 100, 140),
  PROPERTY(14, '游戏厅', 'D', 280, 100, 140),
  { index: 15, name: '河边工坊', kind: 'workshop' },
  { index: 16, name: '邻里补助', kind: 'subsidy', amount: 80 },
  PROPERTY(17, '咖啡馆', 'E', 320, 120, 160),
  { index: 18, name: '河滨公园', kind: 'park' },
  PROPERTY(19, '甜品屋', 'E', 320, 120, 160),
  { index: 20, name: '街区维护', kind: 'fee', amount: 80 },
  PROPERTY(21, '小剧场', 'F', 360, 140, 180),
  PROPERTY(22, '展览馆', 'F', 360, 140, 180),
  { index: 23, name: '公共检修', kind: 'maintenance', perUpgrade: 20 },
]);

export const BOARD_SIZE = BOARD.length;

export const PROPERTY_INDICES: readonly number[] = BOARD.filter((cell) => cell.kind === 'property').map((cell) => cell.index);

export const GROUPS: Readonly<Record<GroupId, readonly number[]>> = Object.freeze(
  (['A', 'B', 'C', 'D', 'E', 'F'] as const).reduce((acc, group) => {
    acc[group] = BOARD.filter((cell) => cell.group === group).map((cell) => cell.index);
    return acc;
  }, {} as Record<GroupId, number[]>),
);

export const cellAt = (index: number): Cell => BOARD[((index % BOARD_SIZE) + BOARD_SIZE) % BOARD_SIZE];

/** 冻结的数值。改这里必须同时改 mapVersion，并在设计记录里写「改前 / 改后 / 模拟结果」。 */
export const MONOPOLY_RULES = Object.freeze({
  version: 1,
  mapVersion: 1,
  /** 两颗骰，走 2–12 格。 */
  diceCount: 2,
  startingCash: 1200,
  /** 越过或恰好落到起点发一次。 */
  startBonus: 120,
  rounds: 12,
  /** 升级后租金翻倍。 */
  upgradedRentMultiplier: 2,
  /** 同组两块都在手上，租金再乘。 */
  groupRentMultiplier: 1.5,
  /** 通行卡：本回合踩到他人地产，租金减半。 */
  passCardMultiplier: 0.5,
  /** 回收价：标价的 50% + 实际升级支出的 50%，各自向下取整。 */
  sellRate: 0.5,
  /** 修缮卡：付正常升级费用的 50%。 */
  repairDiscount: 0.5,
  /** 每种道具最多持有一张。 */
  itemsPerKind: 1,
  /** 连续这么多整轮没有任何主动动作就提前结束。 */
  idleRoundsToEnd: 3,
});

export type Phase = 'prepare' | 'buy' | 'upgrade' | 'workshop';

export interface PlayerState {
  seatId: string;
  cash: number;
  pos: number;
  items: Record<ItemKind, number>;
  bankrupt: boolean;
  /** 本回合开了通行卡；回合结束清掉。 */
  passThisTurn: boolean;
}

export interface PropertyState {
  index: number;
  owner: string | null;
  level: 0 | 1;
  /** 实际付出去的升级费用；回收与资产都按实付算，折扣修缮不能造钱。 */
  upgradePaid: number;
}

export interface MonopolyRank {
  seatId: string;
  cash: number;
  propertyValue: number;
  assets: number;
  properties: number;
  bankrupt: boolean;
}

export interface MonopolyEnd {
  reason: 'last-standing' | 'rounds' | 'time' | 'idle';
  winners: string[];
  tie: boolean;
  ranking: MonopolyRank[];
}

export interface MonopolyState {
  rulesVersion: number;
  mapVersion: number;
  /** 开局冻结的轮序（席位 id）。 */
  order: string[];
  players: Record<string, PlayerState>;
  properties: PropertyState[];
  round: number;
  turnIndex: number;
  phase: Phase;
  /** 每换一位就 +1；用来去重「同一回合被叫醒两次」。 */
  turnSeq: number;
  /** 本回合已经用过道具（每回合最多一张）。 */
  itemUsed: boolean;
  /** 落地后等着买 / 升级的那块地。 */
  pending: number | null;
  /** 这一轮里有没有任何主动动作（托管不算）。 */
  voluntaryThisRound: boolean;
  idleRounds: number;
  ended: MonopolyEnd | null;
  turnsTaken: number;
  timeouts: number;
}

export interface Outcome {
  /** 公开事实，按发生顺序。 */
  facts: string[];
  /** 只给本人看的话（补到什么卡之类）。 */
  notes: Record<string, string[]>;
  /** 这一手之后轮到谁；没有换人就为 null。 */
  nextTurn: { seatId: string; round: number } | null;
  ended: MonopolyEnd | null;
}

export type MonopolyErrorCode = 'not_your_turn' | 'wrong_phase' | 'not_affordable' | 'not_available' | 'bad_input';

export class MonopolyError extends Error {
  readonly code: MonopolyErrorCode;

  constructor(code: MonopolyErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'MonopolyError';
  }
}

const emptyItems = (): Record<ItemKind, number> => ({ signpost: 0, pass: 0, repair: 0 });

const clone = <T>(value: T): T => structuredClone(value);

const isSeatId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const isBool = (value: unknown): value is boolean => typeof value === 'boolean';
const PHASES: readonly Phase[] = ['prepare', 'buy', 'upgrade', 'workshop'];
const END_REASONS: readonly MonopolyEnd['reason'][] = ['last-standing', 'rounds', 'time', 'idle'];

/**
 * 存档自检：取值、边界和交叉关系都查，任何一条不对就整份拒绝。
 * 这里宁可拒绝一局，也不拿半张桌子去跑——损坏状态比停局难查得多。
 */
export function validateState(raw: unknown): MonopolyState {
  if (!raw || typeof raw !== 'object') throw new MonopolyError('bad_input', '活动存档不是对象');
  const state = raw as Partial<MonopolyState>;
  if (state.rulesVersion !== MONOPOLY_RULES.version || state.mapVersion !== MONOPOLY_RULES.mapVersion) {
    throw new MonopolyError('bad_input', '活动存档的规则版本和当前不一致');
  }
  if (!Array.isArray(state.order) || state.order.length < 2 || state.order.length > 6 || !state.order.every(isSeatId)) {
    throw new MonopolyError('bad_input', '活动存档的轮序坏了');
  }
  const order = state.order;
  if (new Set(order).size !== order.length) throw new MonopolyError('bad_input', '活动存档的轮序有重复席位');
  if (!state.players || typeof state.players !== 'object') throw new MonopolyError('bad_input', '活动存档缺少玩家');

  const players = state.players as Record<string, PlayerState>;
  const stranger = Object.keys(players).find((seatId) => !order.includes(seatId));
  if (stranger) throw new MonopolyError('bad_input', '活动存档里有轮序之外的玩家');
  for (const seatId of order) {
    const player = players[seatId];
    if (!player || player.seatId !== seatId) throw new MonopolyError('bad_input', `活动存档缺少席位 ${seatId}`);
    if (!isInt(player.cash) || player.cash < 0) throw new MonopolyError('bad_input', `席位 ${seatId} 的现金坏了`);
    if (!isInt(player.pos) || player.pos < 0 || player.pos >= BOARD_SIZE) {
      throw new MonopolyError('bad_input', `席位 ${seatId} 的位置越界`);
    }
    if (!player.items || typeof player.items !== 'object') throw new MonopolyError('bad_input', `席位 ${seatId} 缺道具`);
    if (Object.keys(player.items).length !== ITEM_KINDS.length) {
      throw new MonopolyError('bad_input', `席位 ${seatId} 的道具种类不对`);
    }
    for (const item of ITEM_KINDS) {
      if (!isInt(player.items[item]) || player.items[item] < 0 || player.items[item] > MONOPOLY_RULES.itemsPerKind) {
        throw new MonopolyError('bad_input', `席位 ${seatId} 的${ITEM_LABELS[item]}数量坏了`);
      }
    }
    if (!isBool(player.bankrupt) || !isBool(player.passThisTurn)) {
      throw new MonopolyError('bad_input', `席位 ${seatId} 的状态标记坏了`);
    }
    if (player.bankrupt && player.cash !== 0) throw new MonopolyError('bad_input', `席位 ${seatId} 已破产却还有现金`);
  }

  if (!Array.isArray(state.properties) || state.properties.length !== PROPERTY_INDICES.length) {
    throw new MonopolyError('bad_input', '活动存档的地产数量不对');
  }
  const seen = new Set<number>();
  for (const property of state.properties) {
    if (!property || !PROPERTY_INDICES.includes(property.index)) {
      throw new MonopolyError('bad_input', '活动存档里有不认识的地产编号');
    }
    if (seen.has(property.index)) throw new MonopolyError('bad_input', '活动存档里的地产编号重复');
    seen.add(property.index);
    if (property.owner !== null && !order.includes(property.owner)) {
      throw new MonopolyError('bad_input', '活动存档里有轮序之外的地主');
    }
    if (property.level !== 0 && property.level !== 1) throw new MonopolyError('bad_input', '活动存档的升级等级坏了');
    if (!isInt(property.upgradePaid) || property.upgradePaid < 0) {
      throw new MonopolyError('bad_input', '活动存档的升级实付坏了');
    }
    if (property.level === 0 && property.upgradePaid !== 0) {
      throw new MonopolyError('bad_input', '没升级的地却记着实付升级费');
    }
  }

  if (!isInt(state.round) || state.round < 1 || state.round > MONOPOLY_RULES.rounds + 1) {
    throw new MonopolyError('bad_input', '活动存档的轮次坏了');
  }
  if (!isInt(state.turnIndex) || state.turnIndex < 0 || state.turnIndex >= order.length) {
    throw new MonopolyError('bad_input', '活动存档的当前玩家下标越界');
  }
  if (!PHASES.includes(state.phase as Phase)) throw new MonopolyError('bad_input', '活动存档的相位坏了');
  if (!isInt(state.turnSeq) || state.turnSeq < 1) throw new MonopolyError('bad_input', '活动存档的回合号坏了');
  if (!isBool(state.itemUsed) || !isBool(state.voluntaryThisRound)) {
    throw new MonopolyError('bad_input', '活动存档的状态标记坏了');
  }
  if (!isInt(state.idleRounds) || state.idleRounds < 0) throw new MonopolyError('bad_input', '活动存档的空转轮数坏了');
  if (!isInt(state.turnsTaken) || state.turnsTaken < 0) throw new MonopolyError('bad_input', '活动存档的回合计数坏了');
  if (!isInt(state.timeouts) || state.timeouts < 0) throw new MonopolyError('bad_input', '活动存档的托管计数坏了');

  const current = players[order[state.turnIndex]!]!;
  const pending = state.pending;
  if (state.phase === 'prepare') {
    if (pending !== null) throw new MonopolyError('bad_input', '准备阶段不该有等待中的地块');
  } else if (!isInt(pending) || pending < 0 || pending >= BOARD_SIZE) {
    throw new MonopolyError('bad_input', '等待中的地块编号不对');
  } else if (state.phase === 'workshop') {
    if (cellAt(pending).kind !== 'workshop') throw new MonopolyError('bad_input', '等待补卡的格子不是工坊');
  } else {
    const property = state.properties.find((entry) => entry.index === pending);
    if (!property || cellAt(pending).kind !== 'property') {
      throw new MonopolyError('bad_input', '等待选择的地块不是地产');
    }
    if (state.phase === 'buy' && property.owner !== null) {
      throw new MonopolyError('bad_input', '等在买的地已经有主');
    }
    if (state.phase === 'upgrade' && (property.owner !== current.seatId || property.level > 0)) {
      throw new MonopolyError('bad_input', '等在升级的地不属于当前玩家或已经升过');
    }
  }
  if (state.ended === undefined) throw new MonopolyError('bad_input', '活动存档缺结局字段');
  if (state.ended === null) {
    if (current.bankrupt) throw new MonopolyError('bad_input', '轮到一位已破产的玩家');
  } else {
    if (!state.ended || typeof state.ended !== 'object') throw new MonopolyError('bad_input', '活动存档的结局坏了');
    if (!END_REASONS.includes(state.ended.reason)) throw new MonopolyError('bad_input', '活动存档的结局原因不认识');
    if (!Array.isArray(state.ended.winners) || state.ended.winners.length === 0
      || !state.ended.winners.every((id) => order.includes(id))) {
      throw new MonopolyError('bad_input', '活动存档的赢家名单坏了');
    }
    if (!isBool(state.ended.tie)) throw new MonopolyError('bad_input', '活动存档的并列标记坏了');
    if (!Array.isArray(state.ended.ranking) || state.ended.ranking.length !== order.length) {
      throw new MonopolyError('bad_input', '活动存档的排名不完整');
    }
    const ranked = new Set<string>();
    for (const entry of state.ended.ranking) {
      if (!entry || !order.includes(entry.seatId) || ranked.has(entry.seatId)) {
        throw new MonopolyError('bad_input', '活动存档的排名里有陌生或重复的席位');
      }
      ranked.add(entry.seatId);
      if (!isInt(entry.cash) || entry.cash < 0 || !isInt(entry.propertyValue) || entry.propertyValue < 0
        || !isInt(entry.assets) || entry.assets < 0 || !isInt(entry.properties) || entry.properties < 0
        || !isBool(entry.bankrupt)) {
        throw new MonopolyError('bad_input', '活动存档的排名金额坏了');
      }
    }
  }
  return raw as MonopolyState;
}

export interface StartOptions {
  /** 按报名顺序给的席位；开局时随机打乱成轮序。 */
  seats: ReadonlyArray<{ seatId: string; name: string }>;
  /** 人手或测试注入的掷骰函数，用来洗轮序；默认取 0.5。 */
  shuffle?: (list: readonly string[]) => string[];
}

export class MonopolyGame {
  private readonly names = new Map<string, string>();
  private state: MonopolyState;

  private constructor(state: MonopolyState) {
    this.state = state;
  }

  static start(options: StartOptions): MonopolyGame {
    const seats = options.seats;
    if (seats.length < 2) throw new MonopolyError('bad_input', '至少要两个席位才能开局');
    const seatIds = seats.map((seat) => seat.seatId);
    if (new Set(seatIds).size !== seatIds.length) throw new MonopolyError('bad_input', '同一个席位不能在桌上占两次');
    const order = options.shuffle ? options.shuffle(seatIds) : [...seatIds];
    if (order.length !== seatIds.length || new Set(order).size !== order.length) {
      throw new MonopolyError('bad_input', '轮序和席位对不上');
    }
    const players: Record<string, PlayerState> = {};
    for (const seatId of order) {
      players[seatId] = {
        seatId,
        cash: MONOPOLY_RULES.startingCash,
        pos: 0,
        items: { ...emptyItems(), signpost: 1, pass: 1, repair: 1 },
        bankrupt: false,
        passThisTurn: false,
      };
    }
    const state: MonopolyState = {
      rulesVersion: MONOPOLY_RULES.version,
      mapVersion: MONOPOLY_RULES.mapVersion,
      order,
      players,
      properties: PROPERTY_INDICES.map((index) => ({ index, owner: null, level: 0, upgradePaid: 0 })),
      round: 1,
      turnIndex: 0,
      phase: 'prepare',
      turnSeq: 1,
      itemUsed: false,
      pending: null,
      voluntaryThisRound: false,
      idleRounds: 0,
      ended: null,
      turnsTaken: 0,
      timeouts: 0,
    };
    const game = new MonopolyGame(state);
    for (const seat of seats) game.names.set(seat.seatId, seat.name);
    return game;
  }

  static restore(raw: unknown, names: ReadonlyMap<string, string>): MonopolyGame {
    const state = validateState(clone(raw));
    if (state.rulesVersion !== MONOPOLY_RULES.version || state.mapVersion !== MONOPOLY_RULES.mapVersion) {
      throw new MonopolyError('bad_input', '活动存档的规则版本和当前不一致');
    }
    const game = new MonopolyGame(state);
    for (const [seatId, name] of names) game.names.set(seatId, name);
    return game;
  }

  /** 席位改了显示名：之后的文字用新名字，状态里不存名字。 */
  setNames(names: ReadonlyMap<string, string>): void {
    for (const [seatId, name] of names) this.names.set(seatId, name);
  }

  nameOf(seatId: string): string {
    return this.names.get(seatId) ?? seatId;
  }

  snapshot(): MonopolyState {
    return clone(this.state);
  }

  get ended(): MonopolyEnd | null {
    return this.state.ended;
  }

  get phase(): Phase {
    return this.state.phase;
  }

  get round(): number {
    return this.state.round;
  }

  get turnSeq(): number {
    return this.state.turnSeq;
  }

  get currentSeatId(): string {
    return this.state.order[this.state.turnIndex]!;
  }

  player(seatId: string): PlayerState {
    const player = this.state.players[seatId];
    if (!player) throw new MonopolyError('bad_input', '这个席位不在这局里');
    return player;
  }

  property(index: number): PropertyState | null {
    return this.state.properties.find((property) => property.index === index) ?? null;
  }

  alive(): string[] {
    return this.state.order.filter((seatId) => !this.state.players[seatId]!.bankrupt);
  }

  /** 当前玩家此刻能做什么；World 用这段生成「合法动作」。 */
  legal(): {
    seatId: string;
    phase: Phase;
    pending: number | null;
    canRoll: boolean;
    items: ItemKind[];
    canBuy: boolean;
    canUpgrade: boolean;
    workshop: ItemKind[];
    standing: string[];
    /** 修缮卡此刻真正能修的地与费用；空 = 有卡也没用。 */
    repairTargets: Array<{ index: number; cost: number }>;
  } {
    const seatId = this.currentSeatId;
    const player = this.player(seatId);
    const pending = this.state.pending;
    const property = pending === null ? null : this.property(pending);
    const repairTargets = this.state.phase === 'prepare' && !this.state.itemUsed && player.items.repair > 0
      ? this.state.properties
        .filter((entry) => entry.owner === seatId && entry.level === 0)
        .map((entry) => ({
          index: entry.index,
          cost: Math.floor((cellAt(entry.index).upgrade ?? 0) * MONOPOLY_RULES.repairDiscount),
        }))
        .filter((target) => player.cash >= target.cost)
      : [];
    return {
      seatId,
      phase: this.state.phase,
      pending,
      canRoll: this.state.phase === 'prepare',
      items: this.state.phase === 'prepare' && !this.state.itemUsed
        ? ITEM_KINDS.filter((item) => player.items[item] > 0 && (item !== 'repair' || repairTargets.length > 0))
        : [],
      canBuy: this.state.phase === 'buy' && !!property && property.owner === null && player.cash >= (cellAt(property.index).price ?? 0),
      canUpgrade: this.state.phase === 'upgrade' && !!property && property.owner === seatId
        && property.level === 0 && player.cash >= (cellAt(property.index).upgrade ?? 0),
      workshop: this.state.phase === 'workshop'
        ? ITEM_KINDS.filter((item) => player.items[item] < MONOPOLY_RULES.itemsPerKind)
        : [],
      standing: ITEM_KINDS.filter((item) => player.items[item] > 0),
      repairTargets,
    };
  }

  // —— 动作 ——

  /** 掷骰移动。骰点由调用方给（先落盘再结算），这里只校验。 */
  roll(seatId: string, dice: readonly number[]): Outcome {
    this.begin(seatId, 'prepare');
    const out = this.emptyOutcome();
    const steps = this.diceSteps(dice);
    this.state.voluntaryThisRound = true;
    out.facts.push(`${this.nameOf(seatId)} 掷出 ${dice.join(' + ')} = ${steps}。`);
    const result = this.doMove(steps, out);
    if (result === 'ended') this.fillEnd(out);
    return out;
  }

  useItem(seatId: string, input: unknown): Outcome {
    this.begin(seatId, 'prepare');
    const action = (input ?? {}) as { item?: unknown; steps?: unknown; target?: unknown };
    if (!isItemKind(action.item)) throw new MonopolyError('bad_input', '道具要写 signpost、pass 或 repair');
    if (this.state.itemUsed) throw new MonopolyError('wrong_phase', '这一回合已经用过一张道具了');
    const player = this.player(seatId);
    if (player.items[action.item] < 1) throw new MonopolyError('not_available', `你手上没有${ITEM_LABELS[action.item]}`);
    const out = this.emptyOutcome();

    if (action.item === 'signpost') {
      const steps = action.steps;
      if (typeof steps !== 'number' || !Number.isInteger(steps) || steps < 1 || steps > 6) {
        throw new MonopolyError('bad_input', '路标卡要走 1 到 6 格');
      }
      this.state.voluntaryThisRound = true;
      this.consumeItem(seatId, 'signpost');
      out.facts.push(`${this.nameOf(seatId)} 用了路标卡，指定向前 ${steps} 格。`);
      const result = this.doMove(steps, out);
      if (result === 'ended') this.fillEnd(out);
      return out;
    }

    if (action.item === 'pass') {
      this.state.voluntaryThisRound = true;
      this.consumeItem(seatId, 'pass');
      player.passThisTurn = true;
      out.facts.push(`${this.nameOf(seatId)} 用了通行卡：这一回合踩到别人的地产，租金减半。`);
      return out;
    }

    // 修缮卡：选自己一块还没升级的地，付半价立刻升。
    const target = action.target;
    if (typeof target !== 'number' || !Number.isInteger(target)) {
      throw new MonopolyError('bad_input', '修缮卡要指定一块自己的地（格号）');
    }
    const cell = cellAt(target);
    const property = this.property(target);
    if (cell.kind !== 'property' || !property) throw new MonopolyError('bad_input', '那一格不是地产');
    if (property.owner !== seatId) throw new MonopolyError('not_available', '那块地不是你的');
    if (property.level > 0) throw new MonopolyError('not_available', '那块地已经升过级了');
    const cost = Math.floor((cell.upgrade ?? 0) * MONOPOLY_RULES.repairDiscount);
    if (player.cash < cost) throw new MonopolyError('not_affordable', `修缮要 ${cost} 金币，你只有 ${player.cash}`);
    this.state.voluntaryThisRound = true;
    this.consumeItem(seatId, 'repair');
    player.cash -= cost;
    property.level = 1;
    property.upgradePaid += cost;
    out.facts.push(`${this.nameOf(seatId)} 用了修缮卡：${cell.name} 半价升级（付 ${cost} 金币）。`);
    return out;
  }

  buy(seatId: string): Outcome {
    this.begin(seatId, 'buy');
    const index = this.state.pending!;
    const cell = cellAt(index);
    const property = this.property(index)!;
    const player = this.player(seatId);
    if (property.owner !== null) throw new MonopolyError('not_available', '这块地已经有主了');
    const price = cell.price ?? 0;
    if (player.cash < price) throw new MonopolyError('not_affordable', `买这块地要 ${price} 金币，你只有 ${player.cash}`);
    const out = this.emptyOutcome();
    this.state.voluntaryThisRound = true;
    player.cash -= price;
    property.owner = seatId;
    property.level = 0;
    property.upgradePaid = 0;
    out.facts.push(`${this.nameOf(seatId)} 买下 ${cell.name}，付 ${price} 金币。`);
    this.endTurn(out);
    this.fillEnd(out);
    return out;
  }

  upgrade(seatId: string): Outcome {
    this.begin(seatId, 'upgrade');
    const index = this.state.pending!;
    const cell = cellAt(index);
    const property = this.property(index)!;
    const player = this.player(seatId);
    if (property.owner !== seatId) throw new MonopolyError('not_available', '那块地不是你的');
    if (property.level > 0) throw new MonopolyError('not_available', '那块地已经升过级了');
    const cost = cell.upgrade ?? 0;
    if (player.cash < cost) throw new MonopolyError('not_affordable', `升级要 ${cost} 金币，你只有 ${player.cash}`);
    const out = this.emptyOutcome();
    this.state.voluntaryThisRound = true;
    player.cash -= cost;
    property.level = 1;
    property.upgradePaid += cost;
    out.facts.push(`${this.nameOf(seatId)} 把 ${cell.name} 升了一级，付 ${cost} 金币。`);
    this.endTurn(out);
    this.fillEnd(out);
    return out;
  }

  takeItem(seatId: string, input: unknown): Outcome {
    this.begin(seatId, 'workshop');
    const item = (input as { item?: unknown } | null)?.item;
    if (!isItemKind(item)) throw new MonopolyError('bad_input', '补卡要写 signpost、pass 或 repair');
    const player = this.player(seatId);
    if (player.items[item] >= MONOPOLY_RULES.itemsPerKind) throw new MonopolyError('not_available', `你已经有一张${ITEM_LABELS[item]}了`);
    const out = this.emptyOutcome();
    this.state.voluntaryThisRound = true;
    player.items[item] += 1;
    // 补到的卡种只进本人私视图：牌桌只公开「补了一张道具」。
    out.facts.push(`${this.nameOf(seatId)} 在工坊补了一张道具。`);
    out.notes[seatId] = [`你补到的是${ITEM_LABELS[item]}，最早下个自己的回合能用。`];
    this.endTurn(out);
    this.fillEnd(out);
    return out;
  }

  /** 放弃当前的可选选择；在准备阶段则按默认动作走完（掷骰、不买、不用道具）。 */
  pass(seatId: string, dice: readonly number[]): Outcome {
    const out = this.emptyOutcome();
    if (this.state.ended) return out;
    if (seatId !== this.currentSeatId) throw new MonopolyError('not_your_turn', '还没轮到你');
    this.defaultTurn(dice, out, true);
    this.fillEnd(out);
    return out;
  }

  /** 服务器托管：和 pass 一样，但不算主动动作。 */
  timeout(dice: readonly number[]): Outcome {
    const out = this.emptyOutcome();
    if (this.state.ended) return out;
    this.state.timeouts += 1;
    this.defaultTurn(dice, out, false);
    this.fillEnd(out);
    return out;
  }

  /** 整局时限到：按当前资产结算。 */
  finish(reason: 'time' | 'idle' | 'rounds'): Outcome {
    const out = this.emptyOutcome();
    this.finishNow(reason, out.facts);
    this.fillEnd(out);
    return out;
  }

  // —— 内部 ——

  private begin(seatId: string, phase: Phase): void {
    if (this.state.ended) throw new MonopolyError('bad_input', '这局已经结束了');
    if (seatId !== this.currentSeatId) throw new MonopolyError('not_your_turn', '还没轮到你');
    if (this.state.phase !== phase) {
      throw new MonopolyError('wrong_phase', phaseHint(this.state.phase));
    }
  }

  private emptyOutcome(): Outcome {
    return { facts: [], notes: {}, nextTurn: null, ended: null };
  }

  private fillEnd(out: Outcome): void {
    out.ended = this.state.ended;
  }

  private consumeItem(seatId: string, item: ItemKind): void {
    const player = this.player(seatId);
    if (player.items[item] < 1) throw new MonopolyError('not_available', `你手上没有${ITEM_LABELS[item]}`);
    player.items[item] -= 1;
    this.state.itemUsed = true;
  }

  /** 骰点校验；不合法就抛，任何状态都还没动。 */
  private diceSteps(dice: readonly number[]): number {
    if (!Array.isArray(dice) || dice.length !== MONOPOLY_RULES.diceCount) {
      throw new MonopolyError('bad_input', '骰子数量不对');
    }
    for (const die of dice) {
      if (!Number.isInteger(die) || die < 1 || die > 6) throw new MonopolyError('bad_input', '骰点只能是 1 到 6');
    }
    return dice.reduce((sum, die) => sum + die, 0);
  }

  /** 掷骰 → 移动 → 结算落地。返回是否换到下一位。 */
  private doRoll(dice: readonly number[], out: Outcome): 'choice' | 'ended' {
    const steps = this.diceSteps(dice);
    const name = this.nameOf(this.currentSeatId);
    out.facts.push(`${name} 掷出 ${dice.join(' + ')} = ${steps}。`);
    return this.doMove(steps, out);
  }

  private doMove(steps: number, out: Outcome): 'choice' | 'ended' {
    const seatId = this.currentSeatId;
    const player = this.player(seatId);
    const from = player.pos;
    const raw = from + steps;
    const to = raw % BOARD_SIZE;
    const laps = Math.floor(raw / BOARD_SIZE);
    player.pos = to;
    if (laps > 0) {
      const bonus = MONOPOLY_RULES.startBonus * laps;
      player.cash += bonus;
      out.facts.push(`${this.nameOf(seatId)} 从 ${cellAt(from).name} 到 ${cellAt(to).name}${laps > 1 ? `（转过 ${laps} 圈）` : ''}，路过门口领 ${bonus} 金币。`);
    } else {
      out.facts.push(`${this.nameOf(seatId)} 从 ${cellAt(from).name} 走到 ${cellAt(to).name}。`);
    }
    return this.resolveLanding(to, out);
  }

  private resolveLanding(index: number, out: Outcome): 'choice' | 'ended' {
    const seatId = this.currentSeatId;
    const player = this.player(seatId);
    const cell = cellAt(index);

    if (cell.kind === 'property') {
      const property = this.property(index)!;
      if (property.owner === null) {
        if (player.cash >= (cell.price ?? 0)) {
          this.state.phase = 'buy';
          this.state.pending = index;
          return 'choice';
        }
        out.facts.push(`${cell.name} 无主，但 ${this.nameOf(seatId)} 只有 ${player.cash} 金币，买不起。`);
        return this.closeTurn(out);
      }
      if (property.owner === seatId) {
        if (property.level === 0 && player.cash >= (cell.upgrade ?? 0)) {
          this.state.phase = 'upgrade';
          this.state.pending = index;
          return 'choice';
        }
        out.facts.push(`${cell.name} 是 ${this.nameOf(seatId)} 自己的地，没什么可做的。`);
        return this.closeTurn(out);
      }
      const rent = this.rentOf(property, player.passThisTurn);
      out.facts.push(`${cell.name} 是 ${this.nameOf(property.owner)} 的地，${this.nameOf(seatId)} 付租金 ${rent} 金币${player.passThisTurn ? '（通行卡减半）' : ''}。`);
      this.pay(player, rent, property.owner, out.facts);
      return this.closeTurn(out);
    }

    if (cell.kind === 'workshop') {
      const missing = ITEM_KINDS.filter((item) => player.items[item] < MONOPOLY_RULES.itemsPerKind);
      if (missing.length > 0) {
        this.state.phase = 'workshop';
        this.state.pending = index;
        return 'choice';
      }
      out.facts.push(`${this.nameOf(seatId)} 到了${cell.name}，三种道具都齐了，直接结束。`);
      return this.closeTurn(out);
    }

    if (cell.kind === 'subsidy') {
      const amount = cell.amount ?? 0;
      player.cash += amount;
      out.facts.push(`邻里补助：${this.nameOf(seatId)} 从银行领 ${amount} 金币。`);
      return this.closeTurn(out);
    }

    if (cell.kind === 'fee') {
      const amount = cell.amount ?? 0;
      out.facts.push(`街区维护：${this.nameOf(seatId)} 向银行交 ${amount} 金币。`);
      this.pay(player, amount, 'bank', out.facts);
      return this.closeTurn(out);
    }

    if (cell.kind === 'maintenance') {
      const upgraded = this.state.properties.filter((property) => property.owner === seatId && property.level > 0).length;
      const amount = upgraded * (cell.perUpgrade ?? 0);
      if (amount === 0) {
        out.facts.push(`公共检修：${this.nameOf(seatId)} 没有升级过的地，不用交钱。`);
        return this.closeTurn(out);
      }
      out.facts.push(`公共检修：${this.nameOf(seatId)} 有 ${upgraded} 块升级过的地，交 ${amount} 金币。`);
      this.pay(player, amount, 'bank', out.facts);
      return this.closeTurn(out);
    }

    out.facts.push(`${cell.name}：没有收支。`);
    return this.closeTurn(out);
  }

  /** 落地后没有可选动作：本回合到此结束。 */
  private closeTurn(out: Outcome): 'ended' {
    this.endTurn(out);
    return 'ended';
  }

  private defaultTurn(dice: readonly number[], out: Outcome, voluntary: boolean): void {
    if (voluntary) this.state.voluntaryThisRound = true;
    if (this.state.phase === 'prepare') {
      const result = this.doRoll(dice, out);
      if (result === 'ended') return;
      // 落地后有可选动作：托管一律放弃。
      out.facts.push(`${this.nameOf(this.currentSeatId)} 放弃之后的选择（默认${phaseAction(this.state.phase)}）。`);
      this.endTurn(out);
      return;
    }
    out.facts.push(`${this.nameOf(this.currentSeatId)} 放弃${phaseAction(this.state.phase)}（超时/托管）。`);
    this.endTurn(out);
  }

  private rentOf(property: PropertyState, halved: boolean): number {
    const cell = cellAt(property.index);
    const base = cell.rent ?? 0;
    const level = property.level > 0 ? MONOPOLY_RULES.upgradedRentMultiplier : 1;
    const group = this.ownsGroup(property) ? MONOPOLY_RULES.groupRentMultiplier : 1;
    const discount = halved ? MONOPOLY_RULES.passCardMultiplier : 1;
    return Math.ceil(base * level * group * discount);
  }

  private ownsGroup(property: PropertyState): boolean {
    if (!property.owner) return false;
    const cell = cellAt(property.index);
    if (!cell.group) return false;
    return GROUPS[cell.group].every((index) => this.property(index)?.owner === property.owner);
  }

  /**
   * 一笔强制付款：够就付；不够按格号从小到大卖地；还不够就把现金全给债权人、
   * 余款注销、破产退出。卖地与回收都进公开事实。
   */
  private pay(player: PlayerState, amount: number, to: 'bank' | string, facts: string[]): void {
    if (amount <= 0) return;
    const wallet = (sum: number): void => {
      if (to === 'bank') return;
      const creditor = this.state.players[to];
      if (creditor) creditor.cash += sum;
    };

    if (player.cash >= amount) {
      player.cash -= amount;
      wallet(amount);
      return;
    }

    const owned = this.state.properties
      .filter((property) => property.owner === player.seatId)
      .sort((a, b) => a.index - b.index);
    for (const property of owned) {
      if (player.cash >= amount) break;
      const cell = cellAt(property.index);
      const back = Math.floor((cell.price ?? 0) * MONOPOLY_RULES.sellRate)
        + Math.floor(property.upgradePaid * MONOPOLY_RULES.sellRate);
      player.cash += back;
      property.owner = null;
      property.level = 0;
      property.upgradePaid = 0;
      facts.push(`${this.nameOf(player.seatId)} 卖掉 ${cell.name}，回收 ${back} 金币。`);
    }

    if (player.cash >= amount) {
      player.cash -= amount;
      wallet(amount);
      return;
    }

    const paid = player.cash;
    player.cash = 0;
    wallet(paid);
    player.bankrupt = true;
    for (const item of ITEM_KINDS) player.items[item] = 0;
    facts.push(`${this.nameOf(player.seatId)} 付不起 ${amount} 金币，把剩下的 ${paid} 金币付掉、欠款注销，破产退出。`);
  }

  private endTurn(out: Outcome): void {
    if (this.state.ended) return;
    const player = this.player(this.currentSeatId);
    player.passThisTurn = false;
    this.state.pending = null;
    this.state.itemUsed = false;
    this.state.turnsTaken += 1;
    this.state.phase = 'prepare';

    const alive = this.alive();
    if (alive.length <= 1) {
      this.finishNow('last-standing', out.facts);
      return;
    }

    let index = this.state.turnIndex;
    for (let step = 1; step <= this.state.order.length; step++) {
      const candidate = (this.state.turnIndex + step) % this.state.order.length;
      if (!this.state.players[this.state.order[candidate]!]!.bankrupt) {
        index = candidate;
        break;
      }
    }
    const wrapped = index <= this.state.turnIndex;

    if (wrapped) {
      if (this.state.voluntaryThisRound) this.state.idleRounds = 0;
      else this.state.idleRounds += 1;
      this.state.voluntaryThisRound = false;
      this.state.round += 1;
      if (this.state.idleRounds >= MONOPOLY_RULES.idleRoundsToEnd) {
        this.finishNow('idle', out.facts);
        return;
      }
      if (this.state.round > MONOPOLY_RULES.rounds) {
        this.finishNow('rounds', out.facts);
        return;
      }
    }

    this.state.turnIndex = index;
    this.state.turnSeq += 1;
    this.player(this.currentSeatId).passThisTurn = false;
    out.nextTurn = { seatId: this.currentSeatId, round: this.state.round };
  }

  private finishNow(reason: MonopolyEnd['reason'], facts: string[]): void {
    if (this.state.ended) return;
    const ranking = this.state.order
      .map((seatId): MonopolyRank => {
        const player = this.state.players[seatId]!;
        const owned = this.state.properties.filter((property) => property.owner === seatId);
        const propertyValue = owned.reduce((sum, property) => sum
          + (cellAt(property.index).price ?? 0) + property.upgradePaid, 0);
        return {
          seatId,
          cash: player.cash,
          propertyValue,
          assets: player.cash + propertyValue,
          properties: owned.length,
          bankrupt: player.bankrupt,
        };
      })
      .sort((a, b) => {
        if (a.bankrupt !== b.bankrupt) return a.bankrupt ? 1 : -1;
        return b.assets - a.assets;
      });
    const ranked = ranking.filter((entry) => !entry.bankrupt);
    const best = ranked.length > 0 ? Math.max(...ranked.map((entry) => entry.assets)) : 0;
    const winners = ranked.filter((entry) => entry.assets === best).map((entry) => entry.seatId);
    this.state.ended = { reason, winners, tie: winners.length > 1, ranking };
    this.state.phase = 'prepare';
    this.state.pending = null;
    const label = reason === 'last-standing' ? '只剩一名未破产玩家'
      : reason === 'rounds' ? `走满 ${MONOPOLY_RULES.rounds} 轮`
        : reason === 'time' ? '整局时限到' : `连续 ${MONOPOLY_RULES.idleRoundsToEnd} 轮没人主动动作`;
    const names = winners.map((seatId) => this.nameOf(seatId)).join('、');
    facts.push(`大富翁结束（${label}）。${winners.length > 1 ? `并列第一：${names}` : `赢家：${names}`}。`);
  }
}

/** 相位对应的默认动作；给回执与托管文案共用。 */
export function phaseAction(phase: Phase): string {
  switch (phase) {
    case 'prepare': return '结束回合';
    case 'buy': return '不买';
    case 'upgrade': return '不升级';
    case 'workshop': return '不补卡';
    default: return '结束回合';
  }
}

function phaseHint(phase: Phase): string {
  switch (phase) {
    case 'prepare': return '现在是准备阶段：可以先用一张道具，然后掷骰';
    case 'buy': return '现在在等你决定买不买脚下这块地';
    case 'upgrade': return '现在在等你决定升不升级脚下这块地';
    case 'workshop': return '现在在等你从工坊补一张道具';
    default: return '现在不能这么做';
  }
}
