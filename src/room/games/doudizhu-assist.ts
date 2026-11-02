/** 决策辅助只接收本人手牌、公开出牌和公开座次信息；不接收任何别家的私牌。 */
import { canBeat, DECK, isCard, moveLabel, parseMove, RANKS, sortCards, type Card, type Move } from './doudizhu.ts';
import type { BotContext } from './doudizhu-bot.ts';
import { createHandPlanner } from './doudizhu-hand-plan.ts';

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

export interface AssistContext extends BotContext {
  /** 都是公开信息；不传其他席位的手牌。 */
  opponentCardsLeft?: readonly number[];
  nextRole?: 'landlord' | 'farmer';
  nextCardsLeft?: number;
}

/** 合并余牌只用来保守判断“可能有更大的牌”，不推断牌具体在谁手里。 */
function responsePossible(move: Move, pool: Record<Card, number>, maxCards: number): boolean {
  if (move.type === 'rocket') return false;
  if (maxCards >= 2 && pool.SJ && pool.BJ) return true;
  if (maxCards >= 4 && RANKS.some((rank, index) => pool[rank] === 4 && (move.type !== 'bomb' || index > move.rank))) return true;
  if (move.type === 'bomb' || maxCards < move.cards.length) return false;
  const per = move.type === 'single' ? 1 : move.type === 'pair' ? 2 : move.type === 'triple' ? 3 : 0;
  if (per) return RANKS.some((rank, index) => index > move.rank && pool[rank] >= per);
  const sequence = move.type === 'straight' ? 1 : move.type === 'pair-straight' ? 2 : move.type === 'airplane' ? 3 : 0;
  if (sequence) {
    for (let start = move.rank + 1; start + move.length - 1 <= RANKS.indexOf('A'); start++) {
      if (RANKS.slice(start, start + move.length).every((rank) => pool[rank] >= sequence)) return true;
    }
    return false;
  }
  // 带牌牌型不作“不可压”的保证，避免把附件主牌判断或隐藏归属猜成事实。
  return true;
}

export function buildAssist(hand: readonly Card[], played: readonly Card[], target: Move | null, context: AssistContext): DoudizhuAssist {
  const counts = countCards(hand);
  const unseen = countCards(subtractCards(DECK, [...played, ...hand]));
  const plays = legalPlays(hand, target);
  const plan = createHandPlanner(hand, target ? legalPlays(hand, null) : plays);
  const beforeGroups = plan(hand);
  const opponentLeft = context.opponentCardsLeft ?? [context.minOpponentLeft];
  const maxOpponentLeft = context.opponentCardsLeft ? Math.max(...opponentLeft) : Math.max(20, context.minOpponentLeft);
  const singleDanger = opponentLeft.includes(1) && (!target || target.type === 'single');
  const pairDanger = opponentLeft.includes(2) && (!target || target.type === 'pair');
  const teammate = context.role === 'farmer' && context.lastPlayBy === 'farmer';
  const nextEnemy = context.nextRole !== undefined && context.nextRole !== context.role;
  const mustCoverTeammate = teammate && nextEnemy && !!target
    && context.nextCardsLeft === target.cards.length && ['single', 'pair'].includes(target.type)
    && responsePossible(target, unseen, context.nextCardsLeft);
  const rated = plays.map((move) => {
    const used = countCards(move.cards);
    const rest = subtractCards(hand, move.cards);
    const groups = plan(rest);
    const splitBomb = RANKS.some((rank) => counts[rank] === 4 && used[rank] > 0 && used[rank] < 4);
    const splitRocket = counts.SJ > 0 && counts.BJ > 0 && used.SJ + used.BJ === 1;
    const splitPair = RANKS.filter((rank) => counts[rank] === 2 && used[rank] === 1).length;
    const bomb = move.type === 'bomb' || move.type === 'rocket';
    const usesBombAsAttachment = !bomb && RANKS.some((rank) => counts[rank] === 4 && used[rank] === 4);
    const finished = move.cards.length === hand.length;
    const urgent = context.minOpponentLeft <= 2;
    const controlled = !responsePossible(move, unseen, maxOpponentLeft);
    let score = -groups * 24 + move.cards.length * 1.5 - move.rank * 0.25
      - splitPair * 5 - (splitBomb ? 70 : 0) - (splitRocket ? 80 : 0)
      - (usesBombAsAttachment ? urgent ? 12 : 30 : 0) - (bomb ? urgent ? 8 : 30 : 0);
    const highCardCost = used.A + used['2'] * 2 + used.SJ * 3 + used.BJ * 4;
    score -= highCardCost * (urgent ? 0.1 : 1.5);
    // 地主需要持续争取主动权；不把“拆手数暂时没减少”机械地当作应该过牌。
    if (target && !teammate) score += context.role === 'landlord' ? 18 : 8;
    // 平时节约控制牌；真正需要封堵时优先选能控住的最小牌，否则尽力顶大。
    if (controlled && !urgent && groups > 1) score -= 12;
    if ((singleDanger && move.type === 'single') || (pairDanger && move.type === 'pair')) {
      score += controlled ? 140 : -180 + move.rank * 5;
    } else if (!target && ((singleDanger && move.cards.length > 1) || (pairDanger && move.type !== 'pair'))) score += 60;
    else if (target && urgent && controlled) score += 100;
    if (teammate && !mustCoverTeammate) score -= 180;
    if (finished) score = 100_000;
    const reasons = [finished ? '可直接出完' : `出后剩 ${rest.length} 张，余牌可组成 ${groups} 手（不含压牌）`];
    if (!finished && singleDanger && move.type === 'single') reasons.push(controlled ? '对手报单，按公开余牌可封住单张' : '对手报单，这手仍可能被压');
    else if (!finished && pairDanger && move.type === 'pair') reasons.push(controlled ? '对手报双，按公开余牌可封住对子' : '对手报双，这手仍可能被压');
    else if (!target && singleDanger && move.cards.length > 1) reasons.push('对手报单，领出多张避免其直接接走');
    if (mustCoverTeammate) reasons.push('下家对手可能接走队友这手，需要考虑接管');
    if (bomb) reasons.push('使用炸弹会使倍数翻倍');
    if (usesBombAsAttachment) reasons.push('四张同点牌用作带牌，失去独立炸弹');
    if (splitBomb) reasons.push('需要拆开四张同点牌');
    if (splitRocket) reasons.push('需要拆开王炸');
    if (splitPair) reasons.push('需要拆对子');
    if (RANKS.some((rank) => counts[rank] === 4 && used[rank] === 0)) reasons.push('保留炸弹');
    const family = `${move.type}:${['single', 'pair'].includes(move.type) ? `${move.rank >= RANKS.indexOf('A') ? 'high' : 'low'}:${controlled}` : ''}`;
    return { score, family, suggestion: { action: { move: 'play' as const, cards: sortCards(move.cards) }, label: moveLabel(move), reason: reasons.join('；'), remaining: rest.length } };
  }).sort((a, b) => b.score - a.score || a.suggestion.action.cards.join(',').localeCompare(b.suggestion.action.cards.join(',')));
  const selected: typeof rated = [];
  for (const entry of rated) {
    if (selected.some((other) => other.family === entry.family)) continue;
    selected.push(entry);
    if (selected.length === (target ? 2 : 3)) break;
  }
  const suggestions: DoudizhuSuggestion[] = selected.map((entry) => entry.suggestion);
  if (target) {
    const pass: DoudizhuSuggestion = {
      action: { move: 'pass' }, label: '不要', remaining: hand.length,
      reason: !plays.length ? '没有合法压牌，只能过牌' : mustCoverTeammate ? '可过，但下家对手可能接走队友的牌；并非无法压牌'
        : teammate ? '队友当前领牌，可选择让牌；并非无法压牌' : '允许过牌，保留手牌组合；并非无法压牌',
    };
    const passScore = -beforeGroups * 24 + 8 + (teammate && !mustCoverTeammate ? 100 : 0)
      - (mustCoverTeammate || (!teammate && (singleDanger || pairDanger)) ? 300 : 0);
    const passFirst = !plays.length || passScore >= rated[0].score;
    if (passFirst) suggestions.unshift(pass); else suggestions.push(pass);
  }
  return { played: countCards(played), otherRemaining: unseen, suggestions, canBeat: plays.length > 0 };
}
