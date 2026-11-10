/**
 * 快局大富翁的纯规则：地图、移动、估值、排名、快照校验。
 * 这里不碰时钟，也不发事件——牌桌行为在 monopoly2d-table.test.ts。
 */
import { describe, expect, it } from 'vitest';
import {
  CLASSIC_RULES, DEFAULT_RULES, SEAT_COUNT, cellAt, estateValue, moveOn, propertiesOf,
  rankSeats, validateState, type Monopoly2dSeatState,
} from '../src/room/games/monopoly2d-rules.ts';

const board = DEFAULT_RULES.board;

const seats = (): Monopoly2dSeatState[] => ([
  { id: 'a', name: '甲', cash: 1000, pos: 0 },
  { id: 'b', name: '乙', cash: 1000, pos: 0 },
  { id: 'c', name: '丙', cash: 1000, pos: 0 },
  { id: 'd', name: '丁', cash: 1000, pos: 0 },
]);

const baseState = (): Record<string, unknown> => ({
  version: 1,
  rulesVersion: DEFAULT_RULES.rulesVersion,
  mapVersion: DEFAULT_RULES.mapVersion,
  status: 'playing',
  host: 'a',
  seats: seats(),
  firstSeat: 0,
  turnNo: 1,
  phase: 'await_roll',
  deadline: 60_000,
  owners: {},
  pending: null,
  last: null,
  ranking: [],
});

describe('地图', () => {
  it.each([
    [16, CLASSIC_RULES.board, [4, 8, 12]],
    [24, board, [6, 12, 18]],
  ] as const)('%i 格地图的四角是起点与三个休息格', (size, map, rest) => {
    expect(map.map((cell) => cell.index)).toEqual([...Array(size).keys()]);
    expect(cellAt(0, map).kind).toBe('start');
    expect(rest.map((index) => cellAt(index, map).kind)).toEqual(['rest', 'rest', 'rest']);
  });

  it('新地图有十二块地产，售价与租金都随格号递增', () => {
    const properties = board.filter((cell) => cell.kind === 'property');
    expect(properties.length).toBe(12);
    for (let index = 1; index < properties.length; index++) {
      expect(properties[index].price!).toBeGreaterThan(properties[index - 1].price!);
      expect(properties[index].rent!).toBeGreaterThan(properties[index - 1].rent!);
      expect(properties[index].rent!).toBeLessThan(properties[index].price!);
    }
    expect(properties.every((cell) => (cell.price! * 85) % 100 === 0)).toBe(true);
  });

  it('环形取格会绕回来', () => {
    expect(cellAt(24, board).index).toBe(0);
    expect(cellAt(-1, board).index).toBe(23);
  });
});

describe('移动', () => {
  it('没跨圈就不发钱', () => {
    expect(moveOn(15, 3, board.length)).toEqual({ to: 18, passedStart: false });
  });

  it('跨过与恰好停在起点都算一次过起点', () => {
    expect(moveOn(23, 3, board.length)).toEqual({ to: 2, passedStart: true });
    expect(moveOn(22, 2, board.length)).toEqual({ to: 0, passedStart: true });
    expect(moveOn(15, 1, CLASSIC_RULES.board.length)).toEqual({ to: 0, passedStart: true });
  });
});

describe('估值与排名', () => {
  it('合计后只取整一次：两块各 130 应得 221，逐块取整会得 220', () => {
    expect(estateValue([130, 130])).toBe(221);
    expect(Math.floor(130 * 0.85) + Math.floor(130 * 0.85)).toBe(220);
  });

  it('当前地图的售价都是 20 的倍数，所以两种取整在这里结果相同', () => {
    const prices = board.filter((cell) => cell.kind === 'property').map((cell) => cell.price!);
    for (const price of prices) {
      expect(estateValue([price])).toBe(Math.floor(price * 0.85));
      expect((price * 85) % 100).toBe(0);
    }
  });

  it('按资产降序、同分并列且按座次排', () => {
    const owners = new Map<number, string>([[1, 'a'], [2, 'b'], [5, 'c']]);
    const players = seats();
    players[0].cash = 900;   // 900 + 102 = 1002
    players[1].cash = 880;   // 880 + 119 = 999
    players[2].cash = 1000;  // 1000 + 136 = 1136
    players[3].cash = 1136;  // 空手 1136
    const rows = rankSeats(players, owners, board);
    expect(rows.map((row) => row.seat)).toEqual(['c', 'd', 'a', 'b']);
    expect(rows.map((row) => row.rank)).toEqual([1, 1, 3, 4]);
    expect(rows[0].estate).toBe(136);
  });

  it('地产归属按格号排序返回', () => {
    const owners = new Map<number, string>([[9, 'a'], [1, 'a'], [5, 'b']]);
    expect(propertiesOf('a', owners)).toEqual([1, 9]);
    expect(propertiesOf('c', owners)).toEqual([]);
  });
});

describe('快照校验', () => {
  it('正常快照能读回', () => {
    const parsed = validateState(baseState(), 'a', 1);
    expect(parsed.status).toBe('playing');
    expect(parsed.seats.length).toBe(SEAT_COUNT);
    expect(parsed.phase).toBe('await_roll');
  });

  it('版本不认识要抛错', () => {
    expect(() => validateState({ ...baseState(), version: 2 }, 'a', 1)).toThrow(/存档版本/);
    expect(() => validateState({ ...baseState(), mapVersion: 1 }, 'a', 1)).toThrow(/规则版本与地图版本/);
  });

  it('开局后席位不满四席要抛错', () => {
    const state = baseState();
    state.seats = seats().slice(0, 3);
    expect(() => validateState(state, 'a', 1)).toThrow(/四席/);
  });

  it('开局前席位是 1..4 席，坐满之前也能读回', () => {
    for (const count of [0, 1, 2, 3, 4]) {
      const state = { ...baseState(), status: 'open', seats: seats().slice(0, count), firstSeat: 0, turnNo: 0, phase: null, deadline: 0 };
      const parsed = validateState(state, 'a', 1);
      expect(parsed.status).toBe('open');
      expect(parsed.seats.length).toBe(count);
    }
    const tooMany = { ...baseState(), status: 'open', seats: [...seats(), { id: 'e', name: '戊', cash: 1000, pos: 0 }], turnNo: 0, phase: null, deadline: 0 };
    expect(() => validateState(tooMany, 'a', 1)).toThrow(/最多 4 席/);
  });

  it('所有人指向不存在的席位要抛错', () => {
    const state = baseState();
    state.owners = { 1: 'z' };
    expect(() => validateState(state, 'a', 1)).toThrow(/所有人不存在/);
  });

  it('把非地产记成有主要抛错', () => {
    const state = baseState();
    state.owners = { 3: 'a' };
    expect(() => validateState(state, 'a', 1)).toThrow(/非地产/);
  });

  it('待购买阶段却没有待买地块要抛错', () => {
    const state = baseState();
    state.phase = 'await_buy';
    state.pending = null;
    expect(() => validateState(state, 'a', 1)).toThrow(/待购买阶段缺少待买地块/);
  });

  it('待掷骰阶段不该带着待买地块', () => {
    const state = baseState();
    state.phase = 'await_roll';
    state.pending = 1;
    expect(() => validateState(state, 'a', 1)).toThrow(/不该有待买地块/);
  });

  it('待买地块已经有主要抛错', () => {
    const state = baseState();
    state.phase = 'await_buy';
    state.pending = 1;
    state.owners = { 1: 'b' };
    expect(() => validateState(state, 'a', 1)).toThrow(/已经有主/);
  });

  it('回合号超出总手数要抛错', () => {
    expect(() => validateState({ ...baseState(), turnNo: 49 }, 'a', 1)).toThrow(/回合序号/);
    expect(() => validateState({ ...baseState(), rulesVersion: 1, mapVersion: 1, turnNo: 25 }, 'a', 1)).toThrow(/回合序号/);
  });

  it('金币为负要抛错', () => {
    const state = baseState();
    (state.seats as Monopoly2dSeatState[])[0].cash = -1;
    expect(() => validateState(state, 'a', 1)).toThrow(/金币/);
  });

  it('结束的桌子必须带四行排名', () => {
    const state = baseState();
    state.status = 'ended';
    state.phase = null;
    state.deadline = 0;
    expect(() => validateState(state, 'a', 1)).toThrow(/排名/);
  });
});
