import { describe, expect, it } from 'vitest';
import { buildAssist, countCards, legalPlays, subtractCards, type DoudizhuAssist } from '../src/room/games/doudizhu-assist.ts';
import { DoudizhuTable } from '../src/room/games/doudizhu-table.ts';
import { createHandPlanner } from '../src/room/games/doudizhu-hand-plan.ts';
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
    expect(assist.suggestions.length).toBeGreaterThan(0);
    expect(assist.suggestions.length).toBeLessThanOrEqual(3);
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

describe('斗地主建议的策略回归', () => {
  const farmer = { role: 'farmer', lastPlayBy: 'landlord', minOpponentLeft: 1, opponentCardsLeft: [1] } as const;
  it('对手报单时封大牌；公开记牌证明 A 已够大时，保留 2', () => {
    const hand: Card[] = ['4','A','2'];
    const unknown = buildAssist(hand, [], target(['3']), farmer);
    expect(unknown.suggestions[0].action).toEqual({ move: 'play', cards: ['2'] });
    const known = buildAssist(hand, ['SJ','BJ','2','2','2','A','A','A'], target(['3']), farmer);
    expect(known.suggestions[0].action).toEqual({ move: 'play', cards: ['A'] });
    expect(known.suggestions[0].reason).toContain('公开余牌');
    expect(known.suggestions[0].reason).toContain('封住单张');
  });

  it('报双优先封对子，非残局仍先用小对子', () => {
    const hand: Card[] = ['5','5','A','A','2','2'];
    expect(buildAssist(hand, [], target(['4','4']), { ...farmer, minOpponentLeft: 2, opponentCardsLeft: [2] }).suggestions[0].action)
      .toEqual({ move: 'play', cards: ['2','2'] });
    expect(buildAssist(hand, [], target(['4','4']), { ...farmer, minOpponentLeft: 10, opponentCardsLeft: [10] }).suggestions[0].action)
      .toEqual({ move: 'play', cards: ['5','5'] });
  });

  it('下家地主报单时不能机械让队友小牌；队友已控住时仍让牌', () => {
    const context = { ...farmer, lastPlayBy: 'farmer', nextRole: 'landlord', nextCardsLeft: 1 } as const;
    const danger = buildAssist(['4','A','2'], [], target(['3']), context);
    expect(danger.suggestions[0].action).toEqual({ move: 'play', cards: ['2'] });
    expect(danger.suggestions[0].reason).toContain('需要考虑接管');
    const safe = buildAssist(['3','4','BJ'], ['SJ'], target(['2']), context);
    expect(safe.canBeat).toBe(true);
    expect(safe.suggestions[0].action.move).toBe('pass');
  });

  it('同样报单，地主还没轮到就不无条件抢队友的牌', () => {
    const context = { ...farmer, lastPlayBy: 'farmer', nextRole: 'farmer', nextCardsLeft: 10 } as const;
    expect(buildAssist(['4','A','2'], [], target(['3']), context).suggestions[0].action.move).toBe('pass');
  });

  it('平时保留炸弹；四带二理由明确失去独立炸弹，候选不重复换附件', () => {
    const assist = buildAssist(['3','3','3','3','4','5','6'], [], null, landlord);
    expect(assist.suggestions[0].action).toEqual({ move: 'play', cards: ['4'] });
    expect(assist.suggestions[0].reason).toContain('保留炸弹');
    const four = assist.suggestions.filter((entry) => entry.label.startsWith('四带二'));
    expect(four).toHaveLength(1);
    expect(four[0].reason).toContain('失去独立炸弹');
    expect(four[0].reason).not.toContain('保留炸弹');
    expect(four[0].reason).not.toContain('翻倍');
  });

  it('不能为了保炸弹而放走报单；非残局可以选择保留组合', () => {
    const hand: Card[] = ['3','3','3','3','4'];
    expect(buildAssist(hand, [], target(['A']), { ...farmer, minOpponentLeft: 10, opponentCardsLeft: [10] }).suggestions[0].action.move).toBe('pass');
    expect(buildAssist(hand, [], target(['A']), farmer).suggestions[0].action).toEqual({ move: 'play', cards: ['3','3','3','3'] });
  });

  it('领出时避开报单对手能直接接走的单牌', () => {
    const assist = buildAssist(['3','3','4','A'], [], null, { ...farmer, nextRole: 'landlord', nextCardsLeft: 1 });
    expect(assist.suggestions[0].action).toEqual({ move: 'play', cards: ['3','3'] });
    expect(assist.suggestions[0].reason).toContain('避免其直接接走');
  });

  it('地主能用小牌争主动权时，不因拆手数暂未减少就机械过牌', () => {
    const assist = buildAssist(['4','4','9','9'], [], target(['3']), landlord);
    expect(assist.suggestions[0].action).toEqual({ move: 'play', cards: ['4'] });
  });

  it('按余牌组合比较出法，不为这次多出几张毁掉后续组合', () => {
    const hand: Card[] = ['Q','8','A','10','8','4','A','Q','8','K','Q','Q'];
    const assist = buildAssist(hand, [], null, landlord);
    expect(assist.suggestions[0].action).toEqual({ move: 'play', cards: ['4','8','8','8'] });
    expect(assist.suggestions[0].reason).toContain('余牌可组成 2 手');
    expect(assist.suggestions[0].reason).toContain('保留炸弹');
  });

  it('静态拆手与独立全子集最优拆分一致，不假定连续拿到出牌权', () => {
    const oracle = (hand: Card[], memo = new Map<string, number>()): number => {
      if (!hand.length) return 0;
      const key = sortCards(hand).join(',');
      if (memo.has(key)) return memo.get(key)!;
      let best = hand.length;
      for (let mask = 1; mask < 2 ** hand.length; mask += 2) {
        const cards = hand.filter((_, index) => mask & (1 << index));
        if (!parseMove(cards)) continue;
        best = Math.min(best, 1 + oracle(hand.filter((_, index) => !(mask & (1 << index))), memo));
      }
      memo.set(key, best); return best;
    };
    for (const hand of [
      ['3','3','3','3','4','5','6'],
      ['3','4','5','6','7','7','8','8','SJ'],
      ['3','3','3','4','4','4','5','6','6'],
    ] as Card[][]) {
      const plan = createHandPlanner(hand, legalPlays(hand, null));
      expect(plan(hand)).toBe(oracle(hand));
      expect(plan([])).toBe(0);
      for (const move of legalPlays(hand, null)) {
        const rest = subtractCards(hand, move.cards);
        expect(plan(rest)).toBe(oracle(rest));
      }
    }
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
