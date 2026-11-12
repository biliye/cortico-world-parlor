import { randomInt } from 'node:crypto';
import { secondsLeft, TableError, type TableEngine, type TableEvent, type TableSeat, type TableStep } from '../table-engine.ts';
import {
  COLOURS, FINISH, HANGAR, MAX_SEATS, PLANES_PER_SEAT, colourFor, legalMoves, positionText, visitCollisions,
  type AeroplaneMove, type AeroplaneSeat,
} from './aeroplane-rules.ts';

interface FlightState {
  version: number;
  status: 'open' | 'playing' | 'ended';
  seats: AeroplaneSeat[];
  current: number;
  deadline: number;
  pending: number | null;
  last: { seat: string; die: number; text: string } | null;
}

interface Options {
  host: TableSeat;
  turnMs?: number;
  rollDie?: () => number;
  firstSeat?: (seats: number) => number;
}

function intBetween(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function freshSeat({ id, name }: TableSeat): AeroplaneSeat {
  return { id, name, planes: Array<number>(PLANES_PER_SEAT).fill(HANGAR) };
}

export class AeroplaneTable implements TableEngine {
  readonly game = 'aeroplane';
  readonly label = '飞行棋';
  readonly stateVersion = 1;
  readonly host: string;
  private readonly turnMs: number;
  private readonly rollDie: () => number;
  private readonly firstSeat: (seats: number) => number;
  private state: FlightState;

  constructor(options: Options) {
    this.host = options.host.id;
    this.turnMs = options.turnMs ?? 60_000;
    this.rollDie = options.rollDie ?? (() => randomInt(1, 7));
    this.firstSeat = options.firstSeat ?? (seats => randomInt(seats));
    this.state = {
      version: this.stateVersion, status: 'open', seats: [freshSeat(options.host)],
      current: 0, deadline: 0, pending: null, last: null,
    };
  }

  get status(): FlightState['status'] { return this.state.status; }
  private get current(): AeroplaneSeat { return this.state.seats[this.state.current]; }

  has(id: string): boolean { return this.state.seats.some(seat => seat.id === id); }
  seatIds(): string[] { return this.state.seats.map(seat => seat.id); }

  join(seat: TableSeat): TableEvent {
    if (this.status !== 'open') throw new TableError('not_open', '这张桌子已经开始了');
    if (this.has(seat.id)) throw new TableError('seated', '你已经在桌上了');
    if (this.state.seats.length >= MAX_SEATS) throw new TableError('full', '飞行棋最多四人');
    this.state.seats.push(freshSeat(seat));
    return this.event('join', `${seat.name} 坐到了飞行棋桌。`, { seat: seat.id });
  }

  leave(id: string): TableEvent {
    if (this.status !== 'open') throw new TableError('not_open', '这张桌子已经开始了');
    if (id === this.host) throw new TableError('not_host', '开桌的人要走请把桌子收掉');
    const index = this.state.seats.findIndex(seat => seat.id === id);
    if (index < 0) throw new TableError('not_seated', '你不在桌上');
    const [seat] = this.state.seats.splice(index, 1);
    return this.event('left', `${seat.name} 离开了飞行棋桌。`, { seat: id });
  }

  start(by: string, now: number): TableStep {
    if (this.status !== 'open') throw new TableError('not_open', '这张桌子已经开始了');
    if (by !== this.host) throw new TableError('not_host', '只有开桌的人可以开始');
    if (this.state.seats.length < 2) throw new TableError('not_open', '飞行棋至少需要两人');
    this.state.current = this.firstSeat(this.state.seats.length);
    this.state.status = 'playing';
    this.state.deadline = now + this.turnMs;
    return {
      events: [this.event('start', `飞行棋开始了，${this.current.name} 先掷骰。`, { seats: this.seatIds(), first: this.current.id })],
      views: [this.current.id],
    };
  }

  act(id: string, input: unknown, now: number): TableStep {
    if (this.status !== 'playing') throw new TableError('not_started', '这张桌子没在玩');
    if (!this.has(id)) throw new TableError('not_seated', '你不在桌上');
    if (this.current.id !== id) throw new TableError('not_turn', '还没轮到你');
    if (now >= this.state.deadline) throw new TableError('expired', '回合已到期，等服务器推进后再看桌面');
    const action = input as { action?: unknown; plane?: unknown } | null;
    if (action?.action === 'roll' && this.state.pending === null) return this.roll(now);
    if (action?.action === 'move' && this.state.pending !== null) {
      const move = this.moves().find(item => item.plane === action.plane);
      if (move) return this.fly(move, now, false);
    }
    throw new TableError('bad_action', this.state.pending === null ? '请先掷骰' : '请选择可飞的飞机编号（1–4）');
  }

  autoPlay(id: string, now: number): TableStep | null {
    if (this.status !== 'playing' || this.current.id !== id) return null;
    const rolled = this.state.pending === null ? this.roll(now, true) : null;
    if (this.state.pending === null) return rolled;
    const move = this.moves().sort((a, b) =>
      Number(b.to === FINISH) - Number(a.to === FINISH) || b.captures - a.captures
      || Number(b.from === HANGAR) - Number(a.from === HANGAR) || b.to - a.to,
    )[0];
    const step = this.fly(move, now, true);
    return rolled ? { ...step, events: [...rolled.events, ...step.events] } : step;
  }

  tick(now: number): TableStep | null {
    return this.status === 'playing' && now >= this.state.deadline ? this.autoPlay(this.current.id, now) : null;
  }

  nextWakeAt(): number | undefined {
    return this.status === 'playing' ? this.state.deadline : undefined;
  }

  rearm(now: number, downtimeMs: number, minHumanMs: number): void {
    if (this.status === 'playing') this.state.deadline = Math.max(this.state.deadline + downtimeMs, now + minHumanMs);
  }

  private moves(): AeroplaneMove[] {
    return this.state.pending === null ? [] : legalMoves(this.state.seats, this.state.current, this.state.pending);
  }

  private roll(now: number, auto = false): TableStep {
    const seat = this.current.id;
    const die = this.rollDie();
    this.state.pending = die;
    const canMove = this.moves().length > 0;
    const again = die === 6;
    const text = `${this.current.name}${auto ? '（代打）' : ''}掷出 ${die}。${canMove ? '请选择飞机。' : again ? '没有可飞的飞机，再掷一次。' : '没有可飞的飞机，换下一位。'}`;
    this.state.last = { seat, die, text };
    const events = [this.event('action', text, { seat, action: 'roll', die, auto })];
    if (!canMove) return this.advance(now, again, events);
    this.state.deadline = now + this.turnMs;
    return { events, views: [seat] };
  }

  private fly(move: AeroplaneMove, now: number, auto: boolean): TableStep {
    const seat = this.current;
    const die = this.state.pending!;
    const hit: Array<{ seat: string; plane: number }> = [];
    visitCollisions(this.state.seats, this.state.current, move.to, (opponent, index) => {
      opponent.planes[index] = HANGAR;
      hit.push({ seat: opponent.id, plane: index + 1 });
    });
    seat.planes[move.plane - 1] = move.to;
    const won = seat.planes.every(progress => progress === FINISH);
    const text = `${seat.name}${auto ? '（代打）' : ''}的 ${move.plane} 号机${move.from === HANGAR ? '起飞' : `飞到${positionText(move.to)}`}${move.jumped ? '（同色跳四格）' : ''}${hit.length ? `，撞回 ${hit.length} 架飞机` : ''}。${die === 6 && !won ? '再掷一次。' : ''}`;
    this.state.last = { seat: seat.id, die, text };
    const events = [this.event('action', text, { seat: seat.id, action: 'move', die, ...move, hit, auto })];
    if (!won) return this.advance(now, die === 6, events);
    this.state.status = 'ended';
    this.state.deadline = 0;
    this.state.pending = null;
    events.push(this.event('end', `${seat.name} 的四架飞机全部抵达，赢得本局。`, { winners: [seat.id] }));
    return { events, views: [], ended: true, seatResults: null };
  }

  private advance(now: number, again: boolean, events: TableEvent[]): TableStep {
    this.state.pending = null;
    this.state.deadline = now + this.turnMs;
    if (!again) this.state.current = (this.state.current + 1) % this.state.seats.length;
    return { events, views: [this.current.id] };
  }

  public() {
    const { status, seats, deadline, pending, last } = this.state;
    return {
      game: this.game, label: this.label, host: this.host, status,
      seats: seats.map((seat, index) => ({ ...seat, planes: [...seat.planes], colour: colourFor(index, seats.length) })),
      phase: status === 'playing' ? pending === null ? 'await_roll' : 'await_move' : null,
      turn: status === 'playing' ? this.current.id : undefined,
      deadline: status === 'playing' ? deadline : undefined,
      die: pending,
      last: last && { ...last },
      winners: status === 'ended' ? [this.current.id] : undefined,
    };
  }

  view(id: string) {
    if (!this.has(id)) return null;
    const yourTurn = this.status === 'playing' && this.current.id === id;
    return { ...this.public(), seat: id, yourTurn, moves: yourTurn ? this.moves() : [] };
  }

  publicText(): string {
    if (this.status === 'open') return `【飞行棋】${this.state.seats.length}/4 人，至少两人可开局。`;
    if (this.status === 'ended') return `【飞行棋】${this.current.name} 的四架飞机全部抵达。`;
    return `【飞行棋】轮到 ${this.current.name}${this.state.pending === null ? '掷骰' : `选择飞机（${this.state.pending} 点）`}。`;
  }

  privateText(id: string, now: number): string | null {
    const view = this.view(id);
    if (!view) return null;
    if (!view.yourTurn) return this.publicText();
    const seat = view.seats.find(entry => entry.id === id)!;
    const positions = seat.planes.map((progress, index) => `${index + 1}号${positionText(progress)}`).join('、');
    const choices = view.moves.map(move => `${move.plane}号→${positionText(move.to)}${move.captures ? `，撞 ${move.captures} 架` : ''}`).join('；');
    const action = choices ? `掷出 ${view.die}。可飞：${choices}。` : '请掷骰。';
    return `【飞行棋】你是${COLOURS[seat.colour]}，${positions}。${action}剩 ${secondsLeft(view.deadline, now)} 秒。`;
  }

  exportState(): unknown { return structuredClone(this.state); }

  restoreState(input: unknown): void {
    const state = input as FlightState | null;
    const validSeat = (seat: AeroplaneSeat) => seat && typeof seat.id === 'string' && seat.id.length > 0
      && typeof seat.name === 'string' && Array.isArray(seat.planes) && seat.planes.length === PLANES_PER_SEAT
      && seat.planes.every(progress => intBetween(progress, HANGAR, FINISH));
    if (!state || state.version !== this.stateVersion || !['open', 'playing', 'ended'].includes(state.status)
      || !Array.isArray(state.seats) || !intBetween(state.seats.length, state.status === 'open' ? 1 : 2, MAX_SEATS)
      || !state.seats.every(validSeat) || state.seats[0].id !== this.host
      || new Set(state.seats.map(seat => seat.id)).size !== state.seats.length
      || !intBetween(state.current, 0, state.seats.length - 1)
      || !Number.isFinite(state.deadline) || (state.status === 'playing' ? state.deadline <= 0 : state.deadline !== 0)
      || (state.last !== null && (!state.last || !intBetween(state.last.die, 1, 6)
        || typeof state.last.text !== 'string' || !state.seats.some(seat => seat.id === state.last?.seat)))
      || (state.pending !== null && (state.status !== 'playing' || !intBetween(state.pending, 1, 6)
        || state.last?.die !== state.pending || state.last.seat !== state.seats[state.current].id
        || legalMoves(state.seats, state.current, state.pending).length === 0))
      || (state.status === 'ended') !== state.seats[state.current].planes.every(progress => progress === FINISH)) {
      throw new Error('无法读取飞行棋存档');
    }
    this.state = structuredClone(state);
  }

  private event(type: 'join' | 'left' | 'start' | 'action' | 'end', text: string, data: Record<string, unknown>): TableEvent {
    return { type: `parlor.table.${type}`, scope: { kind: 'room' }, text, data: { game: this.game, ...data } };
  }
}
