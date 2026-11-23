export const XIANGQI_ROWS = 10;
export const XIANGQI_COLS = 9;

export type Color = 1 | -1;
export type Point = { row: number; col: number };
export type XiangqiMove = { from: Point; to: Point };
export type XiangqiHint = XiangqiMove & { reason: string; positionThreat?: string };
export const XIANGQI_HINT_LIMIT = 3;

const GENERAL = 1;
const ADVISOR = 2;
const ELEPHANT = 3;
const HORSE = 4;
const CHARIOT = 5;
const CANNON = 6;
const SOLDIER = 7;
const BACK_RANK = [CHARIOT, HORSE, ELEPHANT, ADVISOR, GENERAL, ADVISOR, ELEPHANT, HORSE, CHARIOT];
const GLYPHS = { red: ' 帅仕相马车炮兵', black: ' 将士象马车炮卒' };
const VALUE = [0, 0, 2, 2, 4, 9, 4.5, 1];
const POINTS = Array.from({ length: XIANGQI_ROWS * XIANGQI_COLS }, (_, i) => ({
  row: Math.floor(i / XIANGQI_COLS), col: i % XIANGQI_COLS,
}));

export const indexOf = ({ row, col }: Point): number => row * XIANGQI_COLS + col;
export const colorName = (color: Color): string => color === 1 ? '红' : '黑';
export const pieceName = (piece: number): string => GLYPHS[piece > 0 ? 'red' : 'black'][Math.abs(piece)];
export const moveText = ({ from, to }: XiangqiMove): string => `(${from.row},${from.col}) → (${to.row},${to.col})`;

export function isPoint(value: unknown): value is Point {
  const point = value as Point | null;
  return !!point && Number.isInteger(point.row) && point.row >= 0 && point.row < XIANGQI_ROWS
    && Number.isInteger(point.col) && point.col >= 0 && point.col < XIANGQI_COLS;
}

export function isMove(value: unknown): value is XiangqiMove {
  const move = value as XiangqiMove | null;
  return !!move && isPoint(move.from) && isPoint(move.to);
}

export function initialBoard(): number[] {
  const board = Array<number>(POINTS.length).fill(0);
  for (const color of [1, -1] as const) {
    const home = (row: number) => color === 1 ? XIANGQI_ROWS - 1 - row : row;
    BACK_RANK.forEach((piece, col) => { board[indexOf({ row: home(0), col })] = color * piece; });
    for (const col of [1, 7]) board[indexOf({ row: home(2), col })] = color * CANNON;
    for (const col of [0, 2, 4, 6, 8]) board[indexOf({ row: home(3), col })] = color * SOLDIER;
  }
  return board;
}

const ownSide = (row: number, color: Color): boolean => color === 1 ? row >= 5 : row <= 4;
const inPalace = ({ row, col }: Point, color: Color): boolean =>
  col >= 3 && col <= 5 && (color === 1 ? row >= 7 : row <= 2);

function intervening(board: readonly number[], from: Point, to: Point): number {
  const stride = Math.sign(to.row - from.row) * XIANGQI_COLS + Math.sign(to.col - from.col);
  const end = indexOf(to);
  let count = 0;
  for (let at = indexOf(from) + stride; at !== end; at += stride) {
    if (board[at]) count++;
  }
  return count;
}

function followsPieceRule(board: readonly number[], from: Point, to: Point, color: Color): boolean {
  const piece = board[indexOf(from)] * color;
  const target = board[indexOf(to)] * color;
  if (piece <= 0 || target > 0) return false;
  const dr = to.row - from.row;
  const dc = to.col - from.col;
  const r = Math.abs(dr);
  const c = Math.abs(dc);
  switch (piece) {
    case GENERAL:
      // 对方将帅是唯一可隔线攻击的目标，用于检查将帅照面。
      return (r + c === 1 && inPalace(to, color))
        || (target === -GENERAL && c === 0 && intervening(board, from, to) === 0);
    case ADVISOR:
      return r === 1 && c === 1 && inPalace(to, color);
    case ELEPHANT:
      return r === 2 && c === 2 && ownSide(to.row, color)
        && !board[indexOf({ row: from.row + dr / 2, col: from.col + dc / 2 })];
    case HORSE:
      return ((r === 2 && c === 1) || (r === 1 && c === 2))
        && !board[indexOf({ row: from.row + Math.trunc(dr / 2), col: from.col + Math.trunc(dc / 2) })];
    case CHARIOT:
      return (r === 0 || c === 0) && intervening(board, from, to) === 0;
    case CANNON:
      return (r === 0 || c === 0) && intervening(board, from, to) === (target ? 1 : 0);
    case SOLDIER:
      return (dr === -color && c === 0) || (!ownSide(from.row, color) && r === 0 && c === 1);
    default:
      return false;
  }
}

export function isInCheck(board: readonly number[], color: Color): boolean {
  const general = POINTS[board.indexOf(color * GENERAL)];
  return !general || POINTS.some(from => followsPieceRule(board, from, general, -color as Color));
}

export function afterMove(board: readonly number[], { from, to }: XiangqiMove): number[] {
  const next = board.slice();
  next[indexOf(to)] = next[indexOf(from)];
  next[indexOf(from)] = 0;
  return next;
}

export function isLegalMove(board: readonly number[], move: XiangqiMove, color: Color): boolean {
  return isMove(move) && board[indexOf(move.to)] !== -color * GENERAL
    && followsPieceRule(board, move.from, move.to, color)
    && !isInCheck(afterMove(board, move), color);
}

/** 只用于已经被拒绝的走法，合法性仍由 isLegalMove 判定。 */
export function rejectedMoveReason(board: readonly number[], move: unknown, color: Color): string {
  if (!isMove(move)) return '坐标须使用行 0–9、列 0–8，从黑方左上角起算';
  const { from, to } = move;
  const piece = board[indexOf(from)];
  const target = board[indexOf(to)];
  if (!piece) return `起点 (${from.row},${from.col}) 没有棋子`;
  if (piece * color < 0) return '起点是对方棋子';
  if (indexOf(from) === indexOf(to)) return '起点和落点相同';
  if (target * color > 0) return '落点被己方棋子占据';
  if (target === -color * GENERAL) return '应以将死或困毙结束，不能直接吃掉将帅';
  if (!followsPieceRule(board, from, to, color)) {
    const dr = Math.abs(from.row - to.row);
    const dc = Math.abs(from.col - to.col);
    switch (Math.abs(piece)) {
      case HORSE:
        return dr * dc === 2 ? '马腿被挡' : '马须按日字走';
      case CHARIOT:
        return dr === 0 || dc === 0 ? '车的行进路线有棋子阻挡' : '车须沿直线走';
      case CANNON:
        if (dr !== 0 && dc !== 0) return '炮须沿直线走';
        return target ? '炮吃子时起点和落点之间须恰好隔一子' : '炮走到空位时不能越过棋子';
      case ELEPHANT:
        if (dr !== 2 || dc !== 2) return '相（象）须按田字走';
        return ownSide(to.row, color) ? '象眼被挡' : '相（象）不能过河';
      case ADVISOR: return '仕（士）须在九宫内斜走一格';
      case GENERAL: return '帅（将）须在九宫内直走一格';
      default: return '兵（卒）只能前进一步，过河后也可横走一格';
    }
  }
  const next = afterMove(board, move);
  const general = POINTS[next.indexOf(color * GENERAL)];
  const opposingGeneral = POINTS[next.indexOf(-color * GENERAL)];
  if (general && opposingGeneral && general.col === opposingGeneral.col && intervening(next, general, opposingGeneral) === 0) {
    return '这步会造成将帅照面';
  }
  return isInCheck(board, color) ? '你正在被将军，这步未能应将' : '走后己方将帅会被将军';
}

export function* legalMoves(board: readonly number[], color: Color): Generator<XiangqiMove> {
  for (const from of POINTS) {
    if (board[indexOf(from)] * color <= 0) continue;
    for (const to of POINTS) {
      const move = { from, to };
      if (isLegalMove(board, move, color)) yield move;
    }
  }
}

type CaptureReply = { move: XiangqiMove; gain: number; netGain: number; recapture: boolean };

function strongerCapture(current: CaptureReply | undefined, candidate: CaptureReply): CaptureReply {
  if (!current || candidate.netGain > current.netGain
    || (candidate.netGain === current.netGain && candidate.gain > current.gain)) return candidate;
  return current;
}

function formatCaptureThreat(board: readonly number[], reply?: CaptureReply): string | undefined {
  if (!reply || reply.netGain <= 0) return undefined;
  const { move, recapture } = reply;
  return `对方${pieceName(board[indexOf(move.from)])}可吃${pieceName(board[indexOf(move.to)])}（${moveText(move)}）${recapture ? '，己方可回吃' : ''}`;
}

/** 比较对方吃子与己方合法回吃后的子力差，并优先推荐一步胜与应将。 */
export function suggestMoves(
  board: readonly number[], color: Color, moves: readonly XiangqiMove[],
  outcome: (move: XiangqiMove, next: number[], check: boolean) => Color | 0 | undefined,
): XiangqiHint[] {
  const inCheck = isInCheck(board, color);
  const opponent = -color as Color;
  return moves.map(move => {
    const next = afterMove(board, move);
    const check = isInCheck(next, opponent);
    const replies = legalMoves(next, opponent);
    const firstReply = replies.next();
    if (firstReply.done) return { ...move, reason: check ? '一步将死' : '一步困毙', score: 1000 };
    const winner = outcome(move, next, check);
    if (winner !== undefined) {
      if (winner === color) return { ...move, reason: '对手长将判负', score: 999 };
      if (winner === opponent) return { ...move, reason: '长将会判负', score: -1000 };
      return { ...move, reason: '本着成和', score: -40 };
    }
    const captured = board[indexOf(move.to)];
    let strongestReply: CaptureReply | undefined;
    let existingThreat: CaptureReply | undefined;
    let reply: ReturnType<typeof replies.next> = firstReply;
    while (!reply.done) {
      const response = reply.value;
      const gain = VALUE[Math.abs(next[indexOf(response.to)])];
      if (gain > 0) {
        const recaptured = VALUE[Math.abs(next[indexOf(response.from)])];
        const afterReply = afterMove(next, response);
        const recapture = POINTS.some(from => isLegalMove(afterReply, { from, to: response.to }, color));
        const netGain = gain - (recapture ? recaptured : 0);
        const capture = { move: response, gain, netGain, recapture };
        if (indexOf(response.to) === indexOf(move.to) || !isLegalMove(board, response, opponent)) {
          strongestReply = strongerCapture(strongestReply, capture);
        } else {
          existingThreat = strongerCapture(existingThreat, capture);
        }
      }
      reply = replies.next();
    }
    const piece = board[indexOf(move.from)];
    const center = Math.abs(move.from.col - 4) - Math.abs(move.to.col - 4);
    const develop = (Math.abs(piece) === HORSE || Math.abs(piece) === SOLDIER)
      ? color * (move.from.row - move.to.row) : 0;
    const replyGain = Math.max(0, strongestReply?.netGain ?? 0, existingThreat?.netGain ?? 0);
    const score = VALUE[Math.abs(captured)] - replyGain + (check ? 0.3 : 0) + center * 0.03 + develop * 0.08;
    const reasons = [
      inCheck && '应将', check && '将军', captured && `吃${pieceName(captured)}`,
      formatCaptureThreat(next, strongestReply),
    ].filter(Boolean);
    const positionThreat = formatCaptureThreat(next, existingThreat);
    return {
      ...move, reason: reasons.join('、') || '保持子力，调整站位', score,
      ...(positionThreat && { positionThreat }),
    };
  }).sort((a, b) => b.score - a.score)
    .slice(0, XIANGQI_HINT_LIMIT).map(({ score: _score, ...hint }) => hint);
}

export function formatXiangqiBoard(board: readonly number[], last?: XiangqiMove): string {
  // 两个汉字占四个等宽字符，列号和空格也各占同样的宽度。
  const columns = Array.from({ length: XIANGQI_COLS }, (_, col) => String(col).padEnd(4));
  const rows = [`    ${columns.join(' ').trimEnd()}`];
  for (let row = 0; row < XIANGQI_ROWS; row++) {
    const cells = board.slice(row * XIANGQI_COLS, (row + 1) * XIANGQI_COLS)
      .map(piece => piece ? `${colorName(piece > 0 ? 1 : -1)}${pieceName(piece)}` : '.   ');
    rows.push(`${row}   ${cells.join(' ').trimEnd()}`);
  }
  if (last) rows.push(`上一步 ${moveText(last)}`);
  return rows.join('\n');
}

export function formatXiangqiAdvice(hints: readonly XiangqiHint[], warning?: string): string {
  const suggestions = hints.map((hint, i) => `${i + 1}. ${moveText(hint)}（${hint.reason}）`);
  const threatGroups = new Map<string, number[]>();
  for (const [index, hint] of hints.entries()) {
    if (!hint.positionThreat) continue;
    const numbers = threatGroups.get(hint.positionThreat) ?? [];
    numbers.push(index + 1);
    threatGroups.set(hint.positionThreat, numbers);
  }
  const threats = [...threatGroups].map(([text, numbers]) => `第 ${numbers.join('、')} 条建议落子后仍有原局威胁：${text}`);
  return [warning, suggestions.length ? `建议走法 ${suggestions.join('；')}` : '', ...threats].filter(Boolean).join('\n');
}
