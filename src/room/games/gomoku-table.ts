import { TableError, type TableEngine, type TableEvent, type TableSeat, type TableStatus, type TableStep } from '../table-engine.ts';

export const GOMOKU_SIZE = 15;
const SIZE = GOMOKU_SIZE;
const CAPACITY = SIZE * SIZE;
type Color = 1 | 2;
type Point = { row: number; col: number };
type Move = Point & { color: Color };
type Level = 'win' | 'block' | 'shape';
type Hint = Point & { reason: string; level: Level };
type Warning = { level: 'block' | 'danger'; text: string };
type OpenThree = { blocks: number[]; canMakeOpenFour: boolean };
const directions = [[0, 1], [1, 0], [1, 1], [1, -1]] as const;
const other = (color: Color): Color => color === 1 ? 2 : 1;
const inside = (row: number, col: number) => row >= 0 && row < SIZE && col >= 0 && col < SIZE;
const index = (row: number, col: number) => row * SIZE + col;

export function formatGomokuBoard(board: readonly number[], last?: Point): string {
  const rows = Array.from({ length: SIZE }, (_, row) => {
    const cells = board.slice(index(row, 0), index(row + 1, 0)).map((cell, col) => {
      const stone = '.XO'[cell];
      return row === last?.row && col === last.col ? stone.toLowerCase() : stone;
    }).join('');
    return `${String(row).padStart(2)} ${cells}`;
  });
  return ['X黑 O白 .空，小写是末手。列号上下合读。', '             11111', '   012345678901234', ...rows].join('\n');
}

export function formatGomokuAdvice(hints: readonly Hint[], warning?: Warning): string {
  const suggestions = hints.map(({ row, col, reason, level }) =>
    `(${row},${col}) ${level === 'win' ? '连五' : reason}`).join('；');
  return [warning?.text, suggestions && `建议（行,列）：${suggestions}`].filter(Boolean).join('\n');
}

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

function findOpenThrees(board: readonly number[], color: Color): OpenThree[] {
  const threes: OpenThree[] = [];
  const isEmpty = (row: number, col: number) => inside(row, col) && board[index(row, col)] === 0;
  for (let i = 0; i < CAPACITY; i++) {
    if (board[i] !== color) continue;
    const row = Math.floor(i / SIZE), col = i % SIZE;
    for (const [dr, dc] of directions) {
      if (!isEmpty(row - dr, col - dc) || !isEmpty(row + 3 * dr, col + 3 * dc)
        || board[index(row + dr, col + dc)] !== color || board[index(row + 2 * dr, col + 2 * dc)] !== color) continue;
      const blocks = [index(row - dr, col - dc), index(row + 3 * dr, col + 3 * dc)];
      const canExtendBefore = isEmpty(row - 2 * dr, col - 2 * dc);
      const canExtendAfter = isEmpty(row + 4 * dr, col + 4 * dc);
      // 只有一侧能延伸成活四时，封住那一侧的外端也能化解这条威胁。
      if (canExtendBefore && !canExtendAfter) blocks.push(index(row - 2 * dr, col - 2 * dc));
      if (canExtendAfter && !canExtendBefore) blocks.push(index(row + 4 * dr, col + 4 * dc));
      threes.push({ blocks, canMakeOpenFour: canExtendBefore || canExtendAfter });
    }
  }
  return threes;
}

function makesFour(board: readonly number[], { row, col }: Point, color: Color): boolean {
  // 包含本手的五格里，有三颗己方棋子和一个空位即可冲四，空位也可以在中间。
  for (const [dr, dc] of directions) {
    for (let start = -4; start <= 0; start++) {
      const end = start + 4;
      if (!inside(row + start * dr, col + start * dc) || !inside(row + end * dr, col + end * dc)) continue;
      let stones = 0, empty = 0;
      for (let offset = start; offset <= end; offset++) {
        if (offset === 0) continue;
        const cell = board[index(row + offset * dr, col + offset * dc)];
        if (cell === color) stones++;
        if (cell === 0) empty++;
      }
      if (stones === 3 && empty === 1) return true;
    }
  }
  return false;
}

function analyzeGomoku(board: readonly number[], color: Color): { hints: Hint[]; warning: Warning | null } {
  const opponent = other(color);
  const threes = findOpenThrees(board, opponent);
  const forcingThrees = threes.filter(three => three.canMakeOpenFour);
  const winningReplies: number[] = [];
  const candidates: Array<Point & { attack: number; defense: number }> = [];
  for (let i = 0; i < CAPACITY; i++) {
    if (board[i] !== 0) continue;
    const point = { row: Math.floor(i / SIZE), col: i % SIZE };
    const attack = bestLine(board, point, color).length;
    const defense = bestLine(board, point, opponent).length;
    if (defense >= 5) winningReplies.push(i);
    candidates.push({ ...point, attack, defense });
  }
  const fourThree = winningReplies.length === 1 && forcingThrees.some(three => !three.blocks.includes(winningReplies[0]!));
  const doubleThree = forcingThrees.length >= 2 && !forcingThrees[0]!.blocks.some(point =>
    forcingThrees.every(three => three.blocks.includes(point)));
  const warning: Warning | null = fourThree ? { level: 'danger', text: '对方四三，单手封堵挡不住两路。' }
    : doubleThree ? { level: 'danger', text: '对方双活三，单手封堵挡不住两路。' }
    : threes.length ? { level: 'block', text: '对方有活三。不堵就被连成五，有冲四时可抢先手。' } : null;
  const ranked = candidates.map(({ row, col, attack, defense }) => {
    const i = index(row, col);
    const blockedThrees = threes.filter(three => three.blocks.includes(i));
    const blocksThree = blockedThrees.length;
    const blocksEnd = blockedThrees.some(({ blocks: [before, after] }) => i === before || i === after);
    const counterFour = threes.length > 0 && winningReplies.length === 0 && attack < 5
      && makesFour(board, { row, col }, color);
    const distance = Math.abs(row - 7) + Math.abs(col - 7);
    const priority = attack >= 5 ? 5 : defense >= 5 ? 4 : doubleThree && counterFour ? 3
      : blocksEnd || blocksThree > 1 ? 2 : counterFour ? 1 : 0;
    const score = (attack >= 5 || defense >= 5 ? 0 : 30 * attack + 18 * defense) - distance;
    const level: Level = attack >= 5 ? 'win' : defense >= 5 || blocksThree ? 'block' : 'shape';
    const reason = level === 'win' ? '这一步可以连五获胜'
      : defense >= 5 ? '挡住对方下一步连五'
      : blocksThree ? '封堵对方活三'
      : counterFour ? '冲四抢先手'
      : attack >= 2 ? '延伸自己的棋形'
      : defense >= 2 ? '限制对手的棋形' : '靠近棋盘中央';
    return { row, col, level, priority, blocksThree, score, reason };
  });
  const hints = ranked.sort((a, b) => b.priority - a.priority || b.blocksThree - a.blocksThree || b.score - a.score).slice(0, 3)
    .map(({ row, col, reason, level }) => ({ row, col, reason, level }));
  return { hints, warning };
}

export function gomokuHints(board: readonly number[], color: Color): Hint[] {
  return analyzeGomoku(board, color).hints;
}

function isPoint(value: unknown): value is Point {
  const point = value as Partial<Point> | null;
  return !!point && Number.isInteger(point.row) && Number.isInteger(point.col)
    && inside(point.row!, point.col!);
}

/** 认输只有一个布尔标记，不带坐标。 */
function isResign(value: unknown): value is { resign: true } {
  return !!value && typeof value === 'object' && (value as { resign?: unknown }).resign === true;
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
  /**
   * 执黑的那一席在 `seats` 里的下标。开局时由宿主随机指定（`GameCreateContext.firstSeat`），
   * 所以不再固定成「桌主执黑」：谁先手不该由谁开的桌决定。
   */
  private blackIndex = 0;
  /** 终局赢家；认输时没有连五，光靠棋盘推不出来，必须显式记。 */
  private winnerSeat: string | null = null;

  // 不用参数属性（`constructor(private readonly x)`）：那段语法过不了 Node 的
  // --experimental-strip-types（strip-only），线上 serve-world 就是这么起的。
  constructor(host: TableSeat, turnMs = 60_000, firstSeat = 0) {
    this.host = host.id;
    this.seats = [{ ...host }];
    this.turnMs = turnMs;
    this.blackIndex = firstSeat === 1 ? 1 : 0;
  }

  /** 这一手该谁落：黑先，之后两手一换。颜色永远是 1 = 黑、2 = 白。 */
  private get color(): Color { return this.moves.length % 2 === 0 ? 1 : 2; }
  private get turnSeat(): TableSeat | undefined {
    return this.seats[this.color === 1 ? this.blackIndex : 1 - this.blackIndex];
  }

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
    // 执黑的那一席由开桌时传进来的 firstSeat 决定（宿主随机），桌主不再默认占先手。
    this.deadline = now + this.turnMs;
    const first = this.seats[this.blackIndex];
    return {
      events: [this.event('start', `五子棋开局，${first.name} 执黑先行。`)],
      views: [first.id],
    };
  }

  act(seatId: string, action: unknown, now: number): TableStep {
    if (this.status !== 'playing') throw new TableError('not_started', '五子棋桌当前不可落子');
    if (this.turnSeat?.id !== seatId) throw new TableError('not_turn', '还没轮到你');
    if (now >= this.deadline) throw new TableError('expired', '本手已超时');
    if (isResign(action)) return this.resign(seatId, now);
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
      this.winnerSeat = won ? seat.id : null;
      events.push(this.event('end', won ? `${seat.name} 连五获胜。` : '棋盘已满，和棋。', {
        winners: won ? [seat.id] : [], tie: !won,
      }));
      return { events, views: [], ended: true };
    }
    this.deadline = now + this.turnMs;
    return { events, views: [this.turnSeat!.id] };
  }

  /**
   * 认输：本人判负、对面直接获胜，按正常结算走（`winners` 就是对面那一席）。
   * 只有轮到自己时才受理 —— 没到你的手就点认输，多半是视图过期，先让他看一眼棋盘。
   */
  private resign(seatId: string, _now: number): TableStep {
    const seat = this.turnSeat!;
    const opponent = this.seats.find(entry => entry.id !== seatId);
    if (!opponent) throw new TableError('bad_action', '桌上没有对手');
    this.status = 'ended';
    this.deadline = 0;
    this.winningLine = [];
    this.winnerSeat = opponent.id;
    return {
      events: [
        this.event('resign', `${seat.name} 认输了。`, { seat: seat.id }),
        this.event('end', `${opponent.name} 获胜（${seat.name} 认输）。`, {
          winners: [opponent.id], tie: false, cause: 'resign',
        }),
      ],
      views: [],
      ended: true,
    };
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
    const resigned = this.status === 'ended' && this.winningLine.length === 0 && this.winnerSeat !== null;
    return {
      game: this.game, status: this.status, host: this.host, board: this.board.slice(),
      // color 是绝对色（1 黑 / 2 白），不是入座顺序：执黑的那一席由开局随机决定。
      seats: this.seats.map((seat, i) => ({ ...seat, color: i === this.blackIndex ? 1 : 2 })),
      turn: this.status === 'playing' ? this.turnSeat?.id : undefined,
      deadline: this.nextWakeAt(), last: last ? { ...last } : undefined,
      winningLine: this.winningLine.map(point => ({ ...point })),
      winner: this.winnerSeat ?? undefined,
      ...(resigned ? { cause: 'resign' as const } : {}),
      startBlockers: this.seats.length === 2 ? [] : ['等待第二位玩家入座'],
    };
  }

  view(seatId: string) {
    if (!this.has(seatId)) return null;
    const canAct = this.status === 'playing' && this.turnSeat?.id === seatId;
    const { hints, warning } = canAct ? analyzeGomoku(this.board, this.color) : { hints: [], warning: null };
    return { ...this.public(), seat: seatId, canAct, hints, ...(warning && { warning }) };
  }

  publicText(): string {
    if (this.status === 'open') return '五子棋等人中，两席坐满开局。';
    const winner = this.public().winner;
    if (this.status === 'ended') {
      if (!winner) return '五子棋和棋。';
      const name = this.seats.find(seat => seat.id === winner)?.name;
      return this.winningLine.length ? `${name} 连五获胜。` : `${name} 获胜（对手认输）。`;
    }
    return `五子棋第 ${this.moves.length + 1} 手，轮到 ${this.turnSeat?.name}。`;
  }

  privateText(seatId: string): string | null {
    const view = this.view(seatId);
    if (!view) return null;
    if (!view.canAct) return this.publicText();
    return [
      `${this.publicText()} 你执${this.color === 1 ? '黑' : '白'}，行列 0–14。`,
      formatGomokuBoard(view.board, view.last),
      formatGomokuAdvice(view.hints, view.warning),
    ].filter(Boolean).join('\n');
  }

  exportState() {
    return {
      version: this.stateVersion, status: this.status, deadline: this.deadline,
      seats: this.seats.map(seat => ({ ...seat })), moves: this.moves.map(move => ({ ...move })),
      blackIndex: this.blackIndex, winner: this.winnerSeat,
    };
  }

  restoreState(value: unknown): void {
    const state = value as ReturnType<GomokuTable['exportState']> | null;
    if (!state || state.version !== this.stateVersion || !['open', 'playing', 'ended'].includes(state.status)
      || !Array.isArray(state.seats) || state.seats.length < 1 || state.seats.length > 2
      || state.seats[0]?.id !== this.host || new Set(state.seats.map(seat => seat?.id)).size !== state.seats.length
      || state.seats.some(seat => !seat?.id || typeof seat.name !== 'string')
      || !Array.isArray(state.moves) || state.moves.length > CAPACITY || !Number.isSafeInteger(state.deadline)
      // 旧存档没有这个字段：缺省 0 就是「桌主执黑」的旧行为，照旧能恢复。
      || (state.blackIndex !== undefined && state.blackIndex !== 0 && state.blackIndex !== 1)) {
      throw new Error('五子棋存档格式错误');
    }
    const blackIndex = state.blackIndex ?? 0;
    // 只有一席时还分不出黑白，执黑下标只能是 0。
    if (state.seats.length < 2 && blackIndex !== 0) throw new Error('五子棋存档执黑席位非法');
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
    // 认输的局没有连五，也没下满：终止条件只能靠 winner 判断，否则会被当成残缺棋谱拒掉。
    const last = state.moves.at(-1);
    const seatOfColor = (color: Color): string | undefined =>
      state.seats[color === 1 ? blackIndex : 1 - blackIndex]?.id;
    const lineWinner = winningLine.length && last ? seatOfColor(last.color) : undefined;
    // 旧存档没有 winner 字段：和棋时 lineWinner 是 undefined，这里统一折成 null 再比对。
    const declared = (state.winner === undefined ? lineWinner : state.winner) ?? null;
    const drawn = winningLine.length === 0 && state.moves.length === CAPACITY;
    const resigned = winningLine.length === 0 && state.moves.length < CAPACITY;
    const endedOk = winningLine.length > 0
      ? declared === lineWinner
      : drawn ? declared === null : resigned && typeof declared === 'string'
        && state.seats.some(seat => seat.id === declared);
    if ((state.status === 'ended' ? !endedOk : declared !== null)
      || (state.status === 'playing' ? state.deadline <= 0 : state.deadline !== 0)
      || (state.status === 'open' ? state.moves.length > 0 : state.seats.length !== 2)) {
      throw new Error('五子棋存档状态与棋谱不一致');
    }
    this.seats = state.seats.map(seat => ({ ...seat }));
    this.moves = state.moves.map(move => ({ ...move }));
    this.board = board;
    this.winningLine = winningLine;
    this.blackIndex = blackIndex;
    this.winnerSeat = declared ?? null;
    this.status = state.status;
    this.deadline = state.deadline;
  }
}
