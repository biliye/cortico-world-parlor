import { describe, expect, it } from 'vitest';
import { DiceError, DiceTable, formatPrivate, formatPublic } from '../src/room/table.ts';

const fixed = (values: number[]): (() => number) => {
  let index = 0;
  return () => values[index++] ?? 1;
};

describe('暗骰桌', () => {
  it('开局发暗骰；公开视图不含点数，私视图只给自己的', () => {
    const table = new DiceTable({ host: { id: 'a', name: '阿岚' }, now: 0, turnMs: 5000, rng: fixed([1, 2, 3, 4]) });
    table.join({ id: 'b', name: '小满' });
    const step = table.start('a', 0);
    expect(step.views).toEqual(['a']);
    expect(table.public().revealed).toBeUndefined();
    expect(JSON.stringify(table.public().seats)).not.toContain('dice');

    expect(table.view('a')!.dice).toEqual([1, 2]);
    expect(table.view('b')!.dice).toEqual([3, 4]);
    expect(table.view('a')!.yourTurn).toBe(true);
    expect(table.view('b')!.yourTurn).toBe(false);
    expect(formatPrivate(table.view('a')!, 0)).toContain('轮到你');
    expect(formatPrivate(table.view('b')!, 0)).toContain('等待');
    expect(() => table.join({ id: 'c', name: '丙' })).toThrow(DiceError);
  });

  it('重掷、停牌、逐回合推进，最后揭晓并判赢家', () => {
    const table = new DiceTable({ host: { id: 'a', name: '阿岚' }, now: 0, turnMs: 5000, rng: fixed([1, 2, 3, 4, 6]) });
    table.join({ id: 'b', name: '小满' });
    table.start('a', 0);

    const rolled = table.act('a', { type: 'roll', die: 0 }, 100);
    expect(rolled.views).toEqual(['b']);
    expect(table.view('a')!.dice).toEqual([6, 2]);
    expect(table.view('a')!.rerollsLeft).toBe(1);

    expect(table.act('b', { type: 'stand' }, 200).views).toEqual(['a']);
    const ended = table.act('a', { type: 'stand' }, 300);
    expect(ended.ended).toBe(true);

    const result = table.public();
    expect(result.status).toBe('ended');
    expect(result.winners).toEqual(['a']);
    expect(result.revealed).toEqual([
      { id: 'a', name: '阿岚', dice: [6, 2], total: 8 },
      { id: 'b', name: '小满', dice: [3, 4], total: 7 },
    ]);
    expect(formatPublic(result)).toContain('赢家：阿岚');
  });

  it('超时自动停牌，并把回合交给下一位', () => {
    const table = new DiceTable({ host: { id: 'a', name: '阿岚' }, now: 0, turnMs: 1000, rng: fixed([1, 2, 3, 4]) });
    table.join({ id: 'b', name: '小满' });
    table.start('a', 0);
    const step = table.tick(1001)!;
    expect(step.events[0].text).toContain('超时');
    expect(step.views).toEqual(['b']);
    expect(table.view('a')!.yourTurn).toBe(false);
    expect(table.view('b')!.yourTurn).toBe(true);
  });

  it('不在轮次、没有重掷次数会被拒绝', () => {
    const table = new DiceTable({ host: { id: 'a', name: '阿岚' }, now: 0, turnMs: 5000, rng: fixed([1, 2, 3, 4, 5, 6]) });
    table.join({ id: 'b', name: '小满' });
    table.start('a', 0);
    expect(() => table.act('b', { type: 'stand' }, 0)).toThrow(DiceError);
    table.act('a', { type: 'roll', die: 0 }, 0);
    table.act('b', { type: 'roll', die: 0 }, 0);
    table.act('a', { type: 'roll', die: 0 }, 0);
    table.act('b', { type: 'stand' }, 0);
    expect(() => table.act('a', { type: 'roll', die: 0 }, 0)).toThrow(/没有重掷/);
  });
});
