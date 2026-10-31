/**
 * 房间内核：席位、令牌、事件日志、可见性与唤醒挡位。
 * 所有可见性判断都在这里；服务器与 World 只按它给的结果发或不发。
 */
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  DEFAULT_WAKE_TIER, WAKE_TIERS, WAKE_TIER_LABELS, scopeVisibleTo,
  type ActionRequest, type DeliveryReceipt, type JoinRequest, type JoinResponse, type MonopolyInfo, type MonopolySignupView,
  type RoomEvent, type RoomSnapshot, type Scope,
  type Seat, type SeatKind, type WakeTier,
} from './protocol.ts';
import { serverClock } from './clock.ts';
import { parseHandleQuery, shortHandle } from './handles.ts';
import { mentionsInText } from './mentions.ts';
import { DiceTable } from './table.ts';
import { DoudizhuTable } from './games/doudizhu-table.ts';
import { MonopolyTable, PACE_LABELS, type MonopolyPace } from './games/monopoly-table.ts';
import {
  ActivityStore, freshActivity, hashOf, lookupRequest, queueEffect, rememberRequest, requestKeyOf, settleEffect,
  type Effect, type MonopolyActivity,
} from './activity-store.ts';
import {
  isCooId, LedgerStore, MAX_CHIPS, MAX_DUE_MS, MAX_OPEN_PROMISES, MAX_SOCIAL_PER_HOUR, MAX_SOCIAL_TEXT,
  type LedgerEntry,
} from './ledger.ts';
import { MailStore, type MailPage, type MailView } from './mail.ts';
import { ReplayStore } from './replay.ts';
import {
  TableError,
  type TableEngine, type TableEvent, type TableGame, type TablePrivateSummary, type TableStep, type TableSummary,
} from './table-engine.ts';

export interface StoredSeat extends Seat {
  token: string;
  ownerToken: string;
  /** 跨房账本身份；老房间没有时按 legacy:<room>:<seat> 算。 */
  cooId?: string;
}

export interface RoomState {
  version: 1;
  id: string;
  maxSeats: number;
  seq: number;
  seatSeq: number;
  seats: StoredSeat[];
  events: RoomEvent[];
  /** 房间代次：清空重建后旧的 activity.json 不能串过来。 */
  epoch?: string;
  /** 还没开局的大富翁报名表；不占桌子槽。 */
  monopolySignup?: MonopolySignup;
}

/** 大富翁报名：候场期最多 24 小时，开局才占桌子。 */
export interface MonopolySignup {
  hostSeatId: string;
  seats: string[];
  size: 4 | 6;
  pace: MonopolyPace;
  createdAt: number;
  deadlineAt: number;
}

const SIGNUP_MS = 24 * 60 * 60_000;
const MAX_BOTS = 2;
const MONOPOLY_REQUEST_LIMIT = 512;

export interface RoomKernelOptions {
  id: string;
  inviteCode: string;
  maxSeats?: number;
  historyLimit?: number;
  now?: () => number;
  /** 骰子桌每次行动的时限；测试里可以调短（斗地主固定 60 秒一手）。 */
  tableTurnMs?: number;
  /** 账本；不传时用内存账本（测试用）。 */
  ledger?: LedgerStore;
  /** 信箱；不传时用内存信箱（测试用）。 */
  mail?: MailStore;
  /** 回放；不传时只留内存里的房间日志（测试用）。 */
  replay?: ReplayStore;
  /** 大富翁活动存档路径；不传时大富翁只活在内存里（测试用）。 */
  activityFile?: string;
}

/** 一条私聊/账本通知处理完之后，给寄信人的投递回执。 */
export type DeliveredEvent = RoomEvent & { delivered: DeliveryReceipt[] };
export type DeliveredEntry = LedgerEntry & { delivered?: DeliveryReceipt[] };
export interface TableReceipt {
  deadline?: number;
  /** 下一个截止属于谁（显示名）。 */
  turn?: string;
}
export interface StartReceipt extends TableReceipt {
  /** 开局那一刻现读的桌上席位（脚本陪练也列出来）。 */
  seats: string[];
}
export interface MonopolyReceipt extends TableReceipt {
  /** 这一手之后本人看到的私视图。 */
  text?: string;
  seats?: string[];
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

/** 礼物与承诺的字数上限比闲聊短，且要单独校验。 */
const cleanSocial = (value: unknown): string => {
  if (typeof value !== 'string') throw new RoomError('invalid', '内容必须是文字');
  const text = value.trim();
  if (!text) throw new RoomError('invalid', '内容不能为空');
  if (text.length > MAX_SOCIAL_TEXT) throw new RoomError('invalid', `礼物或承诺最多 ${MAX_SOCIAL_TEXT} 个字`);
  return text;
};

const chipsOf = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_CHIPS) {
    throw new RoomError('invalid', `筹码要是 1 到 ${MAX_CHIPS} 之间的整数`);
  }
  return amount;
};

const stakeOf = (value: unknown): number => {
  if (value === undefined || value === null || value === '') return 0;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_CHIPS) {
    throw new RoomError('invalid', `押注要是 0 到 ${MAX_CHIPS} 之间的整数`);
  }
  return amount;
};

const dueOf = (value: unknown, now: number): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new RoomError('invalid', '截止时间要写日期，例如 2026-11-01');
  if (ms <= now) throw new RoomError('invalid', '截止时间要在将来');
  if (ms - now > MAX_DUE_MS) throw new RoomError('invalid', '截止时间最多 90 天');
  return ms;
};

const dueLabel = (due: number): string => new Date(due).toISOString().slice(0, 10);

const publicSeat = (seat: StoredSeat): Seat => ({
  id: seat.id,
  name: seat.name,
  kind: seat.kind,
  tier: seat.tier,
  joinedAt: seat.joinedAt,
  ...(seat.cooId && isCooId(seat.cooId) ? { handle: shortHandle(seat.cooId) } : {}),
});

const isKind = (value: unknown): value is SeatKind => value === 'pet' || value === 'human' || value === 'observer';
const isTier = (value: unknown): value is WakeTier => WAKE_TIERS.includes(value as WakeTier);

export class RoomKernel {
  readonly id: string;
  readonly inviteCode: string;
  readonly maxSeats: number;
  private readonly historyLimit: number;
  private readonly now: () => number;
  private readonly tableTurnMs: number;
  private readonly ledger: LedgerStore;
  /** 信箱：私聊与账本通知都留一份，离线回来还能看。 */
  readonly mail: MailStore;
  /** 回放：房间日志会滚动，回放单独留 7 天。 */
  readonly replay: ReplayStore;
  private seats: StoredSeat[] = [];
  private events: RoomEvent[] = [];
  private seq = 0;
  private seatSeq = 0;
  private table?: TableEngine;
  /** 当前这张桌子的编号：开桌时按事件序号生成，桌内发言的事件带上它。 */
  private tableId = '';
  /** 当前桌子的押注（每人开局押多少筹码）；0 = 不押。 */
  private tableStake = 0;
  private epochValue: string;
  private signup?: MonopolySignup;
  private readonly activityFile?: string;
  private activity?: ActivityStore;
  private activityData?: MonopolyActivity;
  private monopolyGameId?: string;
  /** 存档写不进去 / 读不出来 / 副作用没落盘，这局就冻结，等人处理。 */
  private activityFault?: string;
  private tableFault?: string;
  private effectsFault?: string;
  private readonly listeners = new Set<(event: RoomEvent) => void>();
  private readonly lastSay = new Map<string, number>();

  constructor(options: RoomKernelOptions) {
    this.id = options.id;
    this.inviteCode = options.inviteCode;
    this.maxSeats = options.maxSeats ?? 8;
    this.historyLimit = options.historyLimit ?? 500;
    this.now = options.now ?? Date.now;
    this.tableTurnMs = options.tableTurnMs ?? 45_000;
    this.ledger = options.ledger ?? new LedgerStore({ now: this.now });
    this.mail = options.mail ?? new MailStore({ now: this.now });
    this.replay = options.replay ?? new ReplayStore({ now: this.now });
    this.epochValue = randomUUID();
    this.activityFile = options.activityFile;
    if (options.activityFile) this.activity = new ActivityStore({ file: options.activityFile });
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
        ...(typeof seat.cooId === 'string' && isCooId(seat.cooId) ? { cooId: seat.cooId } : {}),
      }));
    kernel.events = state.events
      .filter((event): event is RoomEvent => !!event && typeof event.seq === 'number' && typeof event.text === 'string')
      .slice(-kernel.historyLimit);
    kernel.seq = Math.max(Number(state.seq) || 0, ...kernel.events.map((event) => event.seq), 0);
    kernel.seatSeq = Math.max(Number(state.seatSeq) || 0, ...kernel.seats.map((seat) => Number(seat.id.slice(1)) || 0), 0);
    if (typeof state.epoch === 'string' && state.epoch.length > 0) kernel.epochValue = state.epoch;
    kernel.signup = kernel.validSignup(state.monopolySignup);
    kernel.restoreActivity();
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
      epoch: this.epochValue,
      ...(this.signup ? { monopolySignup: this.signup } : {}),
    };
  }

  onEvent(listener: (event: RoomEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  seatsPublic(): Seat[] {
    return this.seats.map(publicSeat);
  }

  /** Coo 撞名时自动加序号；真人仍报冲突，让网页用户自己换。 */
  private joinName(base: string, kind: SeatKind): string {
    const taken = (candidate: string): boolean => (
      this.seats.some((seat) => seat.name.toLowerCase() === candidate.toLowerCase())
    );
    if (!taken(base)) return base;
    if (kind !== 'pet') throw new RoomError('conflict', `已经有叫「${base}」的席位`);
    for (let index = 2; index <= 50; index += 1) {
      const suffix = ` ${index}`;
      const candidate = Array.from(base).slice(0, Math.max(1, MAX_NAME - suffix.length)).join('') + suffix;
      if (!taken(candidate)) return candidate;
    }
    throw new RoomError('conflict', `已经有叫「${base}」的席位，自动编号也排满了`);
  }

  join(request: JoinRequest, cooId?: string): JoinResponse {
    const requested = cleanName(request.name);
    if (!requested) throw new RoomError('invalid', '名字不能为空');
    const kind: SeatKind = isKind(request.kind) ? request.kind : 'pet';
    const tier: WakeTier = isTier(request.tier) ? request.tier : DEFAULT_WAKE_TIER;
    const name = this.joinName(requested, kind);
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
      ...(cooId && isCooId(cooId) ? { cooId } : {}),
    };
    this.seats.push(seat);
    // 只有带真身份的席位才发筹码；老式（legacy）席位等绑定后再发，免得换身份时领两次。
    if (seat.cooId) this.ledger.ensureGrant(seat.cooId, this.id);
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
    const handle = parseHandleQuery(value);
    if (handle !== null) {
      const matches = this.seats.filter((seat) => seat.cooId !== undefined && seat.cooId.toLowerCase().startsWith(handle));
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) throw new RoomError('conflict', `这个号对上了 ${matches.length} 个人，用完整 id 或席位名`);
      return undefined;
    }
    const needle = value.trim().toLowerCase();
    return this.seats.find((seat) => seat.id === value.trim())
      ?? this.seats.find((seat) => seat.name.toLowerCase() === needle);
  }

  /** 账本用的跨房身份；老席位没有时按 legacy 算，等 World 带身份来再绑。 */
  cooIdOf(seat: StoredSeat): string {
    return seat.cooId ?? `legacy:${this.id}:${seat.id}`;
  }

  /** 把老席位绑到 World 的 cooId；已经有真身份时不覆盖。 */
  bindCooId(seat: StoredSeat, cooId: string): boolean {
    if (seat.cooId && !seat.cooId.startsWith('legacy:')) return false;
    if (!isCooId(cooId)) return false;
    seat.cooId = cooId;
    this.ledger.ensureGrant(cooId, this.id);
    return true;
  }

  say(seat: StoredSeat, text: string): RoomEvent {
    const body = cleanText(text);
    this.checkSayGap(seat);
    return this.record({
      type: 'parlor.say',
      from: seat.id,
      scope: { kind: 'room' },
      text: body,
      mentions: this.mentions(body),
      data: { name: seat.name },
    });
  }

  /**
   * 牌桌上说的话：只给那一刻坐在这一桌的人（和他们的家长页）看，客厅里看不见。
   * 桌散了、或者换了人开新桌，新坐上来的人也看不到这一桌之前的话。
   */
  tableSay(seat: StoredSeat, text: string): RoomEvent {
    const body = cleanText(text);
    const table = this.table;
    if (!table || table.status === 'ended') throw new RoomError('invalid', '现在没有牌桌，回客厅说吧');
    if (!table.has(seat.id)) throw new RoomError('invalid', '你不在这一桌，回客厅说吧');
    this.checkSayGap(seat);
    return this.record({
      type: 'parlor.table.say',
      from: seat.id,
      scope: { kind: 'table', tableId: this.tableId, seats: this.tableChatSeats() },
      text: body,
      mentions: this.mentions(body),
      data: { name: seat.name, tableId: this.tableId },
    });
  }

  /** 桌上发言与客厅发言共用同一个间隔，防止交替发绕过限速。 */
  private checkSayGap(seat: StoredSeat): void {
    const last = this.lastSay.get(seat.id) ?? 0;
    const now = this.now();
    if (now - last < SAY_GAP_MS) throw new RoomError('invalid', '说得太快了，等一下再说');
    this.lastSay.set(seat.id, now);
  }

  /** 桌上能看见这些话的席位：只算真席位，脚本陪练不是房间席位。 */
  private tableChatSeats(): string[] {
    const table = this.table;
    if (!table) return [];
    return table.seatIds().filter((seatId) => !!this.seatById(seatId));
  }

  whisper(seat: StoredSeat, to: string, text: string): DeliveredEvent {
    const body = cleanText(text);
    const target = this.resolveSeat(to);
    if (!target) throw new RoomError('not_found', `客厅里没有叫「${to}」的席位`);
    if (target.id === seat.id) throw new RoomError('invalid', '不能私聊自己');
    const event = this.record({
      type: 'parlor.whisper',
      from: seat.id,
      scope: { kind: 'seat', seatId: target.id },
      text: body,
      mentions: [target.id],
      data: { name: seat.name, to: target.id, toName: target.name },
    });
    // 对方可能不在线：私聊同时进信箱，回来还能看到。只回「已投递」，不回已读。
    const letter = this.mail.append({
      room: this.id,
      to: this.cooIdOf(target),
      kind: 'whisper',
      fromName: seat.name,
      text: body,
    });
    return {
      ...event,
      delivered: [{
        to: target.name, mailSeq: letter.seq, ts: letter.ts, at: serverClock(letter.ts),
      }],
    };
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

  /** 送礼：纯文本，可选带筹码。礼物是私密条目，只有收礼的人（和家长页）看得见。 */
  gift(seat: StoredSeat, to: string, text: string, chips?: number): DeliveredEntry {
    const body = cleanSocial(text);
    const target = this.requireTarget(seat, to);
    const amount = chipsOf(chips);
    const fromCoo = this.cooIdOf(seat);
    const toCoo = this.cooIdOf(target);
    this.checkSocialBudget(fromCoo);
    if (amount !== undefined && this.ledger.balanceOf(fromCoo) < amount) {
      throw new RoomError('invalid', `你只有 ${this.ledger.balanceOf(fromCoo)} 枚筹码`);
    }
    const entry = this.ledger.record({
      kind: 'gift',
      room: this.id,
      from: fromCoo,
      to: toCoo,
      text: body,
      visibility: 'private',
      data: { fromName: seat.name, toName: target.name, ...(amount ? { chips: amount } : {}) },
      ...(amount ? { transfers: [{ from: fromCoo, to: toCoo, amount }] } : {}),
    });
    const delivered = this.notifyLedger([target.id], `收到一份礼物：${body}${amount ? `（${amount} 枚筹码）` : ''}`, {
      entryId: entry.id, kind: 'gift', action: 'gift', from: seat.name,
    });
    return { ...entry, ...(delivered.length ? { delivered } : {}) };
  }

  /** 承诺：可以带截止时间与筹码；要对方回应才算数。 */
  promise(seat: StoredSeat, to: string, text: string, due?: number | string, chips?: number): DeliveredEntry {
    const body = cleanSocial(text);
    const target = this.requireTarget(seat, to);
    const amount = chipsOf(chips);
    const dueAt = dueOf(due, this.now());
    const fromCoo = this.cooIdOf(seat);
    this.checkSocialBudget(fromCoo);
    if (this.ledger.countOpenPromises(fromCoo) >= MAX_OPEN_PROMISES) {
      throw new RoomError('invalid', `你已经有 ${MAX_OPEN_PROMISES} 条没了结的承诺，先了结几条`);
    }
    const entry = this.ledger.record({
      kind: 'promise',
      room: this.id,
      from: fromCoo,
      to: this.cooIdOf(target),
      text: body,
      visibility: 'private',
      ...(dueAt !== undefined ? { due: dueAt } : {}),
      data: {
        fromName: seat.name,
        toName: target.name,
        ...(amount ? { chips: amount } : {}),
      },
    });
    const delivered = this.notifyLedger([target.id], `${seat.name} 对你许了个承诺：${body}${dueAt ? `（${dueLabel(dueAt)} 前）` : ''}${amount ? `，${amount} 枚筹码` : ''}。用 parlor_respond 回。`, {
      entryId: entry.id, kind: 'promise', action: 'promise', from: seat.name,
    });
    return { ...entry, ...(delivered.length ? { delivered } : {}) };
  }

  /**
   * 回应一条承诺。只有被承诺的人能答应/拒绝/了结；只有提出的人能在对方回应前撤回。
   * 了结只能由债权人做（`to` 那一方），筹码从债务人划给债权人。
   */
  respond(seat: StoredSeat, id: string, action: 'accept' | 'decline' | 'done' | 'cancel'): DeliveredEntry {
    if (seat.kind === 'observer') throw new RoomError('forbidden', '观看者不能写账本');
    const promise = this.ledger.find(id);
    if (!promise || (promise.kind !== 'promise' && promise.kind !== 'debt')) {
      throw new RoomError('not_found', '找不到这条承诺；用 parlor_ledger 看未了结里的 id');
    }
    if (promise.room !== this.id) {
      throw new RoomError('not_found', '这条承诺不在这个客厅；回原来的客厅再回应');
    }
    const me = this.cooIdOf(seat);
    const status = this.ledger.promiseStatus(promise);
    const counterpartCoo = promise.from === me ? promise.to : promise.from;
    const counterpart = counterpartCoo ? this.seatByCoo(counterpartCoo) : undefined;
    const storedName = promise.from === me ? promise.data?.toName : promise.data?.fromName;
    const otherName = counterpart?.name
      ?? (typeof storedName === 'string' && storedName ? storedName : '对方');

    if (action === 'accept' || action === 'decline') {
      if (promise.to !== me) throw new RoomError('forbidden', '只有被承诺的人能回应');
      if (status !== 'pending') throw new RoomError('conflict', `这条承诺已经「${this.statusLabel(status)}」了`);
      return this.transferPromise(seat, promise, action, counterpart, otherName);
    }
    if (action === 'cancel') {
      if (promise.from !== me) throw new RoomError('forbidden', '只有提出承诺的人能撤回');
      if (status !== 'pending') throw new RoomError('conflict', '对方已经回应了，不能单方面撤回');
      return this.transferPromise(seat, promise, action, counterpart, otherName);
    }
    // done = 了结；只有债权人能认。
    if (promise.to !== me) throw new RoomError('forbidden', '只有被承诺的人（债权人）能说了结');
    if (status !== 'accepted') throw new RoomError('conflict', `这条承诺现在是「${this.statusLabel(status)}」，不能了结`);
    const amount = typeof promise.data?.chips === 'number' ? promise.data.chips : 0;
    if (amount > 0) {
      const balance = this.ledger.balanceOf(promise.from);
      if (balance < amount) {
        throw new RoomError('invalid', `${otherName} 现在只有 ${balance} 枚筹码，还不够 ${amount} 枚`);
      }
    }
    return this.transferPromise(seat, promise, action, counterpart, otherName);
  }

  /** 到期没结的承诺：由服务器追加 default，并通知双方；只扫本客厅的承诺。 */
  expireLedger(now = this.now()): LedgerEntry[] {
    const created = this.ledger.expire(now, this.id);
    for (const entry of created) {
      const [debtorCoo, creditorCoo] = entry.participants ?? [];
      const debtor = debtorCoo ? this.seatByCoo(debtorCoo) : undefined;
      const creditor = creditorCoo ? this.seatByCoo(creditorCoo) : undefined;
      const text = typeof entry.data?.promiseText === 'string' ? entry.data.promiseText : entry.text;
      if (debtor) {
        this.notifyLedger([debtor.id], `你对 ${creditor?.name ?? '对方'} 的承诺到期没结：${text}`, {
          entryId: entry.ref, kind: 'promise', action: 'default',
        });
      }
      if (creditor) {
        this.notifyLedger([creditor.id], `${debtor?.name ?? '对方'} 对你的承诺到期没结：${text}`, {
          entryId: entry.ref, kind: 'promise', action: 'default',
        });
      }
    }
    return created;
  }

  /** 余额见底的人由房间补一点（每段间隔最多一次），并私下告诉他。 */
  refillLedger(now = this.now()): LedgerEntry[] {
    const created: LedgerEntry[] = [];
    for (const seat of this.seats) {
      // 只补有真身份的席位；老式席位等绑定后再补。
      if (seat.kind === 'observer' || !seat.cooId) continue;
      const entry = this.ledger.maybeRefill(seat.cooId, this.id, now);
      if (!entry) continue;
      created.push(entry);
      const amount = typeof entry.data?.chips === 'number' ? entry.data.chips : 0;
      this.notifyLedger([seat.id], `房间给你补了 ${amount} 枚筹码，现在有 ${this.ledger.balanceOf(seat.cooId)} 枚。`, {
        entryId: entry.id, kind: 'grant', action: 'refill',
      });
    }
    return created;
  }

  private transferPromise(
    seat: StoredSeat,
    promise: LedgerEntry,
    action: 'accept' | 'decline' | 'done' | 'cancel',
    counterpart: StoredSeat | undefined,
    otherName: string,
  ): DeliveredEntry {
    const kind = action === 'done' ? 'settle' : action;
    const me = this.cooIdOf(seat);
    const amount = action === 'done' && typeof promise.data?.chips === 'number' ? promise.data.chips : 0;
    const prefix = { accept: '已答应', decline: '已拒绝', cancel: '已撤回', done: '已了结' }[action];
    const entry = this.ledger.record({
      kind,
      ref: promise.id,
      room: promise.room,
      from: me,
      ...(promise.from === me ? { to: promise.to } : { to: promise.from }),
      text: `${prefix}：${promise.text}`,
      visibility: 'private',
      data: {
        fromName: seat.name,
        toName: otherName,
        promiseText: promise.text,
        ...(amount ? { chips: amount } : {}),
      },
      ...(amount && promise.from
        ? { transfers: [{ from: promise.from, to: promise.to ?? me, amount }] }
        : {}),
    });
    const text = {
      accept: `答应了你的承诺：${promise.text}`,
      decline: `没答应这条承诺：${promise.text}`,
      cancel: `撤回了承诺：${promise.text}`,
      done: `说了结这条承诺：${promise.text}${amount ? `（${amount} 枚筹码已划给你）` : ''}`,
    }[action];
    if (counterpart) {
      const delivered = this.notifyLedger([counterpart.id], `${seat.name} ${text}`, {
        entryId: promise.id, kind: 'promise', action,
      });
      return { ...entry, ...(delivered.length ? { delivered } : {}) };
    }
    return entry;
  }

  private statusLabel(status: string | null): string {
    return ({
      pending: '等回应', accepted: '已答应', declined: '已拒绝', cancelled: '已撤回',
      settled: '已了结', defaulted: '已失约',
    } as Record<string, string>)[status ?? ''] ?? status ?? '未知';
  }

  private requireTarget(seat: StoredSeat, to: string): StoredSeat {
    if (seat.kind === 'observer') throw new RoomError('forbidden', '观看者不能写账本');
    const target = this.resolveSeat(to);
    if (!target) throw new RoomError('not_found', `客厅里没有叫「${to}」的席位`);
    if (target.id === seat.id) throw new RoomError('invalid', '不能对自己做这件事');
    if (target.kind === 'observer') throw new RoomError('invalid', '观看者不参与账本');
    return target;
  }

  private checkSocialBudget(cooId: string): void {
    if (this.ledger.socialCountSince(cooId, this.now() - 3_600_000) >= MAX_SOCIAL_PER_HOUR) {
      throw new RoomError('invalid', `一小时内最多 ${MAX_SOCIAL_PER_HOUR} 条礼物或承诺，过一会儿再来`);
    }
  }

  private seatByCoo(cooId: string): StoredSeat | undefined {
    return this.seats.find((seat) => this.cooIdOf(seat) === cooId);
  }

  /** 只给该看的席位发一条账本通知；不发公开事件，同时留一封进对方的信箱。 */
  private notifyLedger(seatIds: string[], text: string, data: Record<string, unknown>): DeliveryReceipt[] {
    const delivered: DeliveryReceipt[] = [];
    for (const seatId of new Set(seatIds)) {
      const seat = this.seatById(seatId);
      if (!seat) continue;
      this.record({
        type: 'parlor.ledger',
        from: 'system',
        scope: { kind: 'seat', seatId },
        text,
        data,
      });
      const kind = data.kind === 'gift' ? 'gift' : data.kind === 'promise' ? 'promise' : 'ledger';
      const letter = this.mail.append({
        room: this.id,
        to: this.cooIdOf(seat),
        kind,
        ...(typeof data.action === 'string' ? { action: data.action } : {}),
        fromName: typeof data.from === 'string' ? data.from : '系统',
        text,
        ...(typeof data.entryId === 'string' ? { entryId: data.entryId } : {}),
      });
      delivered.push({
        to: seat.name, mailSeq: letter.seq, ts: letter.ts, at: serverClock(letter.ts),
      });
    }
    return delivered;
  }

  /** 某个席位的未读信数。 */
  mailUnread(seat: StoredSeat): number {
    return this.mail.unreadCount(this.cooIdOf(seat), this.id);
  }

  /** 读信：默认把取走的这几封标成已读。 */
  readMail(seat: StoredSeat, limit = 10, markRead = true): MailPage {
    return this.mail.list(this.cooIdOf(seat), this.id, limit, markRead);
  }

  /** 最近几封（含已读），给家长页看，不动游标。 */
  mailRecent(seat: StoredSeat, limit = 3): MailView[] {
    return this.mail.recent(this.cooIdOf(seat), this.id, limit);
  }

  openTable(seat: StoredSeat, game: TableGame = 'dice', stake = 0): void {
    if (seat.kind === 'observer') throw new RoomError('invalid', '观看者不能开桌');
    if (this.table && this.table.status !== 'ended') throw new RoomError('conflict', '已经有一张桌子了');
    const ante = stakeOf(stake);
    if (ante > 0 && this.ledger.balanceOf(this.cooIdOf(seat)) < ante) {
      throw new RoomError('invalid', `你只有 ${this.ledger.balanceOf(this.cooIdOf(seat))} 枚筹码，押不起 ${ante} 枚`);
    }
    if (game === 'dice') {
      this.table = new DiceTable({ host: { id: seat.id, name: seat.name }, now: this.now(), turnMs: this.tableTurnMs });
    } else if (game === 'ddz') {
      // 斗地主的一手默认 60 秒（骰子桌 45 秒），所以不套用 tableTurnMs。
      this.table = new DoudizhuTable({ host: { id: seat.id, name: seat.name }, now: this.now() });
    } else {
      throw new RoomError('invalid', '不认识的桌子：只能开 dice（骰子）或 ddz（斗地主）');
    }
    this.tableStake = ante;
    // 桌号按开桌那条事件的序号生成：重启后序号接着走，不会和上一张桌撞号。
    this.tableId = `t${this.seq + 1}`;
    this.record({
      type: 'parlor.table.open',
      from: 'system',
      scope: { kind: 'room' },
      text: `${seat.name} 开了一张${game === 'ddz' ? '斗地主' : '骰子'}桌${ante > 0 ? `（每人押 ${ante} 枚筹码）` : ''}。`,
      data: { game, stake: ante, tableId: this.tableId },
    });
  }

  joinTable(seat: StoredSeat): void {
    const table = this.requireTable();
    if (this.tableStake > 0 && this.ledger.balanceOf(this.cooIdOf(seat)) < this.tableStake) {
      throw new RoomError('invalid', `这张桌子每人押 ${this.tableStake} 枚，你只有 ${this.ledger.balanceOf(this.cooIdOf(seat))} 枚`);
    }
    try {
      this.record({ ...table.join({ id: seat.id, name: seat.name }), from: 'system' });
    } catch (error) {
      throw this.tableError(error);
    }
  }

  startTable(seat: StoredSeat): StartReceipt {
    const table = this.requireTable();
    const players = table.seatIds()
      .map((seatId) => this.seatById(seatId))
      .filter((player): player is StoredSeat => !!player && player.kind !== 'observer');
    if (this.tableStake > 0) {
      if (players.length < 2) {
        throw new RoomError('invalid', '押注桌至少要两个真人；陪练不押注');
      }
      for (const player of players) {
        const balance = this.ledger.balanceOf(this.cooIdOf(player));
        if (balance < this.tableStake) {
          throw new RoomError('invalid', `${player.name} 只有 ${balance} 枚筹码，押不起 ${this.tableStake} 枚`);
        }
      }
    }
    let step: TableStep;
    try {
      step = table.start(seat.id, this.now());
    } catch (error) {
      throw this.tableError(error);
    }
    if (this.tableStake > 0) {
      const pot = this.tableStake * players.length;
      this.ledger.record({
        kind: 'ante',
        room: this.id,
        from: 'room',
        participants: players.map((player) => this.cooIdOf(player)),
        text: `开局：${players.map((player) => player.name).join('、')} 各押 ${this.tableStake} 枚筹码（底池 ${pot} 枚）。`,
        visibility: 'room',
        transfers: players.map((player) => ({
          from: this.cooIdOf(player), to: 'room', amount: this.tableStake,
        })),
        data: { game: table.game, gameLabel: table.label, stake: this.tableStake, pot },
      });
    }
    this.recordStep(step);
    return { seats: this.tableRoster(), ...this.tableReceipt() };
  }

  tableAction(seat: StoredSeat, action: unknown): TableReceipt {
    const table = this.requireTable();
    if (table.game !== 'dice') throw new RoomError('invalid', '这张桌子不是骰子桌；斗地主用 ddz_action');
    this.applyStep(table, () => table.act(seat.id, action, this.now()));
    return this.tableReceipt();
  }

  ddzAction(seat: StoredSeat, action: unknown): TableReceipt {
    const table = this.requireTable();
    if (table.game !== 'ddz') throw new RoomError('invalid', '这张桌子不是斗地主桌');
    this.applyStep(table, () => table.act(seat.id, action, this.now()));
    return this.tableReceipt();
  }

  tickTable(now = this.now()): void {
    if (this.signup && now >= this.signup.deadlineAt) {
      const who = this.signup.seats.map((id) => this.seatById(id)?.name ?? '？').join('、');
      this.signup = undefined;
      this.record({
        type: 'parlor.monopoly.cancel',
        from: 'system',
        scope: { kind: 'room' },
        text: `大富翁报名 24 小时没开局，已取消（${who}）。`,
        data: { game: 'monopoly' },
      });
    }
    if (!this.table) return;
    if (this.table.status !== 'playing' && this.table.status !== 'bidding') return;
    const table = this.table;
    const beforeSeq = table instanceof MonopolyTable ? table.turnSeq : 0;
    let step: TableStep | null;
    try {
      step = table.tick(now);
    } catch (error) {
      // 长局里一次托管抛错不能让房间继续跑：冻结并让人看见。
      this.tableFault = `牌桌推进失败：${error instanceof Error ? error.message : String(error)}`;
      console.error('parlor: 牌桌超时代打失败', error);
      return;
    }
    if (!step) return;
    if (table instanceof MonopolyTable) {
      this.recordStep(step, false);
      this.attachMonopolyEffects(step, beforeSeq);
      this.saveActivity();
      this.flushEffects();
      return;
    }
    this.recordStep(step);
  }

  tablePublic(): TableSummary | undefined {
    return this.tableSummary();
  }

  private applyStep(table: TableEngine, run: () => TableStep): void {
    let step: TableStep;
    try {
      step = run();
    } catch (error) {
      throw this.tableError(error);
    }
    this.recordStep(step);
  }

  private requireTable(): TableEngine {
    if (!this.table) throw new RoomError('not_found', '现在没有桌子');
    return this.table;
  }

  private tableError(error: unknown): RoomError {
    if (error instanceof RoomError) return error;
    if (error instanceof TableError) {
      if (error.code === 'not_seated' || error.code === 'not_host' || error.code === 'not_turn') {
        return new RoomError('forbidden', error.message);
      }
      if (error.code === 'full' || error.code === 'seated') return new RoomError('conflict', error.message);
      return new RoomError('invalid', error.message);
    }
    return new RoomError('invalid', error instanceof Error ? error.message : String(error));
  }

  private tableSummary(): TableSummary | undefined {
    const table = this.table;
    if (!table) return undefined;
    return {
      ...(table.public() as Record<string, unknown>),
      game: table.game,
      label: table.label,
      status: table.status,
      host: table.host,
      ...(this.tableStake > 0 ? { stake: this.tableStake } : {}),
      text: table.publicText(),
    } as TableSummary;
  }

  /** 开局那一刻现读的桌上席位名（脚本陪练也列出来，带「（脚本）」）。 */
  private tableRoster(): string[] {
    const publicView = this.table?.public() as { seats?: Array<{ name?: unknown; bot?: unknown }> } | undefined;
    return (publicView?.seats ?? [])
      .map((seat) => (typeof seat.name === 'string' ? (seat.bot === true ? `${seat.name}（脚本）` : seat.name) : '？'));
  }

  /** 下一步的绝对截止时刻，以及轮到谁；没有桌子或已经结束就没有。 */
  private tableReceipt(): TableReceipt {
    const publicView = this.table?.public() as {
      deadline?: unknown;
      turn?: unknown;
      seats?: Array<{ id?: unknown; name?: unknown }>;
    } | undefined;
    const deadline = typeof publicView?.deadline === 'number' && publicView.deadline > 0
      ? publicView.deadline
      : undefined;
    const turnId = typeof publicView?.turn === 'string' ? publicView.turn : undefined;
    const name = turnId
      ? publicView?.seats?.find((seat) => seat.id === turnId)?.name
      : undefined;
    return {
      ...(deadline ? { deadline } : {}),
      ...(typeof name === 'string' && name ? { turn: name } : {}),
    };
  }

  private tablePrivate(seatId: string): TablePrivateSummary | null {
    const table = this.table;
    if (!table) return null;
    const text = table.privateText(seatId, this.now());
    if (!text) return null;
    return {
      ...(table.view(seatId) as Record<string, unknown>),
      game: table.game,
      seat: seatId,
      text,
    } as TablePrivateSummary;
  }

  private recordStep(step: TableStep, recordGame = true): void {
    for (const event of step.events) {
      this.record({
        type: event.type,
        from: 'system',
        scope: event.scope,
        text: event.text,
        data: event.data,
      });
      if (event.type === 'parlor.table.end' && recordGame) this.recordGame(event);
    }
    for (const seatId of step.views) {
      // 脚本陪练不是房间席位：它们的视图不进房间日志。
      if (!this.seatById(seatId)) continue;
      const view = this.table?.view(seatId);
      const text = this.table?.privateText(seatId, this.now());
      if (!view || !text) continue;
      this.record({
        type: 'parlor.table.turn',
        from: 'system',
        scope: { kind: 'seat', seatId },
        text,
        data: { table: view },
      });
    }
  }

  /** 一局结束：按桌上真实席位写一条公开战绩；脚本陪练不进账本。 */
  private recordGame(event: TableEvent): void {
    const table = this.table;
    if (!table) return;
    const seats = table.seatIds()
      .map((seatId) => this.seatById(seatId))
      .filter((seat): seat is StoredSeat => !!seat && seat.kind !== 'observer');
    if (seats.length === 0) return;
    const data = event.data ?? {};
    const winnerIds = Array.isArray(data.winners)
      ? data.winners.filter((id): id is string => typeof id === 'string')
      : [];
    const winners = seats
      .filter((seat) => winnerIds.includes(seat.id))
      .map((seat) => this.cooIdOf(seat));
    const game = typeof data.game === 'string' ? data.game : table.game;
    const stake = this.tableStake;
    const pot = stake > 0 ? stake * seats.length : 0;
    let transfers: { from: string; to: string; amount: number }[] | undefined;
    let chipText = '';
    if (pot > 0 && seats.length >= 2) {
      if (winners.length > 0) {
        const unique = [...new Set(winners)];
        const share = Math.floor(pot / unique.length);
        const rest = pot - share * unique.length;
        transfers = unique
          .map((cooId, index) => ({ from: 'room', to: cooId, amount: share + (index === 0 ? rest : 0) }))
          .filter((transfer) => transfer.amount > 0);
        const names = unique.map((cooId) => this.seatByCoo(cooId)?.name ?? '席位').join('、');
        chipText = ` 底池 ${pot} 枚归 ${names}。`;
      } else {
        transfers = seats.map((seat) => ({ from: 'room', to: this.cooIdOf(seat), amount: stake }));
        chipText = ` 没人赢，底池 ${pot} 枚退回。`;
      }
    }
    this.ledger.record({
      kind: 'game',
      room: this.id,
      from: 'room',
      game,
      participants: [...new Set(seats.map((seat) => this.cooIdOf(seat)))],
      winners: [...new Set(winners)],
      text: `${event.text}${chipText}`,
      visibility: 'room',
      ...(transfers && transfers.length > 0 ? { transfers } : {}),
      data: {
        game,
        gameLabel: table.label,
        // 平局由游戏自己在结束事件里说；账本不认任何具体游戏名。
        tie: data.tie === true,
        ...(stake > 0 ? { stake, pot } : {}),
        multiplier: typeof data.multiplier === 'number' ? data.multiplier : undefined,
        spring: data.spring === true,
        antiSpring: data.antiSpring === true,
        landlord: typeof data.landlord === 'string'
          ? this.seatById(data.landlord)?.name
          : undefined,
      },
    });
    this.tableStake = 0;
  }

  /** 发言里的 `@名字` 与 `@all`；名字按长到短匹配并消费，避免「阿岚」吃掉「阿岚的朋友」。 */
  mentions(text: string): string[] {
    const found = new Set<string>();
    if (text.includes('@all')) for (const seat of this.seats) found.add(seat.id);
    for (const id of mentionsInText(text, this.seats)) found.add(id);
    for (const seat of this.seats) if (text.includes(`@${seat.id}`)) found.add(seat.id);
    return [...found];
  }

  visibleTo(event: RoomEvent, seatId: string): boolean {
    return scopeVisibleTo(event.scope, seatId);
  }

  history(seatId: string, since: number, limit = 30): RoomEvent[] {
    return this.events
      .filter((event) => event.seq > since && this.visibleTo(event, seatId))
      .slice(0, Math.max(1, Math.min(200, limit)));
  }

  latest(): number {
    return this.seq;
  }

  nowMs(): number {
    return this.now();
  }

  /** 重启后把房间日志里还留着的事件补进回放（不改日志）。 */
  roomEvents(): RoomEvent[] {
    return [...this.events];
  }


  // —— 大富翁 ——

  /** 房间代次；活动存档靠它隔离「清空重建」后的旧文件。 */
  roomEpoch(): string {
    return this.epochValue;
  }

  private monopolyFault(): string | undefined {
    return this.activityFault ?? this.tableFault ?? this.effectsFault;
  }

  monopolyInfo(): MonopolyInfo | undefined {
    const fault = this.monopolyFault();
    const signup = this.signup;
    const info: MonopolyInfo = {
      ...(signup ? { signup: this.signupView(signup) } : {}),
      ...(fault ? { fault } : {}),
      ...(this.monopolyGameId ? { gameId: this.monopolyGameId } : {}),
    };
    return Object.keys(info).length > 0 ? info : undefined;
  }

  private signupView(signup: MonopolySignup): MonopolySignupView {
    const humans = signup.seats.length;
    const spare = Math.min(MAX_BOTS, Math.max(0, signup.size - humans));
    return {
      host: this.seatById(signup.hostSeatId)?.name ?? '？',
      seats: signup.seats.map((id) => this.seatById(id)?.name ?? '？'),
      size: signup.size,
      pace: signup.pace,
      deadlineAt: signup.deadlineAt,
      missing: Math.max(0, signup.size - humans - spare),
    };
  }

  private validSignup(raw: unknown): MonopolySignup | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const value = raw as Partial<MonopolySignup>;
    if (typeof value.hostSeatId !== 'string' || !this.seatById(value.hostSeatId)) return undefined;
    if (!Array.isArray(value.seats) || value.seats.length === 0) return undefined;
    const seats = value.seats.filter((id): id is string => typeof id === 'string' && !!this.seatById(id));
    if (seats.length !== value.seats.length || !seats.includes(value.hostSeatId)) return undefined;
    if (value.size !== 4 && value.size !== 6) return undefined;
    if (value.pace !== 'standard' && value.pace !== 'quick') return undefined;
    if (typeof value.createdAt !== 'number' || typeof value.deadlineAt !== 'number') return undefined;
    return {
      hostSeatId: value.hostSeatId,
      seats,
      size: value.size,
      pace: value.pace,
      createdAt: value.createdAt,
      deadlineAt: value.deadlineAt,
    };
  }

  /** 从活动存档恢复一局；读不出来就冻结，不悄悄当成没有。 */
  private restoreActivity(): void {
    const store = this.activity;
    if (!store) return;
    const loaded = store.load();
    if (!loaded) {
      if (store.exists() || (store.backupPath && existsSync(store.backupPath))) {
        this.activityFault = '大富翁活动存档读不出来，这局被冻结，等人处理';
      }
      return;
    }
    if (loaded.roomId !== this.id || loaded.roomEpoch !== this.epochValue) {
      this.activityFault = '活动存档属于另一个房间代次，已隔离不加载';
      return;
    }
    try {
      const table = MonopolyTable.restore(loaded.table, {
        host: loaded.table.host,
        seats: loaded.table.seats,
        pace: loaded.table.pace,
        now: this.now(),
      });
      this.table = table;
      this.monopolyGameId = loaded.gameId;
      this.activityData = loaded;
      const gap = Math.max(0, this.now() - loaded.savedAt);
      if (gap > 0 && table.status === 'playing') {
        table.shiftTime(gap);
        if (gap >= 60_000) {
          this.record({
            type: 'parlor.monopoly.shift',
            from: 'system',
            scope: { kind: 'room' },
            text: `服务停了一次（约 ${Math.round(gap / 60_000)} 分钟）；大富翁的回合截止与整局时限顺延了同样长的时间。`,
            data: { game: 'monopoly', gapMs: gap, since: loaded.savedAt },
          });
        }
      }
      if (loaded.pending) this.replayPending(loaded.pending);
      this.flushEffects();
    } catch (error) {
      this.activityFault = `大富翁活动存档恢复失败：${error instanceof Error ? error.message : String(error)}`;
      this.table = undefined;
      this.activityData = undefined;
    }
  }

  /** 崩溃前已提交但没落盘的那一手：用记下来的骰点重放一次。 */
  private replayPending(pending: NonNullable<MonopolyActivity['pending']>): void {
    const table = this.table;
    const data = this.activityData;
    if (!data || !(table instanceof MonopolyTable)) return;
    try {
      const step = table.act(pending.seatId, pending.action, this.now(), pending.dice);
      this.recordStep(step, false);
      this.attachMonopolyEffects(step, pending.turnSeq);
      data.pending = undefined;
      this.saveActivity();
    } catch (error) {
      this.activityFault = `上次没提交完的动作重放失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private startActivity(now: number): void {
    if (!this.monopolyGameId || !(this.table instanceof MonopolyTable)) return;
    this.activityData = freshActivity({
      roomId: this.id,
      roomEpoch: this.epochValue,
      gameId: this.monopolyGameId,
      savedAt: now,
      table: this.table.snapshot(),
    });
  }

  private saveActivity(): boolean {
    const store = this.activity;
    const data = this.activityData;
    if (!store || !data) return true;
    if (this.table instanceof MonopolyTable) data.table = this.table.snapshot();
    data.savedAt = this.now();
    const ok = store.save(data);
    if (!ok) this.activityFault = '大富翁活动存档写不进去，这局被冻结';
    return ok;
  }

  private rollDice(): [number, number] {
    return [randomInt(1, 7), randomInt(1, 7)];
  }

  private requireMonopoly(): MonopolyTable {
    const table = this.table;
    if (!table || !(table instanceof MonopolyTable)) throw new RoomError('not_found', '现在没有进行中的大富翁');
    return table;
  }

  openMonopoly(seat: StoredSeat, body: { size?: unknown; pace?: unknown }): void {
    if (seat.kind === 'observer') throw new RoomError('invalid', '观看者不能开桌');
    if (this.monopolyFault()) throw new RoomError('conflict', '大富翁出故障了，先让房主处理');
    if (this.signup) throw new RoomError('conflict', '已经有一份大富翁报名表了');
    if (this.table && this.table.status !== 'ended') throw new RoomError('conflict', '现在有一张桌子没结束');
    if (this.table?.game === 'monopoly' && this.table.status === 'ended') this.table = undefined;
    const size = Number(body.size) === 6 ? 6 : 4;
    const pace: MonopolyPace = body.pace === 'quick' ? 'quick' : 'standard';
    const now = this.now();
    this.signup = {
      hostSeatId: seat.id,
      seats: [seat.id],
      size,
      pace,
      createdAt: now,
      deadlineAt: now + SIGNUP_MS,
    };
    this.record({
      type: 'parlor.monopoly.open',
      from: 'system',
      scope: { kind: 'room' },
      text: `${seat.name} 开了大富翁报名：${size} 人座，${PACE_LABELS[pace]}；24 小时内没开局就取消。`,
      mentions: this.seats.filter((entry) => entry.kind !== 'observer').map((entry) => entry.id),
      data: { game: 'monopoly', size, pace, deadlineAt: this.signup.deadlineAt },
    });
  }

  joinMonopoly(seat: StoredSeat): void {
    const signup = this.signup;
    if (!signup) throw new RoomError('not_found', '现在没有大富翁报名表');
    if (seat.kind === 'observer') throw new RoomError('invalid', '观看者不能报名');
    if (!seat.cooId) throw new RoomError('invalid', '报名要先绑定账本身份');
    if (signup.seats.includes(seat.id)) throw new RoomError('conflict', '你已经在报名表上了');
    if (signup.seats.length >= signup.size) throw new RoomError('conflict', '报名满了');
    signup.seats.push(seat.id);
    this.record({
      type: 'parlor.monopoly.join',
      from: 'system',
      scope: { kind: 'room' },
      text: `${seat.name} 报了大富翁（${signup.seats.length}/${signup.size}）。`,
      data: { game: 'monopoly', seats: signup.seats.map((id) => this.seatById(id)?.name ?? '？') },
    });
  }

  leaveMonopoly(seat: StoredSeat): void {
    const signup = this.signup;
    if (!signup) throw new RoomError('not_found', '现在没有大富翁报名表');
    if (signup.hostSeatId === seat.id) throw new RoomError('invalid', '发起人要走请直接取消报名');
    const index = signup.seats.indexOf(seat.id);
    if (index < 0) throw new RoomError('conflict', '你不在报名表上');
    signup.seats.splice(index, 1);
    this.record({
      type: 'parlor.monopoly.leave',
      from: 'system',
      scope: { kind: 'room' },
      text: `${seat.name} 退出了大富翁报名（${signup.seats.length}/${signup.size}）。`,
      data: { game: 'monopoly' },
    });
  }

  cancelMonopoly(seat: StoredSeat): void {
    const signup = this.signup;
    if (!signup) throw new RoomError('not_found', '现在没有大富翁报名表');
    if (signup.hostSeatId !== seat.id) throw new RoomError('forbidden', '只有发起人能取消');
    this.signup = undefined;
    this.record({
      type: 'parlor.monopoly.cancel',
      from: 'system',
      scope: { kind: 'room' },
      text: `${seat.name} 取消了大富翁报名。`,
      data: { game: 'monopoly' },
    });
  }

  startMonopoly(seat: StoredSeat, botsWanted?: unknown): StartReceipt {
    const signup = this.signup;
    if (!signup) throw new RoomError('not_found', '现在没有大富翁报名表');
    if (signup.hostSeatId !== seat.id) throw new RoomError('forbidden', '只有发起人能开局');
    if (this.table && this.table.status !== 'ended') throw new RoomError('conflict', '现在还有一张没结束的桌子');
    const humans = signup.seats
      .map((id) => this.seatById(id))
      .filter((entry): entry is StoredSeat => !!entry && entry.kind !== 'observer');
    if (humans.length < 2) throw new RoomError('invalid', '至少要有两个真人报名（脚本陪练最多补 2 个）');
    const noIdentity = humans.find((entry) => !entry.cooId);
    if (noIdentity) throw new RoomError('invalid', `${noIdentity.name} 还没绑定账本身份，换绑后再开局`);
    const room = signup.size - humans.length;
    const asked = Number(botsWanted);
    const bots = Math.max(0, Math.min(room, Number.isFinite(asked) ? Math.floor(asked) : Math.min(MAX_BOTS, room)));
    if (humans.length + bots < signup.size) {
      throw new RoomError('invalid', `还差 ${signup.size - humans.length - bots} 个人；脚本陪练最多补 ${Math.min(MAX_BOTS, room)} 个`);
    }
    if (this.monopolyGameId) {
      this.activityData = undefined;
      this.activity?.remove();
    }
    const tableSeats = [
      ...humans.map((entry) => ({ id: entry.id, name: entry.name })),
      ...Array.from({ length: bots }, (_, index) => ({
        id: `monopoly-bot-${index + 1}`,
        name: `脚本${index + 1}`,
        bot: true,
      })),
    ];
    const table = new MonopolyTable({
      host: seat.id,
      seats: tableSeats,
      pace: signup.pace,
      now: this.now(),
    });
    this.table = table;
    this.tableStake = 0;
    this.monopolyGameId = randomUUID();
    this.signup = undefined;
    this.activityFault = undefined;
    this.tableFault = undefined;
    this.effectsFault = undefined;
    this.startActivity(this.now());
    this.saveActivity();
    const opening = table.openingStep();
    this.recordStep(opening, false);
    this.attachMonopolyEffects(opening, table.turnSeq);
    this.saveActivity();
    this.flushEffects();
    return { seats: this.tableRoster(), ...this.tableReceipt() };
  }

  /** 大富翁的一切动作：报名与回合动作都从这里进。 */
  monopolyAction(seat: StoredSeat, body: Extract<ActionRequest, { type: 'monopoly' }>): MonopolyReceipt {
    const action = body.action;
    if (action === 'open') {
      this.openMonopoly(seat, body);
      return {};
    }
    if (action === 'join') {
      this.joinMonopoly(seat);
      return {};
    }
    if (action === 'leave') {
      this.leaveMonopoly(seat);
      return {};
    }
    if (action === 'cancel') {
      this.cancelMonopoly(seat);
      return {};
    }
    if (action === 'start') {
      const receipt = this.startMonopoly(seat, body.bots);
      const text = this.tablePrivate(seat.id)?.text;
      return { ...receipt, ...(typeof text === 'string' ? { text } : {}) };
    }

    const fault = this.monopolyFault();
    if (fault) throw new RoomError('conflict', fault);
    const table = this.requireMonopoly();
    if (this.signup) throw new RoomError('conflict', '报名还没开局');
    if (seat.kind === 'observer') throw new RoomError('forbidden', '观看者不能行动');

    const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
    if (!requestId) throw new RoomError('invalid', '大富翁动作要带 requestId；网络重试必须复用同一个');
    const data = this.activityData;
    if (!data) throw new RoomError('conflict', '这一局没有活动存档，不能行动');
    const key = requestKeyOf(data.gameId, seat.id, requestId);
    const payload = { type: action, item: body.item, steps: body.steps, target: body.target, on: body.on };
    const hash = hashOf(payload);
    const lookup = lookupRequest(data, key, hash);
    if (lookup.kind === 'mismatch') throw new RoomError('conflict', '同一个 requestId 换了内容；换一个新的 requestId');
    if (lookup.kind === 'repeat') return lookup.receipt as MonopolyReceipt;
    if (action !== 'set_auto' && body.turnId !== undefined && body.turnId !== table.turnSeq) {
      throw new RoomError('conflict', `这份视图已经过期（服务器现在第 ${table.turnSeq} 回合），先看一眼桌面`);
    }

    const needsDice = action === 'roll' || action === 'pass';
    const dice = needsDice ? this.rollDice() : undefined;
    const beforeSeq = table.turnSeq;
    data.pending = { key, seatId: seat.id, action: payload, turnSeq: beforeSeq, ...(dice ? { dice } : {}) };
    if (!this.saveActivity()) {
      data.pending = undefined;
      throw new RoomError('conflict', '活动存档写不进去，这一手没有执行');
    }

    let step: TableStep;
    try {
      step = table.act(seat.id, payload, this.now(), dice);
    } catch (error) {
      data.pending = undefined;
      this.saveActivity();
      throw this.monopolyRoomError(error);
    }

    this.recordStep(step, false);
    this.attachMonopolyEffects(step, beforeSeq);
    const text = this.tablePrivate(seat.id)?.text;
    const receipt: MonopolyReceipt = {
      ...this.tableReceipt(),
      ...(typeof text === 'string' ? { text } : {}),
    };
    rememberRequest(data, { key, hash, at: this.now(), receipt }, MONOPOLY_REQUEST_LIMIT);
    data.pending = undefined;
    this.saveActivity();
    this.flushEffects();
    return receipt;
  }

  private monopolyRoomError(error: unknown): RoomError {
    if (error instanceof RoomError) return error;
    if (error instanceof TableError) {
      if (error.code === 'not_turn') return new RoomError('forbidden', error.message);
      if (error.code === 'expired') return new RoomError('conflict', error.message);
      return new RoomError('invalid', error.message);
    }
    this.tableFault = `大富翁推进出错：${error instanceof Error ? error.message : String(error)}`;
    return new RoomError('invalid', this.tableFault);
  }

  /** 把这一手带来的账/信排进待发队列；真正写盘在 flushEffects。 */
  private attachMonopolyEffects(step: TableStep, beforeSeq: number): void {
    const data = this.activityData;
    const table = this.table;
    if (!data || !(table instanceof MonopolyTable)) return;
    const now = this.now();

    if (step.ended) {
      const endEvent = step.events.find((event) => event.type === 'parlor.table.end');
      const winners = Array.isArray(endEvent?.data?.winners)
        ? (endEvent!.data!.winners as unknown[]).filter((id): id is string => typeof id === 'string')
        : [];
      const seats = table.seatIds()
        .map((id) => this.seatById(id))
        .filter((entry): entry is StoredSeat => !!entry && entry.kind !== 'observer');
      const endText = typeof endEvent?.text === 'string' ? endEvent.text : '大富翁结束。';
      queueEffect(data, {
        id: `${data.gameId}/result`,
        kind: 'ledger-result',
        payload: {
          text: endText,
          winners: seats.filter((entry) => winners.includes(entry.id)).map((entry) => this.cooIdOf(entry)),
          participants: seats.map((entry) => this.cooIdOf(entry)),
          tie: endEvent?.data?.tie === true,
        },
      });
      for (const entry of seats) {
        queueEffect(data, {
          id: `${data.gameId}/end/${entry.id}`,
          kind: 'mail-end',
          payload: { cooId: this.cooIdOf(entry), name: entry.name, text: endText },
        });
      }
    }

    for (const seatId of step.views) {
      const seat = this.seatById(seatId);
      if (!seat) continue;
      const text = table.privateText(seatId, now);
      if (!text) continue;
      const turnSeq = (table.view(seatId) as { turnSeq?: number } | null)?.turnSeq ?? 0;
      queueEffect(data, {
        id: `${data.gameId}/turn/${turnSeq}/${seat.id}`,
        kind: 'mail-turn',
        payload: { cooId: this.cooIdOf(seat), name: seat.name, text },
      });
    }

    for (const event of step.events) {
      const managedSeat = typeof event.data?.managedSeat === 'string' ? event.data.managedSeat : '';
      if (event.data?.managed !== true || !managedSeat) continue;
      const seat = this.seatById(managedSeat);
      if (!seat) continue;
      queueEffect(data, {
        id: `${data.gameId}/managed/${beforeSeq}/${seat.id}`,
        kind: 'mail-managed',
        payload: { cooId: this.cooIdOf(seat), name: seat.name, text: `服务器托管了你的回合：${event.text}` },
      });
    }
  }

  /** 待发的账/信逐条送达；写不进去就留着，下一次再试，并标记故障。 */
  private flushEffects(): void {
    const data = this.activityData;
    if (!data) return;
    let failed = false;
    for (const effect of [...data.outbox]) {
      try {
        this.writeEffect(effect);
        settleEffect(data, effect.id);
      } catch (error) {
        failed = true;
        this.effectsFault = `大富翁的账/信没写进去：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (!failed) this.effectsFault = undefined;
    this.saveActivity();
  }

  private writeEffect(effect: Effect): void {
    if (effect.kind === 'ledger-result') {
      const payload = effect.payload as {
        text?: unknown; winners?: unknown; participants?: unknown; tie?: unknown;
      };
      this.ledger.recordOnce(effect.id, {
        kind: 'game',
        room: this.id,
        from: 'room',
        game: 'monopoly',
        participants: Array.isArray(payload.participants) ? payload.participants.filter((id): id is string => typeof id === 'string') : [],
        winners: Array.isArray(payload.winners) ? payload.winners.filter((id): id is string => typeof id === 'string') : [],
        text: typeof payload.text === 'string' ? payload.text : '大富翁结束。',
        visibility: 'room',
        data: { game: 'monopoly', gameLabel: '大富翁', tie: payload.tie === true },
      });
      return;
    }
    const payload = effect.payload as { cooId?: unknown; text?: unknown };
    if (typeof payload.cooId !== 'string' || typeof payload.text !== 'string') {
      throw new Error('信件缺少收件人或正文');
    }
    this.mail.appendOnce(effect.id, {
      room: this.id,
      to: payload.cooId,
      kind: 'ledger',
      action: effect.kind,
      fromName: '客厅',
      text: payload.text,
    });
  }

  snapshot(seatId: string, since: number, limit = 30): Omit<RoomSnapshot, 'seat'> {
    const seat = this.seatById(seatId);
    if (!seat) throw new RoomError('not_found', '席位不存在');
    const now = this.now();
    return {
      id: this.id,
      seats: this.seatsPublic(),
      maxSeats: this.maxSeats,
      latest: this.seq,
      now,
      at: serverClock(now),
      events: this.history(seatId, since, limit),
      table: this.tableSummary(),
      tablePrivate: this.tablePrivate(seatId),
      ledger: this.ledger.summaryFor(this.cooIdOf(seat)),
      ledgerRoom: this.ledger.publicInRoom(this.id, 5),
      mailUnread: this.mail.unreadCount(this.cooIdOf(seat), this.id),
      ...(this.monopolyInfo() ? { monopoly: this.monopolyInfo() } : {}),
    };
  }

  record(input: Omit<RoomEvent, 'seq' | 'ts'>): RoomEvent {
    const event: RoomEvent = { seq: ++this.seq, ts: this.now(), ...input };
    this.events.push(event);
    if (this.events.length > this.historyLimit) {
      this.events.splice(0, this.events.length - this.historyLimit);
    }
    this.replay.append(event);
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
