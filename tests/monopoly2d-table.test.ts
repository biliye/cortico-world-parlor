/**
 * 快局大富翁牌桌：阶段推进、买地与收租、超时与托管、恢复、结算。
 * 骰点用固定随机源注入；需要精确局面的用例直接改快照再恢复（顺带覆盖 restore）。
 */
import { describe, expect, it } from 'vitest';
import { Monopoly2dTable } from '../src/room/games/monopoly2d-table.ts';
import type { Monopoly2dSeatState } from '../src/room/games/monopoly2d-rules.ts';

const T0 = 1_000;
const TURNS = 48;

/** 固定骰点：`die(n)` 让下一次掷骰必出 n 点。 */
const die = (value: number): number => (value - 0.5) / 6;
/** 固定事件卡：第 index 张（0 集市 +80、1 寄卖 +40、2 街灯 −40、3 雨棚 −70）。 */
const card = (index: number): number => (index + 0.5) / 4;

function scripted(values: number[]): () => number {
  const queue = [...values];
  return () => (queue.length ? queue.shift()! : 0);
}

function makeTable(rng: () => number = () => 0, options: { rollMs?: number; buyMs?: number } = {}): Monopoly2dTable {
  const table = new Monopoly2dTable({ host: { id: 'a', name: '甲' }, now: T0, rng, ...options });
  table.join({ id: 'b', name: '乙' });
  table.join({ id: 'c', name: '丙' });
  table.join({ id: 'd', name: '丁' });
  return table;
}

const pub = (table: Monopoly2dTable) => table.public();

const priv = (table: Monopoly2dTable, seatId: string) => table.view(seatId) as unknown as {
  canAct: boolean;
  moves: string[];
  turnNo: number;
  phase: 'await_roll' | 'await_buy' | null;
  pending: { index: number; price: number; affordable: boolean; cashAfter: number } | null;
  cash: number;
};

/** 改快照再恢复：用来摆出固定的局面。 */
function load(table: Monopoly2dTable, patch: (state: Record<string, any>) => void): void {
  const state = JSON.parse(JSON.stringify(table.exportState())) as Record<string, any>;
  patch(state);
  table.restoreState(state);
}

describe('开局', () => {
  it('少于四席不能开局', () => {
    const table = new Monopoly2dTable({ host: { id: 'a', name: '甲' }, now: T0, rng: () => 0 });
    table.join({ id: 'b', name: '乙' });
    expect(() => table.start('a', T0)).toThrow(/四个玩家/);
  });

  it('只有开桌的人能开始', () => {
    const table = makeTable();
    expect(() => table.start('b', T0)).toThrow(/开桌的人/);
  });

  it('开局：四席各 1000 金币、都站在起点、第一手待掷骰', () => {
    const table = makeTable();
    const step = table.start('a', T0);
    const state = pub(table);
    expect(state.status).toBe('playing');
    expect(state.turnNo).toBe(1);
    expect(state.round).toBe(1);
    expect(state.phase).toBe('await_roll');
    expect(state.seats.every((seat) => seat.cash === 1000 && seat.pos === 0)).toBe(true);
    expect(state.deadline).toBe(T0 + 60_000);
    expect(state.turn).toBe('a');
    expect(step.views).toEqual(['a']);
    expect(step.events[0].type).toBe('parlor.table.start');
  });
});

describe('掷骰与买地', () => {
  it('落在无主地产进入购买阶段：回合号不变，截止另给 20 秒', () => {
    const table = makeTable();
    table.start('a', T0);
    const step = table.act('a', { move: 'roll', turnNo: 1 }, T0 + 10);
    const state = pub(table);
    expect(state.phase).toBe('await_buy');
    expect(state.pending).toBe(1);
    expect(state.turnNo).toBe(1);
    expect(state.deadline).toBe(T0 + 10 + 20_000);
    expect(step.views).toEqual(['a']);
    expect(priv(table, 'a').moves).toEqual(['buy', 'pass']);
    expect(priv(table, 'a').pending).toMatchObject({ index: 1, price: 120, affordable: true, cashAfter: 880 });
  });

  it('买下：扣钱、记归属、交棒', () => {
    const table = makeTable();
    table.start('a', T0);
    table.act('a', { move: 'roll', turnNo: 1 }, T0 + 10);
    table.act('a', { move: 'buy', turnNo: 1 }, T0 + 20);
    const state = pub(table);
    expect(state.status).toBe('playing');
    expect(state.turnNo).toBe(2);
    expect(state.turn).toBe('b');
    expect(state.phase).toBe('await_roll');
    expect(state.seats[0].cash).toBe(880);
    expect(state.owners).toEqual([{ cell: 1, seat: 'a' }]);
    expect(state.seats[0].properties).toEqual([1]);
    expect(state.pending).toBeUndefined();
    expect(state.deadline).toBe(T0 + 20 + 60_000);
  });

  it('放弃：不扣钱，直接交棒', () => {
    const table = makeTable();
    table.start('a', T0);
    table.act('a', { move: 'roll', turnNo: 1 }, T0 + 10);
    table.act('a', { move: 'pass', turnNo: 1 }, T0 + 12);
    const state = pub(table);
    expect(state.turnNo).toBe(2);
    expect(state.seats[0].cash).toBe(1000);
    expect(state.owners).toEqual([]);
  });

  it('买不起：不进购买阶段，直接交棒', () => {
    const table = makeTable();
    table.start('a', T0);
    load(table, (state) => {
      state.seats[0].cash = 100;
      state.deadline = T0 + 60_000;
    });
    table.act('a', { move: 'roll', turnNo: 1 }, T0 + 10);
    const state = pub(table);
    expect(state.phase).toBe('await_roll');
    expect(state.turnNo).toBe(2);
    expect(state.seats[0].cash).toBe(100);
  });

  it('金币恰好等于售价时可以买', () => {
    const table = makeTable();
    table.start('a', T0);
    load(table, (state) => { state.seats[0].cash = 120; });
    table.act('a', { move: 'roll', turnNo: 1 }, T0 + 10);
    expect(priv(table, 'a').pending?.affordable).toBe(true);
    table.act('a', { move: 'buy', turnNo: 1 }, T0 + 20);
    expect(pub(table).seats[0].cash).toBe(0);
  });
});

describe('收租与事件', () => {
  it('踩到别人的地产按租金付，业主收到等额', () => {
    const table = makeTable();
    table.start('a', T0);
    load(table, (state) => {
      state.seats[0].pos = 1;
      state.seats[0].cash = 900;
      state.owners = { 1: 'a' };
      state.seats[1].cash = 500;
      state.turnNo = 2;
      state.phase = 'await_roll';
      state.deadline = T0 + 60_000;
    });
    table.act('b', { move: 'roll', turnNo: 2 }, T0 + 10);
    const state = pub(table);
    expect(state.seats[1].cash).toBe(480);
    expect(state.seats[0].cash).toBe(920);
    expect(state.turnNo).toBe(3);
  });

  it('租金封顶在现有现金：只有 5 块就只付 5 块', () => {
    const table = makeTable();
    table.start('a', T0);
    load(table, (state) => {
      state.seats[0].pos = 13;
      state.owners = { 13: 'a' };
      state.seats[1].cash = 5;
      state.seats[1].pos = 12;
      state.turnNo = 2;
    });
    table.act('b', { move: 'roll', turnNo: 2 }, T0 + 10);
    const state = pub(table);
    expect(state.seats[1].cash).toBe(0);
    expect(state.seats[0].cash).toBe(1005);
  });

  it('落在自己的地产免租', () => {
    const table = makeTable();
    table.start('a', T0);
    load(table, (state) => {
      state.seats[1].pos = 0;
      state.seats[1].cash = 500;
      state.owners = { 1: 'b' };
      state.turnNo = 2;
    });
    const step = table.act('b', { move: 'roll', turnNo: 2 }, T0 + 10);
    expect(pub(table).seats[1].cash).toBe(500);
    expect(step.events.some((event) => event.text.includes('免租'))).toBe(true);
  });

  it('事件卡加钱', () => {
    const table = makeTable(scripted([0, die(1), card(0)]));
    table.start('a', T0);
    load(table, (state) => { state.seats[0].pos = 2; });
    table.act('a', { move: 'roll', turnNo: 1 }, T0 + 10);
    expect(pub(table).seats[0].cash).toBe(1080);
  });

  it('事件卡扣钱最多扣到 0', () => {
    const table = makeTable(scripted([0, die(1), card(3)]));
    table.start('a', T0);
    load(table, (state) => { state.seats[0].pos = 2; state.seats[0].cash = 30; });
    table.act('a', { move: 'roll', turnNo: 1 }, T0 + 10);
    expect(pub(table).seats[0].cash).toBe(0);
  });

  it('过起点领 120', () => {
    const table = makeTable(scripted([0, die(3)]));
    table.start('a', T0);
    load(table, (state) => { state.seats[0].pos = 22; state.seats[0].cash = 100; });
    table.act('a', { move: 'roll', turnNo: 1 }, T0 + 10);
    const state = pub(table);
    expect(state.seats[0].pos).toBe(1);
    expect(state.seats[0].cash).toBe(220);
  });
});

describe('超时与托管', () => {
  it('待掷骰超时：代掷一次、跳过购买、直接交棒', () => {
    const table = makeTable();
    table.start('a', T0);
    const deadline = pub(table).deadline!;
    const step = table.tick(deadline);
    expect(step).not.toBeNull();
    const state = pub(table);
    expect(state.turnNo).toBe(2);
    expect(state.phase).toBe('await_roll');
    expect(state.owners).toEqual([]);
    expect(state.seats[0].pos).toBe(1);
    expect(step!.events.some((event) => event.text.includes('超时'))).toBe(true);
  });

  it('待购买超时：自动放弃并交棒', () => {
    const table = makeTable();
    table.start('a', T0);
    table.act('a', { move: 'roll', turnNo: 1 }, T0 + 10);
    const buyDeadline = pub(table).deadline!;
    table.tick(buyDeadline);
    const state = pub(table);
    expect(state.turnNo).toBe(2);
    expect(state.owners).toEqual([]);
    expect(state.seats[0].cash).toBe(1000);
  });

  it('没到点 tick 不推进', () => {
    const table = makeTable();
    table.start('a', T0);
    expect(table.tick(T0 + 1)).toBeNull();
  });

  it('托管代打：不等截止也能走完一手', () => {
    const table = makeTable();
    table.start('a', T0);
    const step = table.autoPlay('a', T0 + 100);
    expect(step).not.toBeNull();
    const state = pub(table);
    expect(state.turnNo).toBe(2);
    expect(state.turn).toBe('b');
    expect(step!.events.some((event) => event.text.includes('托管'))).toBe(true);
  });

  it('托管只接受当前席位', () => {
    const table = makeTable();
    table.start('a', T0);
    expect(table.autoPlay('b', T0 + 100)).toBeNull();
  });
});

describe('动作校验', () => {
  it('不是当前席位会被拒', () => {
    const table = makeTable();
    table.start('a', T0);
    expect(() => table.act('b', { move: 'roll', turnNo: 1 }, T0 + 10)).toThrow(/还没轮到你/);
  });

  it('回合号对不上按过期处理', () => {
    const table = makeTable();
    table.start('a', T0);
    expect(() => table.act('a', { move: 'roll', turnNo: 7 }, T0 + 10)).toThrow(/第 1 手/);
  });

  it('待掷骰阶段不能买，待购买阶段不能再掷', () => {
    const table = makeTable();
    table.start('a', T0);
    expect(() => table.act('a', { move: 'buy', turnNo: 1 }, T0 + 10)).toThrow(/没有可买的地产/);
    table.act('a', { move: 'roll', turnNo: 1 }, T0 + 10);
    expect(() => table.act('a', { move: 'roll', turnNo: 1 }, T0 + 11)).toThrow(/决定买不买/);
  });

  it('过了截止再动作会被拒', () => {
    const table = makeTable();
    table.start('a', T0);
    expect(() => table.act('a', { move: 'roll', turnNo: 1 }, T0 + 60_000)).toThrow(/到期/);
  });

  it('不在桌上的人不能动作', () => {
    const table = makeTable();
    table.start('a', T0);
    expect(() => table.act('z', { move: 'roll', turnNo: 1 }, T0 + 10)).toThrow(/不在桌上/);
  });
});

describe('短停机恢复', () => {
  it('购买窗剩 3 秒，恢复成 10 秒', () => {
    const table = makeTable();
    table.start('a', T0);
    load(table, (state) => { state.deadline = 4_000; });
    table.rearm(2_000, 1_000, 10_000);
    expect(pub(table).deadline).toBe(12_000);
  });

  it('购买窗剩 15 秒，恢复仍是 15 秒', () => {
    const table = makeTable();
    table.start('a', T0);
    load(table, (state) => { state.deadline = 16_000; });
    table.rearm(2_000, 1_000, 10_000);
    expect(pub(table).deadline).toBe(17_000);
  });

  it('恢复沿用已落库的骰点与待买地块，不会重掷', () => {
    const table = makeTable();
    table.start('a', T0);
    table.act('a', { move: 'roll', turnNo: 1 }, T0 + 10);
    const before = pub(table);
    const copy = new Monopoly2dTable({ host: { id: 'a', name: '甲' }, now: T0, rng: () => 0.99 });
    copy.restoreState(JSON.parse(JSON.stringify(table.exportState())));
    const after = pub(copy);
    expect(after.pending).toBe(before.pending);
    expect(after.seats[0].pos).toBe(before.seats[0].pos);
    expect(after.turnNo).toBe(before.turnNo);
    expect(after.phase).toBe('await_buy');
  });
});

describe('结算', () => {
  it('48 手打完自动结算：四行排名、资产 = 金币 + 地产 85%', () => {
    const table = makeTable(() => 0.5);
    table.start('a', T0);
    let guard = 0;
    while (pub(table).status === 'playing' && guard++ < 100) {
      const state = pub(table);
      const seat = state.turn!;
      const turnNo = state.turnNo;
      const at = T0 + guard * 10;
      if (state.phase === 'await_buy') table.act(seat, { move: 'pass', turnNo }, at);
      else table.act(seat, { move: 'roll', turnNo }, at);
    }
    const state = pub(table);
    expect(state.status).toBe('ended');
    expect(state.turnNo).toBe(TURNS);
    expect(state.round).toBe(12);
    expect(state.totalRounds).toBe(12);
    expect(state.cells).toHaveLength(24);
    expect(state.ranking).toHaveLength(4);
    for (const row of state.ranking!) {
      const seat = state.seats.find((entry) => entry.id === row.seat)!;
      expect(row.cash).toBe(seat.cash);
      expect(row.total).toBe(row.cash + row.estate);
    }
    expect(state.winners!.length).toBeGreaterThanOrEqual(1);
    expect(state.ranking![0].rank).toBe(1);
  });

  it('并列第一按竞赛排名，同分同名次', () => {
    const table = makeTable();
    table.start('a', T0);
    load(table, (state) => {
      state.turnNo = TURNS;
      state.phase = 'await_roll';
      state.seats.forEach((seat: Monopoly2dSeatState) => { seat.cash = 1000; });
    });
    table.tick(pub(table).deadline!);
    const state = pub(table);
    expect(state.status).toBe('ended');
    expect(state.tie).toBe(true);
    expect(state.winners!.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(state.ranking!.map((row) => row.rank)).toEqual([1, 1, 1, 1]);
  });

  it('终局事件带席位 ID 与并列标记', () => {
    const table = makeTable();
    table.start('a', T0);
    load(table, (state) => { state.turnNo = TURNS; });
    const step = table.tick(pub(table).deadline!)!;
    const end = step.events.find((event) => event.type === 'parlor.table.end')!;
    expect(end).toBeTruthy();
    expect(step.ended).toBe(true);
    expect(Array.isArray((end.data as { winners: string[] }).winners)).toBe(true);
    expect((end.data as { tie: boolean }).tie).toBe(true);
  });
});

describe('快照', () => {
  it('旧桌恢复后按 16 格绕圈，打完第 24 手结算并保留旧地产估值', () => {
    const table = makeTable();
    table.start('a', T0);
    load(table, (state) => {
      state.rulesVersion = 1;
      state.mapVersion = 1;
      state.turnNo = 24;
      state.seats[3].pos = 15;
      state.owners = { 6: 'd' };
    });
    expect(pub(table).cells).toHaveLength(16);
    expect(pub(table).totalRounds).toBe(6);
    expect(table.privateText('d', T0)).toContain('第 6/6 轮第 24 手');

    table.act('d', { move: 'roll', turnNo: 24 }, T0 + 1);
    expect(pub(table)).toMatchObject({ status: 'ended', turnNo: 24, rulesVersion: 1, mapVersion: 1 });
    expect(pub(table).seats[3]).toMatchObject({ pos: 0, cash: 1120, estate: 153 });
    expect(pub(table).ranking?.[0]).toMatchObject({ seat: 'd', total: 1273 });

    const copy = makeTable();
    copy.restoreState(JSON.parse(JSON.stringify(table.exportState())));
    expect(pub(copy)).toEqual(pub(table));
  });

  it('导出再恢复，桌面一致', () => {
    const table = makeTable();
    table.start('a', T0);
    load(table, (state) => { state.turnNo = 47; state.seats[2].pos = 22; });
    table.act('c', { move: 'roll', turnNo: 47 }, T0 + 10);
    expect(pub(table).pending).toBe(23);
    const state = JSON.parse(JSON.stringify(table.exportState()));
    const copy = new Monopoly2dTable({ host: { id: 'a', name: '甲' }, now: T0 });
    copy.restoreState(state);
    expect(copy.seatIds()).toEqual(table.seatIds());
    expect(pub(copy)).toEqual(pub(table));
    copy.act('c', { move: 'buy', turnNo: 47 }, T0 + 20);
    expect(pub(copy).turnNo).toBe(48);
    expect(pub(copy).seats[2]).toMatchObject({ cash: 660, properties: [23], estate: 289 });
  });

  it('坏快照明确抛错', () => {
    const table = makeTable();
    table.start('a', T0);
    const state = JSON.parse(JSON.stringify(table.exportState()));
    state.pending = 1;
    expect(() => new Monopoly2dTable({ host: { id: 'a', name: '甲' }, now: T0 }).restoreState(state))
      .toThrow(/不该有待买地块/);
  });
});
