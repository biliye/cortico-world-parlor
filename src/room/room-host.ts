/**
 * 一个客厅的运行时：席位、聊天、私聊、信箱、账本与牌桌。
 *
 * 负责：加入/离开/换房、说话/私聊/送礼/承诺、按可见区间读历史、快照、信箱、一房一桌。
 * 不负责：全局账户/会话（网关层）、大厅目录（RoomRegistry）、家长门户（下一轮）。
 *
 * 所有写操作都包在 withTransaction 里：事件、席位、信箱要么一起成，要么一起回。
 * 每房事件 seq 由 EventDb 分配，别的客厅不会串号。牌桌规则在 table-host.ts。
 */
import { randomBytes } from 'node:crypto';
import { withTransaction, type Db } from './db.ts';
import { EventDb } from './event-db.ts';
import { LedgerDb } from './ledger-db.ts';
import { MailDb } from './mail-db.ts';
import {
  RoomSeatError, activeSeatForCoo, activeSeats, getRoom, hashSeatToken, joinSeat, releaseSeat,
  seatByTokenHash, updateSeatToken, type RoomRow, type SeatRow,
} from './room-seat-db.ts';
import { serverClock } from './clock.ts';
import { HostError, type HostErrorCode } from './host-error.ts';
import {
  isCooId, MAX_CHIPS, MAX_DUE_MS, MAX_OPEN_PROMISES, MAX_SOCIAL_PER_HOUR, MAX_SOCIAL_TEXT,
  type LedgerEntry,
} from './ledger.ts';
import { TableHost, type StartReceipt, type TableLeaveResult, type TableLockInfo, type TableOpenResult, type TableReceipt } from './table-host.ts';
import type { DeliveryReceipt, RoomEvent, RoomSnapshot, Seat, SeatKind, WakeTier } from './protocol.ts';

export { HostError, type HostErrorCode } from './host-error.ts';

export interface RoomHostOptions {
  now?: () => number;
  token?: () => string;
  /** 启动恢复用的健康基准（由网关从 meta.last_healthy_at 读一次，所有客厅共用）。 */
  recovery?: { lastHealthyAt?: number; maxDowntimeMs?: number; minHumanMs?: number };
}

export interface JoinResult {
  seat: SeatRow;
  /** 明文只返回这一次；库里只有哈希。 */
  token: string;
  event: RoomEvent;
}

export interface LeaveResult {
  seat: SeatRow | null;
  event: RoomEvent;
}

export interface SwitchResult {
  released: SeatRow | null;
  seat: SeatRow;
  token: string;
  leaveEvent: RoomEvent;
  joinEvent: RoomEvent;
}

export interface SayResult {
  event: RoomEvent;
}

export interface WhisperResult {
  event: RoomEvent;
  mailSeq: number;
  /** 给寄信人的投递回执：信留底了，不代表读过。 */
  delivered: DeliveryReceipt[];
}

const MAX_TEXT = 400;
const MAX_NAME = 24;

const cleanText = (value: string): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new HostError('invalid', '消息不能为空');
  if (text.length > MAX_TEXT) throw new HostError('invalid', `一句话最多 ${MAX_TEXT} 个字`);
  return text;
};

const cleanName = (value: string): string => {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME) : '';
  if (!name) throw new HostError('invalid', '名字不能为空');
  return name;
};

/** 礼物与承诺的字数上限比闲聊短，且要单独校验。 */
const cleanSocial = (value: unknown): string => {
  if (typeof value !== 'string') throw new HostError('invalid', '内容必须是文字');
  const text = value.trim();
  if (!text) throw new HostError('invalid', '内容不能为空');
  if (text.length > MAX_SOCIAL_TEXT) throw new HostError('invalid', `礼物或承诺最多 ${MAX_SOCIAL_TEXT} 个字`);
  return text;
};

const chipsOf = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_CHIPS) {
    throw new HostError('invalid', `筹码要是 1 到 ${MAX_CHIPS} 之间的整数`);
  }
  return amount;
};

const dueOf = (value: unknown, now: number): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new HostError('invalid', '截止时间要写日期，例如 2026-11-01');
  if (ms <= now) throw new HostError('invalid', '截止时间要在将来');
  if (ms - now > MAX_DUE_MS) throw new HostError('invalid', '截止时间最多 90 天');
  return ms;
};

const dueLabel = (due: number): string => new Date(due).toISOString().slice(0, 10);

const SAY_GAP_MS = 50;

const makeToken = (): string => randomBytes(24).toString('base64url');

const seatOfRow = (row: SeatRow): Seat => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  tier: row.tier,
  joinedAt: row.joinedAt,
});

const wrapSeatError = (error: unknown): never => {
  if (error instanceof RoomSeatError) {
    const code: HostErrorCode = error.code === 'room_full'
      ? 'full'
      : error.code === 'already_seated' ? 'already_seated'
        : error.code === 'room_not_found' || error.code === 'seat_not_found' ? 'not_found'
          : error.code === 'room_archived' || error.code === 'name_taken' ? 'conflict'
            : 'invalid';
    throw new HostError(code, error.message);
  }
  throw error;
};

export class RoomHost {
  readonly roomId: string;
  private readonly events: EventDb;
  private readonly mail: MailDb;
  private readonly ledger: LedgerDb;
  private readonly tableHost: TableHost;
  private readonly now: () => number;
  private readonly makeToken: () => string;
  /** 客厅发言与桌内发言共用同一个间隔，防止交替发绕过限速。 */
  private readonly lastSay = new Map<string, number>();

  private readonly db: Db;

  constructor(db: Db, roomId: string, options: RoomHostOptions = {}) {
    this.db = db;
    this.roomId = roomId;
    this.events = new EventDb(db);
    this.now = options.now ?? Date.now;
    this.mail = new MailDb(db, { now: this.now });
    this.ledger = new LedgerDb(db, { now: this.now });
    this.makeToken = options.token ?? makeToken;
    this.tableHost = new TableHost({
      db,
      roomId,
      now: this.now,
      ledger: this.ledger,
      mail: this.mail,
      seats: {
        activeSeat: (cooId) => this.seatOf(cooId),
        seats: () => this.seats(),
      },
      ...(options.recovery ? { recovery: options.recovery } : {}),
    });
  }

  room(): RoomRow {
    return this.requireRoom();
  }

  /** 这块地方叫什么：大厅是特殊客厅，事件文案别把大厅写成客厅。 */
  private placeOf(roomId: string): string {
    return getRoom(this.db, roomId)?.kind === 'hall' ? '大厅' : '客厅';
  }

  latest(): number {
    return this.events.latest(this.roomId);
  }

  seats(): SeatRow[] {
    return activeSeats(this.db, this.roomId);
  }

  seatOf(cooId: string): SeatRow | null {
    const seat = activeSeatForCoo(this.db, cooId);
    return seat?.roomId === this.roomId ? seat : null;
  }

  /** 用明文令牌认当前活跃席位；令牌只在这个客厅有效。 */
  seatByToken(token: string): SeatRow {
    const seat = seatByTokenHash(this.db, hashSeatToken(token));
    if (!seat || seat.roomId !== this.roomId) throw new HostError('forbidden', '席位令牌无效或已经离开');
    return seat;
  }

  /** 同一个席位换一枚新令牌（家长再次下场）：席位、可见区间、账本都不动。 */
  reissueSeatToken(cooId: string): { seat: SeatRow; token: string } {
    const seat = this.seatOf(cooId);
    if (!seat) throw new HostError('not_found', '你不在这个客厅里');
    const token = this.makeToken();
    updateSeatToken(this.db, this.roomId, seat.id, hashSeatToken(token));
    return { seat, token };
  }

  join(cooId: string, input: { name?: string; kind?: SeatKind; tier?: WakeTier } = {}): JoinResult {
    const room = this.requireRoom();
    if (room.archivedAt !== null) throw new HostError('conflict', '这个客厅已经归档');
    const active = activeSeatForCoo(this.db, cooId);
    if (active) {
      throw new HostError('already_seated', active.roomId === this.roomId
        ? '你已经在这个客厅里了；用原来的席位令牌'
        : '你已经在另一个客厅里；先离开或换房');
    }
    const name = cleanName(input.name ?? '');
    const token = this.makeToken();
    const visibleFromSeq = this.events.latest(this.roomId);
    const now = this.now();

    return withTransaction(this.db, () => {
      let seat: SeatRow;
      try {
        seat = joinSeat(this.db, {
          roomId: this.roomId,
          cooId,
          name,
          token,
          visibleFromSeq,
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.tier ? { tier: input.tier } : {}),
          now,
        });
      } catch (error) {
        return wrapSeatError(error);
      }
      // 新身份第一次进客厅发筹码；已有身份不会重复发（唯一索引兜底）。
      this.ledger.ensureGrant(cooId, this.roomId);
      const event = this.events.append(this.roomId, {
        type: 'parlor.joined',
        ts: now,
        from: 'system',
        scope: { kind: 'room' },
        text: `${seat.name} 进了${this.placeOf(this.roomId)}。`,
        data: { seatId: seat.id, name: seat.name },
      });
      return { seat, token, event };
    });
  }

  /**
   * 私聊信已经落进信箱了，这里只往对方所在的客厅推一条事件，让在线的人立刻看到；
   * 不再写第二封信（否则信箱里会出现两条）。
   */
  whisperNotice(fromCooId: string, fromName: string, target: { cooId: string; id: string; name: string }, text: string): RoomEvent {
    const now = this.now();
    const senderSeat = activeSeatForCoo(this.db, fromCooId);
    return this.events.append(this.roomId, {
      type: 'parlor.whisper',
      ts: now,
      from: senderSeat?.id ?? 'system',
      scope: { kind: 'seat', seatId: target.id },
      text,
      data: { name: fromName, to: target.name, dm: true },
      audience: [{ cooId: target.cooId, seatId: target.id }],
    });
  }

  leave(cooId: string): LeaveResult {
    this.requireRoom();
    const seat = this.seatOf(cooId);
    if (!seat) throw new HostError('not_found', '你不在这个客厅里');
    this.assertNotLocked(cooId, '离开客厅');
    const now = this.now();

    return withTransaction(this.db, () => {
      const event = this.events.append(this.roomId, {
        type: 'parlor.left',
        ts: now,
        from: seat.id,
        scope: { kind: 'room' },
        text: `${seat.name} 离开了${this.placeOf(this.roomId)}。`,
        data: { seatId: seat.id, name: seat.name },
      });
      let released: SeatRow | null;
      try {
        released = releaseSeat(this.db, this.roomId, seat.id, event.seq, now);
      } catch (error) {
        return wrapSeatError(error);
      }
      return { seat: released, event };
    });
  }

  /**
   * 长时间没有 SSE 的真人席位：写一条带原因的离开事件再释放。
   * 牌桌锁着就不动（等这局结束，下一轮清理再看）。
   */
  releaseOffline(cooId: string, now = this.now()): LeaveResult | null {
    const seat = this.seatOf(cooId);
    if (!seat) return null;
    if (this.tableHost.lockOf(cooId)) return null;
    return withTransaction(this.db, () => {
      const event = this.events.append(this.roomId, {
        type: 'parlor.left',
        ts: now,
        from: seat.id,
        scope: { kind: 'room' },
        text: `${seat.name} 的席位因长时间未上线被释放。`,
        data: { seatId: seat.id, name: seat.name, reason: 'offline' },
      });
      const released = releaseSeat(this.db, this.roomId, seat.id, event.seq, now);
      return { seat: released, event };
    });
  }

  /**
   * 房主移除成员：立刻停止这一房的访问并释放席位；牌桌锁不拦（牌局由服务器托管到结算）。
   * 调用方先 `markTableAuto`，这里只管席位与事件。
   */
  remove(cooId: string, now = this.now()): LeaveResult | null {
    const seat = this.seatOf(cooId);
    if (!seat) return null;
    return withTransaction(this.db, () => {
      const event = this.events.append(this.roomId, {
        type: 'parlor.left',
        ts: now,
        from: seat.id,
        scope: { kind: 'room' },
        text: `${seat.name} 被房主移出了${this.placeOf(this.roomId)}。`,
        data: { seatId: seat.id, name: seat.name, reason: 'removed' },
      });
      const released = releaseSeat(this.db, this.roomId, seat.id, event.seq, now);
      return { seat: released, event };
    });
  }

  /** 原子换房：源客厅写离开事件并释放席位，目标客厅拿新席位并写加入事件。 */
  switchTo(cooId: string, targetRoomId: string, input: { name?: string } = {}): SwitchResult {
    if (targetRoomId === this.roomId) throw new HostError('invalid', '已经在这个客厅里');
    const source = this.requireRoom();
    const target = getRoom(this.db, targetRoomId);
    if (!target) throw new HostError('not_found', '目标客厅不存在');
    if (target.archivedAt !== null) throw new HostError('conflict', '目标客厅已经归档');
    const seat = this.seatOf(cooId);
    if (!seat) throw new HostError('not_found', '你不在当前客厅里');
    this.assertNotLocked(cooId, '换客厅');
    const name = cleanName(input.name ?? seat.name);
    const token = this.makeToken();
    const now = this.now();
    const targetFrom = this.events.latest(targetRoomId);

    return withTransaction(this.db, () => {
      const leaveEvent = this.events.append(this.roomId, {
        type: 'parlor.left',
        ts: now,
        from: seat.id,
        scope: { kind: 'room' },
        text: `${seat.name} 离开了${this.placeOf(this.roomId)}，去「${target.name}」。`,
        data: { seatId: seat.id, name: seat.name, to: targetRoomId },
      });
      let released: SeatRow | null;
      try {
        released = releaseSeat(this.db, this.roomId, seat.id, leaveEvent.seq, now);
      } catch (error) {
        return wrapSeatError(error);
      }
      let joined: SeatRow;
      try {
        joined = joinSeat(this.db, {
          roomId: targetRoomId,
          cooId,
          name,
          token,
          visibleFromSeq: targetFrom,
          kind: seat.kind,
          tier: seat.tier,
          now,
        });
      } catch (error) {
        return wrapSeatError(error);
      }
      const joinEvent = this.events.append(targetRoomId, {
        type: 'parlor.joined',
        ts: now,
        from: 'system',
        scope: { kind: 'room' },
        text: `${joined.name} 进了${this.placeOf(targetRoomId)}。`,
        data: { seatId: joined.id, name: joined.name, from: source.id },
      });
      return { released, seat: joined, token, leaveEvent, joinEvent };
    });
  }

  say(cooId: string, text: string): SayResult {
    const seat = this.requireSeat(cooId);
    const body = cleanText(text);
    this.checkSayGap(cooId);
    const mentions = this.mentionsIn(body, seat);
    const event = this.events.append(this.roomId, {
      type: 'parlor.say',
      ts: this.now(),
      from: seat.id,
      scope: { kind: 'room' },
      text: body,
      ...(mentions.length > 0 ? { mentions } : {}),
      data: { name: seat.name },
    });
    return { event };
  }

  whisper(cooId: string, to: string, text: string): WhisperResult {
    const seat = this.requireSeat(cooId);
    const target = this.resolveSeat(to);
    if (target.id === seat.id) throw new HostError('invalid', '不能对自己说私聊');
    const body = cleanText(text);
    const now = this.now();

    return withTransaction(this.db, () => {
      const event = this.events.append(this.roomId, {
        type: 'parlor.whisper',
        ts: now,
        from: seat.id,
        scope: { kind: 'seat', seatId: target.id },
        text: body,
        data: { name: seat.name, to: target.name },
        audience: [{ cooId: target.cooId, seatId: target.id }],
      });
      const letter = this.mail.append({
        to: target.cooId,
        fromCooId: seat.cooId,
        room: this.roomId,
        kind: 'whisper',
        fromName: seat.name,
        text: body,
      });
      return {
        event,
        mailSeq: letter.seq,
        delivered: [{
          to: target.name, mailSeq: letter.seq, ts: letter.ts, at: serverClock(letter.ts),
        }],
      };
    });
  }

  /** 从最早到最新；用这个 coo 在该客厅最近一次席位的可见区间。 */
  history(cooId: string, options: { since?: number; limit?: number } = {}): RoomEvent[] {
    const interval = this.latestInterval(cooId);
    if (!interval) return [];
    return this.events.history(this.roomId, {
      cooId,
      interval,
      since: options.since ?? 0,
      limit: options.limit ?? 50,
    });
  }

  /**
   * 跨房通知：给此刻在这个客厅的某个 Coo 写一条 seat-scope 事件（不写信箱）。
   * 目标不在这个客厅时返回 null；调用方自己决定要不要另留一封信。
   */
  pingSeat(cooId: string, text: string, data: Record<string, unknown>, type = 'parlor.invite'): RoomEvent | null {
    const seat = this.seatOf(cooId);
    if (!seat) return null;
    return this.events.append(this.roomId, {
      type,
      ts: this.now(),
      from: 'system',
      scope: { kind: 'seat', seatId: seat.id },
      text,
      data,
      audience: [{ cooId, seatId: seat.id }],
    });
  }

  /** 赛后回看：历来有权看的全部事件，不受当前席位区间限制。 */
  replay(cooId: string, options: { before?: number; limit?: number } = {}): { events: RoomEvent[]; older: boolean } {
    this.requireRoom();
    return this.events.replay(this.roomId, {
      cooId,
      ...(options.before !== undefined ? { before: options.before } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
  }

  snapshot(cooId: string, options: { since?: number; limit?: number } = {}): RoomSnapshot {
    const seat = this.requireSeat(cooId);
    const interval = { visibleFromSeq: seat.visibleFromSeq, visibleUntilSeq: seat.visibleToSeq };
    const now = this.now();
    const latest = this.events.latest(this.roomId);
    const room = this.requireRoom();
    return {
      id: this.roomId,
      name: room.name,
      seat: seatOfRow(seat),
      seats: this.seats().map(seatOfRow),
      maxSeats: room.capacity,
      latest,
      now,
      at: serverClock(now),
      events: this.events.recent(this.roomId, {
        cooId,
        interval,
        ...(options.since !== undefined ? { since: options.since } : {}),
        limit: options.limit ?? 30,
      }),
      mailUnread: this.mail.unreadCount(cooId),
      tables: this.tableHost.list(),
      ...(this.tableHost.public(cooId) ? { table: this.tableHost.public(cooId) } : {}),
      tablePrivate: this.tableHost.private(seat.id),
      ledger: this.ledger.summaryFor(cooId),
      ledgerRoom: this.ledger.publicInRoom(this.roomId, 5),
    };
  }

  /** 这个客厅里的未读；跨厅邀请在全局未读里。 */
  mailUnread(cooId: string): number {
    return this.mail.unreadCount(cooId, this.roomId);
  }

  /** 全部客厅的未读（信箱是全局的，邀请也落在这里）。 */
  mailUnreadAll(cooId: string): number {
    return this.mail.unreadCount(cooId);
  }

  /** SSE 补看/轮询：从 since 之后、该 coo 可见的事件。 */
  eventsSince(cooId: string, since: number, limit = 200): RoomEvent[] {
    const interval = this.latestInterval(cooId);
    if (!interval) return [];
    return this.events.history(this.roomId, { cooId, interval, since, limit });
  }

  /** 改当前活跃席位的唤醒挡位。 */
  setTier(cooId: string, tier: WakeTier): void {
    const seat = this.seatOf(cooId);
    if (!seat) throw new HostError('not_found', '你不在这个客厅里');
    this.db.prepare(
      'UPDATE room_seats SET tier = ? WHERE room_id = ? AND id = ? AND released_at IS NULL',
    ).run(tier, this.roomId, seat.id);
  }

  readMail(cooId: string, limit = 10, markRead = true, all = false) {
    return this.mail.list(cooId, all ? undefined : this.roomId, limit, markRead);
  }

  // —— 牌桌 ——

  /** 坐在未结束的牌桌上时不能离厅/换房；返回锁信息给调用方拼错误。 */
  tableLock(cooId: string): TableLockInfo | null {
    return this.tableHost.lockOf(cooId);
  }

  openTable(cooId: string, input: { game?: string; stake?: unknown } = {}, requestId?: string): TableOpenResult {
    if (this.requireRoom().kind === 'hall') {
      throw new HostError('conflict', '大厅是进场和选房的地方，不能开桌；先走进一个客厅');
    }
    return this.tableHost.open(cooId, input, requestId);
  }

  joinTable(cooId: string, tableId?: string, requestId?: string) {
    return this.tableHost.join(cooId, tableId, requestId);
  }

  leaveTable(cooId: string, tableId?: string, requestId?: string): TableLeaveResult {
    return this.tableHost.leave(cooId, tableId, requestId);
  }

  startTable(cooId: string, tableId?: string, requestId?: string): StartReceipt {
    return this.tableHost.start(cooId, tableId, requestId);
  }

  tableAction(cooId: string, action: unknown, options: { tableId?: string; revision?: number; requestId?: string } = {}): TableReceipt {
    return this.tableHost.act(cooId, action, options);
  }

  tableSay(cooId: string, text: string, tableId?: string): RoomEvent {
    this.requireSeat(cooId);
    this.checkSayGap(cooId);
    return this.tableHost.say(cooId, text, tableId);
  }

  tablePublic(tableId?: string, cooId?: string) {
    return this.tableHost.tableSummary(tableId, cooId);
  }

  tablePrivate(seatId: string) {
    return this.tableHost.private(seatId);
  }

  /** 被移出客厅的人：牌局里改成托管（结算仍归他）。 */
  markTableAuto(cooId: string): string[] {
    return this.tableHost.markAuto(cooId);
  }

  /** 这个客厅的桌（运营诊断用）。 */
  tableList() {
    return this.tableHost.list();
  }

  /** 运营命令：作废一张桌并按开局明细退款。 */
  voidTable(tableId: string, note?: string): boolean {
    return this.tableHost.voidTable(tableId, note);
  }

  myTable(cooId: string) {
    return this.tableHost.tableOf(cooId);
  }

  /** 清理超过保留期的事件（回放 7 天；最后 500 条永远留着）。 */
  pruneEvents(beforeTs: number, keep = 500): number {
    return this.events.prune(this.roomId, beforeTs, keep);
  }

  /** 网关每秒调一次：开桌超时、牌局超时代打、承诺到期、余额补给。 */
  tickClock(now = this.now()): void {
    this.tableHost.tick();
    this.expireLedger(now);
    this.refillLedger(now);
  }

  // —— 账本：礼物 / 承诺 / 回应 ——

  gift(cooId: string, to: string, text: string, chips?: unknown): { entry: LedgerEntry; delivered?: DeliveryReceipt[] } {
    const seat = this.requireSeat(cooId);
    if (seat.kind === 'observer') throw new HostError('forbidden', '观看者不能写账本');
    const target = this.requireTarget(seat, to);
    const body = cleanSocial(text);
    const amount = chipsOf(chips);
    this.checkSocialBudget(cooId);
    if (amount !== undefined && this.ledger.balanceOf(cooId) < amount) {
      throw new HostError('invalid', `你只有 ${this.ledger.balanceOf(cooId)} 枚筹码`);
    }
    const entry = this.ledger.record({
      kind: 'gift',
      room: this.roomId,
      from: cooId,
      to: target.cooId,
      text: body,
      visibility: 'private',
      data: { fromName: seat.name, toName: target.name, ...(amount ? { chips: amount } : {}) },
      ...(amount ? { transfers: [{ from: cooId, to: target.cooId, amount }] } : {}),
    });
    const delivered = this.notify(target.cooId, `收到一份礼物：${body}${amount ? `（${amount} 枚筹码）` : ''}`, {
      kind: 'gift', action: 'gift', from: seat.name, entryId: entry.id, toName: target.name,
    });
    return { entry, delivered: [delivered] };
  }

  promise(
    cooId: string,
    to: string,
    text: string,
    due?: unknown,
    chips?: unknown,
  ): { entry: LedgerEntry; delivered?: DeliveryReceipt[] } {
    const seat = this.requireSeat(cooId);
    if (seat.kind === 'observer') throw new HostError('forbidden', '观看者不能写账本');
    const target = this.requireTarget(seat, to);
    const body = cleanSocial(text);
    const amount = chipsOf(chips);
    const dueAt = dueOf(due, this.now());
    this.checkSocialBudget(cooId);
    const open = this.ledger.countOpenPromises(cooId);
    if (open >= MAX_OPEN_PROMISES) {
      throw new HostError('invalid', `你已经有 ${MAX_OPEN_PROMISES} 条没了结的承诺，先了结几条`);
    }
    const entry = this.ledger.record({
      kind: 'promise',
      room: this.roomId,
      from: cooId,
      to: target.cooId,
      text: body,
      visibility: 'private',
      ...(dueAt !== undefined ? { due: dueAt } : {}),
      data: {
        fromName: seat.name,
        toName: target.name,
        ...(amount ? { chips: amount } : {}),
      },
    });
    const delivered = this.notify(
      target.cooId,
      `${seat.name} 对你许了个承诺：${body}${dueAt ? `（${dueLabel(dueAt)} 前）` : ''}${amount ? `，${amount} 枚筹码` : ''}。用 parlor_respond 回。`,
      { kind: 'promise', action: 'promise', from: seat.name, entryId: entry.id, toName: target.name },
    );
    return { entry, delivered: [delivered] };
  }

  /** 回应承诺：只有被承诺的人能答应/拒绝/了结；只有提出的人能在回应前撤回。 */
  respond(
    cooId: string,
    id: string,
    action: 'accept' | 'decline' | 'done' | 'cancel',
  ): { entry: LedgerEntry; delivered?: DeliveryReceipt[] } {
    const seat = this.requireSeat(cooId);
    if (seat.kind === 'observer') throw new HostError('forbidden', '观看者不能写账本');
    const promise = this.ledger.find(id);
    if (!promise || (promise.kind !== 'promise' && promise.kind !== 'debt')) {
      throw new HostError('not_found', '找不到这条承诺；用 parlor_ledger 看未了结里的 id');
    }
    if (promise.room !== this.roomId) {
      throw new HostError('not_found', '这条承诺不在这个客厅；回原来的客厅再回应');
    }
    const status = this.ledger.promiseStatus(promise);
    const counterpartCoo = promise.from === cooId ? promise.to : promise.from;
    const counterpartSeat = counterpartCoo ? this.seatOf(counterpartCoo) : null;
    const storedName = promise.from === cooId ? promise.data?.toName : promise.data?.fromName;
    const otherName = counterpartSeat?.name
      ?? (typeof storedName === 'string' && storedName ? storedName : '对方');

    if (action === 'accept' || action === 'decline') {
      if (promise.to !== cooId) throw new HostError('forbidden', '只有被承诺的人能回应');
      if (status !== 'pending') throw new HostError('conflict', `这条承诺已经「${this.statusLabel(status)}」了`);
    } else if (action === 'cancel') {
      if (promise.from !== cooId) throw new HostError('forbidden', '只有提出承诺的人能撤回');
      if (status !== 'pending') throw new HostError('conflict', '对方已经回应了，不能单方面撤回');
    } else {
      if (promise.to !== cooId) throw new HostError('forbidden', '只有被承诺的人（债权人）能说了结');
      if (status !== 'accepted') throw new HostError('conflict', `这条承诺现在是「${this.statusLabel(status)}」，不能了结`);
      const amount = typeof promise.data?.chips === 'number' ? promise.data.chips : 0;
      if (amount > 0) {
        const balance = promise.from ? this.ledger.balanceOf(promise.from) : 0;
        if (balance < amount) {
          throw new HostError('invalid', `${otherName} 现在只有 ${balance} 枚筹码，还不够 ${amount} 枚`);
        }
      }
    }

    const kind = action === 'done' ? 'settle' : action;
    const amount = action === 'done' && typeof promise.data?.chips === 'number' ? promise.data.chips : 0;
    const prefix = { accept: '已答应', decline: '已拒绝', cancel: '已撤回', done: '已了结' }[action];
    const entry = this.ledger.record({
      kind,
      ref: promise.id,
      room: promise.room,
      from: cooId,
      ...(counterpartCoo ? { to: counterpartCoo } : {}),
      text: `${prefix}：${promise.text}`,
      visibility: 'private',
      data: {
        fromName: seat.name,
        toName: otherName,
        promiseText: promise.text,
        ...(amount ? { chips: amount } : {}),
      },
      ...(amount && promise.from
        ? { transfers: [{ from: promise.from, to: promise.to ?? cooId, amount }] }
        : {}),
    });
    const text = {
      accept: `答应了你的承诺：${promise.text}`,
      decline: `没答应这条承诺：${promise.text}`,
      cancel: `撤回了承诺：${promise.text}`,
      done: `说了结这条承诺：${promise.text}${amount ? `（${amount} 枚筹码已划给你）` : ''}`,
    }[action];
    const delivered = counterpartCoo
      ? this.notify(counterpartCoo, `${seat.name} ${text}`, {
        kind: 'promise', action, from: seat.name, entryId: promise.id, toName: otherName,
      })
      : undefined;
    return { entry, ...(delivered ? { delivered: [delivered] } : {}) };
  }

  /** 到期没结的承诺由服务器追加 default；只扫本客厅的承诺。 */
  expireLedger(now = this.now()): LedgerEntry[] {
    const created = this.ledger.expire(now, this.roomId);
    for (const entry of created) {
      const [debtorCoo, creditorCoo] = entry.participants ?? [];
      const text = typeof entry.data?.promiseText === 'string' ? entry.data.promiseText : entry.text;
      if (debtorCoo) {
        this.notify(debtorCoo, `你对 ${entry.data?.toName ?? '对方'} 的承诺到期没结：${text}`, {
          kind: 'promise', action: 'default', entryId: entry.ref ?? entry.id,
        });
      }
      if (creditorCoo) {
        this.notify(creditorCoo, `${entry.data?.fromName ?? '对方'} 对你的承诺到期没结：${text}`, {
          kind: 'promise', action: 'default', entryId: entry.ref ?? entry.id,
        });
      }
    }
    return created;
  }

  /** 余额见底的人由客厅补一点（每段间隔最多一次），并私下告诉他。 */
  refillLedger(now = this.now()): LedgerEntry[] {
    const created: LedgerEntry[] = [];
    for (const seat of this.seats()) {
      if (seat.kind === 'observer') continue;
      const entry = this.ledger.maybeRefill(seat.cooId, this.roomId, now);
      if (!entry) continue;
      created.push(entry);
      const amount = typeof entry.data?.chips === 'number' ? entry.data.chips : 0;
      this.notify(seat.cooId, `客厅给你补了 ${amount} 枚筹码，现在有 ${this.ledger.balanceOf(seat.cooId)} 枚。`, {
        kind: 'grant', action: 'refill', entryId: entry.id,
      });
    }
    return created;
  }

  private assertNotLocked(cooId: string, verb: string): void {
    const lock = this.tableHost.lockOf(cooId);
    if (!lock) return;
    if (lock.status === 'open') {
      const hint = lock.hostSeatId === this.seatOf(cooId)?.id
        ? '你是开桌的人，先把桌子收起来'
        : '先退桌';
      throw new HostError('conflict', `你还在${lock.label}桌上（还没开局）：${hint}，再${verb}`);
    }
    throw new HostError('conflict', `${lock.label}牌局还没结束；打完才能${verb}`);
  }

  private requireTarget(seat: SeatRow, to: string): SeatRow {
    if (seat.kind === 'observer') throw new HostError('forbidden', '观看者不能写账本');
    const target = this.resolveSeat(to);
    if (target.id === seat.id) throw new HostError('invalid', '不能对自己做这件事');
    if (target.kind === 'observer') throw new HostError('invalid', '观看者不参与账本');
    return target;
  }

  private checkSocialBudget(cooId: string): void {
    if (this.ledger.socialCountSince(cooId, this.now() - 3_600_000) >= MAX_SOCIAL_PER_HOUR) {
      throw new HostError('invalid', `一小时内最多 ${MAX_SOCIAL_PER_HOUR} 条礼物或承诺，过一会儿再来`);
    }
  }

  private checkSayGap(cooId: string): void {
    const last = this.lastSay.get(cooId) ?? 0;
    const now = this.now();
    if (now - last < SAY_GAP_MS) throw new HostError('invalid', '说得太快了，等一下再说');
    this.lastSay.set(cooId, now);
  }

  private statusLabel(status: string | null): string {
    return ({
      pending: '等回应', accepted: '已答应', declined: '已拒绝', cancelled: '已撤回',
      settled: '已了结', defaulted: '已失约',
    } as Record<string, string>)[status ?? ''] ?? status ?? '未知';
  }

  /**
   * 账本通知：对方在这个客厅就写一条 seat-scope 事件（即时唤醒用），
   * 不在也照样留一封进全局信箱。返回给寄信人的投递回执。
   */
  private notify(
    cooId: string,
    text: string,
    data: Record<string, unknown> & { kind: string; entryId?: string },
  ): DeliveryReceipt {
    const seat = this.seatOf(cooId);
    if (seat) {
      this.events.append(this.roomId, {
        type: 'parlor.ledger',
        from: 'system',
        scope: { kind: 'seat', seatId: seat.id },
        text,
        data,
        audience: [{ cooId, seatId: seat.id }],
        ts: this.now(),
      });
    }
    const kind = data.kind === 'gift' ? 'gift' : data.kind === 'promise' ? 'promise' : 'ledger';
    const letter = this.mail.append({
      to: cooId,
      room: this.roomId,
      kind,
      ...(typeof data.action === 'string' ? { action: data.action } : {}),
      fromName: typeof data.from === 'string' ? data.from : '系统',
      text,
      ...(typeof data.entryId === 'string' ? { entryId: data.entryId } : {}),
    });
    return {
      to: seat?.name ?? (typeof data.toName === 'string' ? data.toName : '对方'),
      mailSeq: letter.seq,
      ts: letter.ts,
      at: serverClock(letter.ts),
    };
  }

  private requireRoom(): RoomRow {
    const room = getRoom(this.db, this.roomId);
    if (!room) throw new HostError('not_found', `客厅不存在：${this.roomId}`);
    return room;
  }

  private requireSeat(cooId: string): SeatRow {
    this.requireRoom();
    const seat = this.seatOf(cooId);
    if (!seat) throw new HostError('forbidden', '你不在这个客厅里');
    return seat;
  }

  private resolveSeat(value: string): SeatRow {
    const needle = value.trim().toLowerCase();
    const seats = this.seats();
    const seat = seats.find((item) => item.id === value.trim())
      ?? seats.find((item) => item.name.toLowerCase() === needle);
    if (!seat) throw new HostError('not_found', `客厅里没有叫「${value}」的席位`);
    return seat;
  }

  private mentionsIn(text: string, from: SeatRow): string[] {
    const names = this.seats()
      .filter((seat) => seat.id !== from.id)
      .sort((left, right) => right.name.length - left.name.length);
    return names
      .filter((seat) => text.includes(`@${seat.name}`))
      .map((seat) => seat.id);
  }

  private latestInterval(cooId: string): { visibleFromSeq: number; visibleUntilSeq: number | null } | null {
    const row = this.db.prepare(
      `SELECT visible_from_seq, visible_to_seq FROM room_seats
       WHERE room_id = ? AND coo_id = ?
       ORDER BY visible_from_seq DESC, joined_at DESC, id DESC LIMIT 1`,
    ).get(this.roomId, cooId) as { visible_from_seq: number; visible_to_seq: number | null } | undefined;
    return row ? { visibleFromSeq: row.visible_from_seq, visibleUntilSeq: row.visible_to_seq } : null;
  }
}

