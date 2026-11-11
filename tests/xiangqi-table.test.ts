import { describe, expect, it } from 'vitest';
import { XiangqiTable } from '../src/room/games/xiangqi-table.ts';
import {
  afterMove, indexOf, initialBoard, isInCheck, isLegalMove, legalMoves, suggestMoves,
  type XiangqiMove,
} from '../src/room/games/xiangqi.ts';

const red = { id: 'red', name: '红方' };
const black = { id: 'black', name: '黑方' };
const move = (fromRow: number, fromCol: number, toRow: number, toCol: number): XiangqiMove => ({
  from: { row: fromRow, col: fromCol }, to: { row: toRow, col: toCol },
});
const set = (board: number[], row: number, col: number, piece: number) => {
  board[indexOf({ row, col })] = piece;
};
const sparseBoard = () => {
  const board = Array<number>(90).fill(0);
  set(board, 0, 4, -1);
  set(board, 9, 4, 1);
  set(board, 5, 4, 7);
  return board;
};
const started = () => {
  const table = new XiangqiTable(red, 100);
  table.join(black);
  table.start(red.id, 1);
  return table;
};

describe('象棋走法', () => {
  it('初始棋盘有 32 子与 44 个红方合法走法；挡车和蹩马腿无效', () => {
    const board = initialBoard();
    expect(board.filter(Boolean)).toHaveLength(32);
    expect([...legalMoves(board, 1)]).toHaveLength(44);
    expect(isLegalMove(board, move(9, 0, 5, 0), 1)).toBe(false);
    expect(isLegalMove(board, move(9, 1, 7, 2), 1)).toBe(true);
    set(board, 8, 1, 7);
    expect(isLegalMove(board, move(9, 1, 7, 2), 1)).toBe(false);
  });

  it('炮必须隔一子才能吃子，平走则不能越子', () => {
    const board = initialBoard();
    const capture = move(7, 1, 0, 1);
    expect(isLegalMove(board, capture, 1)).toBe(true);
    expect(isLegalMove(board, move(7, 1, 1, 1), 1)).toBe(false);
    set(board, 3, 1, -7);
    expect(isLegalMove(board, capture, 1)).toBe(false);
    set(board, 3, 1, 0);
    set(board, 2, 1, 0);
    expect(isLegalMove(board, capture, 1)).toBe(false);
  });

  it('象不过河且不能塞象眼，仕与帅受九宫约束', () => {
    const board = sparseBoard();
    set(board, 7, 2, 3);
    expect(isLegalMove(board, move(7, 2, 5, 0), 1)).toBe(true);
    set(board, 6, 1, 7);
    expect(isLegalMove(board, move(7, 2, 5, 0), 1)).toBe(false);
    set(board, 5, 2, 3);
    expect(isLegalMove(board, move(5, 2, 3, 0), 1)).toBe(false);
    set(board, 7, 3, 2);
    expect(isLegalMove(board, move(7, 3, 8, 4), 1)).toBe(true);
    expect(isLegalMove(board, move(7, 3, 6, 2), 1)).toBe(false);
    expect(isLegalMove(board, move(9, 4, 8, 3), 1)).toBe(false);
  });

  it('兵卒过河后才能横走，始终不能后退；禁止走成将帅照面', () => {
    const board = sparseBoard();
    expect(isLegalMove(board, move(5, 4, 5, 5), 1)).toBe(false);
    expect(isLegalMove(board, move(5, 4, 4, 4), 1)).toBe(true);
    set(board, 4, 4, 7);
    set(board, 5, 4, 0);
    expect(isLegalMove(board, move(4, 4, 4, 5), 1)).toBe(false);
    expect(isLegalMove(board, move(4, 4, 5, 4), 1)).toBe(false);
    set(board, 4, 0, -7);
    expect(isLegalMove(board, move(4, 0, 4, 1), -1)).toBe(false);
    set(board, 5, 0, -7);
    expect(isLegalMove(board, move(5, 0, 5, 1), -1)).toBe(true);
    expect(isLegalMove(board, move(5, 0, 4, 0), -1)).toBe(false);
  });

  it.each([
    { label: '一步将死', cols: [0, 8], finish: move(2, 0, 0, 0), inCheck: true },
    { label: '一步困毙', cols: [0, 8, 5], finish: move(2, 0, 2, 3), inCheck: false },
  ])('提示识别$label', ({ label, cols, finish, inCheck }) => {
    const board = sparseBoard();
    set(board, 2, cols[0], 5);
    set(board, 1, cols[1], 5);
    if (cols.length === 3) set(board, 2, cols[2], 5);
    const next = afterMove(board, finish);
    expect(isInCheck(next, -1)).toBe(inCheck);
    expect([...legalMoves(next, -1)]).toEqual([]);
    expect(suggestMoves(board, 1, [finish], () => undefined)).toEqual([{ ...finish, reason: label }]);
  });
});

describe('象棋牌桌', () => {
  it('抽到第二席执红的等人桌可恢复，开局通知只给红方', () => {
    const waiting = new XiangqiTable(black, 100, 1);
    const restored = new XiangqiTable(black, 100);
    restored.restoreState(waiting.exportState());
    restored.join(red);
    expect(restored.start(black.id, 1).views).toEqual([red.id]);
    expect(restored.public()).toMatchObject({ turn: red.id, deadline: 101 });
    expect(restored.public()).not.toHaveProperty('hints');
    expect(restored.view(black.id)).not.toHaveProperty('hints');
    expect(restored.view('observer')).toBeNull();
    const view = restored.view(red.id)!;
    expect(view.hints).toHaveLength(3);
    expect(view.hints?.every(hint => isLegalMove(view.board, hint, 1))).toBe(true);
    expect(restored.privateText(red.id)).toContain('建议走法');
    expect(restored.privateText(red.id)).toContain('parlor_game_action');
  });

  it('被将军必须应将；私视图、托管与恢复使用同一套合法走法', () => {
    const table = started();
    table.act(red.id, move(7, 1, 7, 4), 2);
    table.act(black.id, move(3, 4, 4, 4), 3);
    table.act(red.id, move(6, 4, 5, 4), 4);
    table.act(black.id, move(0, 1, 2, 2), 5);
    const step = table.act(red.id, move(5, 4, 4, 4), 6);
    expect(step.views).toEqual([black.id]);
    expect(table.privateText(black.id)).toContain('必须先应将');
    const view = table.view(black.id)!;
    expect(view.hints?.length).toBeGreaterThan(0);
    expect(view.hints?.every(hint => !isInCheck(afterMove(view.board, hint), -1))).toBe(true);
    expect(() => table.act(black.id, move(3, 0, 4, 0), 7)).toThrow(/应将/);
    const restored = new XiangqiTable(red, 100);
    restored.restoreState(table.exportState());
    expect(restored.public()).toEqual(table.public());
    expect(restored.tick(105)).toBeNull();
    expect(restored.tick(106)?.views).toEqual([red.id]);
    const { from, to } = view.hints![0];
    expect(restored.public().last).toMatchObject({ from, to });
  });

  it('三次重复判和且可以从棋谱恢复终局', () => {
    const table = started();
    const cycle = [move(9, 1, 7, 2), move(0, 1, 2, 2), move(7, 2, 9, 1), move(2, 2, 0, 1)];
    const steps = [...cycle, ...cycle].map((step, i) => table.act(i % 2 ? black.id : red.id, step, i + 2));
    expect(steps.at(-1)).toMatchObject({ ended: true, seatResults: [
      { seatId: red.id, rank: 1 }, { seatId: black.id, rank: 1 },
    ] });
    expect(table.public()).toMatchObject({ status: 'ended', cause: 'repetition', plies: 8 });
    const restored = new XiangqiTable(red);
    restored.restoreState(table.exportState());
    expect(restored.public()).toEqual(table.public());
  });

  it('轮到自己才能认输，保留胜负和棋盘，拒绝非法存档', () => {
    const table = started();
    expect(() => table.act(black.id, { resign: true }, 2)).toThrow(/还没轮到/);
    expect(table.act(red.id, { resign: true }, 2).seatResults).toEqual([
      { seatId: red.id, rank: 2 }, { seatId: black.id, rank: 1 },
    ]);
    const state = table.exportState();
    const restored = new XiangqiTable(red);
    restored.restoreState(state);
    expect(restored.public()).toMatchObject({ status: 'ended', cause: 'resign', winner: black.id });
    expect(() => restored.restoreState({ ...state, moves: [move(9, 0, 1, 0)] })).toThrow(/非法走法/);
  });
});
