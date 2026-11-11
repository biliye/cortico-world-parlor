export const XIANGQI_ROWS = 10;
export const XIANGQI_COLS = 9;

export type Color = 1 | -1;
export type Point = { row: number; col: number };
export type XiangqiMove = { from: Point; to: Point };
export type XiangqiHint = XiangqiMove & { reason: string };

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

export function* legalMoves(board: readonly number[], color: Color): Generator<XiangqiMove> {
  for (const from of POINTS) {
    if (board[indexOf(from)] * color <= 0) continue;
    for (const to of POINTS) {
      const move = { from, to };
      if (isLegalMove(board, move, color)) yield move;
    }
  }
}

/** 逐着检查对手最重的吃子回应，并优先推荐一步胜与应将。 */
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
    let replyGain = VALUE[Math.abs(next[indexOf(firstReply.value.to)])];
    for (const reply of replies) replyGain = Math.max(replyGain, VALUE[Math.abs(next[indexOf(reply.to)])]);
    const piece = board[indexOf(move.from)];
    const center = Math.abs(move.from.col - 4) - Math.abs(move.to.col - 4);
    const develop = (Math.abs(piece) === HORSE || Math.abs(piece) === SOLDIER)
      ? color * (move.from.row - move.to.row) : 0;
    const score = VALUE[Math.abs(captured)] - replyGain + (check ? 0.3 : 0) + center * 0.03 + develop * 0.08;
    const reasons = [
      inCheck && '应将', check && '将军', captured && `吃${pieceName(captured)}`,
      replyGain > VALUE[Math.abs(captured)] && '留意对方吃子',
    ].filter(Boolean);
    return { ...move, reason: reasons.join('、') || '保持子力，调整站位', score };
  }).sort((a, b) => b.score - a.score)
    .slice(0, 3).map(({ score: _score, ...hint }) => hint);
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
  const suggestions = hints.map(hint => `${moveText(hint)}（${hint.reason}）`);
  return [warning, suggestions.length ? `建议走法 ${suggestions.join('；')}` : ''].filter(Boolean).join('\n');
}
