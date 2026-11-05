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

describe('五子棋牌桌', () => {
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
