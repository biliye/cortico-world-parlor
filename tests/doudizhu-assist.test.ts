import { describe, expect, it } from 'vitest';
import { buildAssist, countCards, legalPlays, subtractCards, type DoudizhuAssist } from '../src/room/games/doudizhu-assist.ts';
import { DoudizhuTable } from '../src/room/games/doudizhu-table.ts';
import { RoomKernel } from '../src/room/kernel.ts';
import { canBeat, DECK, parseMove, sortCards, type Card, type Move } from '../src/room/games/doudizhu.ts';

const landlord = { role: 'landlord', minOpponentLeft: 10 } as const;
const target = (cards: Card[]): Move => parseMove(cards)!;
const start = (): DoudizhuTable => {
  let seed = 19;
  const table = new DoudizhuTable({ host: { id: 'a', name: '甲' }, now: 0, rng: () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  } });
  table.join({ id: 'b', name: '乙' }); table.join({ id: 'c', name: '丙' });
  table.start('a', 0); table.act('a', { move: 'bid', call: true }, 0);
  return table;
};
interface View { hand: Card[]; yourTurn: boolean; assist?: DoudizhuAssist; lastPlay: { cards: Card[] } | null }
const view = (table: DoudizhuTable, id: string): View => table.view(id) as View;

describe('斗地主规则建议', () => {
  it('候选覆盖复杂牌型，结果均在手里且能压过目标', () => {
    const hands: Card[][] = [
      ['3','3','3','4','4','4','5','5','6','6'],
      ['3','3','3','3','4','4','5','5','SJ','BJ'],
      ['3','4','5','6','7','8','9','10','J','Q','K','A','2'],
    ];
    const types = new Set(hands.flatMap((hand) => legalPlays(hand, null).map((move) => move.type)));
    for (const type of ['airplane-single', 'airplane-pair', 'four-two', 'four-two-pair', 'rocket', 'pair-straight', 'straight']) expect(types.has(type as Move['type'])).toBe(true);
    for (const hand of hands) for (const last of [null, target(['3']), target(['3','3']), target(['3','3','3','4'])]) {
      for (const move of legalPlays(hand, last)) {
        expect(() => subtractCards(hand, move.cards)).not.toThrow();
        expect(canBeat(move, last)).toBe(true);
      }
    }
  });

  it('用独立子集穷举核对候选，不漏可压牌（含拆炸弹、飞机附件）', () => {
    const hands: Card[][] = [
      ['3','3','3','3','4','4','4','4','5','5'],
      ['3','3','3','4','4','4','5','6','SJ','BJ'],
      ['3','3','4','4','5','5','6','7','8','9'],
    ];
    for (const hand of hands) {
      const oracle = new Map<string, Move>();
      for (let bits = 1; bits < 2 ** hand.length; bits++) {
        const move = parseMove(hand.filter((_, index) => bits & (1 << index)));
        if (move) oracle.set(move.cards.join(','), move);
      }
      for (const last of [null, target(['3']), target(['3','3']), target(['3','3','3','5']), target(['3','3','3','3'])]) {
        expect(legalPlays(hand, last).map((move) => move.cards.join(',')).sort())
          .toEqual([...oracle].filter(([, move]) => canBeat(move, last)).map(([key]) => key).sort());
      }
    }
  });

  it('最多三项，先手不能过；能直接出完时优先走完', () => {
    const hand: Card[] = ['3','4','5','6','7'];
    const assist = buildAssist(hand, [], null, landlord);
    expect(assist.suggestions).toHaveLength(3);
    expect(assist.suggestions[0].action).toEqual({ move: 'play', cards: hand });
    expect(assist.suggestions[0].reason).toContain('可直接出完');
    expect(assist.suggestions.every((entry) => entry.action.move === 'play')).toBe(true);
  });

  it('队友领牌建议过，但明确不是不能压；自己能走完时仍先走完', () => {
    const context = { role: 'farmer', lastPlayBy: 'farmer', minOpponentLeft: 10 } as const;
    const assist = buildAssist(['5','9'], [], target(['4']), context);
    expect(assist.canBeat).toBe(true);
    expect(assist.suggestions[0].action.move).toBe('pass');
    expect(assist.suggestions[0].reason).toContain('并非无法压牌');
    expect(buildAssist(['5'], [], target(['4']), context).suggestions[0].action.move).toBe('play');
  });

  it('没有合法压牌才说只能过牌；王炸不可被压', () => {
    const assist = buildAssist(['3','3','3','3'], [], target(['SJ','BJ']), landlord);
    expect(assist.canBeat).toBe(false);
    expect(assist.suggestions).toEqual([{ action: { move: 'pass' }, label: '不要', remaining: 4, reason: '没有合法压牌，只能过牌' }]);
  });

  it('多重集合计数不重复扣底牌，损坏的牌数报错', () => {
    const assist = buildAssist(['SJ','2'], ['BJ','2'], null, landlord);
    expect(assist.otherRemaining.SJ).toBe(0);
    expect(assist.otherRemaining.BJ).toBe(0);
    expect(assist.otherRemaining['2']).toBe(2);
    expect(Object.values(assist.otherRemaining).reduce((sum, n) => sum + n, 0)).toBe(50);
    expect(() => subtractCards(DECK, ['SJ','SJ'])).toThrow('记牌与牌堆不一致');
  });
});

describe('斗地主通知与旧存档记牌', () => {
  it('真正的轮次事件和主动查看都直接包含建议及工具参数', () => {
    const room = new RoomKernel({ id: 'lobby', inviteCode: 'test', now: () => 0 });
    const joined = room.join({ name: '甲' });
    const seat = room.seatById(joined.seat.id)!;
    room.openTable(seat, 'ddz'); room.startTable(seat);
    room.ddzAction(seat, { move: 'bid', call: true });
    const events = room.history(seat.id, 0, 100).filter((event) => event.type === 'parlor.table.turn');
    expect(events.at(-1)!.text).toContain('本局累计已出');
    expect(events.at(-1)!.text).toContain('parlor_ddz_action {"move":"play"');
    expect(room.snapshot(seat.id, 0, 100).tablePrivate!.text).toContain('合法建议');
  });

  it('新局底牌已归地主，其他两家总计34张；辅助只进当前席位私视图', () => {
    const table = start();
    const assist = view(table, 'a').assist!;
    expect(Object.values(assist.played).reduce((sum, n) => sum + n, 0)).toBe(0);
    expect(Object.values(assist.otherRemaining).reduce((sum, n) => sum + n, 0)).toBe(34);
    expect(view(table, 'b').assist).toBeUndefined();
    expect(JSON.stringify(table.public())).not.toContain('otherRemaining');
    const text = table.privateText('a', 0)!;
    expect(text).toContain('本局累计已出：无');
    expect(text).toContain('其他两家合计未出');
    expect(text).toContain('parlor_ddz_action {"move":"play"');
    expect(text).toContain('下家 乙');
    expect(table.privateText('b', 0)).not.toContain('合法建议');
  });

  it('过牌与重新领出不清整局记牌；旧格式存档恢复逐项相同', () => {
    const table = start();
    const played = view(table, 'a').hand[0];
    table.act('a', { move: 'play', cards: [played] }, 0);
    table.act('b', { move: 'pass' }, 0); table.act('c', { move: 'pass' }, 0);
    expect(view(table, 'a').lastPlay).toBeNull();
    expect(view(table, 'a').assist!.played).toEqual(countCards([played]));
    const state = table.exportState();
    const restored = new DoudizhuTable({ host: { id: 'a', name: '甲' }, now: 0 });
    restored.restoreState(state);
    expect(restored.exportState()).toEqual(state);
    expect(view(restored, 'a').assist).toEqual(view(table, 'a').assist);
    expect(restored.privateText('a', 0)).toEqual(table.privateText('a', 0));
  });

  it('换掉别家隐藏手牌的分配，公开信息相同则本人建议完全相同', () => {
    const table = start();
    const state = table.exportState() as { seats: { hand: Card[]; cards: unknown[] }[] };
    [state.seats[1].hand, state.seats[2].hand] = [state.seats[2].hand, state.seats[1].hand];
    [state.seats[1].cards, state.seats[2].cards] = [state.seats[2].cards, state.seats[1].cards];
    const other = new DoudizhuTable({ host: { id: 'a', name: '甲' }, now: 0 });
    other.restoreState(state);
    expect(view(other, 'a')).toEqual(view(table, 'a'));
    expect(other.privateText('a', 0)).toEqual(table.privateText('a', 0));
  });

  it('三家按建议完整对局，累计公开出牌和程序计数始终相同，54张守恒', () => {
    const table = start();
    const played: Card[] = [];
    let turns = 0;
    while (table.status === 'playing' && turns++ < 500) {
      const id = ['a','b','c'].find((seat) => view(table, seat).yourTurn)!;
      const current = view(table, id);
      expect(current.assist!.played).toEqual(countCards(played));
      expect(current.assist!.otherRemaining).toEqual(countCards(subtractCards(DECK, [...played, ...current.hand])));
      const action = current.assist!.suggestions[0].action;
      if (action.move === 'play') played.push(...action.cards);
      table.act(id, action, 0);
      const remaining = ['a','b','c'].flatMap((seat) => view(table, seat).hand);
      expect(sortCards([...remaining, ...played])).toEqual(sortCards(DECK));
    }
    expect(table.status).toBe('ended');
  });
});
