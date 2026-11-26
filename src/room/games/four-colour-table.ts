import { randomInt } from 'node:crypto';
import { GAME_PRESENTATION } from '../game-labels.ts';
import { TableError, type TableEngine, type TableEvent, type TableSeat, type TableStep } from '../table-engine.ts';
import {
  COLOUR_LABELS, FOUR_COLOUR_TURN_MS, FOUR_COLOURS, NUMBER_RANKS, fourColourFaceText, isFourColour,
  type FourColour, type FourColourCard, type FourColourFace,
} from './four-colour-rules.ts';

const FOUR_COLOUR_CAPACITY = 4;
const FACES: readonly FourColourFace[] = [
  ...FOUR_COLOURS.flatMap(colour => [
    { colour, rank: '0' } as const,
    ...([...NUMBER_RANKS.slice(1), 'skip', 'reverse', 'draw2'] as const)
      .flatMap(rank => [{ colour, rank }, { colour, rank }]),
  ]),
  ...Array.from({ length: 4 }, () => [{ colour: null, rank: 'wild' }, { colour: null, rank: 'draw4' }] as const).flat(),
];

function cardAt(id: number): FourColourCard { return { ...FACES[id], id }; }
const validCardId = (id: unknown): id is number => typeof id === 'number' && Number.isInteger(id) && id >= 0 && id < FACES.length;

interface Player extends TableSeat { hand: number[] }
interface State {
  version: 1;
  status: 'open' | 'playing' | 'ended';
  players: Player[];
  stock: number[];
  discard: number[];
  current: number;
  direction: 1 | -1;
  colour: FourColour | null;
  deadline: number;
  drawn: number | null;
  last: string;
}

export class FourColourTable implements TableEngine {
  readonly game = 'four-colour';
  readonly label = GAME_PRESENTATION['four-colour'].label;
  readonly stateVersion = 1;
  readonly host: string;
  private readonly turnMs: number;
  private state: State;

  constructor(host: TableSeat, turnMs = FOUR_COLOUR_TURN_MS, private readonly randomIndex = randomInt) {
    this.host = host.id;
    this.turnMs = turnMs;
    this.state = {
      version: 1, status: 'open', players: [{ ...host, hand: [] }], stock: [], discard: [],
      current: 0, direction: 1, colour: null, deadline: 0, drawn: null, last: '',
    };
  }

  get status(): State['status'] { return this.state.status; }
  private get current(): Player { return this.state.players[this.state.current]; }
  private get top(): FourColourCard | null {
    const id = this.state.discard.at(-1);
    return id === undefined ? null : cardAt(id);
  }

  has(id: string): boolean { return this.state.players.some(player => player.id === id); }
  seatIds(): string[] { return this.state.players.map(player => player.id); }

  join(seat: TableSeat): TableEvent {
    if (this.status !== 'open') throw new TableError('not_open', '这张桌子已经开始了');
    if (this.has(seat.id)) throw new TableError('seated', '你已经在桌上了');
    if (this.state.players.length >= FOUR_COLOUR_CAPACITY) throw new TableError('full', '四彩牌最多四人');
    this.state.players.push({ ...seat, hand: [] });
    return this.event('join', `${seat.name} 坐到了四彩牌桌。`, { seat: seat.id });
  }

  leave(id: string): TableEvent {
    if (this.status !== 'open') throw new TableError('not_open', '这张桌子已经开始了');
    if (id === this.host) throw new TableError('not_host', '开桌的人要走请把桌子收掉');
    const index = this.state.players.findIndex(player => player.id === id);
    if (index < 0) throw new TableError('not_seated', '你不在桌上');
    const [seat] = this.state.players.splice(index, 1);
    return this.event('left', `${seat.name} 离开了四彩牌桌。`, { seat: id });
  }

  start(by: string, now: number): TableStep {
    if (this.status !== 'open') throw new TableError('not_open', '这张桌子已经开始了');
    if (by !== this.host) throw new TableError('not_host', '只有开桌的人可以开始');
    if (this.state.players.length < 2) throw new TableError('not_open', '四彩牌至少需要两人');
    const stock = this.shuffle(FACES.map((_face, id) => id));
    for (const player of this.state.players) player.hand = stock.splice(-7);
    const first = stock.findIndex(id => NUMBER_RANKS.some(rank => rank === FACES[id].rank));
    const [opening] = stock.splice(first, 1);
    this.state.stock = stock;
    this.state.discard = [opening];
    this.state.colour = FACES[opening].colour;
    this.state.current = this.randomIndex(this.state.players.length);
    this.state.status = 'playing';
    this.state.deadline = now + this.turnMs;
    this.state.last = `${this.current.name} 先出牌。`;
    return {
      events: [this.event('start', `四彩牌开始了。开桌牌是 ${fourColourFaceText(FACES[opening])}，${this.state.last}`, { first: this.current.id })],
      views: [this.current.id],
      refreshViews: this.seatIds().filter(id => id !== this.current.id),
    };
  }

  act(id: string, input: unknown, now: number): TableStep {
    if (this.status !== 'playing') throw new TableError('not_started', '这张桌子没在玩');
    if (!this.has(id)) throw new TableError('not_seated', '你不在桌上');
    if (id !== this.current.id) throw new TableError('not_turn', '还没轮到你');
    if (now >= this.state.deadline) throw new TableError('expired', '回合已到期，等服务器推进后再看桌面');
    const move = input as { action?: unknown; card?: unknown; colour?: unknown } | null;
    if (move?.action === 'play' && validCardId(move.card) && this.playable().includes(move.card)) {
      const face = FACES[move.card];
      if (face.colour === null ? isFourColour(move.colour) : move.colour === undefined) {
        return this.play(move.card, face.colour ?? move.colour as FourColour, now);
      }
    }
    if (move?.card === undefined && move?.colour === undefined) {
      if (move?.action === 'draw' && this.state.drawn === null) return this.draw(now);
      if (move?.action === 'pass' && this.state.drawn !== null) return this.pass(now);
    }
    throw new TableError('bad_action', '请选择当前可出的牌。变色牌需要选颜色，摸过牌后只能出刚摸的牌或结束回合。');
  }

  autoPlay(id: string, now: number): TableStep | null {
    if (this.status !== 'playing' || this.current.id !== id) return null;
    const candidates = this.playable();
    const card = candidates.find(card => FACES[card].colour !== null) ?? candidates[0];
    if (card !== undefined) return this.play(card, FACES[card].colour ?? this.preferredColour(), now, true);
    if (this.state.drawn !== null) return this.pass(now, true);
    const drawn = this.draw(now, true);
    if (this.state.drawn === null) return drawn;
    const finish = this.autoPlay(id, now)!;
    return { ...finish, events: [...drawn.events, ...finish.events] };
  }

  tick(now: number): TableStep | null {
    return this.status === 'playing' && now >= this.state.deadline ? this.autoPlay(this.current.id, now) : null;
  }

  nextWakeAt(): number | undefined { return this.status === 'playing' ? this.state.deadline : undefined; }

  rearm(now: number, downtimeMs: number, minHumanMs: number): void {
    if (this.status === 'playing') this.state.deadline = Math.max(this.state.deadline + downtimeMs, now + minHumanMs);
  }

  public() {
    const { players, colour, deadline, direction, status, last, stock } = this.state;
    return {
      game: this.game, label: this.label, host: this.host, status,
      seats: players.map(({ id, name, kind, hand }) => ({ id, name, kind, count: hand.length })),
      top: this.top, colour, direction, stockCount: stock.length, last,
      turn: status === 'playing' ? this.current.id : undefined,
      deadline: status === 'playing' ? deadline : undefined,
      winners: status === 'ended' ? [this.current.id] : undefined,
    };
  }

  view(id: string) {
    const player = this.state.players.find(player => player.id === id);
    if (!player) return null;
    const yourTurn = this.status === 'playing' && this.current.id === id;
    const playable = yourTurn ? this.playable() : [];
    const actions = yourTurn ? [this.state.drawn === null ? 'draw' : 'pass'] : [];
    if (playable.length) actions.unshift('play');
    return {
      ...this.public(), seat: id, yourTurn, hand: player.hand.map(cardAt), playable, actions,
      drawn: yourTurn ? this.state.drawn : null,
    };
  }

  publicText(): string {
    if (this.status === 'open') return `【四彩牌】${this.state.players.length}/4 人，至少两人开局。`;
    if (this.status === 'ended') return `【四彩牌】${this.current.name} 出完手牌，赢得本局。`;
    return `【四彩牌】当前是 ${fourColourFaceText(this.top!)}（接 ${COLOUR_LABELS[this.state.colour!]}色），轮到 ${this.current.name}。`;
  }

  privateText(id: string): string | null {
    const view = this.view(id);
    if (!view) return null;
    if (!view.yourTurn) return this.publicText();
    const choices = view.hand.filter(card => view.playable.includes(card.id))
      .map(card => `${card.id}=${fourColourFaceText(card)}`);
    return this.publicText() + (choices.length ? `可出的牌：${choices.join('、')}。` : '没有可出的牌。')
      + (view.drawn === null ? '可以摸一张。' : '已摸牌，可以结束回合。');
  }

  exportState(): unknown { return structuredClone(this.state); }

  restoreState(input: unknown): void {
    const state = input as State | null;
    if (!state || state.version !== this.stateVersion || !['open', 'playing', 'ended'].includes(state.status)
      || !Array.isArray(state.players) || state.players.length < (state.status === 'open' ? 1 : 2)
      || state.players.length > FOUR_COLOUR_CAPACITY
      || !state.players.every(seat => seat && typeof seat.id === 'string' && seat.id && typeof seat.name === 'string'
        && Array.isArray(seat.hand) && seat.hand.every(validCardId))
      || state.players[0].id !== this.host || new Set(state.players.map(seat => seat.id)).size !== state.players.length
      || !Array.isArray(state.stock) || !state.stock.every(validCardId)
      || !Array.isArray(state.discard) || !state.discard.every(validCardId)
      || !Number.isInteger(state.current) || state.current < 0 || !state.players[state.current]
      || ![1, -1].includes(state.direction) || typeof state.last !== 'string'
      || !Number.isFinite(state.deadline) || (state.status === 'playing' ? state.deadline <= 0 : state.deadline !== 0)) {
      throw new Error('无法读取四彩牌存档');
    }
    const cards = [...state.stock, ...state.discard, ...state.players.flatMap(seat => seat.hand)];
    const top = FACES[state.discard.at(-1) ?? -1];
    const emptyHands = state.players.filter(seat => seat.hand.length === 0).length;
    const validPlay = cards.length === FACES.length && new Set(cards).size === cards.length
      && !!top && isFourColour(state.colour) && (top.colour === null || top.colour === state.colour)
      && (state.status === 'ended' ? emptyHands === 1 && state.players[state.current].hand.length === 0 : emptyHands === 0);
    if ((state.status === 'open' ? cards.length || state.colour !== null : !validPlay)
      || (state.drawn !== null && (state.status !== 'playing' || !validCardId(state.drawn)
        || !state.players[state.current].hand.includes(state.drawn)))) {
      throw new Error('无法读取四彩牌存档');
    }
    this.state = structuredClone(state);
  }

  private shuffle(cards: number[]): number[] {
    for (let i = cards.length - 1; i > 0; i--) {
      const j = this.randomIndex(i + 1);
      [cards[j], cards[i]] = [cards[i], cards[j]];
    }
    return cards;
  }

  private playable(): number[] {
    const { colour, drawn } = this.state;
    const { hand } = this.current;
    const hasColour = hand.some(id => FACES[id].colour === colour);
    const rank = this.top?.rank;
    return hand.filter(id => {
      if (drawn !== null && id !== drawn) return false;
      const face = FACES[id];
      if (face.rank === 'draw4') return !hasColour;
      return face.rank === 'wild' || face.colour === colour || face.rank === rank;
    });
  }

  private preferredColour(): FourColour {
    return FOUR_COLOURS.map(colour => ({ colour, count: this.current.hand.filter(id => FACES[id].colour === colour).length }))
      .sort((a, b) => b.count - a.count)[0].colour;
  }

  private take(player: Player, count: number): number[] {
    const taken: number[] = [];
    for (let i = 0; i < count; i++) {
      if (!this.state.stock.length && this.state.discard.length > 1) {
        this.state.stock = this.shuffle(this.state.discard.splice(0, this.state.discard.length - 1));
      }
      const next = this.state.stock.pop();
      if (next === undefined) break;
      taken.push(next);
    }
    player.hand.push(...taken);
    return taken;
  }

  private draw(now: number, auto = false): TableStep {
    const player = this.current;
    const [card] = this.take(player, 1);
    this.state.drawn = card ?? null;
    const events = [this.actionEvent('draw', card === undefined ? `${player.name} 无牌可摸。` : `${player.name} 摸了一张牌。`, auto)];
    if (card === undefined || !this.playable().length) return this.advance(1, now, events);
    return { events, views: [player.id] };
  }

  private pass(now: number, auto = false): TableStep {
    return this.advance(1, now, [this.actionEvent('pass', `${this.current.name} 结束了回合。`, auto)]);
  }

  private play(id: number, colour: FourColour, now: number, auto = false): TableStep {
    const player = this.current;
    const face = FACES[id];
    this.state.discard.push(id);
    this.state.colour = colour;
    player.hand.splice(player.hand.indexOf(id), 1);
    let text = `${player.name} 出了 ${fourColourFaceText(face)}${face.colour === null ? `，换成${COLOUR_LABELS[colour]}色` : ''}。`;
    if (player.hand.length === 1) text += '只剩 1 张！';
    if (face.rank === 'reverse') this.state.direction = this.state.direction === 1 ? -1 : 1;
    const next = this.state.players[this.nextIndex(1)];
    const penalty = face.rank === 'draw2' ? 2 : face.rank === 'draw4' ? 4 : 0;
    const skip = face.rank === 'skip' || penalty > 0 || (face.rank === 'reverse' && this.state.players.length === 2);
    if (penalty) text += `${next.name} 摸 ${this.take(next, penalty).length} 张。`;
    if (skip && player.hand.length > 0) text += `跳过 ${next.name}。`;
    const events = [this.actionEvent('play', text, auto)];
    if (player.hand.length > 0) return this.advance(skip ? 2 : 1, now, events);
    this.state.status = 'ended';
    this.state.drawn = null;
    this.state.deadline = 0;
    events.push(this.event('end', this.publicText(), { winners: [player.id] }));
    return { events, views: [], ended: true, seatResults: null };
  }

  private nextIndex(steps: number): number {
    const size = this.state.players.length;
    return (this.state.current + size + steps * this.state.direction) % size;
  }

  private advance(steps: number, now: number, events: TableEvent[]): TableStep {
    this.state.current = this.nextIndex(steps);
    this.state.drawn = null;
    this.state.deadline = now + this.turnMs;
    return { events, views: [this.current.id] };
  }

  private actionEvent(action: string, text: string, auto: boolean): TableEvent {
    this.state.last = text;
    return this.event('action', text, { seat: this.current.id, action, auto });
  }

  private event(type: string, text: string, data: Record<string, unknown>): TableEvent {
    return { type: `parlor.table.${type}`, scope: { kind: 'room' }, text, data: { game: this.game, ...data } };
  }
}
