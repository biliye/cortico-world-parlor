import { describe, expect, it } from 'vitest';
import { FOUR_COLOUR_CALL_MS } from '../src/room/games/four-colour-rules.ts';
import { FourColourTable } from '../src/room/games/four-colour-table.ts';

const a = { id: 'a', name: '阿岚' };
const b = { id: 'b', name: '小满' };
const c = { id: 'c', name: '阿青' };

function start(players = [a, b, c], callLastCard = false) {
  const table = new FourColourTable(players[0], 1_000, () => 0);
  for (const player of players.slice(1)) table.join(player);
  table.start(a.id, 100, { callLastCard });
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
    table.act(a.id, { action: 'play', card: 101, colour: 'blue' }, 201);
    expect(table.public()).toMatchObject({ colour: 'blue', turn: c.id, last: expect.stringContaining('只剩 1 张') });
    expect(table.view(b.id)?.hand).toHaveLength(5);
  });

  it('反转在两人桌跳过对手，出完结算且无法再操作', () => {
    const table = start([a, b]);
    arrange(table, [[1, 21], [5]]);
    table.act(a.id, { action: 'play', card: 21 }, 200);
    expect(table.public()).toMatchObject({ direction: -1, turn: a.id });
    const result = table.act(a.id, { action: 'play', card: 1 }, 201);
    expect(result).toMatchObject({ ended: true, seatResults: null });
    expect(table.public().winners).toEqual([a.id]);
    expect(() => table.act(a.id, { action: 'draw' }, 202)).toThrow();
  });

  it('手动模式可以随变色牌一起喊，普通模式仍自动提示', () => {
    const manual = start([a, b], true);
    arrange(manual, [[1, 100], [5]]);
    manual.act(a.id, { action: 'play', card: 100, colour: 'blue', call: true }, 200);
    expect(manual.public()).toMatchObject({ callLastCard: true, pendingCall: null, turn: b.id, last: expect.stringContaining('喊牌') });
    expect(() => manual.act(b.id, { action: 'catch' }, 201)).toThrow();

    const automatic = start([a, b]);
    arrange(automatic, [[1, 2], [5]]);
    expect(() => automatic.act(a.id, { action: 'play', card: 1, call: true }, 199)).toThrow(/手动喊牌/);
    automatic.act(a.id, { action: 'play', card: 1 }, 200);
    expect(automatic.public()).toMatchObject({ callLastCard: false, pendingCall: null, turn: b.id, last: expect.stringContaining('只剩 1 张') });
  });

  it('喊牌窗口允许本人补喊、其他席抓漏喊；抓到只罚一次并保留反转后的回合', () => {
    const table = start([a, b], true);
    arrange(table, [[1, 21], [5]]);
    const step = table.act(a.id, { action: 'play', card: 21 }, 200);
    expect(step.views).toEqual([a.id, b.id]);
    expect(table.public()).toMatchObject({ pendingCall: a.id, deadline: 200 + FOUR_COLOUR_CALL_MS, turn: undefined });
    expect(table.view(a.id)?.actions).toEqual(['call']);
    expect(table.view(b.id)?.actions).toEqual(['catch']);
    expect(() => table.act(a.id, { action: 'play', card: 1 }, 201)).toThrow(/正在等喊牌/);
    expect(() => table.act(a.id, { action: 'catch' }, 201)).toThrow();
    expect(() => table.act(b.id, { action: 'call' }, 201)).toThrow();
    expect(() => table.act('observer', { action: 'catch' }, 201)).toThrow(/不在桌上/);
    expect(table.autoPlay(a.id, 201)).toBeNull();

    const restored = new FourColourTable(a, 1_000, () => 0);
    restored.restoreState(table.exportState());
    restored.act(a.id, { action: 'call' }, 202);
    expect(restored.public()).toMatchObject({ pendingCall: null, turn: a.id, deadline: 1_202 });
    expect(restored.view(a.id)?.hand).toHaveLength(1);

    const caught = table.act(b.id, { action: 'catch' }, 203);
    expect(caught.events[0]).toMatchObject({ data: { seat: b.id, action: 'catch' }, text: expect.stringContaining('罚摸 2 张') });
    expect(table.public()).toMatchObject({ pendingCall: null, turn: a.id });
    expect(table.view(a.id)?.hand).toHaveLength(3);
    expect(() => table.act(b.id, { action: 'catch' }, 204)).toThrow();
  });

  it('没人抓时到点恢复下一席，旧存档恢复后使用自动提醒', () => {
    const table = start([a, b, c], true);
    arrange(table, [[1, 2], [5], [75]]);
    table.act(a.id, { action: 'play', card: 1 }, 200);
    const deadline = 200 + FOUR_COLOUR_CALL_MS;
    expect(table.nextWakeAt()).toBe(deadline);
    expect(table.tick(deadline - 1)).toBeNull();
    expect(() => table.act(b.id, { action: 'catch' }, deadline)).toThrow(/时限已过/);
    expect(table.tick(deadline)?.views).toEqual([b.id]);
    expect(table.public()).toMatchObject({ pendingCall: null, turn: b.id, deadline: deadline + 1_000 });
    expect(table.view(a.id)?.hand).toHaveLength(1);

    const legacy = start().exportState() as Record<string, unknown>;
    delete legacy.callLastCard;
    delete legacy.pendingCall;
    table.restoreState(legacy);
    expect(table.public()).toMatchObject({ callLastCard: false, pendingCall: null });
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
