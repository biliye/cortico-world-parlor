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
import { DiceTable } from './table.ts';
import { DoudizhuTable } from './games/doudizhu-table.ts';
import {
  isCooId, LedgerStore, MAX_CHIPS, MAX_DUE_MS, MAX_OPEN_PROMISES, MAX_SOCIAL_PER_HOUR, MAX_SOCIAL_TEXT,
  type LedgerEntry,
} from './ledger.ts';
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
}

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
  private readonly tableTurnMs: number;
  private readonly ledger: LedgerStore;
  private seats: StoredSeat[] = [];
  private events: RoomEvent[] = [];
  private seq = 0;
  private seatSeq = 0;
  private table?: TableEngine;
  /** 当前桌子的押注（每人开局押多少筹码）；0 = 不押。 */
  private tableStake = 0;
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

  join(request: JoinRequest, cooId?: string): JoinResponse {
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

  /** 送礼：纯文本，可选带筹码。礼物是私密条目，只有收礼的人（和家长页）看得见。 */
  gift(seat: StoredSeat, to: string, text: string, chips?: number): LedgerEntry {
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
    this.notifyLedger([target.id], `收到一份礼物：${body}${amount ? `（${amount} 枚筹码）` : ''}`, {
      entryId: entry.id, kind: 'gift', action: 'gift', from: seat.name,
    });
    return entry;
  }

  /** 承诺：可以带截止时间与筹码；要对方回应才算数。 */
  promise(seat: StoredSeat, to: string, text: string, due?: number | string, chips?: number): LedgerEntry {
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
    this.notifyLedger([target.id], `${seat.name} 对你许了个承诺：${body}${dueAt ? `（${dueLabel(dueAt)} 前）` : ''}${amount ? `，${amount} 枚筹码` : ''}。用 parlor_respond 回。`, {
      entryId: entry.id, kind: 'promise', action: 'promise', from: seat.name,
    });
    return entry;
  }

  /**
   * 回应一条承诺。只有被承诺的人能答应/拒绝/了结；只有提出的人能在对方回应前撤回。
   * 了结只能由债权人做（`to` 那一方），筹码从债务人划给债权人。
   */
  respond(seat: StoredSeat, id: string, action: 'accept' | 'decline' | 'done' | 'cancel'): LedgerEntry {
    if (seat.kind === 'observer') throw new RoomError('forbidden', '观看者不能写账本');
    const promise = this.ledger.find(id);
    if (!promise || (promise.kind !== 'promise' && promise.kind !== 'debt')) {
      throw new RoomError('not_found', '找不到这条承诺；用 parlor_ledger 看未了结里的 id');
    }
    const me = this.cooIdOf(seat);
    const status = this.ledger.promiseStatus(promise);
    const counterpartCoo = promise.from === me ? promise.to : promise.from;
    const counterpart = counterpartCoo ? this.seatByCoo(counterpartCoo) : undefined;
    const otherName = counterpart?.name
      ?? (typeof promise.data?.fromName === 'string' ? promise.data.fromName : '对方');

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

  /** 到期没结的承诺：由服务器追加 default，并通知双方。 */
  expireLedger(now = this.now()): LedgerEntry[] {
    const created = this.ledger.expire(now);
    for (const entry of created) {
      const [debtorCoo, creditorCoo] = entry.participants ?? [];
      const debtor = debtorCoo ? this.seatByCoo(debtorCoo) : undefined;
      const creditor = creditorCoo ? this.seatByCoo(creditorCoo) : undefined;
      const text = typeof entry.text === 'string' ? entry.text : '';
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
  ): LedgerEntry {
    const kind = action === 'done' ? 'settle' : action;
    const me = this.cooIdOf(seat);
    const amount = action === 'done' && typeof promise.data?.chips === 'number' ? promise.data.chips : 0;
    const entry = this.ledger.record({
      kind,
      ref: promise.id,
      room: promise.room,
      from: me,
      ...(promise.from === me ? { to: promise.to } : { to: promise.from }),
      text: promise.text,
      visibility: 'private',
      data: {
        fromName: seat.name,
        toName: otherName,
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
      this.notifyLedger([counterpart.id], `${seat.name} ${text}`, {
        entryId: promise.id, kind: 'promise', action,
      });
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

  /** 只给该看的席位发一条账本通知；不发公开事件。 */
  private notifyLedger(seatIds: string[], text: string, data: Record<string, unknown>): void {
    for (const seatId of new Set(seatIds)) {
      if (!this.seatById(seatId)) continue;
      this.record({
        type: 'parlor.ledger',
        from: 'system',
        scope: { kind: 'seat', seatId },
        text,
        data,
      });
    }
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
    this.record({
      type: 'parlor.table.open',
      from: 'system',
      scope: { kind: 'room' },
      text: `${seat.name} 开了一张${game === 'ddz' ? '斗地主' : '骰子'}桌${ante > 0 ? `（每人押 ${ante} 枚筹码）` : ''}。`,
      data: { game, stake: ante },
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

  startTable(seat: StoredSeat): void {
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
  }

  tableAction(seat: StoredSeat, action: unknown): void {
    const table = this.requireTable();
    if (table.game !== 'dice') throw new RoomError('invalid', '这张桌子不是骰子桌；斗地主用 ddz_action');
    this.applyStep(table, () => table.act(seat.id, action, this.now()));
  }

  ddzAction(seat: StoredSeat, action: unknown): void {
    const table = this.requireTable();
    if (table.game !== 'ddz') throw new RoomError('invalid', '这张桌子不是斗地主桌');
    this.applyStep(table, () => table.act(seat.id, action, this.now()));
  }

  tickTable(now = this.now()): void {
    if (!this.table) return;
    if (this.table.status !== 'playing' && this.table.status !== 'bidding') return;
    const table = this.table;
    let step: TableStep | null;
    try {
      step = table.tick(now);
    } catch (error) {
      // 超时代打是后台任务：坏一手牌不该把整个房间带下去。
      console.error('parlor: 牌桌超时代打失败', error);
      return;
    }
    if (step) this.recordStep(step);
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

  private recordStep(step: TableStep): void {
    for (const event of step.events) {
      this.record({
        type: event.type,
        from: 'system',
        scope: event.scope,
        text: event.text,
        data: event.data,
      });
      if (event.type === 'parlor.table.end') this.recordGame(event);
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
      table: this.tableSummary(),
      tablePrivate: this.tablePrivate(seatId),
      ledger: this.ledger.summaryFor(this.cooIdOf(seat)),
      ledgerRoom: this.ledger.publicInRoom(this.id, 5),
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
