/**
 * 斗地主规则：纯函数，不碰网络、不碰模型。
 * 花色不参与规则，所以牌只存点数：3..10、J、Q、K、A、2、SJ（小王）、BJ（大王）。
 * 出牌、压牌、计分全部在这里判；World 只把玩家选的牌送进来，把结果原样回执。
 */

export const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', 'SJ', 'BJ'] as const;
export type Card = (typeof RANKS)[number];

const RANK_INDEX: ReadonlyMap<Card, number> = new Map(RANKS.map((rank, index) => [rank, index]));
const ACE = RANK_INDEX.get('A')!;
const TWO = RANK_INDEX.get('2')!;

export const DECK: readonly Card[] = RANKS.flatMap((rank) => (
  rank === 'SJ' || rank === 'BJ' ? [rank] : [rank, rank, rank, rank]
));

export const isCard = (value: unknown): value is Card => typeof value === 'string' && RANK_INDEX.has(value as Card);

const indexOf = (card: Card): number => RANK_INDEX.get(card)!;
const rankName = (rank: number): string => RANKS[rank] ?? '?';

export const sortCards = (cards: readonly Card[]): Card[] => [...cards].sort((a, b) => indexOf(a) - indexOf(b));

/**
 * 花色只决定网页上画哪张牌面；规则、牌型、计分一律只看点数。
 * 但一张桌上的四张 7 必须是四种不同的花，所以发牌时就把整副实体牌洗好，
 * 之后出牌按点数从手里抽走，花色跟着一起走。
 */
export const SUITS = ['S', 'H', 'C', 'D'] as const;
export type Suit = (typeof SUITS)[number];

export interface PhysCard {
  rank: Card;
  /** 大小王没有花色。 */
  suit: Suit | null;
}

export const PHYSICAL_DECK: readonly PhysCard[] = RANKS.flatMap((rank): PhysCard[] => (
  rank === 'SJ' || rank === 'BJ'
    ? [{ rank, suit: null }]
    : SUITS.map((suit) => ({ rank, suit }))
));

const shuffle = <T>(items: T[], rng: () => number): T[] => {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
};

/** 按点数排；同点数保持原顺序，与 sortCards(点数列表) 逐张对齐。 */
export const sortPhys = (cards: readonly PhysCard[]): PhysCard[] => cards
  .map((card, index) => ({ card, index }))
  .sort((a, b) => indexOf(a.card.rank) - indexOf(b.card.rank) || a.index - b.index)
  .map((entry) => entry.card);


export const formatCards = (cards: readonly Card[]): string => sortCards(cards).join(' ');

export type MoveType =
  | 'single' | 'pair' | 'triple' | 'triple-single' | 'triple-pair'
  | 'straight' | 'pair-straight' | 'airplane' | 'airplane-single' | 'airplane-pair'
  | 'four-two' | 'four-two-pair' | 'bomb' | 'rocket';

export interface Move {
  type: MoveType;
  /** 主牌点数；顺子/连对/飞机是起头那张。 */
  rank: number;
  /** 顺子、连对、飞机的组数；其余是 0。 */
  length: number;
  cards: Card[];
}

interface Group {
  card: Card;
  rank: number;
  count: number;
}

const groupsOf = (cards: readonly Card[]): Group[] => {
  const counts = new Map<Card, number>();
  for (const card of cards) counts.set(card, (counts.get(card) ?? 0) + 1);
  return [...counts.entries()]
    .map(([card, count]) => ({ card, rank: indexOf(card), count }))
    .sort((a, b) => a.rank - b.rank);
};

const isConsecutive = (groups: readonly Group[]): boolean => (
  groups.every((group, index) => index === 0 || group.rank === groups[index - 1].rank + 1)
);

const normalize = (cards: readonly string[]): Card[] => {
  if (cards.length === 0) return [];
  if (!cards.every(isCard)) throw new Error(`不认识的牌：${cards.filter((card) => !isCard(card)).join('、')}`);
  return sortCards(cards as Card[]);
};

/** 所有长度 length、每张至少 3、连续且不超过 A 的三张窗口。 */
const tripleWindows = (groups: readonly Group[], length: number): Group[][] => {
  const eligible = groups.filter((group) => group.count >= 3 && group.rank <= ACE);
  const windows: Group[][] = [];
  for (let start = 0; start + length <= eligible.length; start++) {
    const window = eligible.slice(start, start + length);
    if (isConsecutive(window)) windows.push(window);
  }
  return windows;
};

/** 拿掉窗口里的每张 3 张，剩下的就是翅膀（四张的会剩 1 张）。 */
const wingsOf = (groups: readonly Group[], window: readonly Group[]): Group[] => {
  const used = new Map(window.map((group) => [group.card, 3]));
  return groups
    .map((group) => ({ ...group, count: group.count - (used.get(group.card) ?? 0) }))
    .filter((group) => group.count > 0);
};

const move = (type: MoveType, groups: readonly Group[], length = 0): Move => {
  const cards = groups.flatMap((group) => Array.from({ length: group.count }, () => group.card));
  return { type, rank: groups[0].rank, length, cards: sortCards(cards) };
};

/** 认得就返回牌型，不认得返回 null。 */
export function parseMove(input: readonly string[]): Move | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  if (!input.every(isCard)) return null;
  const cards = sortCards(input as Card[]);
  const groups = groupsOf(cards);
  const size = cards.length;

  if (size === 2 && groups.length === 2 && groups[0].card === 'SJ' && groups[1].card === 'BJ') {
    return move('rocket', groups);
  }
  if (size === 4 && groups.length === 1) return move('bomb', groups);
  if (size === 1) return move('single', groups);
  if (size === 2 && groups.length === 1) return move('pair', groups);
  if (size === 3 && groups.length === 1) return move('triple', groups);
  if (size === 4) {
    const triple = groups.find((group) => group.count === 3);
    if (triple) return move('triple-single', groups);
  }
  if (size === 5) {
    const triple = groups.find((group) => group.count === 3);
    const pair = groups.find((group) => group.count === 2);
    if (triple && pair && groups.length === 2) return move('triple-pair', groups);
  }
  if (size === 6) {
    const four = groups.find((group) => group.count === 4);
    if (four) return move('four-two', groups);
  }
  if (size === 8) {
    const four = groups.find((group) => group.count === 4);
    const pairs = groups.filter((group) => group.count === 2);
    if (four && pairs.length === 2) return move('four-two-pair', groups);
  }

  const top = groups[groups.length - 1].rank;
  if (size >= 5 && groups.every((group) => group.count === 1) && top <= ACE && isConsecutive(groups)) {
    return move('straight', groups, size);
  }
  if (size >= 6 && size % 2 === 0 && groups.every((group) => group.count === 2) && top <= ACE && isConsecutive(groups)) {
    return move('pair-straight', groups, size / 2);
  }
  if (size >= 6 && size % 3 === 0 && groups.every((group) => group.count === 3) && top <= ACE && isConsecutive(groups)) {
    return move('airplane', groups, size / 3);
  }
  if (size >= 8 && size % 4 === 0) {
    const need = size / 4;
    for (const window of tripleWindows(groups, need)) {
      const wings = wingsOf(groups, window);
      const wingCount = wings.reduce((sum, group) => sum + group.count, 0);
      if (wingCount === need && wings.every((group) => group.count <= 2)) {
        return move('airplane-single', groups, need);
      }
    }
  }
  if (size >= 10 && size % 5 === 0) {
    const need = size / 5;
    for (const window of tripleWindows(groups, need)) {
      const wings = wingsOf(groups, window);
      if (wings.length === need && wings.every((group) => group.count === 2)) {
        return move('airplane-pair', groups, need);
      }
    }
  }
  return null;
}

/** 同型同长度比主牌；炸弹压非炸弹，王炸最大。 */
export function canBeat(candidate: Move, target: Move | null): boolean {
  if (!target) return true;
  if (candidate.type === 'rocket') return target.type !== 'rocket';
  if (target.type === 'rocket') return false;
  if (candidate.type === 'bomb') {
    return target.type === 'bomb' ? candidate.rank > target.rank : true;
  }
  if (target.type === 'bomb') return false;
  if (candidate.type !== target.type) return false;
  if (candidate.cards.length !== target.cards.length) return false;
  return candidate.rank > target.rank;
}

export function moveLabel(entry: Move): string {
  const rank = rankName(entry.rank);
  switch (entry.type) {
    case 'single': return `单张 ${rank}`;
    case 'pair': return `对子 ${rank}`;
    case 'triple': return `三张 ${rank}`;
    case 'triple-single': return `三带一 ${rank}`;
    case 'triple-pair': return `三带二 ${rank}`;
    case 'straight': return `顺子 ${rank}–${rankName(entry.rank + entry.length - 1)}`;
    case 'pair-straight': return `连对 ${rank}–${rankName(entry.rank + entry.length - 1)}`;
    case 'airplane': return `飞机 ${rank}–${rankName(entry.rank + entry.length - 1)}`;
    case 'airplane-single': return `飞机带单 ${rank}–${rankName(entry.rank + entry.length - 1)}`;
    case 'airplane-pair': return `飞机带对 ${rank}–${rankName(entry.rank + entry.length - 1)}`;
    case 'four-two': return `四带二 ${rank}`;
    case 'four-two-pair': return `四带两对 ${rank}`;
    case 'bomb': return `炸弹 ${rank}`;
    case 'rocket': return '王炸';
    default: return entry.type;
  }
}

/** 手里有多少“大牌”；叫地主的脚本判据。 */
export function handStrength(hand: readonly Card[]): number {
  let score = 0;
  for (const group of groupsOf(normalize(hand))) {
    if (group.card === 'BJ') score += 3;
    else if (group.card === 'SJ') score += 2;
    else if (group.rank === TWO) score += 2;
    else if (group.rank === ACE) score += 1;
    if (group.count === 4) score += 2;
  }
  return score;
}

export interface RoundScore {
  landlordWon: boolean;
  spring: boolean;
  antiSpring: boolean;
  multiplier: number;
}

/** 春天：地主赢且两个农民一张牌都没出过；反春：农民赢且地主只出过一手。 */
export function scoreRound(input: {
  landlordWon: boolean;
  bombs?: number;
  farmerPlays?: number;
  landlordPlays?: number;
}): RoundScore {
  const spring = input.landlordWon && (input.farmerPlays ?? 0) === 0;
  const antiSpring = !input.landlordWon && (input.landlordPlays ?? 0) <= 1;
  const multiplier = 2 ** (input.bombs ?? 0) * (spring || antiSpring ? 2 : 1);
  return { landlordWon: input.landlordWon, spring, antiSpring, multiplier };
}

export function deal(rng: () => number = Math.random): {
  hands: [Card[], Card[], Card[]];
  bottom: Card[];
  /** 与 hands 逐张对齐的花色（只给网页看；规则一律只看 points）。 */
  handCards: [PhysCard[], PhysCard[], PhysCard[]];
  bottomCards: PhysCard[];
} {
  const deck = shuffle([...PHYSICAL_DECK], rng);
  const handsPhys: [PhysCard[], PhysCard[], PhysCard[]] = [
    deck.slice(0, 17), deck.slice(17, 34), deck.slice(34, 51),
  ];
  const bottomPhys = deck.slice(51);
  const ranks = (cards: readonly PhysCard[]): Card[] => cards.map((card) => card.rank);
  return {
    hands: [ranks(handsPhys[0]), ranks(handsPhys[1]), ranks(handsPhys[2])],
    bottom: ranks(bottomPhys),
    handCards: [sortPhys(handsPhys[0]), sortPhys(handsPhys[1]), sortPhys(handsPhys[2])],
    // 底牌保持发牌顺序，跟 bottom 逐张对齐（那三张本来也不排序）。
    bottomCards: bottomPhys,
  };
}

/**
 * 找一个能压过 target 的最小出法；没有就 null（该 pass）。
 * 只保证合法，不追求最优：这是超时代打与脚本陪练用的。
 */
export function suggestMove(hand: readonly string[], target: Move | null): Card[] | null {
  const cards = normalize(hand);
  if (cards.length === 0) return null;
  if (!target) return [cards[0]];
  if (target.type === 'rocket') return null;
  const groups = groupsOf(cards);
  const take = (card: Card, count: number): Card[] => cards.filter((entry) => entry === card).slice(0, count);
  const accept = (picked: Card[]): Card[] | null => {
    const parsed = parseMove(picked);
    return parsed && canBeat(parsed, target) ? sortCards(picked) : null;
  };
  const lowest = (predicate: (group: Group) => boolean): Group | undefined => groups
    .filter((group) => group.rank > target.rank)
    .find(predicate);
  const higher = (count: number): Group | undefined => lowest((group) => group.count >= count);
  const others = (excluded: ReadonlySet<Card>): Group[] => groups.filter((group) => !excluded.has(group.card));

  switch (target.type) {
    case 'single': {
      const group = higher(1);
      if (group) return [group.card];
      break;
    }
    case 'pair': {
      const group = higher(2);
      if (group) return take(group.card, 2);
      break;
    }
    case 'triple': {
      const group = higher(3);
      if (group) return take(group.card, 3);
      break;
    }
    case 'triple-single':
    case 'triple-pair': {
      const group = higher(3);
      if (!group) break;
      const wantPair = target.type === 'triple-pair';
      const wing = others(new Set([group.card])).find((entry) => (wantPair ? entry.count >= 2 : true));
      if (!wing) break;
      const picked = [...take(group.card, 3), ...take(wing.card, wantPair ? 2 : 1)];
      return accept(picked);
    }
    case 'straight':
    case 'pair-straight':
    case 'airplane': {
      const per = target.type === 'straight' ? 1 : target.type === 'pair-straight' ? 2 : 3;
      for (let start = target.rank + 1; start + target.length - 1 <= ACE; start++) {
        const picked: Card[] = [];
        for (let rank = start; rank < start + target.length; rank++) {
          const group = groups.find((entry) => entry.rank === rank);
          if (!group || group.count < per) break;
          picked.push(...take(group.card, per));
        }
        if (picked.length === per * target.length) return accept(picked);
      }
      break;
    }
    case 'airplane-single':
    case 'airplane-pair': {
      const wingPairs = target.type === 'airplane-pair';
      const need = target.length;
      for (let start = target.rank + 1; start + need - 1 <= ACE; start++) {
        const window: Group[] = [];
        for (let rank = start; rank < start + need; rank++) {
          const group = groups.find((entry) => entry.rank === rank);
          if (!group || group.count < 3) break;
          window.push(group);
        }
        if (window.length !== need) continue;
        const picked = window.flatMap((group) => take(group.card, 3));
        const used = new Set(window.map((group) => group.card));
        if (wingPairs) {
          const pairs = others(used).filter((group) => group.count >= 2).slice(0, need);
          if (pairs.length !== need) continue;
          for (const pair of pairs) picked.push(...take(pair.card, 2));
        } else {
          const wingCards = others(used).flatMap((group) => take(group.card, group.count));
          if (wingCards.length < need) continue;
          picked.push(...sortCards(wingCards).slice(0, need));
        }
        const valid = accept(picked);
        if (valid) return valid;
      }
      break;
    }
    case 'four-two':
    case 'four-two-pair': {
      const group = higher(4);
      if (!group) break;
      const pool = others(new Set([group.card]));
      const picked = take(group.card, 4);
      if (target.type === 'four-two') {
        const wings = pool.flatMap((entry) => take(entry.card, entry.count));
        if (wings.length < 2) break;
        picked.push(...sortCards(wings).slice(0, 2));
      } else {
        const pairs = pool.filter((entry) => entry.count >= 2).slice(0, 2);
        if (pairs.length !== 2) break;
        for (const pair of pairs) picked.push(...take(pair.card, 2));
      }
      return accept(picked);
    }
    case 'bomb': {
      const group = higher(4);
      if (group) return take(group.card, 4);
      break;
    }
    default:
      break;
  }

  const bomb = groups.find((group) => group.count === 4);
  if (bomb) return take(bomb.card, 4);
  if ((groups.find((group) => group.card === 'SJ')?.count ?? 0) > 0
    && (groups.find((group) => group.card === 'BJ')?.count ?? 0) > 0) {
    return ['SJ', 'BJ'];
  }
  return null;
}
