/**
 * 斗地主牌桌：3 席，17+17+17 一发，底牌 3 张。
 * 空位由脚本陪练补（它们不是房间席位，不会被叫醒）；轮到的席位超时就按最小合法出牌代打。
 * 隐藏手牌只进各席位自己的私视图；公开事件只有牌数、上一手与结算。
 */
import { randomInt } from 'node:crypto';
import {
  TableError, secondsLeft,
  type TableEngine, type TableEvent, type TableSeat, type TableStatus, type TableStep,
} from '../table-engine.ts';
import {
  canBeat, deal, formatCards, moveLabel, parseMove, scoreRound, sortCards,
  type Card, type Move,
} from './doudizhu.ts';
import { chooseBid, chooseMove, type BotContext } from './doudizhu-bot.ts';

export interface DoudizhuTableOptions {
  host: TableSeat;
  now: number;
  turnMs?: number;
  bidMs?: number;
  botDelayMs?: number;
  rng?: () => number;
}

export type DoudizhuAction =
  | { move: 'bid'; call?: boolean }
  | { move: 'play'; cards?: string[] }
  | { move: 'pass' };

type Role = 'landlord' | 'farmer';

interface Seat {
  id: string;
  name: string;
  bot: boolean;
  hand: Card[];
  role: Role | null;
  plays: number;
}

interface LastPlay {
  seat: string;
  move: Move;
}

const SEAT_COUNT = 3;
const DEFAULT_TURN_MS = 60_000;
const DEFAULT_BID_MS = 30_000;
const DEFAULT_BOT_DELAY_MS = 1500;
const BOT_NAMES = ['陪练甲', '陪练乙'];
const MAX_REDEALS = 5;

export class DoudizhuTable implements TableEngine {
  readonly game = 'ddz';
  readonly label = '斗地主';
  readonly host: string;
  status: TableStatus = 'open';

  private readonly turnMs: number;
  private readonly bidMs: number;
  private readonly botDelayMs: number;
  private readonly rng: () => number;
  private readonly seats: Seat[] = [];
  private hands: [Card[], Card[], Card[]] = [[], [], []];
  private bottom: Card[] = [];
  private dealer = 0;
  private bidIndex = 0;
  private bids = 0;
  private redeals = 0;
  private turnId?: string;
  private deadline = 0;
  private lastPlay?: LastPlay;
  private passes = 0;
  private bombs = 0;
  private result = '';

  constructor(options: DoudizhuTableOptions) {
    this.host = options.host.id;
    this.turnMs = options.turnMs ?? DEFAULT_TURN_MS;
    this.bidMs = options.bidMs ?? DEFAULT_BID_MS;
    this.botDelayMs = options.botDelayMs ?? DEFAULT_BOT_DELAY_MS;
    this.rng = options.rng ?? (() => randomInt(0, 2 ** 31) / 2 ** 31);
    this.seats.push({ id: options.host.id, name: options.host.name, bot: false, hand: [], role: null, plays: 0 });
  }

  has(seatId: string): boolean {
    return this.seats.some((seat) => seat.id === seatId);
  }

  seatIds(): string[] {
    return this.seats.map((seat) => seat.id);
  }

  join(seat: TableSeat): TableEvent {
    if (this.status !== 'open') throw new TableError('not_open', '这张桌子已经开始了');
    if (this.has(seat.id)) throw new TableError('seated', '你已经在桌上了');
    if (this.seats.length >= SEAT_COUNT) throw new TableError('full', '斗地主最多 3 个人');
    this.seats.push({ id: seat.id, name: seat.name, bot: false, hand: [], role: null, plays: 0 });
    return {
      type: 'parlor.table.join',
      scope: { kind: 'room' },
      text: `${seat.name} 坐到了斗地主桌。`,
      data: { game: this.game, seat: seat.id },
    };
  }

  start(by: string, now: number): TableStep {
    if (this.status !== 'open') throw new TableError('not_open', '这张桌子已经开始了');
    if (by !== this.host) throw new TableError('not_host', '只有开桌的人可以开始');
    while (this.seats.length < SEAT_COUNT) {
      const index = this.seats.filter((seat) => seat.bot).length;
      this.seats.push({
        id: `bot${index + 1}`,
        name: BOT_NAMES[index] ?? `陪练${index + 1}`,
        bot: true,
        hand: [],
        role: null,
        plays: 0,
      });
    }
    this.dealRound();
    const first = this.seats[this.bidIndex];
    const names = this.seats.map((seat) => (seat.bot ? `${seat.name}（脚本）` : seat.name)).join('、');
    const events: TableEvent[] = [{
      type: 'parlor.table.start',
      scope: { kind: 'room' },
      text: `斗地主开始了：${names}。${first.name} 先叫地主。`,
      data: { game: this.game, seats: this.seatIds() },
    }];
    this.arm(now);
    return { events, views: this.turnViews() };
  }

  act(seatId: string, input: unknown, now: number): TableStep {
    const action = (input ?? {}) as DoudizhuAction;
    if (this.status === 'bidding') {
      if (action.move !== 'bid') throw new TableError('bad_action', '现在是在叫地主：用 move:"bid" 加 call:true|false');
      return this.bid(seatId, action.call === true, now, false);
    }
    if (this.status === 'playing') {
      if (action.move === 'play') {
        return this.play(seatId, Array.isArray(action.cards) ? action.cards : [], now, false);
      }
      if (action.move === 'pass') return this.pass(seatId, now, false);
      throw new TableError('bad_action', '只能出牌（play）或过（pass）');
    }
    throw new TableError('not_started', '这张桌子没在玩');
  }

  tick(now: number): TableStep | null {
    if (this.status !== 'bidding' && this.status !== 'playing') return null;
    if (now < this.deadline) return null;
    const seat = this.currentSeat();
    if (!seat) return null;
    if (this.status === 'bidding') {
      // 超时的真人不替他叫地主：不叫更保守，也不会把底牌塞给没在的人。
      return this.bid(seat.id, seat.bot ? chooseBid(seat.hand) : false, now, !seat.bot);
    }
    const picked = chooseMove(seat.hand, this.lastPlay?.move ?? null, this.botContext(seat));
    // 脚本陪练正常出牌；人类席位是超时，回执里要说明。
    if (picked && picked.length > 0) return this.play(seat.id, picked, now, !seat.bot);
    return this.pass(seat.id, now, !seat.bot);
  }

  view(seatId: string): unknown | null {
    const seat = this.seats.find((entry) => entry.id === seatId);
    if (!seat) return null;
    return {
      game: this.game,
      seat: seat.id,
      name: seat.name,
      status: this.status,
      role: seat.role,
      hand: sortCards(seat.hand),
      cardsLeft: this.cardsLeft(),
      yourTurn: this.status !== 'ended' && this.turnId === seat.id,
      turn: this.turnId,
      deadline: this.deadline || undefined,
      landlord: this.landlord()?.id,
      lastPlay: this.lastPlay
        ? { seat: this.lastPlay.seat, cards: [...this.lastPlay.move.cards], label: moveLabel(this.lastPlay.move) }
        : null,
      multiplier: 2 ** this.bombs,
    };
  }

  public(): unknown {
    const landlord = this.landlord();
    return {
      game: this.game,
      status: this.status,
      host: this.host,
      seats: this.seats.map((seat) => ({
        id: seat.id, name: seat.name, bot: seat.bot, role: seat.role, cardsLeft: seat.hand.length,
      })),
      turn: this.turnId,
      deadline: this.deadline || undefined,
      landlord: landlord?.id,
      multiplier: 2 ** this.bombs,
      bottom: landlord ? [...this.bottom] : undefined,
      lastPlay: this.lastPlay
        ? { seat: this.lastPlay.seat, cards: [...this.lastPlay.move.cards], label: moveLabel(this.lastPlay.move) }
        : null,
      result: this.result || undefined,
    };
  }

  privateText(seatId: string, now: number): string | null {
    const seat = this.seats.find((entry) => entry.id === seatId);
    if (!seat) return null;
    if (this.status === 'ended') return `【斗地主·结束】${this.result}`;
    if (this.status === 'open') return '【斗地主桌】还没有开始。';
    const turn = this.currentSeat();
    const yourTurn = this.turnId === seat.id;
    const lines: string[] = [];
    if (this.status === 'bidding') {
      lines.push(yourTurn
        ? `【斗地主·叫你当地主】你的 ${seat.hand.length} 张牌：${formatCards(seat.hand)}`
        : `【斗地主·等 ${turn?.name ?? '？'} 叫地主】你的 ${seat.hand.length} 张牌：${formatCards(seat.hand)}`);
      if (yourTurn) {
        lines.push(`${secondsLeft(this.deadline, now)} 秒内：parlor_ddz_action {move:"bid", call:true} 叫地主；call:false 不叫。`);
        lines.push('底牌 3 张会亮给所有人；叫的人拿走底牌并当地主。');
      } else {
        lines.push(`等 ${turn?.name ?? '？'} 决定。`);
      }
      return lines.join('\n');
    }
    const landlord = this.landlord();
    lines.push(yourTurn
      ? `【斗地主·轮到你】你的牌（${seat.hand.length} 张）：${formatCards(seat.hand)}`
      : `【斗地主·等 ${turn?.name ?? '？'} 出牌】你的牌（${seat.hand.length} 张）：${formatCards(seat.hand)}`);
    lines.push(`你是${seat.role === 'landlord' ? '地主' : '农民'}；地主是 ${landlord?.name ?? '？'}；倍数 x${2 ** this.bombs}。`);
    if (this.lastPlay) {
      const owner = this.seats.find((entry) => entry.id === this.lastPlay!.seat);
      lines.push(`上一手：${owner?.name ?? '？'} 出了 ${formatCards(this.lastPlay.move.cards)}（${moveLabel(this.lastPlay.move)}）。`);
      if (yourTurn) lines.push(`${secondsLeft(this.deadline, now)} 秒内：parlor_ddz_action {move:"play", cards:[…]} 压过它；出不了就 {move:"pass"}。`);
    } else if (yourTurn) {
      lines.push(`这一轮你先出，什么牌型都行。${secondsLeft(this.deadline, now)} 秒内：parlor_ddz_action {move:"play", cards:[…]}。`);
    } else {
      lines.push('等上一手结算。');
    }
    return lines.join('\n');
  }

  publicText(): string {
    if (this.status === 'open') {
      return `【斗地主桌】还开着，桌上：${this.seats.map((seat) => seat.name).join('、')}。`;
    }
    if (this.status === 'bidding') {
      return `【斗地主】叫地主中，轮到 ${this.currentSeat()?.name ?? '？'}。`;
    }
    if (this.status === 'ended') return `【斗地主】结束：${this.result}`;
    const turn = this.currentSeat()?.name ?? '？';
    const landlord = this.landlord()?.name ?? '？';
    const left = this.seats.map((seat) => `${seat.name} ${seat.hand.length} 张`).join('、');
    const last = this.lastPlay
      ? `上一手：${this.seats.find((seat) => seat.id === this.lastPlay!.seat)?.name ?? '？'} 出了 ${formatCards(this.lastPlay.move.cards)}（${moveLabel(this.lastPlay.move)}）。`
      : '新一轮，还没人出牌。';
    return `【斗地主】进行中，轮到 ${turn}；地主 ${landlord}；倍数 x${2 ** this.bombs}；剩牌：${left}。${last}`;
  }

  private dealRound(): void {
    const dealt = deal(this.rng);
    this.hands = dealt.hands;
    this.bottom = dealt.bottom;
    this.seats.forEach((seat, index) => {
      seat.hand = sortCards(this.hands[index] ?? []);
      seat.role = null;
      seat.plays = 0;
    });
    this.bidIndex = this.dealer;
    this.bids = 0;
    this.status = 'bidding';
    this.turnId = this.seats[this.bidIndex].id;
    this.lastPlay = undefined;
    this.passes = 0;
    this.bombs = 0;
    this.result = '';
    this.turnId = this.seats[this.bidIndex].id;
  }

  private bid(seatId: string, call: boolean, now: number, auto: boolean): TableStep {
    if (this.status !== 'bidding') throw new TableError('not_started', '现在不是在叫地主');
    const seat = this.seats.find((entry) => entry.id === seatId);
    if (!seat) throw new TableError('not_seated', '你不在桌上');
    if (this.turnId !== seatId) throw new TableError('not_turn', '还没轮到你叫地主');
    const events: TableEvent[] = [{
      type: 'parlor.table.action',
      scope: { kind: 'room' },
      text: `${seat.name} ${call ? '叫地主' : '不叫'}${auto ? '（超时）' : ''}。`,
      data: { game: this.game, seat: seat.id, action: 'bid', call },
    }];
    if (call) {
      this.crown(this.seats.indexOf(seat));
      events.push({
        type: 'parlor.table.action',
        scope: { kind: 'room' },
        text: `底牌是 ${formatCards(this.bottom)}，${seat.name} 当地主，先出牌。`,
        data: { game: this.game, landlord: seat.id, bottom: [...this.bottom] },
      });
      this.arm(now);
      return { events, views: this.turnViews() };
    }
    this.bids += 1;
    if (this.bids < SEAT_COUNT) {
      this.bidIndex = (this.bidIndex + 1) % SEAT_COUNT;
      this.turnId = this.seats[this.bidIndex].id;
      this.arm(now);
      return { events, views: this.turnViews() };
    }
    this.redeals += 1;
    if (this.redeals > MAX_REDEALS) {
      const forced = this.seats[this.dealer];
      this.crown(this.dealer);
      events.push({
        type: 'parlor.table.action',
        scope: { kind: 'room' },
        text: `${MAX_REDEALS} 次都没人叫，按约定 ${forced.name} 直接当地主。底牌是 ${formatCards(this.bottom)}。`,
        data: { game: this.game, landlord: forced.id, bottom: [...this.bottom], forced: true },
      });
      this.arm(now);
      return { events, views: this.turnViews() };
    }
    this.dealer = (this.dealer + 1) % SEAT_COUNT;
    this.dealRound();
    const first = this.seats[this.bidIndex];
    events.push({
      type: 'parlor.table.action',
      scope: { kind: 'room' },
      text: `三家都不叫，重新发牌；这回 ${first.name} 先叫。`,
      data: { game: this.game, redeal: true },
    });
    this.arm(now);
    return { events, views: this.turnViews() };
  }

  private crown(index: number): void {
    const seat = this.seats[index];
    for (const entry of this.seats) entry.role = entry.id === seat.id ? 'landlord' : 'farmer';
    seat.hand = sortCards([...seat.hand, ...this.bottom]);
    this.status = 'playing';
    this.turnId = seat.id;
    this.lastPlay = undefined;
    this.passes = 0;
  }

  private play(seatId: string, cards: readonly string[], now: number, auto: boolean): TableStep {
    if (this.status !== 'playing') throw new TableError('not_started', '这张桌子没在玩');
    const seat = this.seats.find((entry) => entry.id === seatId);
    if (!seat) throw new TableError('not_seated', '你不在桌上');
    if (this.turnId !== seatId) throw new TableError('not_turn', '还没轮到你出牌');
    const entry = parseMove(cards);
    if (!entry) throw new TableError('bad_action', `这不是合法的牌型：${formatCards(cards as Card[])}`);
    this.ensureHolding(seat, entry.cards);
    if (!canBeat(entry, this.lastPlay?.move ?? null)) {
      throw new TableError('bad_action', '这手牌压不过上一手');
    }
    this.discard(seat, entry.cards);
    seat.plays += 1;
    if (entry.type === 'bomb' || entry.type === 'rocket') this.bombs += 1;
    this.lastPlay = { seat: seat.id, move: entry };
    this.passes = 0;
    const events: TableEvent[] = [{
      type: 'parlor.table.action',
      scope: { kind: 'room' },
      text: `${seat.name} ${auto ? '超时，自动' : ''}出了 ${formatCards(entry.cards)}（${moveLabel(entry)}）。`,
      data: { game: this.game, seat: seat.id, action: 'play', cards: entry.cards, label: moveLabel(entry) },
    }];
    if (seat.hand.length === 0) {
      this.finish(seat, events);
      return { events, views: [], ended: true };
    }
    return this.advance(now, events, seat);
  }

  private pass(seatId: string, now: number, auto: boolean): TableStep {
    if (this.status !== 'playing') throw new TableError('not_started', '这张桌子没在玩');
    const seat = this.seats.find((entry) => entry.id === seatId);
    if (!seat) throw new TableError('not_seated', '你不在桌上');
    if (this.turnId !== seatId) throw new TableError('not_turn', '还没轮到你');
    if (!this.lastPlay) throw new TableError('bad_action', '这一轮你先出，必须出牌');
    this.passes += 1;
    const last = this.lastPlay;
    const events: TableEvent[] = [{
      type: 'parlor.table.action',
      scope: { kind: 'room' },
      text: `${seat.name} ${auto ? '超时，' : ''}过。`,
      data: { game: this.game, seat: seat.id, action: 'pass' },
    }];
    if (this.passes >= SEAT_COUNT - 1) {
      const leader = this.seats.find((entry) => entry.id === last.seat)!;
      this.lastPlay = undefined;
      this.passes = 0;
      this.turnId = leader.id;
      events.push({
        type: 'parlor.table.action',
        scope: { kind: 'room' },
        text: `两家都不要，${leader.name} 重新领出。`,
        data: { game: this.game, seat: leader.id, action: 'lead' },
      });
      this.arm(now);
      return { events, views: this.turnViews() };
    }
    return this.advance(now, events, seat);
  }

  private advance(now: number, events: TableEvent[], from: Seat): TableStep {
    const next = this.seats[(this.seats.indexOf(from) + 1) % SEAT_COUNT];
    this.turnId = next.id;
    this.arm(now);
    return { events, views: this.turnViews() };
  }

  private finish(winner: Seat, events: TableEvent[]): void {
    const landlord = this.landlord()!;
    const landlordWon = winner.role === 'landlord';
    const farmers = this.seats.filter((seat) => seat.role === 'farmer');
    const score = scoreRound({
      landlordWon,
      bombs: this.bombs,
      farmerPlays: farmers.reduce((sum, seat) => sum + seat.plays, 0),
      landlordPlays: landlord.plays,
    });
    this.status = 'ended';
    this.turnId = undefined;
    this.deadline = 0;
    const side = landlordWon ? '地主赢' : '农民赢';
    const extra = score.spring ? '，春天' : score.antiSpring ? '，反春' : '';
    this.result = `${side}；地主 ${landlord.name}，倍数 x${score.multiplier}${extra}。`;
    events.push({
      type: 'parlor.table.end',
      scope: { kind: 'room' },
      text: `斗地主结束：${this.result}手牌：${this.seats.map((seat) => `${seat.name} 剩 ${formatCards(seat.hand) || '无'}`).join('；')}。`,
      data: {
        game: this.game,
        landlord: landlord.id,
        winners: (landlordWon ? [landlord] : farmers).map((seat) => seat.id),
        multiplier: score.multiplier,
        spring: score.spring,
        antiSpring: score.antiSpring,
        revealed: this.seats.map((seat) => ({ id: seat.id, name: seat.name, cards: [...seat.hand] })),
      },
    });
  }

  private ensureHolding(seat: Seat, cards: readonly Card[]): void {
    const counts = new Map<Card, number>();
    for (const card of seat.hand) counts.set(card, (counts.get(card) ?? 0) + 1);
    for (const card of cards) {
      const left = counts.get(card) ?? 0;
      if (left <= 0) throw new TableError('bad_action', `你手里没有这张牌：${card}`);
      counts.set(card, left - 1);
    }
  }

  private discard(seat: Seat, cards: readonly Card[]): void {
    for (const card of cards) {
      const index = seat.hand.indexOf(card);
      if (index >= 0) seat.hand.splice(index, 1);
    }
  }

  private currentSeat(): Seat | undefined {
    return this.seats.find((seat) => seat.id === this.turnId);
  }

  private landlord(): Seat | undefined {
    return this.seats.find((seat) => seat.role === 'landlord');
  }

  private botContext(seat: Seat): BotContext {
    const last = this.lastPlay
      ? this.seats.find((entry) => entry.id === this.lastPlay!.seat)
      : undefined;
    const opponents = this.seats.filter((entry) => entry.role !== seat.role);
    return {
      role: seat.role ?? 'farmer',
      lastPlayBy: last?.role ?? undefined,
      minOpponentLeft: Math.min(...opponents.map((entry) => entry.hand.length)),
    };
  }

  private cardsLeft(): Record<string, number> {
    return Object.fromEntries(this.seats.map((seat) => [seat.id, seat.hand.length]));
  }

  private turnViews(): string[] {
    const seat = this.currentSeat();
    return seat && !seat.bot ? [seat.id] : [];
  }

  private arm(now: number): void {
    const seat = this.currentSeat();
    if (!seat) {
      this.deadline = 0;
      return;
    }
    this.deadline = now + (seat.bot
      ? this.botDelayMs
      : this.status === 'bidding' ? this.bidMs : this.turnMs);
  }
}
