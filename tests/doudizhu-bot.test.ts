import { describe, expect, it } from 'vitest';
import { chooseBid, chooseFollow, chooseLead, chooseMove } from '../src/room/games/doudizhu-bot.ts';
import { parseMove, sortCards, type Card } from '../src/room/games/doudizhu.ts';

const target = (cards: string[]) => {
  const parsed = parseMove(cards);
  if (!parsed) throw new Error(`应该认得：${cards.join(' ')}`);
  return parsed;
};

const asSorted = (cards: readonly string[]) => sortCards(cards as Card[]);

describe('斗地主脚本出牌', () => {
  it('领出优先顺子，而不是最小单张', () => {
    const hand = ['3', '4', '5', '6', '7', '9', '9', 'K'];
    expect(asSorted(chooseLead(hand))).toEqual(asSorted(['3', '4', '5', '6', '7']));
  });

  it('领出优先连对与飞机', () => {
    expect(asSorted(chooseLead(['3', '3', '4', '4', '5', '5', '9', 'K'])))
      .toEqual(asSorted(['3', '3', '4', '4', '5', '5']));
    expect(asSorted(chooseLead(['8', '8', '8', '9', '9', '9', 'K'])))
      .toEqual(asSorted(['8', '8', '8', '9', '9', '9']));
  });

  it('领出三带一比对子、单张更能走牌', () => {
    expect(asSorted(chooseLead(['8', '8', '8', '9', 'K', '2'])))
      .toEqual(asSorted(['8', '8', '8', '9']));
  });

  it('不拆炸弹与王炸', () => {
    expect(chooseLead(['3', '3', '3', '3', '4'])).toEqual(['4']);
    expect(chooseLead(['SJ', 'BJ', '3'])).toEqual(['3']);
    expect(asSorted(chooseLead(['SJ', 'BJ']))).toEqual(['SJ', 'BJ']);
  });

  it('农民不顶队友的牌，但能一把走完就走', () => {
    const context = { role: 'farmer', lastPlayBy: 'farmer', minOpponentLeft: 10 } as const;
    expect(chooseFollow(['5', '9'], target(['4']), context)).toBeNull();
    expect(chooseFollow(['5'], target(['4']), context)).toEqual(['5']);
  });

  it('对地主照常压牌，尽量不拆对子', () => {
    const context = { role: 'farmer', lastPlayBy: 'landlord', minOpponentLeft: 10 } as const;
    expect(chooseFollow(['5', '9'], target(['4']), context)).toEqual(['5']);
    expect(chooseFollow(['4', '4', '5', '6'], target(['3']), context)).toEqual(['5']);
    expect(chooseFollow(['4', '4', '2'], target(['3']), context)).toEqual(['4']);
  });

  it('炸弹留给对手快走完的时候', () => {
    const hand = ['3', '3', '3', '3', '4'];
    expect(chooseFollow(hand, target(['A']), { role: 'farmer', lastPlayBy: 'landlord', minOpponentLeft: 10 }))
      .toBeNull();
    expect(asSorted(chooseFollow(hand, target(['A']), { role: 'farmer', lastPlayBy: 'landlord', minOpponentLeft: 2 })!))
      .toEqual(asSorted(['3', '3', '3', '3']));
  });

  it('跟顺子时能找到同长的顺子', () => {
    expect(asSorted(chooseFollow(['4', '5', '6', '7', '8', 'K'], target(['3', '4', '5', '6', '7']), {
      role: 'landlord', lastPlayBy: 'farmer', minOpponentLeft: 10,
    })!)).toEqual(asSorted(['4', '5', '6', '7', '8']));
  });

  it('叫地主沿用大牌强度', () => {
    expect(chooseBid(['3', '4', '5'])).toBe(false);
    expect(chooseBid(['BJ', '2', 'A'])).toBe(true);
  });

  it('chooseMove 先手走领出，跟牌走跟牌', () => {
    const context = { role: 'landlord', lastPlayBy: 'farmer', minOpponentLeft: 10 } as const;
    expect(asSorted(chooseMove(['3', '4', '5', '6', '7', 'K'], null, context)!))
      .toEqual(asSorted(['3', '4', '5', '6', '7']));
    expect(chooseMove(['5', 'K'], target(['4']), context)).toEqual(['5']);
  });
});
