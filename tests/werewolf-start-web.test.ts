import { describe, expect, it } from 'vitest';
import { canStartTable, tableSeatLabel, tableStartBlockers } from '../web-src/lib/games.ts';

describe('狼人杀开局前提示', () => {
  it.each([6, 12])('按 %i 人桌实际容量判断可开局', (capacity) => {
    const table = { game: 'werewolf', capacity, requireHuman: false, seats: Array.from({ length: capacity }, () => ({ kind: 'pet' })) };
    expect(canStartTable(table)).toBe(true);
    expect(canStartTable({ ...table, seats: table.seats.slice(1) })).toBe(false);
  });
  it('满九席仍检查真人/Coo，兼容旧服务端；不把 Coo 显示成人', () => {
    const table = { game: 'werewolf', seats: Array.from({ length: 9 }, () => ({ kind: 'pet' })) };
    expect(canStartTable(table)).toBe(false);
    expect(tableStartBlockers(table).join()).toContain('真人');
    expect(canStartTable({ ...table, requireHuman: false })).toBe(true);
    expect(canStartTable({ ...table, requireHuman: true })).toBe(false);
    table.seats[0] = { kind: 'human' };
    expect(canStartTable(table)).toBe(true);
    expect(canStartTable({ ...table, seats: table.seats.slice(1) })).toBe(false);
    expect(canStartTable({ ...table, seats: table.seats.map(() => ({ kind: 'human' })) })).toBe(false);
    expect(tableSeatLabel({ kind: 'pet' })).toBe('Coo');
    expect(tableSeatLabel({ kind: 'human' })).toBe('人');
    expect(tableSeatLabel({ bot: true })).toBe('脚本');
    expect(tableSeatLabel({})).toBe('席位');
  });

  it('服务端给出的具体缺少条件控制开始按钮，斗地主脚本补位不受影响', () => {
    const table = { game: 'werewolf', seats: Array.from({ length: 9 }, (_, index) => ({ kind: index ? 'pet' : 'human' })), startBlockers: ['9号 九九需要升级到 ≥ 0.29.0'] };
    expect(canStartTable(table)).toBe(false);
    expect(tableStartBlockers(table)).toEqual(table.startBlockers);
    expect(canStartTable({ ...table, startBlockers: [] })).toBe(true);
    expect(canStartTable({ game: 'ddz', seats: [{ kind: 'pet' }] })).toBe(true);
  });
});
