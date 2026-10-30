/**
 * 牌桌的通用契约：一房一桌。规则、发牌与隐藏信息都由各游戏实现，内核只管
 * 开桌/坐下/开始/动作/超时，以及把每个席位的私视图变成一段只给它看的话。
 */

export type TableStatus = 'open' | 'bidding' | 'playing' | 'ended';
/** 游戏 id 是注册表里的字符串（见 `games/registry.ts`）；旧单厅服务器只认 dice/ddz。 */
export type TableGame = string;

export type TableEventScope = { kind: 'room' } | { kind: 'seat'; seatId: string };

export interface TableEvent {
  type: string;
  scope: TableEventScope;
  text: string;
  data?: Record<string, unknown>;
}

export interface TableStep {
  events: TableEvent[];
  /** 需要补发私视图的席位（含当前回合的席位）。 */
  views: string[];
  ended?: boolean;
}

export interface TableSeat {
  id: string;
  name: string;
}

export interface TableEngine {
  readonly game: string;
  /** 给人看的游戏名（「骰子」「斗地主」）；账本原样存进 `data.gameLabel`。 */
  readonly label: string;
  readonly host: string;
  readonly status: TableStatus;
  /**
   * 存档格式版本。与包版本无关；读到不认识的版本必须抛错，不能猜。
   * 引擎只导出规则状态：已经发出去的牌、骰点、座次、回合与截止时刻。
   * 随机源不存档——恢复之后新发的一轮用新随机数，已经提交的结果绝不重掷。
   */
  readonly stateVersion: number;
  /** 可校验的完整内部状态；客户端永远拿不到它，只进服务端 `tables.state_json`。 */
  exportState(): unknown;
  /** 从已提交快照恢复；不能发牌、掷骰或产生事件。版本不认识就抛错。 */
  restoreState(state: unknown): void;
  /**
   * 恢复后把截止时刻搬到现在：短停机续局。
   * 真人保留停机前的剩余时间（至少 `minHumanMs` 秒重新连），脚本按自己的延迟走。
   */
  rearm(now: number, downtimeMs: number, minHumanMs: number): void;
  /**
   * 代打：被移出客厅/托管的人轮到时，由服务器按同一套规则替他走一步。
   * 没轮到他或状态不对返回 null。返回的结构与 `act` 相同。
   */
  autoPlay(seatId: string, now: number): TableStep | null;
  has(seatId: string): boolean;
  seatIds(): string[];
  join(seat: TableSeat): TableEvent;
  /** 未开局时主动离桌；开局后不能离（调用方先判状态，引擎再兜一层）。 */
  leave(seatId: string): TableEvent;
  start(by: string, now: number): TableStep;
  act(seatId: string, action: unknown, now: number): TableStep;
  tick(now: number): TableStep | null;
  /** 给该席位的私视图；不在桌上返回 null。 */
  view(seatId: string): unknown | null;
  /** 公开视图；不含任何人的隐藏信息。 */
  public(): unknown;
  /** 只给该席位看的一段话；不在桌上返回 null。 */
  privateText(seatId: string, now: number): string | null;
  /** 房间公开的一段话。 */
  publicText(): string;
}

export type TableErrorCode =
  | 'not_open' | 'not_started' | 'full' | 'seated' | 'not_seated'
  | 'not_host' | 'not_turn' | 'bad_action' | 'no_rerolls' | 'wrong_game'
  /** 动作到得太晚：这一回合或整局已经截止。 */
  | 'expired';

export class TableError extends Error {
  readonly code: TableErrorCode;

  constructor(code: TableErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'TableError';
  }
}

/** 传进 JSON 的公开桌面；游戏自己的字段（暗骰、倍数…）混在同一层。 */
export interface TableSummary {
  game: string;
  label: string;
  status: TableStatus;
  host: string;
  text: string;
  /** 多桌身份：客户端拿它选桌、发动作。 */
  id?: string;
  tableId?: string;
  /** 已提交状态版本；动作用它防迟到。 */
  revision?: number;
  /** 快照读不出来而被隔离的桌：不再推进，也不接动作。 */
  frozen?: boolean;
  turn?: string;
  deadline?: number;
  [key: string]: unknown;
}

/** 传进 JSON 的私视图；同样带上游戏自己的字段。 */
export interface TablePrivateSummary {
  game: string;
  seat: string;
  text: string;
  /** 这张私视图属于哪张桌（多桌时必需）。 */
  tableId?: string;
  revision?: number;
  [key: string]: unknown;
}

export const secondsLeft = (deadline: number | undefined, now: number): number => (
  deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0
);
