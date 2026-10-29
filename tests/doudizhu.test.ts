import { describe, expect, it } from 'vitest';
import {
  DECK, PHYSICAL_DECK, canBeat, deal, formatCards, handStrength, moveLabel, parseMove, scoreRound,
  sortCards, suggestMove,
} from '../src/room/games/doudizhu.ts';

const seeded = (seed: number): (() => number) => () => {
  seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
  return seed / 4_294_967_296;
};

const move = (cards: string[]) => {
  const parsed = parseMove(cards);
  if (!parsed) throw new Error(`应该认得：${cards.join(' ')}`);
  return parsed;
};

describe('斗地主规则', () => {
  it('一副牌 54 张：13 种点数各四张，大小王各一张', () => {
    expect(DECK).toHaveLength(54);
    expect(new Set(DECK).size).toBe(15);
    for (const rank of ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2']) {
      expect(DECK.filter((card) => card === rank)).toHaveLength(4);
    }
    expect(DECK.filter((card) => card === 'SJ')).toHaveLength(1);
    expect(DECK.filter((card) => card === 'BJ')).toHaveLength(1);
  });

  it('发牌是 17/17/17 + 3 张底牌，一张不多一张不少', () => {
    const dealt = deal(seeded(9));
    expect(dealt.hands.map((hand) => hand.length)).toEqual([17, 17, 17]);
    expect(dealt.bottom).toHaveLength(3);
    const all = [...dealt.hands.flat(), ...dealt.bottom].sort();
    expect(all).toEqual([...DECK].sort());
  });

  it('认得每种牌型', () => {
    expect(move(['3'])).toMatchObject({ type: 'single', rank: 0 });
    expect(move(['3', '3'])).toMatchObject({ type: 'pair', rank: 0 });
    expect(move(['3', '3', '3'])).toMatchObject({ type: 'triple', rank: 0 });
    expect(move(['3', '3', '3', '4'])).toMatchObject({ type: 'triple-single', rank: 0 });
    expect(move(['3', '3', '3', '4', '4'])).toMatchObject({ type: 'triple-pair', rank: 0 });
    expect(move(['3', '4', '5', '6', '7'])).toMatchObject({ type: 'straight', rank: 0, length: 5 });
    expect(move(['3', '3', '4', '4', '5', '5'])).toMatchObject({ type: 'pair-straight', length: 3 });
    expect(move(['3', '3', '3', '4', '4', '4'])).toMatchObject({ type: 'airplane', length: 2 });
    expect(move(['3', '3', '3', '4', '4', '4', '5', '6'])).toMatchObject({ type: 'airplane-single', length: 2 });
    expect(move(['3', '3', '3', '4', '4', '4', '5', '5', '6', '6']))
      .toMatchObject({ type: 'airplane-pair', length: 2 });
    expect(move(['3', '3', '3', '3', '4', '5'])).toMatchObject({ type: 'four-two', rank: 0 });
    expect(move(['3', '3', '3', '3', '4', '4', '5', '5'])).toMatchObject({ type: 'four-two-pair', rank: 0 });
    expect(move(['3', '3', '3', '3'])).toMatchObject({ type: 'bomb', rank: 0 });
    expect(move(['SJ', 'BJ'])).toMatchObject({ type: 'rocket' });
  });

  it('不认得的牌型返回 null', () => {
    expect(parseMove(['3', '4'])).toBeNull();
    expect(parseMove(['3', '3', '4', '4'])).toBeNull();
    expect(parseMove(['3', '3', '3', '3', '4'])).toBeNull();
    expect(parseMove(['3', '3', '3', '5', '5', '5'])).toBeNull();
    expect(parseMove(['3', '4', '5', '6'])).toBeNull();
    expect(parseMove(['10', 'J', 'Q', 'K', 'A', '2'])).toBeNull();
    expect(parseMove(['3', '3', '3', '3', '3'])).toBeNull();
    expect(parseMove(['X'])).toBeNull();
  });

  it('顺子到 A 为止，2 与王不能接', () => {
    expect(parseMove(['10', 'J', 'Q', 'K', 'A'])).toMatchObject({ type: 'straight', rank: 7 });
    expect(parseMove(['J', 'Q', 'K', 'A', '2'])).toBeNull();
    expect(parseMove(['A', '2', '3', '4', '5'])).toBeNull();
    expect(parseMove(['3', '3', '4', '4', '5', '5'])).not.toBeNull();
    expect(parseMove(['2', '2', '3', '3', '4', '4'])).toBeNull();
  });

  it('同型同长度比主牌；炸弹压普通牌；王炸最大', () => {
    expect(canBeat(move(['4', '4']), move(['3', '3']))).toBe(true);
    expect(canBeat(move(['3', '3']), move(['4', '4']))).toBe(false);
    expect(canBeat(move(['4', '5', '6', '7', '8']), move(['3', '4', '5', '6', '7']))).toBe(true);
    expect(canBeat(move(['3', '4', '5', '6', '7', '8']), move(['3', '4', '5', '6', '7']))).toBe(false);
    expect(canBeat(move(['3', '3', '3', '3']), move(['3', '4', '5', '6', '7']))).toBe(true);
    expect(canBeat(move(['4', '4', '4', '4']), move(['3', '3', '3', '3']))).toBe(true);
    expect(canBeat(move(['3', '3', '3', '3']), move(['4', '4', '4', '4']))).toBe(false);
    expect(canBeat(move(['SJ', 'BJ']), move(['3', '3', '3', '3']))).toBe(true);
    expect(canBeat(move(['3', '3', '3', '3']), move(['SJ', 'BJ']))).toBe(false);
    expect(canBeat(move(['4']), move(['3', '3']))).toBe(false);
    expect(canBeat(move(['4']), null)).toBe(true);
  });

  it('最小合法出牌：能压就出最小的，压不过就过，炸弹兜底', () => {
    expect(suggestMove(['3', '4', '5'], move(['4']))).toEqual(['5']);
    expect(suggestMove(['3', '4'], move(['A']))).toBeNull();
    expect(suggestMove(['3', '3', '3', '3', '4'], move(['A']))).toEqual(['3', '3', '3', '3']);
    expect(suggestMove(['3', '4', '5', '6', '7', '8'], move(['3', '4', '5', '6', '7'])))
      .toEqual(['4', '5', '6', '7', '8']);
    expect(suggestMove(['4', '4', '5', '5', '6', '6'], move(['3', '3', '4', '4', '5', '5'])))
      .toEqual(['4', '4', '5', '5', '6', '6']);
    expect(suggestMove(['SJ', 'BJ'], move(['2', '2', '2', '2']))).toEqual(['SJ', 'BJ']);
    expect(suggestMove(['3', '4'], move(['SJ', 'BJ']))).toBeNull();
    expect(suggestMove([], null)).toBeNull();
    expect(suggestMove(['3', '4'], null)).toEqual(['3']);
  });

  it('叫地主强度看大牌与炸弹', () => {
    expect(handStrength(['3', '4', '5'])).toBe(0);
    expect(handStrength(['BJ', '2', 'A'])).toBe(6);
    expect(handStrength(['3', '3', '3', '3'])).toBe(2);
  });

  it('春天、反春与炸弹倍数', () => {
    expect(scoreRound({ landlordWon: true, farmerPlays: 0 })).toMatchObject({ spring: true, multiplier: 2 });
    expect(scoreRound({ landlordWon: true, farmerPlays: 2 })).toMatchObject({ spring: false, multiplier: 1 });
    expect(scoreRound({ landlordWon: false, landlordPlays: 1 })).toMatchObject({ antiSpring: true, multiplier: 2 });
    expect(scoreRound({ landlordWon: false, landlordPlays: 2 })).toMatchObject({ antiSpring: false, multiplier: 1 });
    expect(scoreRound({ landlordWon: true, farmerPlays: 0, bombs: 2 }).multiplier).toBe(8);
  });

  it('牌型与牌面写得出来', () => {
    expect(formatCards(['5', '3', '3'])).toBe('3 3 5');
    expect(moveLabel(move(['3', '4', '5', '6', '7']))).toContain('顺子');
    expect(moveLabel(move(['SJ', 'BJ']))).toBe('王炸');
  });
});

describe('实体牌（花色只给网页画牌面）', () => {
  const seeded = (seed: number): (() => number) => () => {
    seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return seed / 4_294_967_296;
  };

  it('整副 54 张不重样；王没有花色', () => {
    expect(PHYSICAL_DECK).toHaveLength(54);
    expect(new Set(PHYSICAL_DECK.map((card) => card.rank + (card.suit ?? ''))).size).toBe(54);
    expect(PHYSICAL_DECK.filter((card) => card.suit === null).map((card) => card.rank).sort())
      .toEqual(['BJ', 'SJ']);
  });

  it('发完之后三家手牌加底牌正好 54 张，点数与花色逐张对齐', () => {
    const dealt = deal(seeded(21));
    const all = [...dealt.handCards[0], ...dealt.handCards[1], ...dealt.handCards[2], ...dealt.bottomCards];
    expect(all).toHaveLength(54);
    expect(new Set(all.map((card) => card.rank + (card.suit ?? ''))).size).toBe(54);
    for (let index = 0; index < 3; index++) {
      expect(dealt.handCards[index].map((card) => card.rank))
        .toEqual(sortCards(dealt.hands[index]));
    }
    expect(dealt.bottomCards.map((card) => card.rank)).toEqual(dealt.bottom);
  });
});
