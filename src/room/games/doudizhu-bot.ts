/**
 * 斗地主的脚本出牌层（不是规则）：规则仍由 doudizhu.ts 判，这里只挑一手合法的牌。
 * 目标是把牌局打得像人一点：
 * - 领出优先甩连续牌（顺子/连对/飞机），其次三带、对子，最后才是单张；
 * - 两个农民之间不互相顶牌（队友的牌能过就过），除非自己能一把走完；
 * - 炸弹与王炸留着，只在对手快走完或自己能走完时用；
 * - 不为了压一张单牌拆炸弹/王炸，也尽量不拆对子去当单张。
 */
import {
  RANKS, handStrength, isCard, parseMove, suggestMove,
  type Card, type Move,
} from './doudizhu.ts';

export interface BotContext {
  role: 'landlord' | 'farmer';
  /** 上一手是谁打的。 */
  lastPlayBy?: 'landlord' | 'farmer';
  /** 对手里剩牌最少的那家有几步要走；用来决定要不要动炸弹。 */
  minOpponentLeft: number;
}

const ACE = RANKS.indexOf('A');
const JOKER_RANKS = new Set(['SJ', 'BJ']);
const BOMB_GUARD = 4;

const indexOf = (card: Card): number => RANKS.indexOf(card);

const toCards = (hand: readonly string[]): Card[] => {
  const invalid = hand.filter((card) => !isCard(card));
  if (invalid.length) throw new Error(`不认识的牌：${invalid.join('、')}`);
  return [...hand] as Card[];
};

const tally = (cards: readonly Card[]): Map<Card, number> => {
  const counts = new Map<Card, number>();
  for (const card of cards) counts.set(card, (counts.get(card) ?? 0) + 1);
  return counts;
};

interface Candidate {
  cards: Card[];
  move: Move;
}

const scoreOf = (move: Move): number => {
  if (move.type === 'bomb' || move.type === 'rocket') return -100 + move.cards.length;
  let score = move.cards.length;
  if (move.type === 'straight' || move.type === 'pair-straight' || move.type === 'airplane') score += 8;
  else if (move.type === 'triple-single' || move.type === 'triple-pair') score += 2;
  else if (move.type === 'pair') score += 1;
  return score;
};

export function chooseBid(hand: readonly string[]): boolean {
  return handStrength(toCards(hand)) >= 3;
}

/** 领出时挑一手：优先甩得多、牌型连续，其次小牌先走。 */
export function chooseLead(hand: readonly string[]): Card[] {
  const cards = toCards(hand);
  const counts = tally(cards);
  const count = (rank: number): number => counts.get(RANKS[rank]) ?? 0;
  const take = (rank: number, size: number): Card[] => cards
    .filter((card) => card === RANKS[rank])
    .slice(0, size);
  const rocket = count(RANKS.indexOf('SJ')) > 0 && count(RANKS.indexOf('BJ')) > 0;
  const candidates: Candidate[] = [];
  const add = (picked: Card[]): void => {
    const move = parseMove(picked);
    if (move) candidates.push({ cards: move.cards, move });
  };

  for (let start = 0; start <= ACE; start++) {
    let end = start;
    while (end <= ACE && count(end) >= 1 && count(end) < BOMB_GUARD) end++;
    for (let length = 5; length <= end - start; length++) {
      const picked: Card[] = [];
      for (let rank = start; rank < start + length; rank++) picked.push(...take(rank, 1));
      add(picked);
    }
  }

  for (let start = 0; start <= ACE; start++) {
    let end = start;
    while (end <= ACE && count(end) >= 2 && count(end) < BOMB_GUARD) end++;
    for (let length = 3; length <= end - start; length++) {
      const picked: Card[] = [];
      for (let rank = start; rank < start + length; rank++) picked.push(...take(rank, 2));
      add(picked);
    }
  }

  for (let start = 0; start <= ACE; start++) {
    let end = start;
    while (end <= ACE && count(end) === 3) end++;
    for (let length = 2; length <= end - start; length++) {
      const picked: Card[] = [];
      for (let rank = start; rank < start + length; rank++) picked.push(...take(rank, 3));
      add(picked);
    }
  }

  const wingRank = (rank: number, size: 1 | 2): number | undefined => {
    for (let other = 0; other <= ACE; other++) {
      if (other === rank || count(other) !== size) continue;
      if (rocket && JOKER_RANKS.has(RANKS[other])) continue;
      return other;
    }
    return undefined;
  };

  for (let rank = 0; rank <= ACE; rank++) {
    if (count(rank) !== 3) continue;
    const triple = take(rank, 3);
    add(triple);
    const single = wingRank(rank, 1);
    if (single !== undefined) add([...triple, ...take(single, 1)]);
    const pair = wingRank(rank, 2);
    if (pair !== undefined) add([...triple, ...take(pair, 2)]);
  }

  for (let rank = 0; rank <= ACE; rank++) {
    if (count(rank) === 2) add(take(rank, 2));
  }

  const looseSingles: number[] = [];
  for (let rank = 0; rank < RANKS.length; rank++) {
    if (count(rank) !== 1) continue;
    if (rocket && JOKER_RANKS.has(RANKS[rank])) continue;
    looseSingles.push(rank);
  }
  for (const rank of looseSingles) add(take(rank, 1));
  if (looseSingles.length === 0) {
    const fallback = [...Array(ACE + 1).keys()]
      .find((rank) => count(rank) === 2 || count(rank) === 3);
    if (fallback !== undefined) add(take(fallback, 1));
  }

  for (let rank = 0; rank <= ACE; rank++) {
    if (count(rank) === 4) add(take(rank, 4));
  }
  if (rocket) add(['SJ', 'BJ']);

  if (candidates.length === 0) return cards;
  candidates.sort((a, b) => (
    scoreOf(b.move) - scoreOf(a.move)
    || a.move.rank - b.move.rank
    || b.cards.length - a.cards.length
  ));
  return candidates[0].cards;
}

/** 跟牌时挑一手；返回 null = 过。 */
export function chooseFollow(
  hand: readonly string[],
  target: Move,
  context: BotContext,
): Card[] | null {
  const cards = toCards(hand);
  const candidate = suggestMove(cards, target);
  if (!candidate) return null;
  const move = parseMove(candidate);
  if (!move) return null;

  // 能一把走完就一定要走，哪怕压的是队友。
  if (candidate.length === cards.length) return candidate;

  // 队友的牌不顶：把出牌权留给队友。
  if (context.role === 'farmer' && context.lastPlayBy === 'farmer') return null;

  const counts = tally(cards);
  const wastesBomb = move.type !== 'bomb' && move.type !== 'rocket'
    && move.cards.some((card) => (counts.get(card) ?? 0) === BOMB_GUARD);
  const wastesRocket = move.type !== 'rocket'
    && counts.get('SJ') === 1 && counts.get('BJ') === 1
    && move.cards.some((card) => JOKER_RANKS.has(card));
  const isBomb = move.type === 'bomb' || move.type === 'rocket';
  if ((isBomb || wastesBomb || wastesRocket) && context.minOpponentLeft > 4) return null;

  // 单张能不用拆对子就别拆：在手牌里找一张更低、但没成对的单张。
  if (move.type === 'single') {
    const limit = Math.min(target.rank + 5, ACE);
    const loose = cards
      .filter((card) => {
        const rank = indexOf(card);
        return rank > target.rank && rank <= limit && (counts.get(card) ?? 0) === 1;
      })
      .sort((a, b) => indexOf(a) - indexOf(b))[0];
    if (loose && (counts.get(candidate[0]) ?? 0) > 1) return [loose];
  }

  return candidate;
}

/** 轮到自己时的一手牌（先手 / 跟牌都走这里）。 */
export function chooseMove(hand: readonly string[], target: Move | null, context: BotContext): Card[] | null {
  if (!target) return chooseLead(hand);
  return chooseFollow(hand, target, context);
}
