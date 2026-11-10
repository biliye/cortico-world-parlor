import { expect, it } from 'vitest';
import { fitRatings } from '../src/room/ratings/bt.ts';

const player = (cooId: string | null, rank: number, team: string | null = null) => ({ cooId, rank, team });

it('十胜零负仍收敛，每对一场虚拟平局，按每组几何平均强度定零分', () => {
  const win = [player('a', 1), player('b', 2)];
  const [[a, b]] = fitRatings(Array.from({ length: 10 }, () => win));
  const score = Math.round(200 * Math.log10(21) * 10) / 10;
  expect(a).toEqual({ cooId: 'a', rating: score, games: 10 });
  expect(b).toEqual({ cooId: 'b', rating: -score, games: 10 });
});

it('不同桌型总权重相等，陪练与同队对不产生比较，无对战路径的组独立拟合', () => {
  const wins = Array.from({ length: 8 }, () => [player('a', 1), player('b', 2)]);
  const loss = [player('a', 2), player('b', 1), player(null, 2)];
  const draw = [player('c', 1), player('d', 1)];
  const practice = [player('a', 1, 'farmers'), player('b', 1, 'farmers'), player(null, 3, 'landlord')];
  // 先验证仅有 2/3 人桌时，8 场两人胜与 1 场三人负的权重相抵。
  expect(fitRatings([...wins, loss, practice])).toEqual([[
    { cooId: 'a', rating: 0, games: 9 },
    { cooId: 'b', rating: 0, games: 9 },
  ]]);
  expect(fitRatings([practice, draw, [player('a', 1), player('b', 1)]])).toEqual([
    [{ cooId: 'c', rating: 0, games: 1 }, { cooId: 'd', rating: 0, games: 1 }],
    [{ cooId: 'a', rating: 0, games: 1 }, { cooId: 'b', rating: 0, games: 1 }],
  ]);
});
