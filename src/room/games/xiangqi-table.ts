import { TableError, type TableEngine, type TableEvent, type TableSeat, type TableStatus, type TableStep } from '../table-engine.ts';
import {
  afterMove, colorName, formatXiangqiAdvice, formatXiangqiBoard, indexOf, initialBoard, isInCheck,
  isLegalMove, isMove, legalMoves, moveText, pieceName, suggestMoves,
  type Color, type XiangqiHint, type XiangqiMove,
} from './xiangqi.ts';

const QUIET_LIMIT = 120;
const causeLabel = {
  mate: '将死', stalemate: '困毙', resign: '认输',
  perpetual_check: '单方长将判负', repetition: '三次重复局面', no_capture: '连续 60 回合未吃子',
};
type Result = { winner: Color | 0; cause: keyof typeof causeLabel };
type PlayedMove = XiangqiMove & { piece: number; captured: number; check: boolean };
type TurnAdvice = { legalMoves: XiangqiMove[]; hints: XiangqiHint[]; warning?: string };
const positionKey = (board: readonly number[], turn: Color) => `${turn}:${board.join(',')}`;
const colorAt = (ply: number): Color => ply % 2 === 0 ? 1 : -1;

class Match {
  board = initialBoard();
  moves: PlayedMove[] = [];
  result: Result | null = null;
  private quiet = 0;
  private positions = new Map([[positionKey(this.board, 1), [0]]]);

  get turn(): Color { return colorAt(this.moves.length); }

  private drawOrPerpetual(move: XiangqiMove, next: number[], check: boolean): Result | null {
    if (this.board[indexOf(move.to)]) return null;
    const opponent = -this.turn as Color;
    const visits = this.positions.get(positionKey(next, opponent));
    if (visits && visits.length >= 2) {
      const start = visits[0];
      const onlyChecks = { [this.turn]: check, [opponent]: true };
      for (let i = start; i < this.moves.length; i++) {
        if (!this.moves[i].check) onlyChecks[colorAt(i)] = false;
      }
      if (onlyChecks[this.turn] !== onlyChecks[opponent]) {
        return { winner: onlyChecks[this.turn] ? opponent : this.turn, cause: 'perpetual_check' };
      }
      return { winner: 0, cause: 'repetition' };
    }
    return this.quiet + 1 >= QUIET_LIMIT ? { winner: 0, cause: 'no_capture' } : null;
  }

  play(move: XiangqiMove): PlayedMove {
    const color = this.turn;
    const opponent = -color as Color;
    const piece = this.board[indexOf(move.from)];
    const captured = this.board[indexOf(move.to)];
    const next = afterMove(this.board, move);
    const check = isInCheck(next, opponent);
    this.result = legalMoves(next, opponent).next().done
      ? { winner: color, cause: check ? 'mate' : 'stalemate' }
      : this.drawOrPerpetual(move, next, check);
    const played = { from: { ...move.from }, to: { ...move.to }, piece, captured, check };
    this.board = next;
    this.moves.push(played);
    this.quiet = captured ? 0 : this.quiet + 1;
    if (captured) this.positions.clear();
    const key = positionKey(next, opponent);
    const visits = this.positions.get(key) ?? [];
    visits.push(this.moves.length);
    this.positions.set(key, visits);
    return played;
  }

  advice(): TurnAdvice {
    const moves = [...legalMoves(this.board, this.turn)];
    const hints = suggestMoves(this.board, this.turn, moves,
      (move, next, check) => this.drawOrPerpetual(move, next, check)?.winner);
    return {
      legalMoves: moves, hints,
      ...(isInCheck(this.board, this.turn) ? { warning: '你正在被将军，必须先应将。' } : {}),
    };
  }
}

export class XiangqiTable implements TableEngine {
  readonly game = 'xiangqi';
  readonly label = '中国象棋';
  readonly stateVersion = 1;
  readonly host: string;
  status: TableStatus = 'open';
  private readonly turnMs: number;
  private redIndex: number;
  private seats: TableSeat[];
  private deadline = 0;
  private match = new Match();
  private advice: TurnAdvice | undefined;

  constructor(host: TableSeat, turnMs = 60_000, firstSeat = 0) {
    this.host = host.id;
    this.seats = [{ ...host }];
    this.turnMs = turnMs;
    this.redIndex = firstSeat === 1 ? 1 : 0;
  }

  private seatOf(color: Color): TableSeat {
    return this.seats[color === 1 ? this.redIndex : 1 - this.redIndex];
  }

  has(seatId: string): boolean { return this.seats.some(seat => seat.id === seatId); }
  seatIds(): string[] { return this.seats.map(seat => seat.id); }

  private event(type: string, text: string, data: Record<string, unknown> = {}): TableEvent {
    return { type: 'parlor.table.' + type, scope: { kind: 'room' }, text, data: { game: this.game, ...data } };
  }

  join(seat: TableSeat): TableEvent {
    if (this.status !== 'open') throw new TableError('not_open', '象棋已开局');
    if (this.has(seat.id)) throw new TableError('seated', '你已经入座');
    if (this.seats.length === 2) throw new TableError('full', '象棋桌已满');
    this.seats.push({ ...seat });
    return this.event('join', `${seat.name} 坐到了象棋桌。`, { seat: seat.id });
  }

  leave(seatId: string): TableEvent {
    if (this.status !== 'open') throw new TableError('not_open', '开局后由宿主处理离桌');
    if (!this.has(seatId)) throw new TableError('not_seated', '你没有入座');
    if (seatId === this.host) throw new TableError('not_host', '桌主离开请收桌');
    this.seats = this.seats.filter(seat => seat.id !== seatId);
    return this.event('left', '一位玩家离开了象棋桌。', { seat: seatId });
  }

  start(by: string, now: number): TableStep {
    if (by !== this.host) throw new TableError('not_host', '只有桌主可以开局');
    if (this.status !== 'open' || this.seats.length !== 2) throw new TableError('not_open', '需要两席坐满才能开局');
    this.status = 'playing';
    this.deadline = now + this.turnMs;
    const first = this.seatOf(1);
    return { events: [this.event('start', `象棋开局，${first.name} 执红先行。`)], views: [first.id] };
  }

  act(seatId: string, action: unknown, now: number): TableStep {
    if (this.status !== 'playing') throw new TableError('not_started', '象棋桌当前不可走棋');
    const color = this.match.turn;
    const seat = this.seatOf(color);
    if (seat.id !== seatId) throw new TableError('not_turn', '还没轮到你');
    if (now >= this.deadline) throw new TableError('expired', '本手已超时');
    if ((action as { resign?: unknown } | null)?.resign === true) {
      return this.end({ winner: -color as Color, cause: 'resign' }, [
        this.event('resign', `${seat.name} 认输了。`, { seat: seatId }),
      ]);
    }
    if (!isMove(action) || !isLegalMove(this.match.board, action, color)) {
      throw new TableError('bad_action', '这步棋不合法，请检查棋子走法、将帅照面或是否需要应将。');
    }
    return this.play(action, now, false);
  }

  private play(move: XiangqiMove, now: number, automatic: boolean): TableStep {
    const seat = this.seatOf(this.match.turn);
    const played = this.match.play(move);
    this.advice = undefined;
    const capture = played.captured ? `，吃${pieceName(played.captured)}` : '';
    const check = played.check ? '，将军' : '';
    const events = [this.event('action',
      `${seat.name}${automatic ? '（托管）' : ''}走${pieceName(played.piece)} ${moveText(move)}${capture}${check}。`,
      { move: played, seat: seat.id })];
    if (this.match.result) return this.end(this.match.result, events);
    this.deadline = now + this.turnMs;
    return { events, views: [this.seatOf(this.match.turn).id] };
  }

  private end(result: Result, events: TableEvent[]): TableStep {
    this.status = 'ended';
    this.deadline = 0;
    this.match.result = result;
    this.advice = undefined;
    const winner = result.winner ? this.seatOf(result.winner) : undefined;
    events.push(this.event('end', this.publicText(), {
      winners: winner ? [winner.id] : [], tie: !winner, cause: result.cause,
    }));
    return {
      events, views: [], ended: true,
      seatResults: this.seats.map(seat => ({ seatId: seat.id, rank: !winner || seat.id === winner.id ? 1 : 2 })),
    };
  }

  autoPlay(seatId: string, now: number): TableStep | null {
    if (this.status !== 'playing' || this.seatOf(this.match.turn).id !== seatId) return null;
    const [move] = (this.advice ??= this.match.advice()).hints;
    return move ? this.play(move, now, true) : null;
  }

  tick(now: number): TableStep | null {
    return this.status === 'playing' && now >= this.deadline ? this.autoPlay(this.seatOf(this.match.turn).id, now) : null;
  }

  nextWakeAt(): number | undefined { return this.status === 'playing' ? this.deadline : undefined; }

  rearm(now: number, downtimeMs: number, minHumanMs: number): void {
    if (this.status === 'playing') this.deadline = now + Math.max(this.deadline - (now - downtimeMs), minHumanMs);
  }

  public() {
    const { board, moves, result, turn } = this.match;
    const last = moves.at(-1);
    return {
      game: this.game, status: this.status, host: this.host, board: board.slice(), plies: moves.length,
      seats: this.seats.map((seat, i) => ({ ...seat, color: i === this.redIndex ? 1 : -1 })),
      turn: this.status === 'playing' ? this.seatOf(turn).id : undefined,
      deadline: this.nextWakeAt(),
      last: last ? { ...last, from: { ...last.from }, to: { ...last.to } } : undefined,
      winner: result?.winner ? this.seatOf(result.winner).id : undefined,
      cause: result?.cause, check: last?.check ?? false,
      startBlockers: this.seats.length === 2 ? [] : ['等待第二位玩家入座'],
    };
  }

  view(seatId: string) {
    if (!this.has(seatId)) return null;
    const canAct = this.status === 'playing' && this.seatOf(this.match.turn).id === seatId;
    const advice = canAct ? this.advice ??= this.match.advice() : undefined;
    return { ...this.public(), seat: seatId, canAct, yourTurn: canAct, ...advice };
  }

  publicText(): string {
    if (this.status === 'open') return '中国象棋等人中，两席坐满开局。';
    const { result, turn, moves } = this.match;
    if (result) {
      return result.winner
        ? `${this.seatOf(result.winner).name} 获胜（${causeLabel[result.cause]}）。`
        : `中国象棋和棋（${causeLabel[result.cause]}）。`;
    }
    return `象棋第 ${moves.length + 1} 手，轮到 ${this.seatOf(turn).name}（${colorName(turn)}方）。`;
  }

  privateText(seatId: string): string | null {
    const view = this.view(seatId);
    if (!view) return null;
    if (!view.canAct) return this.publicText();
    return [
      `${this.publicText()} 你执${colorName(this.match.turn)}。行 0–9、列 0–8，从黑方左上角起算。`,
      formatXiangqiBoard(view.board, view.last),
      formatXiangqiAdvice(view.hints ?? [], view.warning),
      '用 parlor_game_action 的 move 提交 params: {from:{row,col},to:{row,col}}。',
    ].filter(Boolean).join('\n');
  }

  exportState() {
    return {
      version: this.stateVersion, status: this.status, deadline: this.deadline, redIndex: this.redIndex,
      seats: this.seats.map(seat => ({ ...seat })),
      moves: this.match.moves.map(({ from, to }) => ({ from: { ...from }, to: { ...to } })),
      resigned: this.match.result?.cause === 'resign',
    };
  }

  restoreState(value: unknown): void {
    const state = value as ReturnType<XiangqiTable['exportState']> | null;
    if (!state || state.version !== this.stateVersion || !['open', 'playing', 'ended'].includes(state.status)
      || !Array.isArray(state.seats) || state.seats.length < 1 || state.seats.length > 2
      || state.seats[0]?.id !== this.host || new Set(state.seats.map(seat => seat?.id)).size !== state.seats.length
      || state.seats.some(seat => typeof seat?.id !== 'string' || !seat.id || typeof seat.name !== 'string')
      || (state.redIndex !== 0 && state.redIndex !== 1)
      || !Array.isArray(state.moves) || typeof state.resigned !== 'boolean'
      || !Number.isSafeInteger(state.deadline) || (state.status === 'playing' ? state.deadline <= 0 : state.deadline !== 0)
      || (state.status === 'open' ? state.moves.length !== 0 : state.seats.length !== 2)) {
      throw new Error('象棋存档格式错误');
    }
    const match = new Match();
    for (const move of state.moves) {
      if (match.result || !isMove(move) || !isLegalMove(match.board, move, match.turn)) {
        throw new Error('象棋存档含非法走法');
      }
      match.play(move);
    }
    if (state.resigned && !match.result) match.result = { winner: -match.turn as Color, cause: 'resign' };
    if ((state.status === 'ended') !== !!match.result || state.resigned !== (match.result?.cause === 'resign')) {
      throw new Error('象棋存档状态与棋谱不一致');
    }
    this.match = match;
    this.seats = state.seats.map(seat => ({ ...seat }));
    this.redIndex = state.redIndex;
    this.status = state.status;
    this.deadline = state.deadline;
    this.advice = undefined;
  }
}
