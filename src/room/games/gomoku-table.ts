import { TableError, type TableEngine, type TableEvent, type TableSeat, type TableStatus, type TableStep } from '../table-engine.ts';

export const GOMOKU_SIZE = 15;
const SIZE = GOMOKU_SIZE;
const CAPACITY = SIZE * SIZE;
type Color = 1 | 2;
type Point = { row: number; col: number };
type Move = Point & { color: Color };
/** win=这步连五；block=不挡就输；shape=做形/发展。前端据此区分提示样式。 */
type Level = 'win' | 'block' | 'shape';
type Hint = Point & { reason: string; level: Level };
const directions = [[0, 1], [1, 0], [1, 1], [1, -1]] as const;
const other = (color: Color): Color => color === 1 ? 2 : 1;
const inside = (row: number, col: number) => row >= 0 && row < SIZE && col >= 0 && col < SIZE;
const index = (row: number, col: number) => row * SIZE + col;

function bestLine(board: readonly number[], { row: originRow, col: originCol }: Point, color: Color): Point[] {
  const point = { row: originRow, col: originCol };
  let best: Point[] = [point];
  for (const [dr, dc] of directions) {
    const line: Point[] = [point];
    for (const sign of [-1, 1]) {
      let row = point.row + sign * dr;
      let col = point.col + sign * dc;
      while (inside(row, col) && board[index(row, col)] === color) {
        line.push({ row, col });
        row += sign * dr;
        col += sign * dc;
      }
    }
    if (line.length > best.length) best = line;
  }
  return best;
}

export function gomokuHints(board: readonly number[], color: Color): Hint[] {
  const candidates: Array<Hint & { score: number }> = [];
  for (let i = 0; i < CAPACITY; i++) {
    if (board[i] !== 0) continue;
    const point = { row: Math.floor(i / SIZE), col: i % SIZE };
    const attack = bestLine(board, point, color).length;
    const defense = bestLine(board, point, other(color)).length;
    const distance = Math.abs(point.row - 7) + Math.abs(point.col - 7);
    const score = attack >= 5 ? 1000 : defense >= 5 ? 500 : 30 * attack + 18 * defense;
    const level: Level = attack >= 5 ? 'win' : defense >= 5 ? 'block' : 'shape';
    const reason = level === 'win' ? '这一步可以连五获胜'
      : level === 'block' ? '挡住对方下一步连五'
      : attack >= 2 ? '延伸自己的棋形'
      : defense >= 2 ? '限制对手的棋形' : '靠近棋盘中央';
    candidates.push({ ...point, level, score: score - distance, reason });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, 3)
    .map(({ row, col, reason, level }) => ({ row, col, reason, level }));
}

function isPoint(value: unknown): value is Point {
  const point = value as Partial<Point> | null;
  return !!point && Number.isInteger(point.row) && Number.isInteger(point.col)
    && inside(point.row!, point.col!);
}

export class GomokuTable implements TableEngine {
  readonly game = 'gomoku';
  readonly label = '五子棋';
  readonly stateVersion = 1;
  readonly host: string;
  status: TableStatus = 'open';
  private seats: TableSeat[];
  private moves: Move[] = [];
  private board = Array<number>(CAPACITY).fill(0);
  private winningLine: Point[] = [];
  private deadline = 0;
  private readonly turnMs: number;

  // 不用参数属性（`constructor(private readonly x)`）：那段语法过不了 Node 的
  // --experimental-strip-types（strip-only），线上 serve-world 就是这么起的。
  constructor(host: TableSeat, turnMs = 60_000) {
    this.host = host.id;
    this.seats = [{ ...host }];
    this.turnMs = turnMs;
  }

  private get color(): Color { return this.moves.length % 2 === 0 ? 1 : 2; }
  private get turnSeat(): TableSeat | undefined { return this.seats[this.color - 1]; }

  has(seatId: string): boolean { return this.seats.some(seat => seat.id === seatId); }
  seatIds(): string[] { return this.seats.map(seat => seat.id); }

  private event(type: string, text: string, data: Record<string, unknown> = {}): TableEvent {
    return { type: 'parlor.table.' + type, scope: { kind: 'room' }, text, data: { game: this.game, ...data } };
  }

  join(seat: TableSeat): TableEvent {
    if (this.status !== 'open') throw new TableError('not_open', '五子棋已开局');
    if (this.has(seat.id)) throw new TableError('seated', '你已经入座');
    if (this.seats.length === 2) throw new TableError('full', '五子棋桌已满');
    this.seats.push({ ...seat });
    return this.event('join', `${seat.name} 坐到了五子棋桌。`, { seat: seat.id });
  }

  leave(seatId: string): TableEvent {
    if (this.status !== 'open') throw new TableError('not_open', '开局后由宿主处理离桌');
    if (!this.has(seatId)) throw new TableError('not_seated', '你没有入座');
    if (seatId === this.host) throw new TableError('not_host', '桌主离开请收桌');
    this.seats = this.seats.filter(seat => seat.id !== seatId);
    return this.event('left', '一位玩家离开了五子棋桌。', { seat: seatId });
  }

  start(by: string, now: number): TableStep {
    if (by !== this.host) throw new TableError('not_host', '只有桌主可以开局');
    if (this.status !== 'open' || this.seats.length !== 2) throw new TableError('not_open', '需要两席坐满才能开局');
    this.status = 'playing';
    this.deadline = now + this.turnMs;
    return { events: [this.event('start', '五子棋开局，黑棋先行。')], views: [this.host] };
  }

  act(seatId: string, action: unknown, now: number): TableStep {
    if (this.status !== 'playing') throw new TableError('not_started', '五子棋桌当前不可落子');
    if (this.turnSeat?.id !== seatId) throw new TableError('not_turn', '还没轮到你');
    if (now >= this.deadline) throw new TableError('expired', '本手已超时');
    if (!isPoint(action) || this.board[index(action.row, action.col)] !== 0) {
      throw new TableError('bad_action', '请选择 0–14 范围内的空交点');
    }
    return this.place(action, now, false);
  }

  private place(point: Point, now: number, automatic: boolean): TableStep {
    const seat = this.turnSeat!;
    const color = this.color;
    const move = { row: point.row, col: point.col, color };
    this.moves.push(move);
    this.board[index(move.row, move.col)] = color;
    const line = bestLine(this.board, move, color);
    const events = [this.event('action', `${seat.name}${automatic ? '（托管）' : ''}落子 ${move.row},${move.col}。`, { move, seat: seat.id })];
    if (line.length >= 5 || this.moves.length === CAPACITY) {
      this.status = 'ended';
      this.deadline = 0;
      this.winningLine = line.length >= 5 ? line : [];
      const won = this.winningLine.length > 0;
      events.push(this.event('end', won ? `${seat.name} 连五获胜。` : '棋盘已满，和棋。', {
        winners: won ? [seat.id] : [], tie: !won,
      }));
      return { events, views: [], ended: true };
    }
    this.deadline = now + this.turnMs;
    return { events, views: [this.turnSeat!.id] };
  }

  autoPlay(seatId: string, now: number): TableStep | null {
    if (this.status !== 'playing' || this.turnSeat?.id !== seatId) return null;
    const [move] = gomokuHints(this.board, this.color);
    return move ? this.place(move, now, true) : null;
  }

  tick(now: number): TableStep | null {
    return this.status === 'playing' && now >= this.deadline ? this.autoPlay(this.turnSeat!.id, now) : null;
  }

  nextWakeAt(): number | undefined { return this.status === 'playing' ? this.deadline : undefined; }

  rearm(now: number, downtimeMs: number, minHumanMs: number): void {
    if (this.status === 'playing') this.deadline = now + Math.max(this.deadline - (now - downtimeMs), minHumanMs);
  }

  public() {
    const last = this.moves.at(-1);
    return {
      game: this.game, status: this.status, host: this.host, board: this.board.slice(),
      seats: this.seats.map((seat, i) => ({ ...seat, color: i + 1 })),
      turn: this.status === 'playing' ? this.turnSeat?.id : undefined,
      deadline: this.nextWakeAt(), last: last ? { ...last } : undefined,
      winningLine: this.winningLine.map(point => ({ ...point })),
      winner: this.winningLine.length && last ? this.seats[last.color - 1]?.id : undefined,
      startBlockers: this.seats.length === 2 ? [] : ['等待第二位玩家入座'],
    };
  }

  view(seatId: string) {
    if (!this.has(seatId)) return null;
    const canAct = this.status === 'playing' && this.turnSeat?.id === seatId;
    return { ...this.public(), seat: seatId, canAct, hints: canAct ? gomokuHints(this.board, this.color) : [] };
  }

  publicText(): string {
    if (this.status === 'open') return '五子棋等人中，两席坐满开局。';
    const winner = this.public().winner;
    if (this.status === 'ended') return winner ? `${this.seats.find(seat => seat.id === winner)?.name} 连五获胜。` : '五子棋和棋。';
    return `五子棋第 ${this.moves.length + 1} 手，轮到 ${this.turnSeat?.name}。`;
  }

  privateText(seatId: string): string | null {
    const view = this.view(seatId);
    if (!view) return null;
    if (!view.canAct) return this.publicText();
    const hints = view.hints.map(hint =>
      `parlor_game_action {action:"place",params:{"row":${hint.row},"col":${hint.col}}}（${hint.reason}）`).join('；');
    const rows = Array.from({ length: SIZE }, (_, row) =>
      this.board.slice(row * SIZE, (row + 1) * SIZE).map(cell => '.XO'[cell]).join(''));
    return `${this.publicText()} 你执${this.color === 1 ? '黑' : '白'}，行列从 0 开始（X 黑，O 白）。\n${rows.join('\n')}\n建议：${hints}`;
  }

  exportState() {
    return {
      version: this.stateVersion, status: this.status, deadline: this.deadline,
      seats: this.seats.map(seat => ({ ...seat })), moves: this.moves.map(move => ({ ...move })),
    };
  }

  restoreState(value: unknown): void {
    const state = value as ReturnType<GomokuTable['exportState']> | null;
    if (!state || state.version !== this.stateVersion || !['open', 'playing', 'ended'].includes(state.status)
      || !Array.isArray(state.seats) || state.seats.length < 1 || state.seats.length > 2
      || state.seats[0]?.id !== this.host || new Set(state.seats.map(seat => seat?.id)).size !== state.seats.length
      || state.seats.some(seat => !seat?.id || typeof seat.name !== 'string')
      || !Array.isArray(state.moves) || state.moves.length > CAPACITY || !Number.isSafeInteger(state.deadline)) {
      throw new Error('五子棋存档格式错误');
    }
    const board = Array<number>(CAPACITY).fill(0);
    let winningLine: Point[] = [];
    for (const [i, move] of state.moves.entries()) {
      if (winningLine.length || !isPoint(move) || move.color !== i % 2 + 1 || board[index(move.row, move.col)] !== 0) {
        throw new Error('五子棋存档含非法落子');
      }
      board[index(move.row, move.col)] = move.color;
      const line = bestLine(board, move, move.color);
      if (line.length >= 5) winningLine = line;
    }
    const terminal = winningLine.length > 0 || state.moves.length === CAPACITY;
    if ((state.status === 'ended') !== terminal
      || (state.status === 'playing' ? state.deadline <= 0 : state.deadline !== 0)
      || (state.status === 'open' ? state.moves.length > 0 : state.seats.length !== 2)) {
      throw new Error('五子棋存档状态与棋谱不一致');
    }
    this.seats = state.seats.map(seat => ({ ...seat }));
    this.moves = state.moves.map(move => ({ ...move }));
    this.board = board;
    this.winningLine = winningLine;
    this.status = state.status;
    this.deadline = state.deadline;
  }
}
