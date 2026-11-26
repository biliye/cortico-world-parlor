import { describe, expect, it } from 'vitest';
import { FOUR_COLOUR_CALL_MS } from '../src/room/games/four-colour-rules.ts';
import { FourColourTable } from '../src/room/games/four-colour-table.ts';

const a = { id: 'a', name: '阿岚' };
const b = { id: 'b', name: '小满' };
const c = { id: 'c', name: '阿青' };

function start(players = [a, b, c]) {
  const table = new FourColourTable(players[0], 1_000, () => 0);
  for (const player of players.slice(1)) table.join(player);
  table.start(a.id, 100);
  return table;
}

// 牌号按每色 25 张排列，100 起是百搭牌。其余牌留在摸牌堆以保留完整牌组。
function arrange(table: FourColourTable, hands: number[][], discard = [0], stockTop: number[] = []) {
  const state = table.exportState() as {
    players: Array<{ hand: number[] }>;
    discard: number[];
    stock: number[];
  };
  for (const [index, hand] of hands.entries()) state.players[index].hand = hand;
  state.discard = discard;
  const inUse = new Set([...hands.flat(), ...discard, ...stockTop]);
  state.stock = [...Array.from({ length: 108 }, (_, i) => i).filter(id => !inUse.has(id)), ...stockTop];
  table.restoreState(state);
}

describe('四彩牌规则', () => {
  it('每席发七张，只把牌面发给对应席位；存档可以还原', () => {
    const table = start();
    expect(table.public().seats.map(seat => seat.count)).toEqual([7, 7, 7]);
    expect(table.public().seats.every(seat => !('hand' in seat))).toBe(true);
    expect(table.view('observer')).toBeNull();
    const hands = table.seatIds().map(id => table.view(id)!.hand.map(card => card.id));
    expect(new Set(hands.flat()).size).toBe(21);
    const restored = new FourColourTable(a);
    restored.restoreState(table.exportState());
    expect(restored.public()).toEqual(table.public());
    expect(restored.view(b.id)).toEqual(table.view(b.id));
  });

  it('摸到可接的牌后只许出该牌，摸牌事件不公开牌面', () => {
    const table = start();
    arrange(table, [[1, 50], [5], [75]], [0], [2]);
    const drawn = table.act(a.id, { action: 'draw' }, 200);
    expect(drawn.events[0].data).toEqual({ game: 'four-colour', seat: a.id, action: 'draw', auto: false });
    expect(table.view(a.id)).toMatchObject({ playable: [2], actions: ['play', 'pass'] });
    expect(() => table.act(a.id, { action: 'play', card: 1 }, 201)).toThrow();
    table.act(a.id, { action: 'pass' }, 202);
    expect(table.public().turn).toBe(b.id);
  });

  it('变色 +4 受当前颜色限制，要求选颜色并跳过罚摸的玩家', () => {
    const table = start();
    arrange(table, [[1, 50, 101], [5], [75]]);
    expect(() => table.act(a.id, { action: 'play', card: 101, colour: 'blue' }, 200)).toThrow();
    arrange(table, [[50, 101], [5], [75]]);
    expect(() => table.act(a.id, { action: 'play', card: 101 }, 200)).toThrow();
    table.act(a.id, { action: 'play', card: 101, colour: 'blue', call: true }, 201);
    expect(table.public()).toMatchObject({ colour: 'blue', turn: c.id, last: expect.stringContaining('只剩 1 张') });
    expect(table.view(b.id)?.hand).toHaveLength(5);
  });

  it('反转在两人桌跳过对手，出完结算且无法再操作', () => {
    const table = start([a, b]);
    arrange(table, [[1, 21], [5]]);
    table.act(a.id, { action: 'play', card: 21, call: true }, 200);
    expect(table.public()).toMatchObject({ direction: -1, turn: a.id });
    const result = table.act(a.id, { action: 'play', card: 1 }, 201);
    expect(result).toMatchObject({ ended: true, seatResults: null });
    expect(table.public().winners).toEqual([a.id]);
    expect(() => table.act(a.id, { action: 'draw' }, 202)).toThrow();
  });

  it('旧版已开局的存档依旧自动提示，恢复后可继续出牌', () => {
    const table = start([a, b]);
    arrange(table, [[1, 2], [5]]);
    const legacy = table.exportState() as Record<string, unknown>;
    delete legacy.callLastCard;
    delete legacy.pendingCall;
    table.restoreState(legacy);
    expect(() => table.act(a.id, { action: 'play', card: 1, call: true }, 199)).toThrow(/才可以一起喊牌/);
    table.act(a.id, { action: 'play', card: 1 }, 200);
    expect(table.public()).toMatchObject({ callLastCard: false, pendingCall: null, turn: b.id, last: expect.stringContaining('只剩 1 张') });
  });

  it('只叫醒本人补喊，其他席和观战者不能代喊，喊完保留反转后的回合', () => {
    const table = start([a, b]);
    arrange(table, [[1, 21], [5]]);
    const step = table.act(a.id, { action: 'play', card: 21 }, 200);
    expect(step.views).toEqual([a.id]);
    expect(step.refreshViews).toEqual([b.id]);
    expect(table.public()).toMatchObject({ pendingCall: a.id, deadline: 200 + FOUR_COLOUR_CALL_MS, turn: undefined });
    expect(table.view(a.id)?.actions).toEqual(['call']);
    expect(table.view(b.id)?.actions).toEqual([]);
    expect(() => table.act(a.id, { action: 'play', card: 1 }, 201)).toThrow(/需要喊牌/);
    expect(() => table.act(b.id, { action: 'call' }, 201)).toThrow();
    expect(() => table.act('observer', { action: 'call' }, 201)).toThrow(/不在桌上/);
    expect(table.autoPlay(a.id, 201)).toBeNull();

    table.act(a.id, { action: 'call' }, 202);
    expect(table.public()).toMatchObject({ pendingCall: null, turn: a.id, deadline: 1_202 });
    expect(table.view(a.id)?.hand).toHaveLength(1);
  });

  it('喊牌窗口恢复后顺延，到点只罚两张一次，再恢复下一席', () => {
    const table = start();
    arrange(table, [[1, 2], [5], [75]]);
    table.act(a.id, { action: 'play', card: 1 }, 200);
    const restored = new FourColourTable(a, 1_000, () => 0);
    restored.restoreState(table.exportState());
    restored.rearm(9_000, 3_000, 5_000);
    const deadline = 14_000;
    expect(restored.nextWakeAt()).toBe(deadline);
    expect(restored.tick(deadline - 1)).toBeNull();
    expect(() => restored.act(a.id, { action: 'call' }, deadline)).toThrow(/时限已过/);
    const step = restored.tick(deadline);
    expect(step?.views).toEqual([b.id]);
    expect(step?.events[0]).toMatchObject({ data: { seat: a.id, action: 'call_missed', auto: true }, text: expect.stringContaining('罚摸 2 张') });
    expect(restored.tick(deadline)).toBeNull();
    expect(restored.public()).toMatchObject({ pendingCall: null, turn: b.id, deadline: deadline + 1_000 });
    expect(restored.view(a.id)?.hand).toHaveLength(3);
  });

  it('摸牌堆与旧弃牌不足两张时，超时按实际牌数罚摸', () => {
    const table = start();
    const inUse = new Set([0, 1, 2, 5]);
    arrange(table, [[1, 2], [5], Array.from({ length: 108 }, (_, id) => id).filter(id => !inUse.has(id))]);
    expect(table.public().stockCount).toBe(0);
    table.act(a.id, { action: 'play', card: 1 }, 200);
    expect(table.tick(200 + FOUR_COLOUR_CALL_MS)?.events[0].text).toContain('罚摸 1 张');
    expect(table.view(a.id)?.hand.map(card => card.id)).toEqual([2, 0]);
    expect(table.public()).toMatchObject({ pendingCall: null, turn: b.id, stockCount: 0 });
  });

  it('代打到只剩一张时随出牌喊牌，下一次可以代打出完', () => {
    const table = start([a, b]);
    arrange(table, [[21, 1], [5]]);
    expect(table.tick(1_100)?.events[0].text).toContain('喊牌');
    expect(table.public()).toMatchObject({ pendingCall: null, turn: a.id });
    expect(table.tick(2_100)).toMatchObject({ ended: true });
  });

  it('库存用完后仅重洗旧弃牌，截止后自动完成回合', () => {
    const table = start();
    // 所有未列出的牌都留在第三席，摸牌堆已空。
    const inUse = new Set([0, 2, 26, 75]);
    arrange(table, [[26], [75], Array.from({ length: 108 }, (_, id) => id).filter(id => !inUse.has(id))], [2, 0]);
    expect(table.public().stockCount).toBe(0);
    expect(table.tick(1_099)).toBeNull();
    expect(table.tick(1_100)?.events.map(event => event.data?.action)).toEqual(['draw', 'play']);
    expect(table.public()).toMatchObject({ turn: b.id, top: { id: 2 }, stockCount: 0 });
  });
});
