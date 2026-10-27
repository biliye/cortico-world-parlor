import { describe, expect, it } from 'vitest';
import { RoomKernel } from '../src/room/kernel.ts';
import { TableError } from '../src/room/table-engine.ts';
import { DoudizhuTable } from '../src/room/games/doudizhu-table.ts';
import { parseMove, suggestMove } from '../src/room/games/doudizhu.ts';

const seeded = (seed: number): (() => number) => () => {
  seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
  return seed / 4_294_967_296;
};

interface DdzView {
  hand: string[];
  role: 'landlord' | 'farmer' | null;
  yourTurn: boolean;
  cardsLeft: Record<string, number>;
  multiplier: number;
  lastPlay: { cards: string[] } | null;
}

interface DdzPublic {
  game: string;
  status: string;
  seats: { id: string; name: string; bot: boolean; cardsLeft: number; role: string | null }[];
  bottom?: string[];
  landlord?: string;
  multiplier: number;
  result?: string;
}

const viewOf = (table: DoudizhuTable, seat: string): DdzView => table.view(seat) as DdzView;
const publicOf = (table: DoudizhuTable): DdzPublic => table.public() as DdzPublic;

const HOST = { id: 'a', name: '阿岚' };
const GUEST = { id: 'b', name: '小满' };

describe('斗地主桌', () => {
  it('一个人也能开：空位补两个脚本陪练，起手 17 张', () => {
    const table = new DoudizhuTable({ host: HOST, now: 0, rng: seeded(7) });
    const step = table.start('a', 0);
    expect(table.status).toBe('bidding');
    expect(table.seatIds()).toEqual(['a', 'bot1', 'bot2']);
    expect(publicOf(table).seats.map((seat) => seat.bot)).toEqual([false, true, true]);
    expect(viewOf(table, 'a').hand).toHaveLength(17);
    expect(viewOf(table, 'a').yourTurn).toBe(true);
    expect(step.views).toEqual(['a']);
    expect(table.publicText()).toContain('叫地主中');
  });

  it('叫地主拿走三张底牌，底牌亮给所有人', () => {
    const table = new DoudizhuTable({ host: HOST, now: 0, rng: seeded(7) });
    table.start('a', 0);
    const step = table.act('a', { move: 'bid', call: true }, 0);
    expect(table.status).toBe('playing');
    expect(viewOf(table, 'a').hand).toHaveLength(20);
    expect(viewOf(table, 'a').role).toBe('landlord');
    expect(publicOf(table).bottom).toHaveLength(3);
    expect(publicOf(table).landlord).toBe('a');
    expect(step.events.some((event) => event.text.includes('底牌'))).toBe(true);
    expect(table.publicText()).toContain('地主 阿岚');
  });

  it('三家都不叫会重新发牌', () => {
    const table = new DoudizhuTable({ host: HOST, now: 0, rng: seeded(3) });
    table.join(GUEST);
    table.join({ id: 'c', name: '阿满' });
    table.start('a', 0);
    const first = viewOf(table, 'a').hand;
    expect(table.act('a', { move: 'bid', call: false }, 0)).toBeTruthy();
    expect(table.act('b', { move: 'bid', call: false }, 0)).toBeTruthy();
    const third = table.act('c', { move: 'bid', call: false }, 0);
    expect(third.events.some((event) => event.text.includes('重新发牌'))).toBe(true);
    expect(table.status).toBe('bidding');
    expect(viewOf(table, 'b').hand).toHaveLength(17);
    expect(viewOf(table, 'b').hand).not.toEqual(first);
  });

  it('出牌要轮到自己、要在手里、要压得过', () => {
    const table = new DoudizhuTable({ host: HOST, now: 0, rng: seeded(5) });
    table.join(GUEST);
    table.join({ id: 'c', name: '阿满' });
    table.start('a', 0);
    table.act('a', { move: 'bid', call: true }, 0);
    const hand = viewOf(table, 'a').hand;
    const lowest = hand[0];
    const missing = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', 'SJ', 'BJ']
      .find((rank) => !hand.includes(rank))!;
    expect(() => table.act('b', { move: 'play', cards: [lowest] }, 0)).toThrow(TableError);
    expect(() => table.act('a', { move: 'play', cards: [missing] }, 0)).toThrow(/没有这张牌/);
    expect(() => table.act('a', { move: 'play', cards: ['3', '4'] }, 0)).toThrow(/不是合法/);
    table.act('a', { move: 'play', cards: [lowest] }, 0);
    expect(publicOf(table).seats.find((seat) => seat.id === 'a')?.cardsLeft).toBe(19);
    expect(publicOf(table).seats.find((seat) => seat.id === 'b')?.cardsLeft).toBe(17);
    expect(() => table.act('a', { move: 'pass' }, 0)).toThrow(/还没轮到/);
  });

  it('超时按脚本出牌代打（会出组合牌）', () => {
    const table = new DoudizhuTable({ host: HOST, now: 0, rng: seeded(13) });
    table.join(GUEST);
    table.join({ id: 'c', name: '阿满' });
    table.start('a', 0);
    table.act('a', { move: 'bid', call: true }, 0);
    const before = viewOf(table, 'a').hand.length;
    const step = table.tick(60_001)!;
    expect(step.events.some((event) => event.text.includes('超时，自动'))).toBe(true);
    expect(viewOf(table, 'a').hand.length).toBeLessThan(before);
  });

  it('一个人 + 两个脚本陪练能打完整局，脚本会出组合牌', () => {
    let now = 1_000;
    const table = new DoudizhuTable({ host: HOST, now, botDelayMs: 1_000, rng: seeded(11) });
    const plays: { seat?: string; cards: string[] }[] = [];
    const collect = (step: { events: { data?: Record<string, unknown> }[] } | null): void => {
      for (const event of step?.events ?? []) {
        if (event.data?.action !== 'play' || !Array.isArray(event.data.cards)) continue;
        plays.push({
          seat: typeof event.data.seat === 'string' ? event.data.seat : undefined,
          cards: event.data.cards as string[],
        });
      }
    };
    collect(table.start('a', now));
    let guard = 0;
    while (table.status !== 'ended' && guard++ < 600) {
      const view = viewOf(table, 'a');
      if (table.status === 'bidding') {
        if (view.yourTurn) collect(table.act('a', { move: 'bid', call: true }, now));
        else {
          now += 1_100;
          collect(table.tick(now));
        }
        continue;
      }
      if (view.yourTurn) {
        const target = view.lastPlay ? parseMove(view.lastPlay.cards) : null;
        const picked = suggestMove(view.hand, target);
        collect(table.act('a', picked ? { move: 'play', cards: picked } : { move: 'pass' }, now));
      } else {
        now += 1_100;
        collect(table.tick(now));
      }
    }
    expect(table.status).toBe('ended');
    expect(publicOf(table).result).toContain('倍数');
    expect(table.publicText()).toContain('结束');
    expect(publicOf(table).multiplier).toBeGreaterThanOrEqual(1);
    expect(plays.some((play) => play.seat?.startsWith('bot') && play.cards.length >= 2)).toBe(true);
  });
});

describe('客厅内核里的斗地主', () => {
  const build = () => {
    let now = 0;
    const kernel = new RoomKernel({ id: 'lobby', inviteCode: 'inv', now: () => now });
    const a = kernel.join({ name: '阿岚' });
    const b = kernel.join({ name: '小满' });
    const c = kernel.join({ name: '阿满' });
    return {
      kernel,
      a: kernel.seatById(a.seat.id)!,
      b: kernel.seatById(b.seat.id)!,
      c: kernel.seatById(c.seat.id)!,
      tick: (ms: number) => { now += ms; },
    };
  };

  it('公开桌面不含手牌，私视图只给自己', () => {
    const room = build();
    room.kernel.openTable(room.a, 'ddz');
    room.kernel.joinTable(room.b);
    room.kernel.joinTable(room.c);
    room.kernel.startTable(room.a);

    const snapA = room.kernel.snapshot(room.a.id, 0, 100);
    const snapB = room.kernel.snapshot(room.b.id, 0, 100);
    expect(snapA.table?.game).toBe('ddz');
    expect(snapA.table?.status).toBe('bidding');
    expect(JSON.stringify(snapA.table)).not.toContain('"hand"');
    expect((snapA.tablePrivate as unknown as DdzView).hand).toHaveLength(17);
    expect((snapB.tablePrivate as unknown as DdzView).hand).toHaveLength(17);
    expect((snapB.tablePrivate as unknown as DdzView).hand)
      .not.toEqual((snapA.tablePrivate as unknown as DdzView).hand);
    expect(snapA.tablePrivate?.text).toContain('叫地主');

    const turns = (seatId: string) => room.kernel.history(seatId, 0, 100)
      .filter((event) => event.type === 'parlor.table.turn');
    expect(turns(room.a.id)).toHaveLength(1);
    expect(turns(room.b.id)).toHaveLength(0);
    expect(turns(room.c.id)).toHaveLength(0);
  });

  it('叫地主后拿到 20 张；骰子动作打到斗地主桌上会被拒', () => {
    const room = build();
    room.kernel.openTable(room.a, 'ddz');
    room.kernel.joinTable(room.b);
    room.kernel.startTable(room.a);
    room.kernel.ddzAction(room.a, { move: 'bid', call: true });
    const snap = room.kernel.snapshot(room.a.id, 0, 100);
    expect((snap.tablePrivate as unknown as DdzView).hand).toHaveLength(20);
    expect((snap.tablePrivate as unknown as DdzView).role).toBe('landlord');
    expect(snap.table?.text).toContain('地主 阿岚');
    expect(() => room.kernel.tableAction(room.a, { type: 'stand' })).toThrow(/不是骰子桌/);
  });

  it('叫地主超时会自动不叫，下一家接手', () => {
    const room = build();
    room.kernel.openTable(room.a, 'ddz');
    room.kernel.joinTable(room.b);
    room.kernel.joinTable(room.c);
    room.kernel.startTable(room.a);
    room.tick(30_001);
    room.kernel.tickTable();
    const text = room.kernel.history(room.a.id, 0, 100).map((event) => event.text).join('\n');
    expect(text).toContain('阿岚 不叫（超时）');
    expect((room.kernel.snapshot(room.b.id, 0, 1).tablePrivate as unknown as DdzView).yourTurn).toBe(true);
  });
});
