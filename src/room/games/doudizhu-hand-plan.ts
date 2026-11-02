import { RANKS, type Card, type Move } from './doudizhu.ts';

/** 静态拆手：每组均为合法领出，不假定能连续拿到出牌权。 */
export function createHandPlanner(hand: readonly Card[], moves: readonly Move[]): (cards: readonly Card[]) => number {
  const powers = RANKS.map((_, index) => 5 ** index);
  const tally = (cards: readonly Card[]): number[] => RANKS.map((rank) => cards.filter((card) => card === rank).length);
  const keyOf = (counts: readonly number[]): number => counts.reduce((sum, count, rank) => sum + count * powers[rank], 0);
  const entries = moves.map((move) => {
    const counts = tally(move.cards);
    return { counts, key: keyOf(counts), size: move.cards.length };
  }).sort((a, b) => b.size - a.size || a.key - b.key);
  const singleMoves = new Set(entries.map((entry) => entry.key));
  const containing = RANKS.map((_, rank) => entries.filter((entry) => entry.counts[rank] > 0));
  const memo = new Map<number, number>([[0, 0]]);
  const fits = (move: readonly number[], counts: readonly number[]): boolean => move.every((n, rank) => n <= counts[rank]);
  // 所有候选共用缓存和确定性的搜索额度；大手牌达到额度后返回真实合法拆分的上界。
  const budget = hand.length <= 12 ? 4096 : 1200;
  let visited = 0;
  const greedy = (counts: readonly number[]): number => {
    const rest = [...counts];
    let groups = 0;
    for (const entry of entries) while (fits(entry.counts, rest)) {
      for (let rank = 0; rank < rest.length; rank++) rest[rank] -= entry.counts[rank];
      groups++;
    }
    return groups;
  };
  const solve = (counts: number[], key: number): number => {
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (singleMoves.has(key)) { memo.set(key, 1); return 1; }
    let best = greedy(counts);
    if (best > 2 && visited++ < budget) {
      const anchor = counts.findIndex((count) => count > 0);
      for (const entry of containing[anchor]) {
        if (!fits(entry.counts, counts)) continue;
        const rest = counts.map((count, rank) => count - entry.counts[rank]);
        best = Math.min(best, 1 + solve(rest, key - entry.key));
        if (best === 2) break;
      }
    }
    memo.set(key, best);
    return best;
  };
  return (cards) => { const counts = tally(cards); return solve(counts, keyOf(counts)); };
}
