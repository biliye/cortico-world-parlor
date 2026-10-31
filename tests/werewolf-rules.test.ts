import { describe, expect, it } from 'vitest';
import {
  ROLE_COUNTS, WEREWOLF_SEAT_COUNT, cleanSpeech, dealRoles, factionOf, judgeOutcome,
  tallyVotes, versionAtLeast,
} from '../src/room/games/werewolf.ts';

const seqRng = (values: number[]): { rng: () => number } => {
  let index = 0;
  return { rng: () => values[index++ % values.length] ?? 0.5 };
};

describe('狼人杀纯规则', () => {
  it('发牌：九张恰好 3+3+1+1+1，洗牌不重不漏', () => {
    for (const seed of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99]) {
      const roles = dealRoles(seqRng([seed]).rng);
      expect(roles).toHaveLength(WEREWOLF_SEAT_COUNT);
      for (const { role, count } of ROLE_COUNTS) {
        expect(roles.filter((entry) => entry === role)).toHaveLength(count);
      }
    }
  });

  it('判胜负：好人全灭狼、屠边两向、平局顺序', () => {
    const aliveOf = (roles: string[]) => {
      const map = new Map<number, 'wolf' | 'villager' | 'seer' | 'witch' | 'hunter'>();
      roles.forEach((role, index) => map.set(index + 1, role as 'wolf'));
      return map;
    };
    // 全员出局 → 平局优先于「狼全灭好人胜」。
    expect(judgeOutcome(aliveOf([]))).toBe('draw');
    // 狼全灭 → 好人胜。
    expect(judgeOutcome(aliveOf(['villager', 'villager', 'seer']))).toBe('good');
    // 屠边一：村民全出局。
    expect(judgeOutcome(aliveOf(['wolf', 'wolf', 'seer', 'witch']))).toBe('wolf');
    // 屠边二：三神全出局。
    expect(judgeOutcome(aliveOf(['wolf', 'villager', 'villager']))).toBe('wolf');
    // 还有村民与神职 → 未决。
    expect(judgeOutcome(aliveOf(['wolf', 'villager', 'seer']))).toBe(null);
    expect(judgeOutcome(aliveOf(['wolf', 'villager', 'witch', 'hunter']))).toBe(null);
    // 只剩好人 → 好人胜（狼全灭的自然结果）。
    expect(judgeOutcome(aliveOf(['witch']))).toBe('good');
  });

  it('数票：唯一最高出局、平票并列、全弃票', () => {
    const ballots = (pairs: Array<[number, number | null]>) => new Map(pairs);
    // 唯一最高。
    expect(tallyVotes(ballots([[1, 3], [2, 3], [3, 5], [4, null]]))).toMatchObject({ exiled: 3, top: 2 });
    // 平票。
    const tied = tallyVotes(ballots([[1, 3], [2, 5], [3, 3], [4, 5]]));
    expect(tied.exiled).toBeUndefined();
    expect(tied.tie).toEqual([3, 5]);
    expect(tied.top).toBe(2);
    // 全弃票。
    expect(tallyVotes(ballots([[1, null], [2, null]]))).toMatchObject({ noValid: true, top: 0 });
    // 空票箱。
    expect(tallyVotes(ballots([]))).toMatchObject({ noValid: true });
    // 允许目标过滤（PK 复投：只数投给 PK 席位的票）。
    expect(tallyVotes(ballots([[1, 3], [2, 5]]), new Set([3]))).toMatchObject({ exiled: 3, top: 1 });
  });

  it('发言校验：300 字上限按码点数、超长拒绝不截断、纯不可见拒绝', () => {
    expect(cleanSpeech('  你好  ', 300)).toBe('你好');
    expect(Array.from(cleanSpeech('🐶'.repeat(150), 300))).toHaveLength(150);
    // 301 个码点（emoji 也按码点数：301 只 🐶 同样超）。
    expect(() => cleanSpeech('旺'.repeat(301), 300)).toThrow(/300/);
    expect(() => cleanSpeech('🐶'.repeat(301), 300)).toThrow(/300/);
    expect(Array.from(cleanSpeech('🐶'.repeat(300), 300))).toHaveLength(300);
    // 换行与制表保留。
    expect(cleanSpeech('第一行\n第二行\t尾', 300)).toBe('第一行\n第二行\t尾');
    // 纯空白 / 纯零宽。
    expect(() => cleanSpeech('   ', 300)).toThrow();
    expect(() => cleanSpeech('\u200b\u200b', 300)).toThrow();
    // 有害控制字符。
    expect(() => cleanSpeech('a\u0000b', 300)).toThrow();
    expect(() => cleanSpeech('a\u0007b', 300)).toThrow();
    // 非字符串。
    expect(() => cleanSpeech(42 as unknown, 300)).toThrow();
  });

  it('版本比较：能力闸按三段数字比', () => {
    expect(versionAtLeast('0.29.0', '0.29.0')).toBe(true);
    expect(versionAtLeast('0.30.1', '0.29.0')).toBe(true);
    expect(versionAtLeast('1.0.0', '0.29.0')).toBe(true);
    expect(versionAtLeast('0.28.0', '0.29.0')).toBe(false);
    expect(versionAtLeast(undefined, '0.29.0')).toBe(false);
    expect(versionAtLeast('', '0.29.0')).toBe(false);
    expect(versionAtLeast('beta', '0.29.0')).toBe(false);
  });

  it('阵营划分', () => {
    expect(factionOf('wolf')).toBe('wolf');
    for (const role of ['villager', 'seer', 'witch', 'hunter'] as const) {
      expect(factionOf(role)).toBe('good');
    }
  });
});
