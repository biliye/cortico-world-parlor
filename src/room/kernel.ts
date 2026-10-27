/**
 * 房间内核：席位、令牌、事件日志、可见性与唤醒挡位。
 * 所有可见性判断都在这里；服务器与 World 只按它给的结果发或不发。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_WAKE_TIER, WAKE_TIERS, WAKE_TIER_LABELS,
  type JoinRequest, type JoinResponse, type RoomEvent, type RoomSnapshot, type Scope,
  type Seat, type SeatKind, type WakeTier,
} from './protocol.ts';

export interface StoredSeat extends Seat {
  token: string;
  ownerToken: string;
}

export interface RoomState {
  version: 1;
  id: string;
  maxSeats: number;
  seq: number;
  seatSeq: number;
  seats: StoredSeat[];
  events: RoomEvent[];
}

export interface RoomKernelOptions {
  id: string;
  inviteCode: string;
  maxSeats?: number;
  historyLimit?: number;
  now?: () => number;
}

export class RoomError extends Error {
  readonly code: 'forbidden' | 'conflict' | 'full' | 'invalid' | 'not_found';

  constructor(code: 'forbidden' | 'conflict' | 'full' | 'invalid' | 'not_found', message: string) {
    super(message);
    this.code = code;
    this.name = 'RoomError';
  }
}

const TOKEN_BYTES = 24;
const MAX_TEXT = 400;
const MAX_NAME = 24;
const SAY_GAP_MS = 50;

const makeToken = (): string => randomBytes(TOKEN_BYTES).toString('base64url');

const sameToken = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const cleanName = (value: unknown): string => (
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME) : ''
);

const cleanText = (value: unknown): string => {
  if (typeof value !== 'string') throw new RoomError('invalid', '消息必须是文字');
  const text = value.trim();
  if (!text) throw new RoomError('invalid', '消息不能为空');
  if (text.length > MAX_TEXT) throw new RoomError('invalid', `一句话最多 ${MAX_TEXT} 个字`);
  return text;
};

const publicSeat = (seat: StoredSeat): Seat => ({
  id: seat.id, name: seat.name, kind: seat.kind, tier: seat.tier, joinedAt: seat.joinedAt,
});

const isKind = (value: unknown): value is SeatKind => value === 'pet' || value === 'human' || value === 'observer';
const isTier = (value: unknown): value is WakeTier => WAKE_TIERS.includes(value as WakeTier);

export class RoomKernel {
  readonly id: string;
  readonly inviteCode: string;
  readonly maxSeats: number;
  private readonly historyLimit: number;
  private readonly now: () => number;
  private seats: StoredSeat[] = [];
  private events: RoomEvent[] = [];
  private seq = 0;
  private seatSeq = 0;
  private readonly listeners = new Set<(event: RoomEvent) => void>();
  private readonly lastSay = new Map<string, number>();

  constructor(options: RoomKernelOptions) {
    this.id = options.id;
    this.inviteCode = options.inviteCode;
    this.maxSeats = options.maxSeats ?? 8;
    this.historyLimit = options.historyLimit ?? 500;
    this.now = options.now ?? Date.now;
  }

  static fromJSON(raw: unknown, options: RoomKernelOptions): RoomKernel {
    const kernel = new RoomKernel(options);
    if (!raw || typeof raw !== 'object') return kernel;
    const state = raw as Partial<RoomState>;
    if (state.version !== 1 || !Array.isArray(state.seats) || !Array.isArray(state.events)) return kernel;
    kernel.seats = state.seats
      .filter((seat): seat is StoredSeat => !!seat && typeof seat.id === 'string' && typeof seat.token === 'string'
        && typeof seat.ownerToken === 'string' && typeof seat.name === 'string')
      .map((seat) => ({
        id: seat.id,
        name: seat.name,
        kind: isKind(seat.kind) ? seat.kind : 'pet',
        tier: isTier(seat.tier) ? seat.tier : DEFAULT_WAKE_TIER,
        joinedAt: Number(seat.joinedAt) || 0,
        token: seat.token,
        ownerToken: seat.ownerToken,
      }));
    kernel.events = state.events
      .filter((event): event is RoomEvent => !!event && typeof event.seq === 'number' && typeof event.text === 'string')
      .slice(-kernel.historyLimit);
    kernel.seq = Math.max(Number(state.seq) || 0, ...kernel.events.map((event) => event.seq), 0);
    kernel.seatSeq = Math.max(Number(state.seatSeq) || 0, ...kernel.seats.map((seat) => Number(seat.id.slice(1)) || 0), 0);
    return kernel;
  }

  toJSON(): RoomState {
    return {
      version: 1,
      id: this.id,
      maxSeats: this.maxSeats,
      seq: this.seq,
      seatSeq: this.seatSeq,
      seats: this.seats,
      events: this.events,
    };
  }

  onEvent(listener: (event: RoomEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  seatsPublic(): Seat[] {
    return this.seats.map(publicSeat);
  }

  join(request: JoinRequest): JoinResponse {
    const name = cleanName(request.name);
    if (!name) throw new RoomError('invalid', '名字不能为空');
    const kind: SeatKind = isKind(request.kind) ? request.kind : 'pet';
    const tier: WakeTier = isTier(request.tier) ? request.tier : DEFAULT_WAKE_TIER;
    if (this.seats.some((seat) => seat.name.toLowerCase() === name.toLowerCase())) {
      throw new RoomError('conflict', `已经有叫「${name}」的席位`);
    }
    if (kind !== 'observer' && this.seats.filter((seat) => seat.kind !== 'observer').length >= this.maxSeats) {
      throw new RoomError('full', `客厅最多 ${this.maxSeats} 个会说话的席位`);
    }
    const seat: StoredSeat = {
      id: `s${++this.seatSeq}`,
      name,
      kind,
      tier,
      joinedAt: this.now(),
      token: makeToken(),
      ownerToken: makeToken(),
    };
    this.seats.push(seat);
    this.record({
      type: 'parlor.joined',
      from: 'system',
      scope: { kind: 'room' },
      text: `${name} 进了客厅。`,
      data: { seatId: seat.id, name },
    });
    return {
      room: this.id,
      seat: publicSeat(seat),
      token: seat.token,
      ownerToken: seat.ownerToken,
      maxSeats: this.maxSeats,
    };
  }

  authenticate(token: string): { seat: StoredSeat; role: 'pet' | 'owner' } | null {
    if (!token) return null;
    for (const seat of this.seats) {
      if (sameToken(seat.token, token)) return { seat, role: 'pet' };
      if (sameToken(seat.ownerToken, token)) return { seat, role: 'owner' };
    }
    return null;
  }

  seatById(id: string): StoredSeat | undefined {
    return this.seats.find((seat) => seat.id === id);
  }

  resolveSeat(value: string): StoredSeat | undefined {
    const needle = value.trim().toLowerCase();
    return this.seats.find((seat) => seat.id === value.trim())
      ?? this.seats.find((seat) => seat.name.toLowerCase() === needle);
  }

  say(seat: StoredSeat, text: string): RoomEvent {
    const body = cleanText(text);
    const last = this.lastSay.get(seat.id) ?? 0;
    const now = this.now();
    if (now - last < SAY_GAP_MS) throw new RoomError('invalid', '说得太快了，等一下再说');
    this.lastSay.set(seat.id, now);
    return this.record({
      type: 'parlor.say',
      from: seat.id,
      scope: { kind: 'room' },
      text: body,
      mentions: this.mentions(body),
      data: { name: seat.name },
    });
  }

  whisper(seat: StoredSeat, to: string, text: string): RoomEvent {
    const body = cleanText(text);
    const target = this.resolveSeat(to);
    if (!target) throw new RoomError('not_found', `客厅里没有叫「${to}」的席位`);
    if (target.id === seat.id) throw new RoomError('invalid', '不能私聊自己');
    return this.record({
      type: 'parlor.whisper',
      from: seat.id,
      scope: { kind: 'seat', seatId: target.id },
      text: body,
      mentions: [target.id],
      data: { name: seat.name, to: target.id, toName: target.name },
    });
  }

  setTier(seat: StoredSeat, tier: WakeTier): Seat {
    if (!isTier(tier)) throw new RoomError('invalid', '未知的提醒挡位');
    seat.tier = tier;
    this.record({
      type: 'parlor.tier',
      from: 'system',
      scope: { kind: 'seat', seatId: seat.id },
      text: `提醒挡位改成了「${WAKE_TIER_LABELS[tier]}」。`,
      data: { seatId: seat.id, tier },
    });
    return publicSeat(seat);
  }

  /** 发言里的 `@名字` 与 `@all`。名字先按长到短匹配，避免「阿岚」吃掉「阿岚的朋友」。 */
  mentions(text: string): string[] {
    const found = new Set<string>();
    if (text.includes('@all')) for (const seat of this.seats) found.add(seat.id);
    for (const seat of [...this.seats].sort((a, b) => b.name.length - a.name.length)) {
      if (text.includes(`@${seat.name}`) || text.includes(`@${seat.id}`)) found.add(seat.id);
    }
    return [...found];
  }

  visibleTo(event: RoomEvent, seatId: string): boolean {
    return event.scope.kind === 'room' || event.scope.seatId === seatId;
  }

  history(seatId: string, since: number, limit = 30): RoomEvent[] {
    return this.events
      .filter((event) => event.seq > since && this.visibleTo(event, seatId))
      .slice(0, Math.max(1, Math.min(200, limit)));
  }

  latest(): number {
    return this.seq;
  }

  snapshot(seatId: string, since: number, limit = 30): Omit<RoomSnapshot, 'seat'> {
    const seat = this.seatById(seatId);
    if (!seat) throw new RoomError('not_found', '席位不存在');
    return {
      id: this.id,
      seats: this.seatsPublic(),
      maxSeats: this.maxSeats,
      latest: this.seq,
      events: this.history(seatId, since, limit),
    };
  }

  record(input: Omit<RoomEvent, 'seq' | 'ts'>): RoomEvent {
    const event: RoomEvent = { seq: ++this.seq, ts: this.now(), ...input };
    this.events.push(event);
    if (this.events.length > this.historyLimit) {
      this.events.splice(0, this.events.length - this.historyLimit);
    }
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* 一个订阅者出错不影响其他人 */ }
    }
    return event;
  }

  /** 只给测试与迁移用：把一条任意 scope 的事件写进日志。 */
  appendRaw(scope: Scope, text: string, type = 'parlor.say', from = 'system'): RoomEvent {
    return this.record({ type, from, scope, text });
  }
}
