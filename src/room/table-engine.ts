/**
 * 牌桌的通用契约：一房一桌。规则、发牌与隐藏信息都由各游戏实现，内核只管
 * 开桌/坐下/开始/动作/超时，以及把每个席位的私视图变成一段只给它看的话。
 */

export type TableStatus = 'open' | 'bidding' | 'playing' | 'ended';
export type TableGame = 'dice' | 'ddz';

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
  readonly host: string;
  readonly status: TableStatus;
  has(seatId: string): boolean;
  seatIds(): string[];
  join(seat: TableSeat): TableEvent;
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
  | 'not_host' | 'not_turn' | 'bad_action' | 'no_rerolls' | 'wrong_game';

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
  status: TableStatus;
  host: string;
  text: string;
  turn?: string;
  deadline?: number;
  [key: string]: unknown;
}

/** 传进 JSON 的私视图；同样带上游戏自己的字段。 */
export interface TablePrivateSummary {
  game: string;
  seat: string;
  text: string;
  [key: string]: unknown;
}

export const secondsLeft = (deadline: number | undefined, now: number): number => (
  deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0
);
