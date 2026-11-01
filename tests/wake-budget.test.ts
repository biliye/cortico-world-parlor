import { describe, expect, it } from 'vitest';
import { AmbientWakeBudget } from '../src/wake-budget.ts';

describe('普通闲聊投递额度', () => {
  it.each([60, 30])('%s 次/小时：最多积存三次，耗尽后按速率恢复', (rate) => {
    const budget = new AmbientWakeBudget();
    expect([0, 1, 2].map(() => budget.reserve(rate, 0))).toEqual([0, 0, 0]);
    const interval = 3_600_000 / rate;
    expect(budget.reserve(rate, 0)).toBe(interval);
    expect(budget.reserve(rate, interval - 1)).toBe(1);
    expect(budget.reserve(rate, interval)).toBe(0);
    expect(budget.reserve(rate, interval)).toBe(interval);
  });

  it('积存额度不会突破滚动一小时硬上限，边界过去后恢复', () => {
    const budget = new AmbientWakeBudget();
    for (let i = 0; i < 60; i += 1) expect(budget.reserve(60, i * 60_000)).toBe(0);
    expect(budget.reserve(60, 3_599_999)).toBe(1);
    expect(budget.reserve(60, 3_600_000)).toBe(0);
    expect(budget.reserve(60, 3_600_000)).toBe(60_000);
  });

  it('切换挡位不重置额度，时钟倒退不产生新额度', () => {
    const budget = new AmbientWakeBudget();
    for (let i = 0; i < 3; i += 1) expect(budget.reserve(60, 100_000)).toBe(0);
    expect(budget.reserve(30, 100_000)).toBe(120_000);
    expect(budget.reserve(60, 90_000)).toBe(60_000);
    expect(budget.reserve(60, 160_000)).toBe(0);
  });
});
