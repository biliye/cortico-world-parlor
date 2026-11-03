import { describe, expect, it } from 'vitest';
import { TableError, type TableStep } from '../src/room/table-engine.ts';
import { DoudizhuTable } from '../src/room/games/doudizhu-table.ts';
import {
  canBeat, DECK, moveLabel, parseMove, PHYSICAL_DECK, RANKS, sortCards, sortPhys, suggestMove,
  type Card, type PhysCard,
} from '../src/room/games/doudizhu.ts';
import { chooseBid, chooseMove } from '../src/room/games/doudizhu-bot.ts';

/**
 * 斗地主端到端对局流：重上桌到打到结束，14 种牌形一个不漏。
 *
 * 与 doudizhu.test.ts（规则单点）、doudizhu-table.test.ts（桌面单点）、
 * doudizhu-assist.test.ts（建议）互补，这里是「导演式」全牌形走桌：
 * - 识别：15 种单张、对子/三张全点位、三带一/二（含王翅膀）、顺子 5–12 张、
 *   连对、飞机不带/带单/带对（翅膀成对、双王、跨组特例）、四带二/两对、炸弹、王炸；
 * - 压牌：同型同长比主牌、同型异长拒绝、异型同尺寸拒绝、炸弹与王炸层级；
 * - 整局：叫地主（中途叫、全不叫重发、5 轮后强制）、双过回领出权、领出不能过、
 *   春天/反春/炸弹倍数（被压的炸弹也计）、超时与 bot 代打；
 * - 重上桌：exportState→restoreState 跨停机续打到终局、旧存档带牌主牌按实际牌重算、
 *   rearm 截止时刻、autoPlay 代打矩阵。
 *
 * 导演手段：真开局→exportState→按剧本重排三家手牌→restoreState，
 * 本身就走在「短停机续局」的真实恢复路径上。
 */

type R = string;
type AnyView = Record<string, any>;

const HOST = { id: 'a', name: '阿岚' };
const GUESTS = [{ id: 'b', name: '小满' }, { id: 'c', name: '阿满' }];
const SEATS = ['a', 'b', 'c'];

const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const move = (cards: R[]) => {
  const parsed = parseMove(cards);
  if (!parsed) throw new Error(`应该认得：${cards.join(' ')}`);
  return parsed;
};

const playEvent = (step: TableStep | null): { data?: Record<string, unknown> } | undefined => (
  step?.events.find((event) => event.data?.action === 'play')
);

const expectLabel = (step: TableStep, label: string): void => {
  expect(playEvent(step)?.data?.label).toBe(label);
};

interface PhysLike { rank: string; suit: 'S' | 'H' | 'C' | 'D' | null }

/** 按点数从牌池抠实体牌；池被消费，三家加底牌必须恰好分完 54 张。 */
const carve = (pool: PhysCard[], ranks: readonly R[]): PhysCard[] => ranks.map((rank) => {
  const index = pool.findIndex((card) => card.rank === rank);
  if (index < 0) throw new Error(`测试牌组缺牌：${rank}`);
  return pool.splice(index, 1)[0];
});

interface HandSpec { landlord?: R[]; bottom?: R[]; b?: R[]; c?: R[] }

/**
 * 开一桌真局、a 叫地主，再把三家手牌换成剧本指定的牌（不足的按牌池顺序补齐）。
 * 默认轮到 a 领出，deadline 拉远避免 tick 抢戏。
 */
const directedTable = (
  spec: HandSpec = {},
  opts: { turn?: string; deadline?: number; botSeats?: string[]; botDelayMs?: number } = {},
): DoudizhuTable => {
  const bottom = spec.bottom ?? [];
  const table = new DoudizhuTable({ host: { ...HOST }, now: 0, rng: seeded(97), botDelayMs: opts.botDelayMs });
  table.join({ ...GUESTS[0] });
  table.join({ ...GUESTS[1] });
  table.start('a', 0);
  table.act('a', { move: 'bid', call: true }, 0);
  const state = table.exportState() as Record<string, any>;
  const pool = PHYSICAL_DECK.map((card) => ({ ...card }));
  // 先排剧本牌，再按牌池顺序把空位补满；补牌只认「这副牌还剩几张」的账。
  // 底牌已含在地主手牌里，bottomCards 从地主实体牌里挑同点数的出来展示（与 crown 行为一致）。
  const maxOf = (rank: R): number => (rank === 'SJ' || rank === 'BJ' ? 1 : 4);
  const spoken: Record<string, number> = {};
  const lists = [
    sortCards([...(spec.landlord ?? []), ...bottom] as Card[]),
    sortCards((spec.b ?? []) as Card[]),
    sortCards((spec.c ?? []) as Card[]),
  ] as Card[][];
  for (const ranks of lists) for (const rank of ranks) spoken[rank] = (spoken[rank] ?? 0) + 1;
  const targets = [20, 17, 17];
  for (const card of PHYSICAL_DECK) {
    const seat = lists.findIndex((ranks, index) => ranks.length < targets[index]);
    if (seat < 0) break;
    if ((spoken[card.rank] ?? 0) >= maxOf(card.rank)) continue;
    lists[seat].push(card.rank);
    spoken[card.rank] = (spoken[card.rank] ?? 0) + 1;
  }
  const rankLists = lists;
  const phys = rankLists.map((ranks) => sortPhys(carve(pool, ranks)));
  if (pool.length !== 0) throw new Error(`牌池没分完，剩 ${pool.length} 张`);
  const bottomPhys: PhysCard[] = [];
  for (const rank of bottom) {
    const card = phys[0].find((entry) => entry.rank === rank && !bottomPhys.includes(entry));
    if (!card) throw new Error(`底牌 ${rank} 不在地主手里`);
    bottomPhys.push(card);
  }
  state.seats = state.seats.map((seat: Record<string, unknown>, index: number) => ({
    ...seat,
    role: index === 0 ? 'landlord' : 'farmer',
    plays: 0,
    bot: opts.botSeats?.includes(SEATS[index]) === true,
    hand: [...rankLists[index]],
    cards: phys[index].map((card) => ({ ...card })),
  }));
  state.hands = rankLists.map((ranks) => [...ranks]);
  state.handCards = phys.map((cards) => cards.map((card) => ({ ...card })));
  state.bottom = [...bottom];
  state.bottomCards = bottomPhys.map((card) => ({ ...card }));
  state.status = 'playing';
  state.turnId = opts.turn ?? 'a';
  state.deadline = opts.deadline ?? 60_000;
  state.lastPlay = null;
  state.passes = 0;
  state.roundPlays = [];
  state.roundPasses = [];
  state.bombs = 0;
  state.result = '';
  table.restoreState(state);
  return table;
};

const viewOf = (table: DoudizhuTable, id: string): AnyView => table.view(id) as AnyView;
const publicOf = (table: DoudizhuTable): AnyView => table.public() as AnyView;
const turnSeat = (table: DoudizhuTable): string => SEATS.find((id) => viewOf(table, id).yourTurn)!;
const textOf = (step: TableStep | null): string => (step?.events ?? []).map((event) => event.text).join('\n');
const endEvent = (step: TableStep | null): Record<string, unknown> | undefined => (
  step?.events.find((event) => event.type === 'parlor.table.end')?.data as Record<string, unknown> | undefined
);

/** 读引擎是否还在打；独立函数避免 TS 把循环内 act 后的状态误收窄成不可能。 */
const stillGoing = (table: DoudizhuTable): boolean => table.status !== 'ended';

describe('斗地主全牌形：识别', () => {
  it.each(RANKS.map((rank) => [rank] as const))('单张 %s 认得，标签就是它自己', (rank) => {
    const parsed = move([rank]);
    expect(parsed).toMatchObject({ type: 'single', rank: RANKS.indexOf(rank) });
    expect(moveLabel(parsed)).toBe(`单张 ${rank}`);
  });

  it.each(RANKS.slice(0, 13).map((rank) => [rank] as const))('对子 %s 认得', (rank) => {
    expect(move([rank, rank])).toMatchObject({ type: 'pair', rank: RANKS.indexOf(rank) });
  });

  it.each(RANKS.slice(0, 13).map((rank) => [rank] as const))('三张 %s 认得', (rank) => {
    expect(move([rank, rank, rank])).toMatchObject({ type: 'triple', rank: RANKS.indexOf(rank) });
  });

  it('三带一：翅膀可以是任意单张，包括王；四个同点先判炸弹', () => {
    expect(move(['3', '3', '3', 'SJ'])).toMatchObject({ type: 'triple-single', rank: 0 });
    expect(move(['3', '3', '3', 'BJ'])).toMatchObject({ type: 'triple-single', rank: 0 });
    expect(move(['2', '2', '2', 'SJ'])).toMatchObject({ type: 'triple-single', rank: 12 });
    expect(move(['3', '3', '3', '3'])).toMatchObject({ type: 'bomb', rank: 0 });
    // 主体取三张那组，哪怕对子排前面。
    expect(move(['3', '3', '4', '4', '4'])).toMatchObject({ type: 'triple-pair', rank: RANKS.indexOf('4') });
  });

  it('三带二：翅膀必须恰好是对子；双王凑不成对', () => {
    expect(move(['3', '3', '3', '2', '2'])).toMatchObject({ type: 'triple-pair', rank: 0 });
    expect(move(['K', 'K', 'K', '2', '2'])).toMatchObject({ type: 'triple-pair', rank: RANKS.indexOf('K') });
    expect(parseMove(['3', '3', '3', 'SJ', 'BJ'])).toBeNull();
    expect(parseMove(['3', '3', '3', '5', '5', '5'])).toBeNull();
  });

  it('顺子：5 到 12 张连续，3 起到 A 止', () => {
    for (let length = 5; length <= 12; length++) {
      const cards = RANKS.slice(0, length);
      expect(move([...cards])).toMatchObject({ type: 'straight', rank: 0, length });
    }
    expect(move(['10', 'J', 'Q', 'K', 'A'])).toMatchObject({ type: 'straight', rank: RANKS.indexOf('10') });
    expect(parseMove(['3', '4', '5', '6'])).toBeNull();
    expect(parseMove(['J', 'Q', 'K', 'A', '2'])).toBeNull();
    expect(parseMove(['A', '2', '3', '4', '5'])).toBeNull();
    expect(parseMove(['9', '10', 'J', 'Q', 'K', 'SJ'])).toBeNull();
  });

  it('连对：3 对起到 A，2 与王不进连对', () => {
    expect(move(['3', '3', '4', '4', '5', '5'])).toMatchObject({ type: 'pair-straight', rank: 0, length: 3 });
    expect(move(['7', '7', '8', '8', '9', '9', '10', '10']))
      .toMatchObject({ type: 'pair-straight', rank: RANKS.indexOf('7'), length: 4 });
    expect(move(['Q', 'Q', 'K', 'K', 'A', 'A'])).toMatchObject({ type: 'pair-straight', rank: RANKS.indexOf('Q') });
    expect(move(RANKS.slice(0, 12).flatMap((rank) => [rank, rank])))
      .toMatchObject({ type: 'pair-straight', rank: 0, length: 12 });
    expect(parseMove(['3', '3', '4', '4'])).toBeNull();
    expect(parseMove(['2', '2', '3', '3', '4', '4'])).toBeNull();
  });

  it('飞机不带：2 组起、A 止、必须连续', () => {
    expect(move(['3', '3', '3', '4', '4', '4'])).toMatchObject({ type: 'airplane', rank: 0, length: 2 });
    expect(move(['3', '3', '3', '4', '4', '4', '5', '5', '5'])).toMatchObject({ type: 'airplane', length: 3 });
    expect(move(['J', 'J', 'J', 'Q', 'Q', 'Q', 'K', 'K', 'K', 'A', 'A', 'A']))
      .toMatchObject({ type: 'airplane', rank: RANKS.indexOf('J'), length: 4 });
    expect(move(RANKS.slice(0, 12).flatMap((rank) => [rank, rank, rank])))
      .toMatchObject({ type: 'airplane', length: 12 });
    expect(parseMove(['3', '3', '3', '5', '5', '5'])).toBeNull();
    expect(parseMove(['2', '2', '2', '3', '3', '3'])).toBeNull();
    expect(parseMove(['A', 'A', 'A', '2', '2', '2'])).toBeNull();
  });

  it('飞机带单：翅膀可以是两张散单、一对、甚至双王', () => {
    expect(move(['3', '3', '3', '4', '4', '4', '5', '6'])).toMatchObject({ type: 'airplane-single', rank: 0, length: 2 });
    expect(move(['3', '3', '3', '4', '4', '4', '5', '5'])).toMatchObject({ type: 'airplane-single', length: 2 });
    expect(move(['3', '3', '3', '4', '4', '4', 'SJ', 'BJ'])).toMatchObject({ type: 'airplane-single', length: 2 });
    expect(move(['3', '3', '3', '4', '4', '4', '2', '2'])).toMatchObject({ type: 'airplane-single', length: 2 });
    expect(move(['K', 'K', 'K', 'A', 'A', 'A', '2', '2']))
      .toMatchObject({ type: 'airplane-single', rank: RANKS.indexOf('K') });
    expect(move(['3', '3', '3', '4', '4', '4', '5', '5', '5', '6', '6', '7']))
      .toMatchObject({ type: 'airplane-single', length: 3 });
    // 跨组特例：44445555 本实现判 444 555 带两张单（4、5 各剩一张）。
    expect(move(['4', '4', '4', '4', '5', '5', '5', '5']))
      .toMatchObject({ type: 'airplane-single', rank: RANKS.indexOf('4'), length: 2 });
    // 翅膀数不对都不是飞机带单。
    expect(parseMove(['3', '3', '3', '4', '4', '4', '5', '5', '6'])).toBeNull();
    expect(parseMove(['3', '3', '3', '4', '4', '4', '5', '6', '7'])).toBeNull();
    expect(parseMove(['3', '3', '3', '4', '4', '4', '5', '5', '5', '6', '6', '6', '7', '8', '9'])).toBeNull();
  });

  it('飞机带对：翅膀必须恰好是对子，混单张不认', () => {
    expect(move(['3', '3', '3', '4', '4', '4', '5', '5', '6', '6']))
      .toMatchObject({ type: 'airplane-pair', rank: 0, length: 2 });
    expect(move(['3', '3', '3', '4', '4', '4', '5', '5', '5', '6', '6', '7', '7', '8', '8']))
      .toMatchObject({ type: 'airplane-pair', length: 3 });
    expect(move(['3', '3', '3', '4', '4', '4', '5', '5', '5', '6', '6', '6', '7', '7', '7', '8', '8', '9', '9', '10', '10', 'J', 'J', 'Q', 'Q']))
      .toMatchObject({ type: 'airplane-pair', length: 5 });
    expect(parseMove(['3', '3', '3', '4', '4', '4', '5', '5', '6'])).toBeNull();
    expect(parseMove(['3', '3', '3', '4', '4', '4', '5', '5', '6', '6', '6'])).toBeNull();
    expect(parseMove(['3', '3', '3', '4', '4', '4', '5', '6', '6', '6'])).toBeNull();
    // 333444555 本身是不带翅膀的飞机，不是「带零对」。
    expect(move(['3', '3', '3', '4', '4', '4', '5', '5', '5'])).toMatchObject({ type: 'airplane', length: 3 });
  });

  it('四带二：两张翅膀随意，可以是一对、也可以是双王', () => {
    expect(move(['4', '4', '4', '4', '5', '6'])).toMatchObject({ type: 'four-two', rank: RANKS.indexOf('4') });
    expect(move(['4', '4', '4', '4', '5', '5'])).toMatchObject({ type: 'four-two', rank: RANKS.indexOf('4') });
    expect(move(['4', '4', '4', '4', 'SJ', 'BJ'])).toMatchObject({ type: 'four-two', rank: RANKS.indexOf('4') });
    expect(move(['2', '2', '2', '2', '3', '4'])).toMatchObject({ type: 'four-two', rank: 12 });
    // 22222 不存在，但 2222+22 是四带二不是三带二。
    expect(move(['2', '2', '2', '2', '5', '5'])).toMatchObject({ type: 'four-two', rank: 12 });
    expect(parseMove(['4', '4', '4', '4', '4', '5', '6'])).toBeNull();
    expect(parseMove(['4', '4', '4', '4', '4', '4', '5', '6'])).toBeNull();
  });

  it('四带两对：两副对子，混单张不认；三副对子也不认；44445555 优先判飞机带单', () => {
    expect(move(['4', '4', '4', '4', '5', '5', '6', '6']))
      .toMatchObject({ type: 'four-two-pair', rank: RANKS.indexOf('4') });
    // 四带两对固定 8 张：四张加三副对子不是更长的四带两对，也没有别的牌形可套。
    expect(parseMove(['4', '4', '4', '4', '5', '5', '6', '6', '7', '7', '8', '8'])).toBeNull();
    expect(parseMove(['4', '4', '4', '4', '3', '3', '5', 'SJ'])).toBeNull();
    expect(parseMove(['4', '4', '4', '4', '5', '5', '6'])).toBeNull();
    expect(move(['4', '4', '4', '4', '5', '5', '5', '5'])).toMatchObject({ type: 'airplane-single' });
  });

  it('炸弹与王炸', () => {
    expect(move(['3', '3', '3', '3'])).toMatchObject({ type: 'bomb', rank: 0 });
    expect(move(['2', '2', '2', '2'])).toMatchObject({ type: 'bomb', rank: 12 });
    expect(move(['SJ', 'BJ'])).toMatchObject({ type: 'rocket' });
    expect(move(['BJ', 'SJ'])).toMatchObject({ type: 'rocket' });
    expect(parseMove(['SJ', 'BJ', '3'])).toBeNull();
  });
});

describe('斗地主全牌形：压牌矩阵', () => {
  it('单张全序：BJ > SJ > 2 > A > … > 3', () => {
    expect(canBeat(move(['BJ']), move(['SJ']))).toBe(true);
    expect(canBeat(move(['SJ']), move(['BJ']))).toBe(false);
    expect(canBeat(move(['SJ']), move(['2']))).toBe(true);
    expect(canBeat(move(['2']), move(['A']))).toBe(true);
    expect(canBeat(move(['A']), move(['2']))).toBe(false);
    expect(canBeat(move(['4']), move(['3']))).toBe(true);
    expect(canBeat(move(['3']), move(['4']))).toBe(false);
  });

  it('对子与三张同理：22 压 AA，王不成对不成三', () => {
    expect(canBeat(move(['2', '2']), move(['A', 'A']))).toBe(true);
    expect(canBeat(move(['A', 'A']), move(['2', '2']))).toBe(false);
    expect(canBeat(move(['2', '2', '2']), move(['A', 'A', 'A']))).toBe(true);
    expect(canBeat(move(['A', 'A', 'A']), move(['2', '2', '2']))).toBe(false);
  });

  it('同型同长比主牌；同型异长一律拒绝', () => {
    expect(canBeat(move(['4', '5', '6', '7', '8']), move(['3', '4', '5', '6', '7']))).toBe(true);
    expect(canBeat(move(['3', '4', '5', '6', '7', '8']), move(['3', '4', '5', '6', '7']))).toBe(false);
    expect(canBeat(move(['4', '4', '5', '5', '6', '6', '7', '7']), move(['3', '3', '4', '4', '5', '5']))).toBe(false);
    expect(canBeat(move(['3', '3', '4', '4', '5', '5']), move(['4', '4', '5', '5', '6', '6', '7', '7']))).toBe(false);
    expect(canBeat(move(['5', '5', '5', '6', '6', '6']), move(['3', '3', '3', '4', '4', '4']))).toBe(true);
    expect(canBeat(move(['3', '3', '3', '4', '4', '4']), move(['5', '5', '5', '6', '6', '6']))).toBe(false);
    expect(canBeat(move(['5', '5', '5', '6', '6', '6', '7', '7', '7']), move(['3', '3', '3', '4', '4', '4']))).toBe(false);
    expect(canBeat(move(['5', '5', '5', '6', '6', '6', '7', '8']), move(['3', '3', '3', '4', '4', '4', '5', '6']))).toBe(true);
    expect(canBeat(move(['5', '5', '5', '6', '6', '6', '7', '7', '7', '8', '9', '10']),
      move(['3', '3', '3', '4', '4', '4', '5', '6']))).toBe(false);
    expect(canBeat(move(['5', '5', '5', '6', '6', '6', '7', '7', '8', '8']),
      move(['3', '3', '3', '4', '4', '4', '5', '5', '6', '6']))).toBe(true);
    expect(canBeat(move(['5', '5', '5', '6', '6', '6', '7', '7', '7', '8', '8', '9', '9', '10', '10']),
      move(['3', '3', '3', '4', '4', '4', '5', '5', '6', '6']))).toBe(false);
  });

  it('异型同尺寸也拒绝；炸弹不受尺寸限制', () => {
    expect(canBeat(move(['4', '4']), move(['5']))).toBe(false);
    expect(canBeat(move(['6']), move(['4', '4']))).toBe(false);
    expect(canBeat(move(['8', '8', '8', '3']), move(['9', '9', '9']))).toBe(false);
    expect(canBeat(move(['9', '9', '9']), move(['8', '8', '8', '3']))).toBe(false);
    expect(canBeat(move(['5', '5', '5', '5', '9', '9', 'Q', 'Q']), move(['3', '3', '3', '4', '4', '4', '5', '6']))).toBe(false);
    expect(canBeat(move(['3', '3', '3', '4', '4', '4', '5', '6']), move(['5', '5', '5', '5', '9', '9', 'Q', 'Q']))).toBe(false);
    expect(canBeat(move(['5', '5', '5', '5', '9', 'Q']), move(['3', '3', '3', '4', '4', '4', '5', '5', '6', '6']))).toBe(false);
    expect(canBeat(move(['3', '3', '3', '3']), move(['2']))).toBe(true);
    expect(canBeat(move(['3', '3', '3', '3']), move(['K', 'K', 'K', 'A', 'A', 'A', '2', '2']))).toBe(true);
    expect(canBeat(move(['3', '3', '3', '3']), move(['3', '3', '3', '3', 'SJ', 'BJ']))).toBe(true);
    expect(canBeat(move(['3', '3', '3', '3']), move(['4', '4', '4', '4', '5', '5', '6', '6']))).toBe(true);
  });

  it('炸弹对炸弹比点数，王炸封顶，王炸不可再被王炸压', () => {
    expect(canBeat(move(['2', '2', '2', '2']), move(['A', 'A', 'A', 'A']))).toBe(true);
    expect(canBeat(move(['A', 'A', 'A', 'A']), move(['K', 'K', 'K', 'K']))).toBe(true);
    expect(canBeat(move(['4', '4', '4', '4']), move(['3', '3', '3', '3']))).toBe(true);
    expect(canBeat(move(['3', '3', '3', '3']), move(['4', '4', '4', '4']))).toBe(false);
    expect(canBeat(move(['SJ', 'BJ']), move(['2', '2', '2', '2']))).toBe(true);
    expect(canBeat(move(['2', '2', '2', '2']), move(['SJ', 'BJ']))).toBe(false);
    expect(canBeat(move(['SJ', 'BJ']), move(['SJ', 'BJ']))).toBe(false);
  });
});

describe('导演式：每个牌形都能真的领出', () => {
  const LEADS: { name: string; cards: R[]; label: string }[] = [
    { name: '单张 3', cards: ['3'], label: '单张 3' },
    { name: '单张 大王', cards: ['BJ'], label: '单张 BJ' },
    { name: '对子 5', cards: ['5', '5'], label: '对子 5' },
    { name: '对子 2', cards: ['2', '2'], label: '对子 2' },
    { name: '三张 8', cards: ['8', '8', '8'], label: '三张 8' },
    { name: '三带一 9 带 3', cards: ['9', '9', '9', '3'], label: '三带一 9' },
    { name: '三带一 6 带大王', cards: ['6', '6', '6', 'BJ'], label: '三带一 6' },
    { name: '三带二 J 带 QQ', cards: ['J', 'J', 'J', 'Q', 'Q'], label: '三带二 J' },
    { name: '三带二 2 带 KK', cards: ['2', '2', '2', 'K', 'K'], label: '三带二 2' },
    { name: '顺子 4–8', cards: ['4', '5', '6', '7', '8'], label: '顺子 4–8' },
    { name: '顺子 10–A', cards: ['10', 'J', 'Q', 'K', 'A'], label: '顺子 10–A' },
    { name: '连对 7–9', cards: ['7', '7', '8', '8', '9', '9'], label: '连对 7–9' },
    { name: '连对 Q–A', cards: ['Q', 'Q', 'K', 'K', 'A', 'A'], label: '连对 Q–A' },
    { name: '飞机 3–4', cards: ['3', '3', '3', '4', '4', '4'], label: '飞机 3–4' },
    { name: '飞机带单 3–4 带 5、6', cards: ['3', '3', '3', '4', '4', '4', '5', '6'], label: '飞机带单 3–4' },
    { name: '飞机带单 3–4 带 5、小王', cards: ['3', '3', '3', '4', '4', '4', '5', 'SJ'], label: '飞机带单 3–4' },
    { name: '飞机带对 3–4 带 55、66', cards: ['3', '3', '3', '4', '4', '4', '5', '5', '6', '6'], label: '飞机带对 3–4' },
    { name: '四带二 4 带 5、6', cards: ['4', '4', '4', '4', '5', '6'], label: '四带二 4' },
    { name: '四带二 4 带 55', cards: ['4', '4', '4', '4', '5', '5'], label: '四带二 4' },
    { name: '四带两对 4', cards: ['4', '4', '4', '4', '5', '5', '6', '6'], label: '四带两对 4' },
    { name: '炸弹 2', cards: ['2', '2', '2', '2'], label: '炸弹 2' },
    { name: '王炸', cards: ['SJ', 'BJ'], label: '王炸' },
  ];

  it.each(LEADS)('$name：地主领出成功、标签正确、轮到下家', ({ cards, label }) => {
    const table = directedTable({ landlord: cards });
    const before = viewOf(table, 'a').hand.length;
    const step = table.act('a', { move: 'play', cards }, 0);
    expectLabel(step, label);
    expect(viewOf(table, 'a').hand.length).toBe(before - cards.length);
    expect(viewOf(table, 'b').yourTurn).toBe(true);
    expect(step.views).toEqual(['b']);
    expect(publicOf(table).lastPlay.label).toBe(label);
    expect(publicOf(table).lastPlay.cards).toEqual(sortCards(cards as Card[]));
  });
});

describe('导演式：压牌与拒绝（走真桌子）', () => {
  interface BeatCase { name: string; lead: R[]; reply: R[]; ok?: boolean; error?: RegExp }

  const CASES: BeatCase[] = [
    { name: '三带二只比主体', lead: ['9', '9', '9', '4', '4'], reply: ['J', 'J', 'J', '8', '8'], ok: true },
    { name: '三带二主体小压不过', lead: ['9', '9', '9', '4', '4'], reply: ['8', '8', '8', '7', '7'] },
    { name: '三带一带王照比主体', lead: ['6', '6', '6', 'BJ'], reply: ['7', '7', '7', '3'], ok: true },
    { name: '三带一带王主体小压不过', lead: ['6', '6', '6', 'BJ'], reply: ['5', '5', '5', 'A'] },
    { name: '同长顺子接得上', lead: ['3', '4', '5', '6', '7'], reply: ['4', '5', '6', '7', '8'], ok: true },
    { name: '高顺子接低顺子', lead: ['3', '4', '5', '6', '7'], reply: ['9', '10', 'J', 'Q', 'K'], ok: true },
    { name: '顺子长度不同压不过', lead: ['3', '4', '5', '6', '7'], reply: ['4', '5', '6', '7', '8', '9'] },
    { name: '2 不能进顺子', lead: ['3', '4', '5', '6', '7'], reply: ['J', 'Q', 'K', 'A', '2'], error: /不是合法/ },
    { name: '连对接连对', lead: ['7', '7', '8', '8', '9', '9'], reply: ['8', '8', '9', '9', '10', '10'], ok: true },
    { name: '连对两对不够长', lead: ['7', '7', '8', '8', '9', '9'], reply: ['8', '8', '9', '9'], error: /不是合法/ },
    { name: '飞机接飞机', lead: ['3', '3', '3', '4', '4', '4'], reply: ['5', '5', '5', '6', '6', '6'], ok: true },
    { name: '飞机组数不同压不过', lead: ['3', '3', '3', '4', '4', '4'], reply: ['6', '6', '6', '7', '7', '7', '8', '8', '8'] },
    { name: 'AAA222 不是飞机（2 不入组）', lead: ['3', '3', '3', '4', '4', '4'], reply: ['A', 'A', 'A', '2', '2', '2'], error: /不是合法/ },
    { name: '飞机带单只比主体', lead: ['3', '3', '3', '4', '4', '4', '8', '9'], reply: ['5', '5', '5', '6', '6', '6', '7', '8'], ok: true },
    { name: '飞机带单翅膀数量不认', lead: ['3', '3', '3', '4', '4', '4', '5', '5', '6', '6'], reply: ['7', '7', '7', '8', '8', '8', '9', '9', '10'], error: /不是合法/ },
    { name: '飞机带对接飞机带对', lead: ['3', '3', '3', '4', '4', '4', '5', '5', '6', '6'], reply: ['7', '7', '7', '8', '8', '8', '9', '9', '10', '10'], ok: true },
    { name: '飞机带单压不了飞机带对（异型同尺寸）', lead: ['3', '3', '3', '4', '4', '4', '5', '5', '6', '6'], reply: ['7', '7', '7', '8', '8', '8', '9', '10'] },
    { name: '四带二比主体', lead: ['4', '4', '4', '4', '5', '6'], reply: ['8', '8', '8', '8', '9', 'Q'], ok: true },
    { name: '四带二主体小压不过', lead: ['4', '4', '4', '4', '5', '6'], reply: ['3', '3', '3', '3', 'K', 'Q'] },
    { name: '四带两对比主体', lead: ['4', '4', '4', '4', '5', '5', '6', '6'], reply: ['8', '8', '8', '8', '9', '9', '10', '10'], ok: true },
    { name: '四带两对主体小压不过', lead: ['4', '4', '4', '4', '5', '5', '6', '6'], reply: ['3', '3', '3', '3', '9', '9', '10', '10'] },
    { name: '三张不能被三带一压', lead: ['9', '9', '9'], reply: ['10', '10', '10', '3'] },
    { name: '三张接三张', lead: ['9', '9', '9'], reply: ['10', '10', '10'], ok: true },
    { name: '王炸不可被炸弹压', lead: ['SJ', 'BJ'], reply: ['2', '2', '2', '2'] },
  ];

  it.each(CASES)('$name', ({ lead, reply, ok, error }) => {
    const table = directedTable({ landlord: lead, b: reply });
    table.act('a', { move: 'play', cards: lead }, 0);
    if (ok) {
      const step = table.act('b', { move: 'play', cards: reply }, 0);
      expectLabel(step, moveLabel(move(reply)));
      expect(viewOf(table, 'b').hand.length).toBe(17 - reply.length);
      expect(viewOf(table, 'c').yourTurn).toBe(true);
    } else {
      const before = table.exportState();
      expect(() => table.act('b', { move: 'play', cards: reply }, 0)).toThrow(error ?? /压不过/);
      expect(table.exportState()).toEqual(before);
    }
  });

  it('炸弹链：小炸弹压不动，大炸弹接得住，王炸封顶且倍数逐个翻', () => {
    const table = directedTable({
      landlord: ['5', '5', '5', '5'],
      b: ['4', '4', '4', '4', '8', '8', '8', '8'],
      c: ['2', '2', '2', '2', 'SJ', 'BJ'],
    });
    expect(publicOf(table).multiplier).toBe(1);
    table.act('a', { move: 'play', cards: ['5', '5', '5', '5'] }, 0);
    expect(publicOf(table).multiplier).toBe(2);
    expect(() => table.act('b', { move: 'play', cards: ['4', '4', '4', '4'] }, 0)).toThrow(/压不过/);
    table.act('b', { move: 'play', cards: ['8', '8', '8', '8'] }, 0);
    expect(publicOf(table).multiplier).toBe(4);
    table.act('c', { move: 'play', cards: ['2', '2', '2', '2'] }, 0);
    expect(publicOf(table).multiplier).toBe(8);
    // 王炸之前：炸弹对炸弹只比点数，6 压不动 2。
    expect(() => table.act('a', { move: 'play', cards: ['6', '6', '6', '6'] }, 0)).toThrow(/压不过/);
    table.act('a', { move: 'pass' }, 0);
    table.act('b', { move: 'pass' }, 0);
    expect(viewOf(table, 'c').yourTurn).toBe(true);
    table.act('c', { move: 'play', cards: ['SJ', 'BJ'] }, 0);
    expect(publicOf(table).multiplier).toBe(16);
    // 王炸之后任何牌都压不动；a、b 都过 → c 重新领出。
    expect(() => table.act('a', { move: 'play', cards: ['7', '7', '7', '7'] }, 0)).toThrow(/压不过/);
    table.act('a', { move: 'pass' }, 0);
    const step = table.act('b', { move: 'pass' }, 0);
    expect(textOf(step)).toContain('重新领出');
    expect(viewOf(table, 'c').yourTurn).toBe(true);
    expect(viewOf(table, 'c').canPass).toBe(false);
  });

  it('三张被同尺寸的炸弹接住：炸弹无视牌型', () => {
    const table = directedTable({ landlord: ['9', '9', '9'], b: ['4', '4', '4', '4'] });
    table.act('a', { move: 'play', cards: ['9', '9', '9'] }, 0);
    const step = table.act('b', { move: 'play', cards: ['4', '4', '4', '4'] }, 0);
    expectLabel(step, '炸弹 4');
    expect(publicOf(table).multiplier).toBe(2);
  });
});

describe('导演式：整局到结算', () => {
  it('地主 20 张一手飞机带单直接打完：立即终局、春天、倍数 2', () => {
    // 整手 = 5 组三张 + 一对 8 + 一对 9 + 单张 10；底牌 8 8 9 是其中的三张。
    const full = ['3', '3', '3', '4', '4', '4', '5', '5', '5', '6', '6', '6', '7', '7', '7', '8', '8', '9', '9', '10'];
    const bottom = ['8', '8', '9'];
    const explicit = [...full];
    for (const rank of bottom) explicit.splice(explicit.indexOf(rank), 1);
    const table = directedTable({ landlord: explicit, bottom });
    expect(viewOf(table, 'a').hand).toHaveLength(20);
    const step = table.act('a', { move: 'play', cards: full }, 0);
    expectLabel(step, '飞机带单 3–7');
    expect(step.ended).toBe(true);
    expect(table.status).toBe('ended');
    expect(publicOf(table).result).toContain('地主赢');
    expect(publicOf(table).result).toContain('春天');
    const end = endEvent(step);
    expect(end).toMatchObject({ spring: true, antiSpring: false, multiplier: 2, landlord: 'a' });
    expect(end?.winners).toEqual(['a']);
    expect(publicOf(table)).toMatchObject(end!);
    const recovered = new DoudizhuTable({ host: { ...HOST }, now: 0 });
    recovered.restoreState(table.exportState());
    expect(publicOf(recovered)).toMatchObject(end!);
    expect(viewOf(table, 'b').status).toBe('ended');
    expect(table.privateText('b', 1)).toContain('【斗地主·结束】');
    expect(table.nextWakeAt()).toBeUndefined();
    expect(() => table.act('b', { move: 'pass' }, 1)).toThrow(TableError);
  });

  it('农民一张没出过：地主赢算春天，54 张全程守恒', () => {
    const table = directedTable({
      landlord: ['3', '3', '3', '3', '4', '4', '4', '4', '5', '5', '5', '5', '6', '6', '6', '6', '7'],
      bottom: ['7', '7', '7'],
    });
    const played: Card[] = [];
    let step: TableStep | null = null;
    let guard = 0;
    while (guard++ < 100 && stillGoing(table)) {
      const hand = viewOf(table, 'a').hand;
      step = table.act('a', { move: 'play', cards: [hand[0]] }, 0);
      played.push(...sortCards([hand[0]]));
      if (!stillGoing(table)) break;
      table.act('b', { move: 'pass' }, 0);
      table.act('c', { move: 'pass' }, 0);
      const remaining = SEATS.flatMap((id) => viewOf(table, id).hand as Card[]);
      expect(sortCards([...remaining, ...played])).toEqual(sortCards([...DECK]));
    }
    expect(table.status).toBe('ended');
    const end = endEvent(step);
    expect(end).toMatchObject({ spring: true, multiplier: 2 });
    expect(end?.winners).toEqual(['a']);
    expect(publicOf(table).result).toContain('春天');
  });

  it('地主只出过一手：农民赢算反春', () => {
    const table = directedTable({
      landlord: ['3', '4', '4', '5', '5', '6', '6', '7', '7', '8', '8', '9', '9', '10', '10', 'J', 'J'],
      bottom: ['Q', 'Q', 'K'],
      b: ['4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'K', 'A', 'A', '2', '2', 'SJ', 'BJ'],
    });
    table.act('a', { move: 'play', cards: ['3'] }, 0);
    table.act('b', { move: 'play', cards: ['4'] }, 0);
    table.act('c', { move: 'pass' }, 0);
    table.act('a', { move: 'pass' }, 0);
    let step: TableStep | null = null;
    let guard = 0;
    while (viewOf(table, 'b').hand.length > 0 && guard++ < 100) {
      const hand = viewOf(table, 'b').hand as Card[];
      step = table.act('b', { move: 'play', cards: [hand[0]] }, 0);
      if (viewOf(table, 'b').hand.length === 0) break;
      table.act('c', { move: 'pass' }, 0);
      table.act('a', { move: 'pass' }, 0);
    }
    expect(table.status).toBe('ended');
    const end = endEvent(step);
    expect(end).toMatchObject({ spring: false, antiSpring: true, multiplier: 2 });
    expect(end?.winners).toEqual(['b', 'c']);
    expect(publicOf(table)).toMatchObject(end!);
    expect(publicOf(table).result).toContain('反春');
    expect(viewOf(table, 'a').hand).toHaveLength(19);
  });

  it('两个炸弹都被计倍（被压的也算），叠上反春是 8 倍', () => {
    const table = directedTable({
      landlord: ['3', '3', '3', '3', '4', '4', '4', '4', '5', '5', '5', '5', '6', '6', '6', '6', '7'],
      bottom: ['7', '7', '7'],
      b: ['8', '8', '8', '8'],
    });
    table.act('a', { move: 'play', cards: ['3', '3', '3', '3'] }, 0);
    table.act('b', { move: 'play', cards: ['8', '8', '8', '8'] }, 0);
    expect(publicOf(table).multiplier).toBe(4);
    table.act('c', { move: 'pass' }, 0);
    table.act('a', { move: 'pass' }, 0);
    let step: TableStep | null = null;
    let guard = 0;
    while (viewOf(table, 'b').hand.length > 0 && guard++ < 100) {
      const hand = viewOf(table, 'b').hand as Card[];
      step = table.act('b', { move: 'play', cards: [hand[0]] }, 0);
      if (viewOf(table, 'b').hand.length === 0) break;
      table.act('c', { move: 'pass' }, 0);
      table.act('a', { move: 'pass' }, 0);
    }
    const end = endEvent(step);
    expect(end).toMatchObject({ antiSpring: true, multiplier: 8 });
  });

  it('王炸计倍且之后炸弹也压不动；农民赢叠反春是 4 倍', () => {
    const table = directedTable({ landlord: ['3'], b: ['SJ', 'BJ'], c: ['2', '2', '2', '2'] });
    table.act('a', { move: 'play', cards: ['3'] }, 0);
    const rocket = table.act('b', { move: 'play', cards: ['SJ', 'BJ'] }, 0);
    expectLabel(rocket, '王炸');
    expect(publicOf(table).multiplier).toBe(2);
    expect(() => table.act('c', { move: 'play', cards: ['2', '2', '2', '2'] }, 0)).toThrow(/压不过/);
    table.act('c', { move: 'pass' }, 0);
    table.act('a', { move: 'pass' }, 0);
    let step: TableStep | null = null;
    let guard = 0;
    while (viewOf(table, 'b').hand.length > 0 && guard++ < 100) {
      const hand = viewOf(table, 'b').hand as Card[];
      step = table.act('b', { move: 'play', cards: [hand[0]] }, 0);
      if (viewOf(table, 'b').hand.length === 0) break;
      table.act('c', { move: 'pass' }, 0);
      table.act('a', { move: 'pass' }, 0);
    }
    const end = endEvent(step);
    expect(end).toMatchObject({ antiSpring: true, multiplier: 4 });
  });

  it('地主赢、农民出过一手：无春无反，倍数 1', () => {
    const table = directedTable({ landlord: ['3', '5'], bottom: ['6', '6', '6'], c: ['4'] });
    table.act('a', { move: 'play', cards: ['3'] }, 0);
    table.act('b', { move: 'pass' }, 0);
    table.act('c', { move: 'play', cards: ['4'] }, 0);
    table.act('a', { move: 'play', cards: ['5'] }, 0);
    table.act('b', { move: 'pass' }, 0);
    table.act('c', { move: 'pass' }, 0);
    let step: TableStep | null = null;
    let guard = 0;
    while (guard++ < 100 && stillGoing(table)) {
      const hand = viewOf(table, 'a').hand as Card[];
      step = table.act('a', { move: 'play', cards: [hand[0]] }, 0);
      if (!stillGoing(table)) break;
      table.act('b', { move: 'pass' }, 0);
      table.act('c', { move: 'pass' }, 0);
    }
    const end = endEvent(step);
    expect(end).toMatchObject({ spring: false, antiSpring: false, multiplier: 1 });
    expect(end?.winners).toEqual(['a']);
    expect(publicOf(table).result).toContain('地主赢');
    expect(publicOf(table).result).not.toContain('春天');
    expect(publicOf(table).result).not.toContain('反春');
  });

  it('双过回领出权：领出权回到上一手玩家，不是首家', () => {
    const table = directedTable({ landlord: ['3', '9'], b: ['5'], c: [] });
    table.act('a', { move: 'play', cards: ['3'] }, 0);
    table.act('b', { move: 'play', cards: ['5'] }, 0);
    table.act('c', { move: 'pass' }, 0);
    const step = table.act('a', { move: 'pass' }, 0);
    expect(textOf(step)).toContain('重新领出');
    expect(viewOf(table, 'b').yourTurn).toBe(true);
    expect(viewOf(table, 'b').canPass).toBe(false);
    expect(publicOf(table).lastPlay).toBeNull();
    expect(publicOf(table).plays).toEqual([]);
    expect(publicOf(table).passed).toEqual([]);
    // b 领出不能过。
    expect(() => table.act('b', { move: 'pass' }, 0)).toThrow(/必须出牌/);
  });

  it('三家全不叫 6 轮后，按约定强制当前 dealer 当地主', () => {
    const table = new DoudizhuTable({ host: { ...HOST }, now: 0, rng: seeded(31) });
    table.join({ ...GUESTS[0] });
    table.join({ ...GUESTS[1] });
    table.start('a', 0);
    let forced: TableStep | null = null;
    for (let i = 0; i < 18; i++) {
      const seat = turnSeat(table);
      const step = table.act(seat, { move: 'bid', call: false }, 0);
      if (textOf(step).includes('直接当地主')) forced = step;
    }
    expect(forced).not.toBeNull();
    expect(textOf(forced)).toContain('5 次都没人叫');
    expect(viewOf(table, 'c').role).toBe('landlord');
    expect(viewOf(table, 'c').hand).toHaveLength(20);
    expect(table.status).toBe('playing');
    expect(viewOf(table, 'c').yourTurn).toBe(true);
    expect(publicOf(table).bottom).toHaveLength(3);
  });

  it('叫地主中途有人叫：后面的人不用再问，直接进牌局', () => {
    const table = new DoudizhuTable({ host: { ...HOST }, now: 0, rng: seeded(37) });
    table.join({ ...GUESTS[0] });
    table.join({ ...GUESTS[1] });
    table.start('a', 0);
    table.act('a', { move: 'bid', call: false }, 0);
    const step = table.act('b', { move: 'bid', call: true }, 0);
    expect(textOf(step)).toContain('底牌');
    expect(viewOf(table, 'b').role).toBe('landlord');
    expect(viewOf(table, 'b').hand).toHaveLength(20);
    expect(viewOf(table, 'c').role).toBe('farmer');
    expect(viewOf(table, 'c').yourTurn).toBe(false);
    expect(table.status).toBe('playing');
    expect(viewOf(table, 'b').yourTurn).toBe(true);
    expect(publicOf(table).landlord).toBe('b');
    expect(publicOf(table).bottom).toHaveLength(3);
    expect(publicOf(table).bottomCards.map((card: PhysLike) => card.rank)).toEqual(publicOf(table).bottom);
  });

  it('阶段与动作错配都会被拒', () => {
    const table = new DoudizhuTable({ host: { ...HOST }, now: 0, rng: seeded(61) });
    table.join({ ...GUESTS[0] });
    table.join({ ...GUESTS[1] });
    table.start('a', 0);
    expect(() => table.act('a', { move: 'play', cards: ['3'] }, 0)).toThrow(/叫地主/);
    expect(() => table.act('b', { move: 'bid', call: true }, 0)).toThrow(/还没轮到你叫地主/);
    table.act('a', { move: 'bid', call: true }, 0);
    expect(() => table.act('a', { move: 'bid', call: true }, 0)).toThrow(/只能出牌/);
    expect(() => table.act('a', { move: 'pass' }, 0)).toThrow(/必须出牌/);
    expect(() => table.act('b', { move: 'pass' }, 0)).toThrow(/还没轮到你/);
    // 双过之后 a 重新领出，领出同样不能过。
    table.act('a', { move: 'play', cards: [viewOf(table, 'a').hand[0]] }, 0);
    table.act('b', { move: 'pass' }, 0);
    table.act('c', { move: 'pass' }, 0);
    expect(viewOf(table, 'a').yourTurn).toBe(true);
    expect(() => table.act('a', { move: 'pass' }, 0)).toThrow(/必须出牌/);
  });

  it('非法动作：没轮到、没这张、牌形不认、压不过，全部原样拒绝且不留痕', () => {
    const table = directedTable({
      landlord: ['3', '3', '3', '3', '4', '4', '4', '4', '5', '5', '5', '5', '6', '6', '6', '6', '7'],
      bottom: ['7', '7', '7'],
      b: ['8', '8', '8', '8', '9', '9', '9', '9', '10', '10', '10', '10', 'J', 'J', 'J', 'J', 'SJ'],
      c: ['Q', 'Q', 'Q', 'Q', 'K', 'K', 'K', 'K', 'A', 'A', 'A', 'A', '2', '2', '2', '2', 'BJ'],
    });
    const before = table.exportState();
    expect(() => table.act('c', { move: 'play', cards: ['Q'] }, 0)).toThrow(/还没轮到你/);
    expect(() => table.act('a', { move: 'play', cards: ['SJ'] }, 0)).toThrow(/没有这张牌/);
    expect(() => table.act('a', { move: 'play', cards: ['3', '4'] }, 0)).toThrow(/不是合法/);
    expect(() => table.act('a', { move: 'play', cards: ['3', '4', '5', '6'] }, 0)).toThrow(/不是合法/);
    expect(() => table.act('a', { move: 'play', cards: ['3', '3', '3', '3', '3'] }, 0)).toThrow(/不是合法/);
    // 五次拒绝之后，引擎状态必须与出牌前一模一样：回合、手牌、桌面、倍数都不许动。
    expect(table.exportState()).toEqual(before);
    expect(viewOf(table, 'a').hand).toHaveLength(20);
    expect(viewOf(table, 'a').yourTurn).toBe(true);
    expect(publicOf(table).lastPlay).toBeNull();
    expect(publicOf(table).multiplier).toBe(1);
    table.act('a', { move: 'play', cards: ['3', '3', '3'] }, 0);
    const afterLead = table.exportState();
    expect(() => table.act('b', { move: 'play', cards: ['8', '8'] }, 0)).toThrow(/压不过/);
    expect(() => table.act('b', { move: 'play', cards: ['8', '8', '8', '3'] }, 0)).toThrow(/没有这张牌/);
    // 被拒后回合仍在 b、手牌与桌面不变（`8 8 8 3` 里 3 不在 b 手上，不该扣掉那三张 8）。
    expect(table.exportState()).toEqual(afterLead);
    expect(viewOf(table, 'b').yourTurn).toBe(true);
    expect(viewOf(table, 'b').hand).toHaveLength(17);
    const step = table.act('b', { move: 'play', cards: ['8', '8', '8'] }, 0);
    expectLabel(step, '三张 8');
  });

  it('超时：叫牌超时按不叫；出牌超时按最小合法牌代打；压不动就超时过', () => {
    const bidding = new DoudizhuTable({ host: { ...HOST }, now: 0, rng: seeded(41) });
    bidding.join({ ...GUESTS[0] });
    bidding.join({ ...GUESTS[1] });
    bidding.start('a', 0);
    expect(bidding.tick(29_999)).toBeNull();
    const step = bidding.tick(30_000)!;
    expect(textOf(step)).toContain('不叫（超时）');
    expect(viewOf(bidding, 'b').yourTurn).toBe(true);

    // b 的牌不留四张一组：bot 有「对手没报牌不拆炸弹」的守规矩，别让它选择过牌。
    const play = directedTable({ landlord: ['3'], b: ['9', '9', '9', '10', 'J', 'Q', 'Q', 'K', 'K', 'K', 'A', 'A', 'A', '2', '2', '2', 'SJ'] });
    play.act('a', { move: 'play', cards: ['3'] }, 0);
    expect(play.tick(1_000)).toBeNull();
    const autoed = play.tick(60_000)!;
    expect(textOf(autoed)).toContain('超时，自动');
    expectLabel(autoed, '单张 9');
    expect(viewOf(play, 'b').hand).toHaveLength(16);

    const stuck = directedTable({ landlord: ['BJ'], b: ['3', '3', '4', '4', '5', '5', '6', '6', '7', '7', '8', '8', '9', '9', '10', 'J', 'Q'] });
    stuck.act('a', { move: 'play', cards: ['BJ'] }, 0);
    const passed = stuck.tick(60_000)!;
    expect(textOf(passed)).toContain('超时，');
    expect(textOf(passed)).toContain('过。');
    expect(viewOf(stuck, 'b').hand).toHaveLength(17);
  });

  it('bot 席位到点自己走，回执不带「超时」', () => {
    const table = directedTable(
      { landlord: ['3'], b: ['4'] },
      { botSeats: ['b'], botDelayMs: 1_500 },
    );
    table.act('a', { move: 'play', cards: ['3'] }, 0);
    const hand = viewOf(table, 'b').hand as Card[];
    const expected = chooseMove(hand, parseMove(['3']), { role: 'farmer', lastPlayBy: 'landlord', minOpponentLeft: 19 });
    const step = table.tick(1_500)!;
    expect(expected).toEqual(['4']);
    expect(step).not.toBeNull();
    expect(playEvent(step)?.data?.cards).toEqual(['4']);
    expect(textOf(step)).toContain('小满 出了 4');
    expect(textOf(step)).not.toContain('超时');
    expect(viewOf(table, 'b').hand).toHaveLength(16);
  });
});

describe('重上桌：存档恢复续打', () => {
  it('恢复后状态逐字节一致，跨一次停机把整局打完', () => {
    const table = directedTable({
      landlord: ['9', '9', '9', '3'],
      bottom: ['4', '4', '4'],
    });
    table.act('a', { move: 'play', cards: ['9', '9', '9', '3'] }, 0);
    table.act('b', { move: 'pass' }, 0);
    const saved = table.exportState();
    expect(publicOf(table).lastPlay.label).toBe('三带一 9');
    expect(publicOf(table).passed).toEqual(['b']);

    const revived = new DoudizhuTable({ host: { ...HOST }, now: 0, rng: seeded(97) });
    revived.restoreState(saved);
    expect(revived.exportState()).toEqual(saved);
    expect(viewOf(revived, 'c').yourTurn).toBe(true);
    expect(publicOf(revived).lastPlay.label).toBe('三带一 9');
    expect(publicOf(revived).plays.map((play: AnyView) => play.seat)).toEqual(['a']);

    const step = revived.act('c', { move: 'pass' }, 0);
    expect(textOf(step)).toContain('重新领出');
    expect(viewOf(revived, 'a').yourTurn).toBe(true);

    let last: TableStep | null = null;
    let guard = 0;
    while (guard++ < 100 && stillGoing(revived)) {
      const hand = viewOf(revived, 'a').hand as Card[];
      last = revived.act('a', { move: 'play', cards: [hand[0]] }, 0);
      if (revived.status === 'ended') break;
      revived.act('b', { move: 'pass' }, 0);
      revived.act('c', { move: 'pass' }, 0);
    }
    expect(revived.status).toBe('ended');
    const end = endEvent(last);
    expect(end).toMatchObject({ spring: true, multiplier: 2 });
    expect(end?.winners).toEqual(['a']);
  });

  it('旧存档把四带二主牌存错时，恢复按实际牌重算并照常裁决', () => {
    const table = directedTable({ landlord: ['4', '4', '4', '4', '5', '6'], b: ['7', '7', '7', '7', '9', 'Q'] });
    table.act('a', { move: 'play', cards: ['4', '4', '4', '4', '5', '6'] }, 0);
    const original = table.exportState();
    const legacy = structuredClone(original) as Record<string, any>;
    // 把附件 6 当主牌存,而且存成比 K 还大的脏值:若恢复不重算,7 的四带二(rank 4)会被挡住。
    // 这样「重算」这件事在裁决层就能验,不用只靠深等。
    legacy.lastPlay.move.rank = RANKS.indexOf('2') + 5;
    for (const [, entry] of legacy.roundPlays) entry.move.rank = RANKS.indexOf('2') + 5;
    const revived = new DoudizhuTable({ host: { ...HOST }, now: 0, rng: seeded(97) });
    revived.restoreState(legacy);
    expect(revived.exportState()).toEqual(original);
    expect(publicOf(revived).lastPlay.label).toBe('四带二 4');
    const step = revived.act('b', { move: 'play', cards: ['7', '7', '7', '7', '9', 'Q'] }, 0);
    expectLabel(step, '四带二 7');
  });

  it('rearm：真人保底 15 秒可连回，bot 按延迟走，终局不动', () => {
    const human = directedTable({}, { turn: 'b', deadline: 965_000 });
    human.rearm(1_000_000, 40_000, 15_000);
    expect((human.exportState() as Record<string, unknown>).deadline).toBe(1_015_000);

    const bot = directedTable({}, { turn: 'b', botSeats: ['b'], botDelayMs: 8_000 });
    bot.rearm(1_000_000, 999_999, 15_000);
    expect((bot.exportState() as Record<string, unknown>).deadline).toBe(1_008_000);

    const fresh = new DoudizhuTable({ host: { ...HOST }, now: 0 });
    fresh.rearm(1_000_000, 1_000, 15_000);
    expect((fresh.exportState() as Record<string, unknown>).deadline).toBe(0);
  });

  it('autoPlay 矩阵：没轮到/不在桌上/没开局都返回 null；叫牌按 chooseBid；出牌带超时字样；压不动自动过', () => {
    const fresh = new DoudizhuTable({ host: { ...HOST }, now: 0 });
    expect(fresh.autoPlay('a', 0)).toBeNull();

    const table = directedTable({ landlord: ['3'], b: ['9', '9', '9', '10', 'J', 'Q', 'Q', 'K', 'K', 'K', 'A', 'A', 'A', '2', '2', '2', 'SJ'], c: ['3', '3', '3', '4', '4', '4', '5', '5', '5', '6', '6', '6', '7', '7', '7', '8', '8'] });
    table.act('a', { move: 'play', cards: ['3'] }, 0);
    expect(table.autoPlay('c', 0)).toBeNull();
    const played = table.autoPlay('b', 0)!;
    expect(textOf(played)).toContain('超时，自动');
    expectLabel(played, '单张 9');
    expect(table.autoPlay('b', 0)).toBeNull();
    const passed = table.autoPlay('c', 0)!;
    expect(textOf(passed)).toContain('超时，');
    expect(textOf(passed)).toContain('过。');
    expect(viewOf(table, 'c').hand).toHaveLength(17);

    const bidding = new DoudizhuTable({ host: { ...HOST }, now: 0, rng: seeded(53) });
    bidding.join({ ...GUESTS[0] });
    bidding.join({ ...GUESTS[1] });
    bidding.start('a', 0);
    const hand = viewOf(bidding, 'a').hand as Card[];
    const step = bidding.autoPlay('a', 0)!;
    expect(step.events[0].data?.call).toBe(chooseBid(hand));
  });
});

describe('视图与私话契约', () => {
  it('公开视图不含任何 hand；私视图只有自己的牌', () => {
    const table = directedTable({ landlord: ['3'] });
    const publicJson = JSON.stringify(publicOf(table));
    expect(publicJson).not.toContain('"hand"');
    expect(publicJson).not.toContain('handCards');
    const mine = viewOf(table, 'a').hand as Card[];
    expect(viewOf(table, 'b').hand as Card[]).not.toEqual(mine);
    expect(viewOf(table, 'b').yourTurn).toBe(false);
    expect(viewOf(table, 'c').yourTurn).toBe(false);
  });

  it('canPass / hint / assist 只出现在轮到的席位上', () => {
    const table = directedTable({ landlord: ['3'], b: ['9', '9', '9', '10', 'J', 'Q', 'Q', 'K', 'K', 'K', 'A', 'A', 'A', '2', '2', '2', 'SJ'] });
    expect(viewOf(table, 'a').yourTurn).toBe(true);
    expect(viewOf(table, 'a').canPass).toBe(false);
    expect(viewOf(table, 'a').hint.cards).toBeDefined();
    expect(viewOf(table, 'a').assist).toBeDefined();
    table.act('a', { move: 'play', cards: ['3'] }, 0);
    expect(viewOf(table, 'a').yourTurn).toBe(false);
    expect(viewOf(table, 'a').hint).toBeUndefined();
    expect(viewOf(table, 'a').assist).toBeUndefined();
    expect(viewOf(table, 'b').yourTurn).toBe(true);
    expect(viewOf(table, 'b').canPass).toBe(true);
    expect(viewOf(table, 'b').hint.cards).toEqual(['9']);
    expect(viewOf(table, 'c').hint).toBeUndefined();

    const stuck = directedTable({ landlord: ['BJ'], b: ['3', '3', '4', '4', '5', '5', '6', '6', '7', '7', '8', '8', '9', '9', '10', 'J', 'Q'] });
    stuck.act('a', { move: 'play', cards: ['BJ'] }, 0);
    expect(viewOf(stuck, 'b').hint.pass).toBe(true);
    expect(viewOf(stuck, 'b').hint.cards).toBeUndefined();
    expect(viewOf(stuck, 'b').assist.canBeat).toBe(false);
  });

  it('privateText 覆盖叫牌、出牌、旁观与终局', () => {
    const table = new DoudizhuTable({ host: { ...HOST }, now: 0, rng: seeded(59) });
    table.join({ ...GUESTS[0] });
    table.join({ ...GUESTS[1] });
    table.start('a', 0);
    expect(table.privateText('a', 0)).toContain('叫你当地主');
    expect(table.privateText('b', 0)).toContain('等 阿岚 叫地主');
    expect(table.privateText('b', 0)).not.toContain('parlor_ddz_action');
    expect(table.publicText()).toContain('叫地主中');

    table.act('a', { move: 'bid', call: true }, 0);
    const yours = table.privateText('a', 0)!;
    expect(yours).toContain('轮到你');
    expect(yours).toContain('这一轮你先出');
    expect(yours).toContain('合法建议');
    expect(yours).toContain('座次');
    expect(yours).toContain('本局累计已出');
    expect(yours).toContain('其他两家合计未出');
    const waiting = table.privateText('b', 0)!;
    expect(waiting).toContain('等 阿岚 出牌');
    expect(waiting).not.toContain('合法建议');
    expect(table.publicText()).toContain('地主 阿岚');

    table.act('a', { move: 'play', cards: [viewOf(table, 'a').hand[0]] }, 0);
    expect(table.privateText('b', 0)).toContain('上一手');
    expect(table.privateText('b', 0)).toContain('压过它');
  });
});

/** 交叉核对补的契约点：回归不会叫疼、但坏了会伤人的那些。 */
describe('契约点：底牌时机、唤醒时刻、恢复保底', () => {
  it('叫牌阶段底牌一无所知；叫成之后才公开', () => {
    const table = new DoudizhuTable({ host: { ...HOST }, now: 0, rng: seeded(71) });
    table.join({ ...GUESTS[0] });
    table.join({ ...GUESTS[1] });
    table.start('a', 0);
    expect(table.status).toBe('bidding');
    expect(publicOf(table).bottom).toBeUndefined();
    expect(publicOf(table).bottomCards).toBeUndefined();
    expect(publicOf(table).landlord).toBeUndefined();
    expect(JSON.stringify(publicOf(table))).not.toContain('bottom');
    table.act('a', { move: 'bid', call: true }, 0);
    expect(publicOf(table).bottom).toHaveLength(3);
    expect(publicOf(table).bottomCards).toHaveLength(3);
    expect(viewOf(table, 'a').hand).toHaveLength(20);
  });

  it('nextWakeAt：进行中给这一手的截止，终局与未开局都不唤醒', () => {
    const open = new DoudizhuTable({ host: { ...HOST }, now: 0, rng: seeded(73) });
    open.join({ ...GUESTS[0] });
    open.join({ ...GUESTS[1] });
    open.start('a', 0);
    expect(open.nextWakeAt()).toBe(30_000);
    open.act('a', { move: 'bid', call: true }, 0);
    expect(open.nextWakeAt()).toBe(60_000);
    open.act('a', { move: 'play', cards: [viewOf(open, 'a').hand[0]] }, 0);
    expect(open.nextWakeAt()).toBe(60_000);
    const fresh = new DoudizhuTable({ host: { ...HOST }, now: 0 });
    expect(fresh.nextWakeAt()).toBeUndefined();
  });

  it('rearm：真人按「停机前还剩多少」重新计时，不够才抬到保底', () => {
    // 停机前还剩 40 秒（旧 now = 1_000_000）→ 重连后照样给 40 秒，
    // 不掐掉停机耗掉的那 10 秒（契约写的是「保留停机前的剩余时间」）。
    const table = directedTable({}, { turn: 'b', deadline: 1_040_000 });
    table.rearm(1_010_000, 10_000, 10_000);
    expect((table.exportState() as Record<string, unknown>).deadline).toBe(1_050_000);
    // 停机前只剩 2 秒 → 抬到保底 10 秒。
    const tight = directedTable({}, { turn: 'b', deadline: 1_002_000 });
    tight.rearm(1_010_000, 10_000, 10_000);
    expect((tight.exportState() as Record<string, unknown>).deadline).toBe(1_020_000);
    // 原截止已过 → 也给保底。
    const late = directedTable({}, { turn: 'b', deadline: 1_000_000 });
    late.rearm(1_100_000, 100_000, 15_000);
    expect((late.exportState() as Record<string, unknown>).deadline).toBe(1_115_000);
  });

  it('入座守卫：满员、重复入座、开局后入座/离桌、非主持开局都被拒', () => {
    const table = new DoudizhuTable({ host: { ...HOST }, now: 0, rng: seeded(79) });
    expect(() => table.start('b', 0)).toThrow(/只有开桌的人/);
    table.join({ ...GUESTS[0] });
    expect(() => table.join({ ...GUESTS[0] })).toThrow(/已经在桌上/);
    table.join({ ...GUESTS[1] });
    expect(() => table.join({ id: 'd', name: '第四位' })).toThrow(/最多 3 个人/);
    // 开局前:开桌的人不能自己走,客人可以走,走了还能再坐回来。
    expect(() => table.leave('a')).toThrow(/开桌的人/);
    expect(table.leave('c').text).toContain('离开了斗地主桌');
    expect(table.seatIds()).toEqual(['a', 'b']);
    table.join({ id: 'c', name: '阿满' });
    expect(table.seatIds()).toEqual(['a', 'b', 'c']);
    table.start('a', 0);
    expect(() => table.leave('b')).toThrow(/已经开始/);
    expect(() => table.join({ id: 'd', name: '第四位' })).toThrow(/已经开始了/);
    expect(() => table.start('a', 0)).toThrow(/已经开始了/);
    expect(() => table.act('b', { move: 'bid', call: true }, 0)).toThrow(/还没轮到你叫地主/);
  });

  it('坏存档一律抛错，不猜、不半途恢复', () => {
    const fresh = () => new DoudizhuTable({ host: { ...HOST }, now: 0 });
    const base = (() => {
      const table = directedTable({ landlord: ['3'] });
      return table.exportState() as Record<string, any>;
    })();
    const broken: Array<[string, unknown, RegExp]> = [
      ['不是对象', null, /不是对象/],
      ['版本不认识', { ...base, version: 99 }, /不认识的斗地主存档版本/],
      ['主持席位对不上', { ...base, host: 'zzz' }, /主持席位对不上/],
      ['状态非法', { ...base, status: 'weird' }, /状态不对/],
      ['没有席位', { ...base, seats: [] }, /缺席位/],
      ['席位形状不对', { ...base, seats: [{ id: 'a' }] }, /席位形状不对/],
      ['手牌形状不对', { ...base, seats: [{ id: 'a', name: 'n', hand: 'x', cards: [] }] }, /手牌形状不对/],
      ['牌堆形状不对', { ...base, hands: [[], []] }, /牌堆形状不对/],
      ['轮次出牌形状不对', { ...base, roundPlays: [['a', null]] }, /轮次出牌形状不对/],
      ['上一手牌型不合法', { ...base, lastPlay: { seat: 'a', move: { cards: ['3', '4'] }, cards: [] } }, /出牌牌型不合法/],
    ];
    for (const [name, state, error] of broken) {
      expect(() => fresh().restoreState(state), name).toThrow(error);
    }
  });
});

describe('契约点：suggestMove 的目标牌型矩阵', () => {
  const pick = (hand: R[], target: R[] | null) => suggestMove(hand, target ? parseMove(target) : null);

  it('三张/三带一/三带二/飞机/飞机带对/四带二/四带两对 都能给出最小合法解', () => {
    const cases: Array<[string, R[], R[]]> = [
      ['三张', ['5', '5', '5', '9'], ['4', '4', '4']],
      ['三带一', ['5', '5', '5', '9'], ['4', '4', '4', '7']],
      ['三带二', ['5', '5', '5', '9', '9'], ['4', '4', '4', '8', '8']],
      ['飞机', ['4', '4', '4', '5', '5', '5', '9'], ['3', '3', '3', '4', '4', '4']],
      ['飞机带对', ['4', '4', '4', '5', '5', '5', '9', '9', '10', '10'], ['3', '3', '3', '4', '4', '4', '7', '7', '8', '8']],
      ['四带二', ['5', '5', '5', '5', '9', '10'], ['4', '4', '4', '4', '8', '8']],
      ['四带两对', ['5', '5', '5', '5', '9', '9', '10', '10'], ['4', '4', '4', '4', '7', '7', '8', '8']],
    ];
    for (const [name, hand, target] of cases) {
      const picked = pick(hand, target);
      expect(picked, name).not.toBeNull();
      const parsed = parseMove(picked!);
      expect(parsed, name).not.toBeNull();
      expect(canBeat(parsed!, parseMove(target)), name).toBe(true);
    }
  });

  it('飞机带单有合法翅膀时，提示与代打都能接牌（E4）', () => {
    const hand: R[] = ['4', '4', '4', '5', '5', '5', '6', '6', '6', '9', '9', '9', '10'];
    const target = parseMove(['3', '3', '3', '4', '4', '4', '5', '5', '5', '6', '7', '8'])!;
    // 合法解确实存在:444 555 666 + 9 9 10。
    expect(parseMove(['4', '4', '4', '5', '5', '5', '6', '6', '6', '9', '9', '10'])).not.toBeNull();
    expect(canBeat(parseMove(['4', '4', '4', '5', '5', '5', '6', '6', '6', '9', '9', '10'])!, target)).toBe(true);
    const expected = ['4', '4', '4', '5', '5', '5', '6', '6', '6', '9', '9', '10'];
    for (const picked of [
      suggestMove(hand, target),
      chooseMove(hand, target, { role: 'farmer', lastPlayBy: 'landlord', minOpponentLeft: 10 }),
    ]) {
      expect(picked).toEqual(expected);
      expect(canBeat(parseMove(picked!)!, target)).toBe(true);
    }
    // 对照:翅膀里没有三张同点就能解。
    expect(suggestMove(['4', '4', '4', '5', '5', '5', '6', '6', '6', '9', '9', '10', 'J'], target))
      .not.toBeNull();
  });

  it('四组飞机不会把四张同点全塞进翅膀；无同型解仍可用炸弹', () => {
    const target = move(['3', '3', '3', '4', '4', '4', '5', '5', '5', '6', '6', '6', '8', '9', '10', 'J']);
    const body = ['4', '4', '4', '5', '5', '5', '6', '6', '6', '7', '7', '7'];
    const picked = suggestMove([...body, '9', '9', '9', '9', '10', '10'], target)!;
    expect(parseMove(picked)?.type).toBe('airplane-single');
    expect(canBeat(parseMove(picked)!, target)).toBe(true);
    expect(picked.filter((card) => card === '9')).toHaveLength(2);
    expect(picked.filter((card) => card === '10')).toHaveLength(2);
    expect(suggestMove([...body, '9', '9', '9', '9'], target)).toEqual(['9', '9', '9', '9']);
    expect(suggestMove([...body, '9', '9', '9'], target)).toBeNull();
  });

  it('真实 54 张牌的桌面提示和超时代打都能跟飞机带单（E4）', () => {
    // 主体用互不重叠的点数，保证上一手与本人手牌能同时存在于真实牌堆。
    const previous = ['3', '3', '3', '4', '4', '4', '5', '5', '5', 'J', 'Q', 'K'];
    const hand = ['6', '6', '6', '7', '7', '7', '8', '8', '8', '9', '9', '9', '10'];
    const table = directedTable({ landlord: previous, b: hand });
    table.act('a', { move: 'play', cards: previous }, 0);
    const hint = viewOf(table, 'b').hint;
    expect(hint.pass).not.toBe(true);
    expect(parseMove(hint.cards)?.type).toBe('airplane-single');
    expect(canBeat(parseMove(hint.cards)!, move(previous))).toBe(true);
    const step = table.autoPlay('b', 1)!;
    expect(playEvent(step)?.data?.label).toContain('飞机带单');
    expect(viewOf(table, 'b').hand).toHaveLength(5);
  });
});
