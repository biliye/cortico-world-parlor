import { describe, expect, it } from 'vitest';
import { XiangqiTable, XiangqiMoveError } from '../src/room/games/xiangqi-table.ts';
import {
  afterMove, formatXiangqiAdvice, indexOf, initialBoard, isInCheck, isLegalMove, legalMoves, rejectedMoveReason, suggestMoves,
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
    [move(9, 1, 10, 2), '坐标须使用行 0–9、列 0–8，从黑方左上角起算'],
    [move(8, 1, 7, 2), '起点 (8,1) 没有棋子'],
    [move(0, 1, 2, 2), '起点是对方棋子'],
    [move(9, 1, 9, 1), '起点和落点相同'],
    [move(9, 1, 9, 2), '落点被己方棋子占据'],
    [move(9, 1, 8, 3), '马腿被挡'],
    [move(9, 1, 8, 1), '马须按日字走'],
    [move(9, 0, 5, 0), '车的行进路线有棋子阻挡'],
    [move(9, 0, 8, 1), '车须沿直线走'],
    [move(7, 1, 5, 2), '炮须沿直线走'],
    [move(7, 1, 2, 1), '炮吃子时起点和落点之间须恰好隔一子'],
    [move(7, 1, 1, 1), '炮走到空位时不能越过棋子'],
    [move(9, 2, 8, 1), '相（象）须按田字走'],
    [move(9, 3, 8, 3), '仕（士）须在九宫内斜走一格'],
    [move(9, 4, 8, 3), '帅（将）须在九宫内直走一格'],
    [move(6, 0, 6, 1), '兵（卒）只能前进一步，过河后也可横走一格'],
  ] as const)('开局非法着法 %j 提示「%s」', (attempt, reason) => {
    const board = initialBoard();
    expect(isLegalMove(board, attempt, 1)).toBe(false);
    expect(rejectedMoveReason(board, attempt, 1)).toBe(reason);
  });

  it.each<{ pieces: [number, number, number][]; attempt: XiangqiMove; reason: string }>([
    { pieces: [[1, 4, 5]], attempt: move(1, 4, 0, 4), reason: '应以将死或困毙结束，不能直接吃掉将帅' },
    { pieces: [[7, 2, 3], [6, 1, 7]], attempt: move(7, 2, 5, 0), reason: '象眼被挡' },
    { pieces: [[5, 2, 3]], attempt: move(5, 2, 3, 0), reason: '相（象）不能过河' },
    { pieces: [[5, 4, 0], [4, 4, 7]], attempt: move(4, 4, 4, 5), reason: '这步会造成将帅照面' },
    { pieces: [[9, 0, -5]], attempt: move(5, 4, 4, 4), reason: '你正在被将军，这步未能应将' },
    { pieces: [[9, 0, -5], [9, 2, 5]], attempt: move(9, 2, 8, 2), reason: '走后己方将帅会被将军' },
  ])('指定局面的非法着法提示「$reason」', ({ pieces, attempt, reason }) => {
    const board = sparseBoard();
    for (const [row, col, piece] of pieces) set(board, row, col, piece);
    expect(isLegalMove(board, attempt, 1)).toBe(false);
    expect(rejectedMoveReason(board, attempt, 1)).toBe(reason);
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

  it('推荐考虑回吃，说明对手净赚的应手，省略对手净亏的原有交换', () => {
    const board = initialBoard();
    const horse = move(9, 1, 7, 2);
    const cannon = move(7, 1, 0, 1);
    const hints = suggestMoves(board, 1, [cannon, horse], () => undefined);
    expect(hints).toMatchObject([
      { ...horse, reason: '保持子力，调整站位' },
      { ...cannon, reason: '吃马、对方车可吃炮（(0,0) → (0,1)）' },
    ]);
    const [suggestions] = formatXiangqiAdvice(hints).split('\n');
    expect(suggestions).toContain('对方车可吃炮');
    expect(hints[0].positionThreat).toBeUndefined();
  });

  it('省略可以等价回吃的直接应手', () => {
    const board = sparseBoard();
    set(board, 7, 0, 5);
    set(board, 0, 2, -5);
    set(board, 7, 8, 5);
    const attempt = move(7, 0, 7, 2);
    const reply = move(0, 2, 7, 2);
    const next = afterMove(board, attempt);
    expect(isLegalMove(next, reply, -1)).toBe(true);
    expect(isLegalMove(afterMove(next, reply), move(7, 8, 7, 2), 1)).toBe(true);
    expect(suggestMoves(board, 1, [attempt], () => undefined)).toEqual([
      { ...attempt, reason: '保持子力，调整站位' },
    ]);
  });

  it('保留对手净赚的原局威胁，合并多条建议中的同一条', () => {
    const board = sparseBoard();
    set(board, 0, 0, -5);
    set(board, 7, 0, 4);
    set(board, 7, 7, 4);
    const hints = suggestMoves(board, 1, [move(5, 4, 4, 4), move(7, 7, 5, 8), move(7, 7, 5, 6)], () => undefined);
    const threat = '对方车可吃马（(0,0) → (7,0)）';
    expect(hints.map(hint => hint.positionThreat)).toEqual([threat, threat, threat]);
    const [suggestions, ...threats] = formatXiangqiAdvice(hints).split('\n');
    expect(suggestions).not.toContain(threat);
    expect(threats).toEqual([`第 1、2、3 条建议落子后仍有原局威胁：${threat}`]);
  });

  it('本着新暴露的吃子应手仍列在走法理由中', () => {
    const board = sparseBoard();
    set(board, 0, 0, -5);
    set(board, 5, 0, 5);
    set(board, 7, 0, 4);
    const uncover = move(5, 0, 5, 1);
    const reply = move(0, 0, 7, 0);
    expect(isLegalMove(board, uncover, 1)).toBe(true);
    expect(isLegalMove(board, reply, -1)).toBe(false);
    expect(isLegalMove(afterMove(board, uncover), reply, -1)).toBe(true);
    expect(suggestMoves(board, 1, [uncover], () => undefined)).toEqual([
      { ...uncover, reason: '对方车可吃马（(0,0) → (7,0)）' },
    ]);
  });
});

describe('象棋牌桌', () => {
  it('非法着法说明原因并给本手首选，编号落子与对应的坐标一致', () => {
    const table = started();
    const before = table.exportState();
    const [first, second] = table.view(red.id)!.hints!;
    expect(() => table.act(red.id, move(9, 1, 8, 3), 2)).toThrow(XiangqiMoveError);
    expect(() => table.act(red.id, move(9, 1, 8, 3), 2)).toThrow(expect.objectContaining({
      message: '马腿被挡', deadline: 101, alternative: first,
    }));
    expect(table.exportState()).toEqual(before);
    expect(table.act(red.id, { hint: 2 }, 3).views).toEqual([black.id]);
    expect(table.public().last).toMatchObject({ from: second.from, to: second.to });
  });

  it('真人每手 3 分钟，Coo 每手 60 秒，恢复后仍在各自时限托管', () => {
    const human = { ...red, kind: 'human' as const };
    const table = new XiangqiTable(human);
    table.join(black);
    table.start(human.id, 1);
    expect(table.nextWakeAt()).toBe(180_001);

    const restored = new XiangqiTable(human);
    restored.restoreState(table.exportState());
    expect(restored.tick(180_000)).toBeNull();
    expect(restored.tick(180_001)?.views).toEqual([black.id]);
    expect(restored.nextWakeAt()).toBe(240_001);
    expect(restored.tick(240_000)).toBeNull();
    expect(restored.tick(240_001)?.views).toEqual([human.id]);
    expect(restored.nextWakeAt()).toBe(420_001);
  });

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

  it('单方长将三次重复判负，恢复棋谱仍是同一结果', () => {
    const table = started();
    // 黑方移开左士，红车从左底角绕到第 1 行。
    const opening = [
      move(9, 0, 8, 0), move(0, 3, 1, 4), move(8, 0, 8, 3),
      move(1, 4, 2, 5), move(8, 3, 1, 3), move(0, 1, 2, 2),
    ];
    const cycle = [move(1, 3, 1, 4), move(0, 4, 0, 3), move(1, 4, 1, 3), move(0, 3, 0, 4)];
    const steps = [...opening, ...cycle, ...cycle].map((step, i) => table.act(i % 2 ? black.id : red.id, step, i + 2));
    expect(steps[9].ended).toBeUndefined();
    expect(steps.at(-1)).toMatchObject({ ended: true, seatResults: [
      { seatId: red.id, rank: 2 }, { seatId: black.id, rank: 1 },
    ] });
    expect(table.public()).toMatchObject({ status: 'ended', winner: black.id, cause: 'perpetual_check', plies: 14 });
    const restored = new XiangqiTable(red);
    restored.restoreState(table.exportState());
    expect(restored.public()).toEqual(table.public());
  });

  it('拒绝超过规则允许最大手数的存档，先检查长度再读取着法', () => {
    const table = started();
    const moves = Array(3_721);
    Object.defineProperty(moves, 0, { get: () => { throw new Error('不应读取着法'); } });
    expect(() => table.restoreState({ ...table.exportState(), moves })).toThrow('象棋存档格式错误');
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
