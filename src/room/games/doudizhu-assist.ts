/** 决策辅助只接收本人手牌、公开出牌和公开座次信息；不接收任何别家的私牌。 */
import { canBeat, DECK, isCard, moveLabel, parseMove, RANKS, sortCards, type Card, type Move } from './doudizhu.ts';
import type { BotContext } from './doudizhu-bot.ts';

export const countCards = (cards: readonly Card[]): Record<Card, number> => Object.fromEntries(
  RANKS.map((rank) => [rank, cards.filter((card) => card === rank).length]),
) as Record<Card, number>;

/** 多重集合扣减，损坏的牌局不能被悄悄截成 0。 */
export function subtractCards(pool: readonly Card[], removed: readonly Card[]): Card[] {
  const counts = countCards(pool);
  for (const card of removed) {
    if (!isCard(card) || --counts[card] < 0) throw new Error('斗地主记牌与牌堆不一致');
  }
  return RANKS.flatMap((rank) => Array<Card>(counts[rank]).fill(rank));
}

export const formatCounts = (cards: readonly Card[]): string => {
  const counts = countCards(cards);
  return RANKS.filter((rank) => counts[rank] > 0).map((rank) => `${rank}×${counts[rank]}`).join(' ') || '无';
};

/** 按点数选附件；不按实体牌枚举，避免同点数的花色制造重复组合。 */
function attachments(counts: Record<Card, number>, size: number, pairs: boolean, emit: (cards: Card[]) => void): void {
  const ranks = RANKS.filter((rank) => counts[rank] >= (pairs ? 2 : 1));
  const picked: Card[] = [];
  const visit = (index: number, left: number): void => {
    if (left === 0) { emit([...picked]); return; }
    if (index >= ranks.length || ranks.slice(index).reduce((sum, rank) => sum + (pairs ? 1 : Math.min(2, counts[rank])), 0) < left) return;
    const rank = ranks[index];
    for (let n = 0; n <= Math.min(left, pairs ? 1 : Math.min(2, counts[rank])); n++) {
      const length = picked.length;
      picked.push(...Array<Card>(n * (pairs ? 2 : 1)).fill(rank));
      visit(index + 1, left - n);
      picked.length = length;
    }
  };
  visit(0, size);
}

/** 规则生成候选，最终统一交给现有牌型和压牌裁决；提示只取少量结果。 */
export function legalPlays(hand: readonly Card[], target: Move | null): Move[] {
  const counts = countCards(hand);
  const found = new Map<string, Move>();
  const add = (cards: Card[]): void => {
    const move = parseMove(cards);
    if (move && canBeat(move, target)) found.set(move.cards.join(','), move);
  };
  const take = (rank: Card, n: number): Card[] => Array<Card>(n).fill(rank);
  for (const rank of RANKS) {
    for (let n = 1; n <= Math.min(4, counts[rank]); n++) add(take(rank, n));
    if (counts[rank] >= 3) for (const wing of RANKS) {
      if (rank === wing) continue;
      if (counts[wing] >= 1) add([...take(rank, 3), wing]);
      if (counts[wing] >= 2) add([...take(rank, 3), ...take(wing, 2)]);
    }
    if (counts[rank] === 4) {
      const rest = { ...counts, [rank]: 0 };
      attachments(rest, 2, false, (wings) => add([...take(rank, 4), ...wings]));
      attachments(rest, 2, true, (wings) => add([...take(rank, 4), ...wings]));
    }
  }
  if (counts.SJ && counts.BJ) add(['SJ', 'BJ']);
  const ace = RANKS.indexOf('A');
  for (const perRank of [1, 2, 3]) {
    const minimum = perRank === 1 ? 5 : perRank === 2 ? 3 : 2;
    for (let start = 0; start <= ace; start++) {
      const body: Card[] = [];
      for (let end = start; end <= ace && counts[RANKS[end]] >= perRank; end++) {
        body.push(...take(RANKS[end], perRank));
        const length = end - start + 1;
        if (length < minimum) continue;
        add([...body]);
        if (perRank !== 3) continue;
        const rest = { ...counts };
        for (const card of body) rest[card]--;
        attachments(rest, length, false, (wings) => add([...body, ...wings]));
        attachments(rest, length, true, (wings) => add([...body, ...wings]));
      }
    }
  }
  return [...found.values()];
}

export interface DoudizhuSuggestion {
  action: { move: 'play'; cards: Card[] } | { move: 'pass' };
  label: string;
  reason: string;
  remaining: number;
}

export interface DoudizhuAssist {
  played: Record<Card, number>;
  otherRemaining: Record<Card, number>;
  suggestions: DoudizhuSuggestion[];
  canBeat: boolean;
}

export function buildAssist(hand: readonly Card[], played: readonly Card[], target: Move | null, context: BotContext): DoudizhuAssist {
  const counts = countCards(hand);
  const plays = legalPlays(hand, target);
  const rated = plays.map((move) => {
    const used = countCards(move.cards);
    const splitBomb = RANKS.some((rank) => counts[rank] === 4 && used[rank] > 0 && used[rank] < 4);
    const splitRocket = counts.SJ > 0 && counts.BJ > 0 && used.SJ + used.BJ === 1;
    const splitPair = RANKS.filter((rank) => counts[rank] === 2 && used[rank] === 1).length;
    const bomb = move.type === 'bomb' || move.type === 'rocket';
    const finished = move.cards.length === hand.length;
    const urgent = context.minOpponentLeft <= 2;
    const score = finished ? 10_000 : (target ? 20 : move.cards.length * 5)
      - move.rank * 0.3 - splitPair * 6 - (splitBomb ? 80 : 0) - (splitRocket ? 90 : 0)
      - (bomb ? urgent ? 12 : 65 : 0);
    const reasons = [finished ? '可直接出完' : `出后剩 ${hand.length - move.cards.length} 张`];
    if (bomb) reasons.push('使用炸弹会使倍数翻倍');
    if (splitBomb) reasons.push('需要拆开四张同点牌');
    if (splitRocket) reasons.push('需要拆开王炸');
    if (splitPair) reasons.push('需要拆对子');
    if (!finished && !bomb && !splitBomb && !splitRocket && !splitPair) reasons.push(target ? '合法压牌，保留完整对子与炸弹' : '先走组合牌或散牌，保留完整对子与炸弹');
    return { score, suggestion: { action: { move: 'play' as const, cards: sortCards(move.cards) }, label: moveLabel(move), reason: reasons.join('；'), remaining: hand.length - move.cards.length } };
  }).sort((a, b) => b.score - a.score || a.suggestion.action.cards.join(',').localeCompare(b.suggestion.action.cards.join(',')));
  const suggestions: DoudizhuSuggestion[] = rated.slice(0, target ? 2 : 3).map((entry) => entry.suggestion);
  if (target) {
    const teammate = context.role === 'farmer' && context.lastPlayBy === 'farmer';
    const pass: DoudizhuSuggestion = {
      action: { move: 'pass' }, label: '不要', remaining: hand.length,
      reason: !plays.length ? '没有合法压牌，只能过牌' : teammate ? '队友当前领牌，可选择让牌；并非无法压牌' : '允许过牌，保留手牌；并非无法压牌',
    };
    const passFirst = !plays.length || (rated[0]?.score ?? 0) < 0 || (teammate && rated[0]?.score !== 10_000);
    if (passFirst) suggestions.unshift(pass); else suggestions.push(pass);
  }
  return { played: countCards(played), otherRemaining: countCards(subtractCards(DECK, [...played, ...hand])), suggestions, canBeat: plays.length > 0 };
}
