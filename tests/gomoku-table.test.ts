import { describe, expect, it } from 'vitest';
import { GomokuTable } from '../src/room/games/gomoku-table.ts';

const black = { id: 'black', name: '黑方' };
const white = { id: 'white', name: '白方' };

function started() {
  const table = new GomokuTable(black, 100);
  table.join(white);
  table.start(black.id, 1000);
  return table;
}

function playThreat(blackMoves: Array<[number, number]>, whiteMoves = blackMoves.slice(1).map((_, i) => [i * 2, 12])) {
  const table = started();
  blackMoves.forEach(([row, col], i) => {
    table.act(black.id, { row, col }, 1001);
    if (i < blackMoves.length - 1) {
      const [replyRow, replyCol] = whiteMoves[i]!;
      table.act(white.id, { row: replyRow, col: replyCol }, 1001);
    }
  });
  return table;
}

describe('五子棋牌桌', () => {
  it('行动通知用数字标尺和小写末手，只用坐标写建议', () => {
    const table = started();
    expect(table.privateText(black.id)).toContain(' 0 ...............');
    table.act(black.id, { row: 0, col: 10 }, 1001);
    const whiteText = table.privateText(white.id)!;
    expect(whiteText).toContain('\n             11111\n   012345678901234\n 0 ..........x....');
    table.act(white.id, { row: 14, col: 14 }, 1001);
    const blackText = table.privateText(black.id)!;
    expect(blackText).toContain('\n 0 ..........X....');
    expect(blackText).toContain('\n14 ..............o');
    expect(blackText).toMatch(/建议（行,列）：\(\d+,\d+\) /);
    expect(blackText).not.toContain('parlor_game_action');
  });

  it('提示一步连五或封堵，只给当前玩家，按空交点和轮序校验', () => {
    const table = started();
    expect(table.view(black.id)?.hints[0]).toMatchObject({ row: 7, col: 7, level: 'shape' });
    expect(table.view(white.id)?.hints).toEqual([]);
    expect(() => table.act(white.id, { row: 1, col: 0 }, 1001)).toThrow('还没轮到你');
    for (let col = 0; col < 4; col++) {
      table.act(black.id, { row: 0, col }, 1001);
      expect(() => table.act(white.id, { row: 0, col }, 1001)).toThrow('空交点');
      if (col < 3) table.act(white.id, { row: 1, col }, 1001);
    }
    expect(table.view(white.id)?.hints[0]).toMatchObject({ row: 0, col: 4, reason: '挡住对方下一步连五', level: 'block' });
    table.act(white.id, { row: 1, col: 3 }, 1001);
    expect(table.view(black.id)?.hints[0]).toMatchObject({ row: 0, col: 4, reason: '这一步可以连五获胜', level: 'win' });
    expect(table.act(black.id, { row: 0, col: 4 }, 1001).ended).toBe(true);
    expect(table.public()).toMatchObject({ winner: 'black', status: 'ended' });
    expect(table.public().winningLine).toHaveLength(5);
  });

  it('活三单独提示，优先封两端，并保留冲四抢先手的建议', () => {
    const table = playThreat([[1, 2], [1, 3], [1, 4], [12, 12]], [[8, 7], [8, 8], [8, 10]]);
    const view = table.view(white.id)!;
    expect(view.warning).toMatchObject({ level: 'block', text: expect.stringContaining('不堵就被连成五') });
    expect(view.hints.slice(0, 2)).toEqual([5, 1].map(col => ({ row: 1, col, reason: '封堵对方活三', level: 'block' })));
    expect(view.hints[2]).toMatchObject({ row: 8, col: 9, reason: '冲四抢先手' });
    expect(table.privateText(white.id)).toContain('\n对方有活三。不堵就被连成五');
    expect(table.view(black.id)?.warning).toBeUndefined();
    expect(table.tick(1101)?.events[0]?.data).toMatchObject({ move: { row: 1, col: 5 } });

    // 靠边的活三还有一个能封住活四的外端，第三条仍留给冲四。
    const edge = playThreat([[1, 1], [1, 2], [1, 3], [12, 12]], [[8, 7], [8, 8], [8, 10]]);
    expect(edge.view(white.id)?.hints.map(hint => hint.reason)).toEqual(['封堵对方活三', '封堵对方活三', '冲四抢先手']);
  });

  it('双活三和四三各自标红，四三仍优先封下一手连五', () => {
    const doubleThree = playThreat([[7, 6], [7, 7], [7, 8], [6, 7], [8, 7]]);
    expect(doubleThree.view(white.id)?.warning).toMatchObject({ level: 'danger', text: expect.stringContaining('双活三') });
    const fourThree = playThreat([[1, 0], [1, 1], [1, 2], [1, 3], [9, 6], [9, 7], [9, 8]]);
    const view = fourThree.view(white.id)!;
    expect(view.warning).toMatchObject({ level: 'danger', text: expect.stringContaining('四三') });
    expect(view.hints[0]).toMatchObject({ row: 1, col: 4, reason: '挡住对方下一步连五' });
  });

  it('两条线能一手封住时只给普通提醒，边界也不会算成空位', () => {
    const shared = playThreat([[7, 4], [7, 5], [7, 6], [4, 7], [5, 7], [6, 7]]).view(white.id)!;
    expect(shared.warning?.level).toBe('block');
    expect(shared.hints[0]).toMatchObject({ row: 7, col: 7, reason: '封堵对方活三' });
    const sharedFour = playThreat([[1, 0], [1, 1], [1, 2], [1, 3], [2, 4], [3, 4], [4, 4]]).view(white.id)!;
    expect(sharedFour.warning?.level).toBe('block');
    expect(sharedFour.hints[0]).toMatchObject({ row: 1, col: 4, reason: '挡住对方下一步连五' });
    expect(playThreat([[0, 0], [0, 1], [0, 2]]).view(white.id)?.warning).toBeUndefined();
  });

  it('恢复棋谱与期限，超时只代下一手并拒绝坏快照', () => {
    const table = started();
    table.act(black.id, { row: 7, col: 7 }, 1001);
    const restored = new GomokuTable(black, 100);
    restored.restoreState(table.exportState());
    expect(restored.public()).toEqual(table.public());
    expect(restored.tick(1100)).toBeNull();
    expect(restored.tick(1101)?.views).toEqual([black.id]);
    expect(restored.tick(1101)).toBeNull();
    expect(() => restored.restoreState({ ...table.exportState(), status: 'ended' })).toThrow('不一致');
  });
});
