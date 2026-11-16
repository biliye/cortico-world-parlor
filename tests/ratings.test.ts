import { expect, it } from 'vitest';
import { GAME_LIST } from '../src/room/games/registry.ts';
import { fitRatings } from '../src/room/ratings/bt.ts';
import { validSeatResults } from '../src/room/table-results.ts';

const ratedFixtures: Record<string, number> = {
  dice: 2, ddz: 3, werewolf: 6, monopoly2d: 4, gomoku: 2, xiangqi: 2,
  'mahjong-sichuan': 4, 'mahjong-guangdong': 4,
};

it.each(GAME_LIST.filter(game => game.rated))('$id 正常终局符合统一的逐席赛果契约', game => {
  const playerCount = ratedFixtures[game.id];
  expect(playerCount, '新开榜玩法需要登记终局测试夹具').toBeDefined();
  const seats = Array.from({ length: playerCount }, (_, index) => ({
    id: `seat-${index + 1}`, name: `玩家 ${index + 1}`, kind: 'pet' as const, clientVersion: '0.40.0',
  }));
  let now = 1_000;
  const engine = game.create({ host: seats[0]!, now, seatCount: 6, requireHuman: false, turnMs: 1 });
  for (const seat of seats.slice(1)) engine.join(seat);
  let step = engine.start(seats[0]!.id, now);
  for (let turn = 0; !step.ended && turn < 500; turn++) {
    now = (engine.nextWakeAt?.(now) ?? now + 600_000) + 1;
    step = engine.tick(now) ?? step;
  }
  expect(step.ended).toBe(true);
  const end = step.events.find(event => event.type === 'parlor.table.end');
  expect(end).toBeDefined();
  const winners = end!.data!.winners as string[];
  expect(validSeatResults(step.seatResults, engine.seatIds(), winners, end!.data!.tie === true, game.ratingOrder)).toBe(true);
});

it('拒绝缺席、重复席、赢家矛盾的逐席赛果，接受全桌和局', () => {
  const seats = ['a', 'b'];
  const a = { seatId: 'a', rank: 1 };
  const b = { seatId: 'b', rank: 2 };
  expect(validSeatResults(null, seats, ['a'], false)).toBe(false);
  expect(validSeatResults([a], seats, ['a'], false)).toBe(false);
  expect(validSeatResults([a, a], seats, ['a'], false)).toBe(false);
  expect(validSeatResults([a, b], seats, ['b'], false)).toBe(false);
  expect(validSeatResults([a, { ...b, rank: 1 }], seats, [], true)).toBe(true);
});

it('并列后按占用的席位数跳名次，首位并列和全桌和局分别处理', () => {
  const seats = ['a', 'b', 'c'];
  const tied = [{ seatId: 'a', rank: 1 }, { seatId: 'b', rank: 1 }];
  expect(validSeatResults([{ seatId: 'c', rank: 3 }, ...tied], seats, ['a', 'b'], true)).toBe(true);
  expect(validSeatResults([{ seatId: 'c', rank: 2 }, ...tied], seats, ['a', 'b'], true)).toBe(false);
  expect(validSeatResults([{ seatId: 'c', rank: 3 }, tied[0]!, { seatId: 'b', rank: 3 }], seats, ['a'], false)).toBe(false);
});

const player = (cooId: string | null, rank: number, team: string | null = null) => ({ cooId, rank, team });

it('按净分评级时要求每席有分数，同分必须并列，胡牌名单可以不同', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const seats = [
    { seatId: 'a', rank: 2, score: 3 }, { seatId: 'b', rank: 1, score: 5 },
    { seatId: 'c', rank: 3, score: -4 }, { seatId: 'd', rank: 3, score: -4 },
  ];
  expect(validSeatResults(seats, ids, ['a'], false, 'score')).toBe(true);
  expect(validSeatResults(seats, ids, ['a'], false)).toBe(false);
  expect(validSeatResults([{ ...seats[0], rank: 1 }, { ...seats[1], rank: 2 }, ...seats.slice(2)], ids, ['a'], false, 'score')).toBe(false);
  expect(validSeatResults([...seats.slice(0, 3), { ...seats[3], rank: 4 }], ids, ['a'], false, 'score')).toBe(false);
  expect(validSeatResults([...seats.slice(0, 3), { ...seats[3], score: undefined }], ids, ['a'], false, 'score')).toBe(false);
});

it('四家零分的完整流局按平局计一场', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const draw = ids.map(seatId => ({ seatId, rank: 1, score: 0 }));
  expect(validSeatResults(draw, ids, [], true, 'score')).toBe(true);
  expect(fitRatings([draw.map(seat => player(seat.seatId, seat.rank))])).toEqual([
    ids.map(cooId => ({ cooId, games: 1, rating: 0 })),
  ]);
});

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
