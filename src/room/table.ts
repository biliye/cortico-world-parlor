/**
 * 牌桌：一个最小活动。暗骰桌——每人两颗隐藏骰子，可以重掷，最高点数赢。
 * 规则、发牌、隐藏信息全在这里；World 只把私视图交给 bot，把动作送回来。
 */
import { randomInt } from 'node:crypto';
import {
  TableError, secondsLeft,
  type TableEngine, type TableErrorCode, type TableEvent, type TableSeat, type TableStatus, type TableStep,
} from './table-engine.ts';

export type { TableEvent, TableStatus, TableStep } from './table-engine.ts';

export interface TableSeatView {
  id: string;
  name: string;
  stood: boolean;
}

export interface TableReveal {
  id: string;
  name: string;
  dice: number[];
  total: number;
}

export interface TablePublic {
  game: 'dice';
  status: TableStatus;
  host: string;
  seats: TableSeatView[];
  turn?: string;
  deadline?: number;
  winners?: string[];
  revealed?: TableReveal[];
}

export interface TablePrivate {
  seat: string;
  name: string;
  status: TableStatus;
  dice: number[];
  rerollsLeft: number;
  yourTurn: boolean;
  turn?: string;
  deadline?: number;
  others: TableSeatView[];
}

export interface TableAction {
  type: 'roll' | 'stand';
  die?: number;
}

export type DiceErrorCode = TableErrorCode;

export class DiceError extends TableError {
  constructor(code: DiceErrorCode, message: string) {
    super(code, message);
    this.name = 'DiceError';
  }
}

export interface DiceTableOptions {
  host: { id: string; name: string };
  now: number;
  turnMs?: number;
  rerolls?: number;
  maxSeats?: number;
  rng?: () => number;
}

interface Seat {
  id: string;
  name: string;
  stood: boolean;
}

const DEFAULT_TURN_MS = 45_000;
const DEFAULT_REROLLS = 2;
const DEFAULT_MAX_SEATS = 4;

export class DiceTable implements TableEngine {
  readonly game = 'dice';
  status: TableStatus = 'open';
  readonly host: string;

  private readonly turnMs: number;
  private readonly rerollLimit: number;
  private readonly maxSeats: number;
  private readonly rng: () => number;
  private readonly seats: Seat[];
  private readonly dice = new Map<string, number[]>();
  private readonly rerolls = new Map<string, number>();
  private turnId?: string;
  private deadline = 0;
  private winners: string[] = [];
  private revealed: TableReveal[] = [];

  constructor(options: DiceTableOptions) {
    this.host = options.host.id;
    this.turnMs = options.turnMs ?? DEFAULT_TURN_MS;
    this.rerollLimit = options.rerolls ?? DEFAULT_REROLLS;
    this.maxSeats = options.maxSeats ?? DEFAULT_MAX_SEATS;
    this.rng = options.rng ?? (() => randomInt(1, 7));
    this.seats = [{ id: options.host.id, name: options.host.name, stood: false }];
  }

  has(seatId: string): boolean {
    return this.seats.some((seat) => seat.id === seatId);
  }

  seatIds(): string[] {
    return this.seats.map((seat) => seat.id);
  }

  activeSeat(): string | undefined {
    return this.turnId;
  }

  join(seat: TableSeat): TableEvent {
    if (this.status !== 'open') throw new DiceError('not_open', '这张桌子已经开始了');
    if (this.has(seat.id)) throw new DiceError('seated', '你已经在桌上了');
    if (this.seats.length >= this.maxSeats) throw new DiceError('full', `这张桌子最多 ${this.maxSeats} 个人`);
    this.seats.push({ id: seat.id, name: seat.name, stood: false });
    return {
      type: 'parlor.table.join',
      scope: { kind: 'room' },
      text: `${seat.name} 坐到了骰子桌。`,
      data: { game: this.game, seat: seat.id },
    };
  }

  start(by: string, now: number): TableStep {
    if (this.status !== 'open') throw new DiceError('not_open', '这张桌子已经开始了');
    if (by !== this.host) throw new DiceError('not_host', '只有开桌的人可以开始');
    if (this.seats.length < 2) throw new DiceError('not_open', '至少要有两个人才能开始');
    this.status = 'playing';
    for (const seat of this.seats) {
      this.dice.set(seat.id, [this.roll(), this.roll()]);
      this.rerolls.set(seat.id, this.rerollLimit);
    }
    this.turnId = this.seats[0].id;
    this.deadline = now + this.turnMs;
    const names = this.seats.map((seat) => seat.name).join('、');
    return {
      events: [{ type: 'parlor.table.start', scope: { kind: 'room' }, text: `骰子桌开始了：${names}。`, data: { game: this.game } }],
      views: [this.turnId],
    };
  }

  act(seatId: string, input: unknown, now: number): TableStep {
    if (this.status !== 'playing') throw new DiceError('not_started', '这张桌子没在玩');
    const seat = this.seats.find((entry) => entry.id === seatId);
    if (!seat) throw new DiceError('not_seated', '你不在桌上');
    if (this.turnId !== seatId) throw new DiceError('not_turn', '还没轮到你');
    const action = (input ?? {}) as TableAction;
    const events: TableEvent[] = [];
    if (action.type === 'roll') {
      const die = action.die ?? 0;
      if (die !== 0 && die !== 1) throw new DiceError('bad_action', 'die 只能是 0 或 1');
      const left = this.rerolls.get(seatId) ?? 0;
      if (left <= 0) throw new DiceError('no_rerolls', '没有重掷次数了');
      const dice = this.dice.get(seatId)!;
      dice[die] = this.roll();
      this.rerolls.set(seatId, left - 1);
      events.push({ type: 'parlor.table.action', scope: { kind: 'room' }, text: `${seat.name} 重掷了一颗骰子。`, data: { game: this.game, seat: seatId } });
    } else if (action.type === 'stand') {
      seat.stood = true;
      events.push({ type: 'parlor.table.action', scope: { kind: 'room' }, text: `${seat.name} 停牌了。`, data: { game: this.game, seat: seatId } });
    } else {
      throw new DiceError('bad_action', '只能重掷或停牌');
    }
    return this.advance(now, events);
  }

  tick(now: number): TableStep | null {
    if (this.status !== 'playing' || now < this.deadline) return null;
    const seat = this.seats.find((entry) => entry.id === this.turnId);
    if (!seat) return null;
    seat.stood = true;
    return this.advance(now, [{
      type: 'parlor.table.action',
      scope: { kind: 'room' },
      text: `${seat.name} 超时，自动停牌。`,
      data: { game: this.game, seat: seat.id, timeout: true },
    }]);
  }

  view(seatId: string): TablePrivate | null {
    const seat = this.seats.find((entry) => entry.id === seatId);
    if (!seat) return null;
    return {
      seat: seat.id,
      name: seat.name,
      status: this.status,
      dice: [...(this.dice.get(seat.id) ?? [])],
      rerollsLeft: this.rerolls.get(seat.id) ?? this.rerollLimit,
      yourTurn: this.status === 'playing' && this.turnId === seat.id,
      turn: this.turnId,
      deadline: this.deadline,
      others: this.seats.filter((entry) => entry.id !== seat.id).map((entry) => ({ id: entry.id, name: entry.name, stood: entry.stood })),
    };
  }

  public(): TablePublic {
    return {
      game: this.game,
      status: this.status,
      host: this.host,
      seats: this.seats.map((seat) => ({ id: seat.id, name: seat.name, stood: seat.stood })),
      turn: this.turnId,
      deadline: this.deadline || undefined,
      winners: this.winners.length ? [...this.winners] : undefined,
      revealed: this.status === 'ended' ? this.revealed : undefined,
    };
  }

  privateText(seatId: string, now: number): string | null {
    const view = this.view(seatId);
    return view ? formatPrivate(view, now) : null;
  }

  publicText(): string {
    return formatPublic(this.public());
  }

  private roll(): number {
    return this.rng();
  }

  private advance(now: number, events: TableEvent[]): TableStep {
    const current = this.seats.findIndex((seat) => seat.id === this.turnId);
    for (let offset = 1; offset <= this.seats.length; offset++) {
      const next = this.seats[(current + offset) % this.seats.length];
      if (next.stood) continue;
      this.turnId = next.id;
      this.deadline = now + this.turnMs;
      return { events, views: [next.id] };
    }
    return this.finish(events);
  }

  private finish(events: TableEvent[]): TableStep {
    this.status = 'ended';
    this.turnId = undefined;
    this.deadline = 0;
    this.revealed = this.seats.map((seat) => {
      const dice = this.dice.get(seat.id) ?? [];
      return { id: seat.id, name: seat.name, dice: [...dice], total: dice.reduce((sum, value) => sum + value, 0) };
    });
    const best = Math.max(...this.revealed.map((entry) => entry.total));
    this.winners = this.revealed.filter((entry) => entry.total === best).map((entry) => entry.id);
    const scoreline = this.revealed.map((entry) => `${entry.name} ${entry.total} 点`).join('、');
    const winnerNames = this.revealed.filter((entry) => entry.total === best).map((entry) => entry.name).join('、');
    events.push({
      type: 'parlor.table.end',
      scope: { kind: 'room' },
      text: `骰子桌结束：${scoreline}。${this.winners.length > 1 ? `平局：${winnerNames}` : `赢家：${winnerNames}`}。`,
      data: { game: this.game, winners: this.winners, revealed: this.revealed },
    });
    return { events, views: [], ended: true };
  }
}

/** 只给桌上该席位看的一段话；服务端把它塞进 `parlor.table.turn`。 */
export function formatPrivate(view: TablePrivate, now: number): string {
  if (view.status === 'ended') return '【骰子桌】这局已经结束了。';
  const total = view.dice.reduce((sum, value) => sum + value, 0);
  const others = view.others.length
    ? view.others.map((seat) => `${seat.name}（${seat.stood ? '已停' : '还在'}）`).join('、')
    : '没有别人';
  const lines = [
    `【骰子桌·${view.yourTurn ? '轮到你' : '等待'}】你的点数：${view.dice.join(' 和 ')}（共 ${total}），还能重掷 ${view.rerollsLeft} 次。`,
    `对手：${others}。`,
  ];
  if (view.yourTurn) {
    lines.push(`${secondsLeft(view.deadline, now)} 秒内：parlor_table_action {action:"roll", die:0|1} 重掷一颗；或 {action:"stand"} 停牌。`);
  } else {
    lines.push('等对方行动。');
  }
  return lines.join('\n');
}

/** 房间公开的桌面状态；不含任何人的暗骰。 */
export function formatPublic(table: TablePublic): string {
  if (table.status === 'open') {
    return `【骰子桌】还开着，桌上：${table.seats.map((seat) => seat.name).join('、')}。`;
  }
  if (table.status === 'playing') {
    const turn = table.seats.find((seat) => seat.id === table.turn)?.name ?? '？';
    const seats = table.seats.map((seat) => `${seat.name}（${seat.stood ? '已停' : '还在'}）`).join('、');
    return `【骰子桌】进行中，轮到 ${turn}。桌上：${seats}。`;
  }
  const scoreline = (table.revealed ?? []).map((entry) => `${entry.name} ${entry.total} 点`).join('、');
  const winners = (table.revealed ?? []).filter((entry) => table.winners?.includes(entry.id)).map((entry) => entry.name).join('、');
  return `【骰子桌】已结束：${scoreline}。${(table.winners?.length ?? 0) > 1 ? `平局：${winners}` : `赢家：${winners}`}。`;
}
