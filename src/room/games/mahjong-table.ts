import { randomInt } from 'node:crypto';
import { GAME_PRESENTATION } from '../game-labels.ts';
import { TableError, type TableEngine, type TableEvent, type TableSeat, type TableStatus, type TableStep } from '../table-engine.ts';
import { canHu, isTile, RED, SUITS, suitOf, TILES, tileCounts, tileKinds, type MahjongGame } from './mahjong-rules.ts';

const CAPACITY = 4;
/** 碰杠胡的响应窗口与出牌时长；对外页的规则页直接引用这一份。 */
export const MAHJONG_REPLY_MS = 20_000;
export const MAHJONG_TURN_MS = 60_000;
export const MAHJONG_ACTIONS = ['exchange', 'missing', 'discard', 'pung', 'kong', 'hu', 'pass'] as const;
type ActionName = typeof MAHJONG_ACTIONS[number];
type Choice = 'pung' | 'kong' | 'hu' | 'pass';
type Phase = 'waiting' | 'exchange' | 'missing' | 'discard' | 'claim' | 'result';
type Meld = { kind: 'pung' | 'kong'; tile: number; from: number | null };
type Discard = { tile: number; order: number; taken?: 'pung' | 'kong' | 'hu'; by?: number[] };
type Win = { tile: number; from: number | null };
type Player = {
  seat: TableSeat;
  hand: number[];
  river: Discard[];
  melds: Meld[];
  exchange: number[] | null;
  missing: number | null;
  win: Win | null;
  score: number;
};
type Claim = { from: number; choices: Partial<Record<number, Choice>> };
type State = {
  version: number;
  game: MahjongGame;
  status: TableStatus;
  players: Player[];
  wall: number[];
  dealer: number;
  turn: number;
  phase: Phase;
  deadline: number;
  window: number;
  direction: number;
  exchangeDone: boolean;
  draw: number | null;
  discards: number;
  claim: Claim | null;
};
type Action = { action?: unknown; windowId?: unknown; tile?: unknown; tiles?: unknown; suit?: unknown };

function player(seat: TableSeat): Player {
  return { seat: { ...seat }, hand: [], river: [], melds: [], exchange: null, missing: null, win: null, score: 0 };
}

function removeTiles(hand: number[], tiles: readonly number[]): number[] | null {
  const remaining = hand.slice();
  for (const tile of tiles) {
    const index = remaining.indexOf(tile);
    if (index === -1) return null;
    remaining.splice(index, 1);
  }
  return remaining;
}

function leastSuit(hand: readonly number[], minimum: number): number {
  const counts = SUITS.map((_, suit) => hand.filter(tile => suitOf(tile) === suit).length);
  return counts.reduce((best, count, suit) =>
    count >= minimum && (best < 0 || count < counts[best]) ? suit : best, -1);
}

export class MahjongTable implements TableEngine {
  readonly game: MahjongGame;
  readonly label: string;
  readonly host: string;
  readonly stateVersion = 1;
  private readonly turnMs: number;
  private state: State;

  constructor(game: MahjongGame, host: TableSeat, turnMs = MAHJONG_TURN_MS, dealer = 0) {
    this.game = game;
    this.label = GAME_PRESENTATION[game].label;
    this.host = host.id;
    this.turnMs = turnMs;
    this.state = {
      version: this.stateVersion, game, status: 'open', players: [player(host)], wall: [], dealer,
      turn: dealer, phase: 'waiting', deadline: 0, window: 0, direction: 0, exchangeDone: false,
      draw: null, discards: 0, claim: null,
    };
  }

  get status(): TableStatus { return this.state.status; }
  private get sichuan(): boolean { return this.game === 'mahjong-sichuan'; }
  private get players(): Player[] { return this.state.players; }
  private get windowId(): string { return 'm' + this.state.window; }

  has(id: string): boolean { return this.seatIds().includes(id); }
  seatIds(): string[] { return this.players.map(p => p.seat.id); }

  private event(type: string, text: string, data: Record<string, unknown> = {}): TableEvent {
    return { type: 'parlor.table.' + type, scope: { kind: 'room' }, text, data: { game: this.game, ...data } };
  }

  join(seat: TableSeat): TableEvent {
    if (this.status !== 'open') throw new TableError('not_open', '麻将已开局');
    if (this.has(seat.id)) throw new TableError('seated', '你已经入座');
    if (this.players.length >= CAPACITY) throw new TableError('full', '麻将桌已满');
    this.players.push(player(seat));
    return this.event('join', seat.name + ' 坐到了麻将桌。', { seat: seat.id });
  }

  leave(id: string): TableEvent {
    if (this.status !== 'open') throw new TableError('not_open', '开局后由宿主处理离桌');
    if (!this.has(id)) throw new TableError('not_seated', '你没有入座');
    if (id === this.host) throw new TableError('not_host', '桌主离开请收桌');
    this.state.players = this.players.filter(p => p.seat.id !== id);
    return this.event('left', '一位玩家离开了麻将桌。', { seat: id });
  }

  start(by: string, now: number): TableStep {
    if (by !== this.host) throw new TableError('not_host', '只有桌主可以开局');
    if (this.status !== 'open' || this.players.length !== CAPACITY) throw new TableError('not_open', '需要四席坐满才能开局');
    const wall = Array.from({ length: tileKinds(this.game) * 4 }, (_, id) => Math.floor(id / 4));
    for (let i = wall.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [wall[i], wall[j]] = [wall[j], wall[i]];
    }
    for (const p of this.players) p.hand = wall.splice(0, 13);
    this.state.wall = wall;
    this.state.status = 'playing';
    const dealer = this.players[this.state.dealer];
    const events = [this.event('start', this.label + '开局，' + dealer.seat.name + '坐庄。')];
    if (this.sichuan) {
      this.state.direction = randomInt(1, 4);
      this.openPhase('exchange', now);
      return this.step(events, this.seatIds());
    }
    return this.drawFor(this.state.dealer, now, events);
  }

  act(id: string, value: unknown, now: number): TableStep {
    if (this.status !== 'playing') throw new TableError('not_started', '麻将桌当前不可行动');
    const index = this.seatIds().indexOf(id);
    if (index < 0) throw new TableError('not_seated', '你没有入座');
    const action = value as Action | null;
    if (action?.windowId !== this.windowId || now >= this.state.deadline) {
      throw new TableError('expired', '这个行动窗口已经过去');
    }
    if (!this.legal(index).includes(action.action as ActionName)) throw new TableError('bad_action', '当前不能执行这个动作');
    return this.play(index, action, now);
  }

  private play(index: number, action: Action, now: number): TableStep {
    const p = this.players[index];
    switch (this.state.phase) {
      case 'exchange': {
        const tiles = action.tiles;
        if (!Array.isArray(tiles) || tiles.length !== 3 || !tiles.every(tile => isTile(tile, 27) && suitOf(tile) === suitOf(tiles[0]))
          || !removeTiles(p.hand, tiles)) throw new TableError('bad_action', '请选择手里的三张同门牌');
        p.exchange = tiles.slice();
        if (this.players.some(entry => !entry.exchange)) return this.step();
        const outgoing = this.players.map(entry => entry.exchange!);
        for (const [i, entry] of this.players.entries()) {
          const source = (i + CAPACITY - this.state.direction) % CAPACITY;
          entry.hand = [...removeTiles(entry.hand, outgoing[i])!, ...outgoing[source]];
          entry.exchange = null;
        }
        this.state.exchangeDone = true;
        this.openPhase('missing', now);
        return this.step([this.event('action', '换牌完成，请定缺。')], this.seatIds());
      }
      case 'missing': {
        const suit = action.suit;
        if (suit !== 0 && suit !== 1 && suit !== 2) throw new TableError('bad_action', '请选择缺万、筒或条');
        p.missing = suit;
        if (this.players.some(entry => entry.missing === null)) return this.step();
        return this.drawFor(this.state.dealer, now, [this.event('action', '定缺完成，庄家摸牌。')]);
      }
      case 'claim': {
        if (action.tile !== undefined) throw new TableError('bad_action', '响应弃牌时不需要指定牌');
        const claim = this.state.claim!;
        claim.choices[index] = action.action as Choice;
        return this.respond(now);
      }
      case 'discard': {
        if (action.action === 'hu') return this.win([index], this.state.draw!, null, now, []);
        if (action.action === 'kong') {
          if (typeof action.tile !== 'number' || !this.ownKongs(index).includes(action.tile)) {
            throw new TableError('bad_action', '请选择可以杠的牌');
          }
          return this.kong(index, action.tile, null, now, []);
        }
        if (typeof action.tile !== 'number' || !this.discardable(index).includes(action.tile)) {
          throw new TableError('bad_action', '请选择可打出的手牌，有缺门牌时须先打缺');
        }
        return this.discard(index, action.tile, now);
      }
      default:
        throw new TableError('bad_action', '当前不能打牌');
    }
  }

  private openPhase(phase: Phase, now: number): void {
    this.state.phase = phase;
    this.state.window++;
    this.state.deadline = now + (phase === 'claim' ? Math.min(MAHJONG_REPLY_MS, this.turnMs) : this.turnMs);
  }

  private step(events: TableEvent[] = [], views: string[] = []): TableStep {
    return { events, views };
  }

  private following(index: number): number {
    for (let distance = 1; distance < CAPACITY; distance++) {
      const next = (index + distance) % CAPACITY;
      if (!this.players[next].win) return next;
    }
    throw new Error('麻将没有下一席');
  }

  private drawFor(index: number, now: number, events: TableEvent[]): TableStep {
    if (!this.state.wall.length) return this.finish(events);
    this.state.turn = index;
    const tile = this.state.wall.pop()!;
    this.players[index].hand.push(tile);
    this.state.draw = tile;
    this.openPhase('discard', now);
    return this.step(events, [this.players[index].seat.id]);
  }

  private discardable(index: number): number[] {
    const { hand, missing } = this.players[index];
    const mustDiscard = missing === null ? [] : hand.filter(tile => suitOf(tile) === missing);
    return [...new Set(mustDiscard.length ? mustDiscard : hand)].sort((a, b) => a - b);
  }

  private mayMeld(p: Player, tile: number): boolean {
    return tile !== RED && suitOf(tile) !== p.missing;
  }

  private ownKongs(index: number): number[] {
    if (!this.state.wall.length || this.state.draw === null) return [];
    const p = this.players[index];
    const counts = tileCounts(p.hand, tileKinds(this.game));
    return counts.flatMap((count, tile) => this.mayMeld(p, tile) && (
      count === 4 || (count > 0 && p.melds.some(m => m.kind === 'pung' && m.tile === tile))
    ) ? [tile] : []);
  }

  private claimOptions(index: number): Choice[] {
    const claim = this.state.claim;
    const p = this.players[index];
    if (!claim || claim.from === index || p.win) return [];
    const { tile } = this.players[claim.from].river.at(-1)!;
    const actions: Choice[] = [];
    if (this.sichuan && canHu(this.game, [...p.hand, tile], p.melds.length, p.missing)) actions.push('hu');
    if (this.mayMeld(p, tile)) {
      const count = p.hand.filter(t => t === tile).length;
      if (count >= 2) actions.push('pung');
      if (count >= 3 && this.state.wall.length) actions.push('kong');
    }
    if (actions.length) actions.push('pass');
    return actions;
  }

  private legal(index: number): ActionName[] {
    const p = this.players[index];
    if (this.status !== 'playing' || p.win) return [];
    switch (this.state.phase) {
      case 'exchange': return p.exchange ? [] : ['exchange'];
      case 'missing': return p.missing === null ? ['missing'] : [];
      case 'claim': return this.state.claim?.choices[index] ? [] : this.claimOptions(index);
      case 'discard': {
        if (index !== this.state.turn) return [];
        const actions: ActionName[] = ['discard'];
        if (this.state.draw !== null && canHu(this.game, p.hand, p.melds.length, p.missing)) actions.unshift('hu');
        if (this.ownKongs(index).length) actions.push('kong');
        return actions;
      }
      default: return [];
    }
  }

  private discard(index: number, tile: number, now: number): TableStep {
    const p = this.players[index];
    p.hand = removeTiles(p.hand, [tile])!;
    p.river.push({ tile, order: ++this.state.discards });
    this.state.draw = null;
    this.state.claim = { from: index, choices: {} };
    const events = [this.event('action', p.seat.name + ' 打出' + TILES[tile] + '。', { seat: p.seat.id, tile })];
    const pending = this.players.filter((_, i) => this.claimOptions(i).length).map(entry => entry.seat.id);
    if (!pending.length) {
      this.state.claim = null;
      return this.drawFor(this.following(index), now, events);
    }
    this.openPhase('claim', now);
    return this.step(events, pending);
  }

  private respond(now: number, timedOut = false): TableStep {
    const claim = this.state.claim!;
    if (!timedOut && this.players.some((_, i) => !claim.choices[i] && this.claimOptions(i).length)) return this.step();
    const { from, choices } = claim;
    this.state.claim = null;
    const entry = this.players[from].river.at(-1)!;
    const order = [1, 2, 3].map(offset => (from + offset) % CAPACITY);
    const winners = order.filter(i => choices[i] === 'hu');
    if (winners.length) {
      entry.taken = 'hu';
      entry.by = winners;
      return this.win(winners, entry.tile, from, now, []);
    }
    const caller = order.find(i => choices[i] === 'pung' || choices[i] === 'kong');
    if (caller === undefined) return this.drawFor(this.following(from), now, [
      this.event('action', '响应结束，继续摸牌。'),
    ]);
    entry.taken = choices[caller] === 'kong' ? 'kong' : 'pung';
    entry.by = [caller];
    if (entry.taken === 'kong') return this.kong(caller, entry.tile, from, now, []);
    const p = this.players[caller];
    p.hand = removeTiles(p.hand, [entry.tile, entry.tile])!;
    p.melds.push({ kind: 'pung', tile: entry.tile, from });
    this.state.turn = caller;
    this.openPhase('discard', now);
    return this.step([this.event('action', p.seat.name + ' 碰' + TILES[entry.tile] + '。')], [p.seat.id]);
  }

  private pay(to: number, from: number | null, amount: number): void {
    for (const [i, p] of this.players.entries()) {
      if (i === to || p.win || (from !== null && i !== from)) continue;
      p.score -= amount;
      this.players[to].score += amount;
    }
  }

  private kong(index: number, tile: number, from: number | null, now: number, events: TableEvent[]): TableStep {
    const p = this.players[index];
    const existing = from === null ? p.melds.find(m => m.kind === 'pung' && m.tile === tile) : undefined;
    const amount = existing ? 1 : 2;
    if (existing) {
      p.hand = removeTiles(p.hand, [tile])!;
      existing.kind = 'kong';
    } else {
      const count = from === null ? 4 : 3;
      p.hand = removeTiles(p.hand, Array<number>(count).fill(tile))!;
      p.melds.push({ kind: 'kong', tile, from });
    }
    this.pay(index, from, amount);
    const description = from === null && !existing ? ' 暗杠。' : ' 杠' + TILES[tile] + '。';
    events.push(this.event('action', p.seat.name + description));
    return this.drawFor(index, now, events);
  }

  private win(winners: number[], tile: number, from: number | null, now: number, events: TableEvent[]): TableStep {
    for (const index of winners) {
      this.pay(index, from, 1);
      this.players[index].win = { tile, from };
    }
    this.state.draw = null;
    events.push(this.event('action', winners.map(i => this.players[i].seat.name).join('、')
      + (from === null ? ' 自摸' : ' 胡') + TILES[tile] + '。'));
    if (!this.sichuan || this.players.filter(p => p.win).length === 3) return this.finish(events);
    return this.drawFor(this.following(from ?? winners[0]), now, events);
  }

  private finish(events: TableEvent[]): TableStep {
    this.state.status = 'ended';
    this.state.phase = 'result';
    this.state.deadline = 0;
    this.state.draw = null;
    const winners = this.players.filter(p => p.win).map(p => p.seat.id);
    const summary = this.players.map(p => p.seat.name + ' ' + (p.score > 0 ? '+' : '') + p.score + ' 分').join('，');
    const seatResults = this.players.map(p => ({
      seatId: p.seat.id, score: p.score,
      rank: 1 + this.players.filter(other => other.score > p.score).length,
    }));
    events.push(this.event('end', this.label + '结束。' + summary + '。等级分按含杠分的结算净分排名。', {
      winners, tie: !winners.length,
    }));
    return { events, views: [], ended: true, seatResults };
  }

  autoPlay(id: string, now: number): TableStep | null {
    const index = this.seatIds().indexOf(id);
    if (index < 0 || this.status !== 'playing') return null;
    const actions = this.legal(index);
    const p = this.players[index];
    if (actions.includes('exchange')) {
      const suit = leastSuit(p.hand, 3);
      return this.play(index, { tiles: p.hand.filter(tile => suitOf(tile) === suit).slice(0, 3) }, now);
    }
    if (actions.includes('missing')) return this.play(index, { suit: leastSuit(p.hand, 0) }, now);
    if (actions.includes('pass')) return this.play(index, { action: actions.includes('hu') ? 'hu' : 'pass' }, now);
    if (actions.includes('hu')) return this.play(index, { action: 'hu' }, now);
    if (actions.includes('discard')) {
      const tile = this.discardHints(index)[0]?.tile ?? this.discardable(index)[0];
      return this.play(index, { action: 'discard', tile }, now);
    }
    return null;
  }

  tick(now: number): TableStep | null {
    if (this.status !== 'playing' || now < this.state.deadline) return null;
    if (this.state.phase === 'claim') return this.respond(now, true);
    // 超时将同一预备窗口收齐，最后一次提交才产生公开事件和新窗口。
    if (this.state.phase === 'exchange' || this.state.phase === 'missing') {
      const pending = this.players.filter((_, i) => this.legal(i).length).map(p => p.seat.id);
      let step: TableStep | null = null;
      for (const id of pending) step = this.autoPlay(id, now);
      return step;
    }
    return this.autoPlay(this.players[this.state.turn].seat.id, now);
  }

  nextWakeAt(): number | undefined { return this.status === 'playing' ? this.state.deadline : undefined; }

  rearm(now: number, downtimeMs: number, minHumanMs: number): void {
    if (this.status === 'playing') this.state.deadline = now + Math.max(this.state.deadline - (now - downtimeMs), minHumanMs);
  }

  private unseen(index: number): number[] {
    const known = this.players[index].hand.slice();
    for (const [i, p] of this.players.entries()) {
      for (const entry of p.river) {
        if (entry.taken !== 'pung' && entry.taken !== 'kong') known.push(entry.tile);
      }
      for (const m of p.melds) {
        if (i === index || m.from !== null) {
          known.push(...Array<number>(m.kind === 'pung' ? 3 : 4).fill(m.tile));
        }
      }
      if (i !== index && p.win) known.push(...p.hand);
    }
    return tileCounts(known, tileKinds(this.game)).map(count => 4 - count);
  }

  private discardHints(index: number, unseen = this.unseen(index)) {
    const p = this.players[index];
    return this.discardable(index).map(tile => {
      const rest = removeTiles(p.hand, [tile])!;
      const waits = unseen.flatMap((count, candidate) =>
        count > 0 && canHu(this.game, [...rest, candidate], p.melds.length, p.missing) ? [candidate] : []);
      const total = waits.reduce((sum, t) => sum + unseen[t], 0);
      const support = p.hand.filter(t => t === tile).length - 1 + (tile < 27
        ? rest.filter(t => suitOf(t) === suitOf(tile) && t !== tile && Math.abs(t - tile) <= 2).length : 0);
      const reason = total ? '听 ' + waits.map(t => TILES[t]).join('、') + '，合计 ' + total + ' 张未见'
        : suitOf(tile) === p.missing ? '先打缺门牌' : support === 0 ? '手中孤张' : '保留搭子较多的牌';
      return { tile, waits, total, support, reason };
    }).sort((a, b) => Number(a.tile === RED) - Number(b.tile === RED)
      || b.total - a.total || a.support - b.support || a.tile - b.tile)
      .slice(0, 3).map(({ support: _support, ...hint }) => hint);
  }

  public() {
    const s = this.state;
    return {
      game: this.game, status: this.status, host: this.host, capacity: CAPACITY, phase: s.phase,
      dealer: this.players[s.dealer]?.seat.id,
      turn: s.phase === 'discard' ? this.players[s.turn].seat.id : undefined,
      wallCount: s.wall.length, deadline: this.nextWakeAt(), lastDiscard: s.discards,
      direction: s.exchangeDone ? s.direction : undefined,
      seats: this.players.map(p => ({
        ...p.seat, count: p.hand.length, river: p.river.map(({ by, ...entry }) => ({
          ...entry, ...(by && { claimedBy: by.map(index => this.players[index].seat.id) }),
        })),
        melds: p.melds.map(m => ({ kind: m.kind, tile: m.from === null && !p.win && s.phase !== 'result' ? null : m.tile })),
        missing: s.phase === 'missing' ? null : p.missing,
        win: p.win && { ...p.win },
        revealed: p.win || s.phase === 'result' ? p.hand.slice().sort((a, b) => a - b) : undefined,
        score: p.score,
      })),
      startBlockers: this.players.length < CAPACITY ? ['等四人坐满后开局'] : [],
    };
  }

  view(id: string) {
    const index = this.seatIds().indexOf(id);
    if (index < 0) return null;
    const p = this.players[index];
    const actions = this.legal(index);
    const unseen = this.unseen(index);
    return {
      game: this.game, seat: id, status: this.status, phase: this.state.phase,
      windowId: this.windowId, deadline: this.nextWakeAt(), yourTurn: actions.length > 0,
      hand: p.hand.slice().sort((a, b) => a - b), missing: p.missing, drawn: this.state.turn === index ? this.state.draw : null,
      ownMelds: p.melds.map(m => ({ ...m })),
      actions, unseen,
      discardable: actions.includes('discard') ? this.discardable(index) : [],
      kongs: actions.includes('kong') && this.state.phase === 'discard' ? this.ownKongs(index) : [],
      hints: actions.includes('discard') ? this.discardHints(index, unseen) : [],
    };
  }

  publicText(): string {
    switch (this.state.phase) {
      case 'waiting': return this.label + '等人中，四人坐满开局。';
      case 'exchange': return '换三张，请各选三张同门手牌。';
      case 'missing': return '定缺，请各选一门打缺。';
      case 'claim': return '等待碰、杠或胡牌响应。';
      case 'discard': return '轮到 ' + this.players[this.state.turn].seat.name + '，牌墙余 ' + this.state.wall.length + ' 张。';
      case 'result': return this.label + '已结算。';
    }
  }

  privateText(id: string): string | null {
    const view = this.view(id);
    if (!view) return null;
    if (!view.yourTurn) return this.publicText();
    const options = view.actions.join('、');
    const hints = view.hints.map(hint => '打' + TILES[hint.tile] + '：' + hint.reason).join('；');
    const response = this.state.claim && this.players[this.state.claim.from].river.at(-1);
    const suggestHu = view.actions.includes('hu') ? '可胡' + (response ? TILES[response.tile] : '') + '。' : '';
    const unseen = view.unseen.flatMap((count, tile) => count < 4 ? [TILES[tile] + '×' + count] : []);
    const discard = view.discardable.length ? '可出 ' + view.discardable.map(tile => TILES[tile]).join('、') + '。' : '';
    const kong = view.kongs.length ? '可杠 ' + view.kongs.map(tile => TILES[tile] + '(' + tile + ')').join('、') + '。' : '';
    const exchangeSuit = view.phase === 'exchange' ? leastSuit(view.hand, 3) : -1;
    const opening = view.phase === 'exchange'
      ? '建议换 ' + view.hand.filter(tile => suitOf(tile) === exchangeSuit).slice(0, 3).map(tile => TILES[tile] + '(' + tile + ')').join('、') + '。'
      : view.phase === 'missing' ? '建议缺' + SUITS[leastSuit(view.hand, 0)] + '，suit 取 0 万、1 筒、2 条。' : '';
    const args = view.phase === 'exchange' ? 'exchange 参数 tiles 为三张同门牌号。'
      : view.phase === 'discard' ? 'discard 和手内 kong 参数 tile 为牌号。' : '';
    return [this.publicText(), response && '当前弃牌 ' + TILES[response.tile] + '。',
      '手牌 ' + view.hand.map(tile => TILES[tile] + '(' + tile + ')').join(' ') + '。',
      '动作 ' + options + '（windowId ' + view.windowId + '）。', args, discard, suggestHu, kong, opening, hints,
      unseen.length ? '未见张数 ' + unseen.join(' ') + '（其余牌各 4 张）。未见牌也可能在他家手牌或暗杠中。' : '',
    ].filter(Boolean).join(' ');
  }

  exportState(): State { return structuredClone(this.state); }

  restoreState(value: unknown): void {
    const s = value as State | null;
    if (!s || s.version !== this.stateVersion || s.game !== this.game
      || !Array.isArray(s.players) || s.players.length < 1 || s.players.length > CAPACITY
      || s.players[0]?.seat?.id !== this.host || new Set(s.players.map(p => p?.seat?.id)).size !== s.players.length
      || !Array.isArray(s.wall) || !['open', 'playing', 'ended'].includes(s.status)
      || !Number.isInteger(s.dealer) || s.dealer < 0 || s.dealer >= CAPACITY
      || !Number.isInteger(s.turn) || s.turn < 0 || s.turn >= CAPACITY
      || !Number.isSafeInteger(s.deadline) || !Number.isSafeInteger(s.window) || s.window < 0
      || !Number.isInteger(s.direction) || s.direction < 0 || s.direction >= CAPACITY
      || typeof s.exchangeDone !== 'boolean' || !Number.isSafeInteger(s.discards) || s.discards < 0
      || (s.status === 'open' && (s.phase !== 'waiting' || s.deadline !== 0))
      || (s.status !== 'open' && s.players.length !== CAPACITY)
      || (s.status === 'playing' && (s.deadline <= 0 || !['exchange', 'missing', 'discard', 'claim'].includes(s.phase)))
      || (s.status === 'ended' && (s.phase !== 'result' || s.deadline !== 0))
      || (s.phase === 'claim') !== !!s.claim
      || (s.claim && (s.claim.from !== s.turn || !s.players[s.claim.from]?.river?.length
        || !s.claim.choices || typeof s.claim.choices !== 'object'
        || Object.entries(s.claim.choices).some(([index, choice]) =>
          !/^[0-3]$/.test(index) || +index === s.claim!.from || !['pung', 'kong', 'hu', 'pass'].some(action => action === choice))))) {
      throw new Error('麻将存档格式错误');
    }
    const kinds = tileKinds(this.game);
    const tiles = s.wall.slice();
    const orders: number[] = [];
    for (const p of s.players) {
      if (!p?.seat?.id || typeof p.seat.name !== 'string' || !Number.isSafeInteger(p.score)
        || !Array.isArray(p.hand) || !Array.isArray(p.river) || !Array.isArray(p.melds)
        || (p.missing !== null && (!this.sichuan || ![0, 1, 2].includes(p.missing)))
        || (p.win && !isTile(p.win.tile, kinds))
        || (p.exchange !== null && (s.phase !== 'exchange' || !Array.isArray(p.exchange) || p.exchange.length !== 3
          || !p.exchange.every(tile => isTile(tile, 27) && suitOf(tile) === suitOf(p.exchange![0]))
          || !removeTiles(p.hand, p.exchange)))) throw new Error('麻将存档席位错误');
      tiles.push(...p.hand);
      for (const entry of p.river) {
        if (!isTile(entry?.tile, kinds) || !Number.isSafeInteger(entry.order) || entry.order < 1 || entry.order > s.discards
          || (entry.taken !== undefined && (!['pung', 'kong', 'hu'].includes(entry.taken)
            || !Array.isArray(entry.by) || !entry.by.length || entry.by.some(i => !s.players[i])))) throw new Error('麻将存档牌河错误');
        orders.push(entry.order);
        if (entry.taken !== 'pung' && entry.taken !== 'kong') tiles.push(entry.tile);
      }
      for (const m of p.melds) {
        if (!isTile(m?.tile, kinds) || !['pung', 'kong'].includes(m.kind)
          || (m.from !== null && (!Number.isInteger(m.from) || m.from < 0 || m.from >= CAPACITY))) throw new Error('麻将存档副露错误');
        tiles.push(...Array<number>(m.kind === 'pung' ? 3 : 4).fill(m.tile));
      }
    }
    if (orders.length !== s.discards || new Set(orders).size !== orders.length
      || s.players.reduce((sum, p) => sum + p.score, 0) !== 0
      || (s.draw !== null && (s.phase !== 'discard' || !s.players[s.turn]?.hand.includes(s.draw)))
      || (s.status === 'open' ? tiles.length !== 0 : (
        tiles.length !== kinds * 4 || tiles.some(tile => !isTile(tile, kinds)) || tileCounts(tiles, kinds).some(count => count !== 4)
      ))) throw new Error('麻将存档牌张或分数不守恒');
    this.state = structuredClone(s);
  }
}
