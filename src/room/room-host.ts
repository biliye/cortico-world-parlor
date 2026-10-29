/**
 * 一个客厅的运行时（聊天切片）。
 *
 * 负责：加入/离开/换房、说话/私聊、按可见区间读历史、快照、信箱。
 * 不负责：牌桌（下一层接入）、全局账户/会话（网关层）、大厅目录（RoomRegistry）。
 *
 * 所有写操作都包在 withTransaction 里：事件、席位、信箱要么一起成，要么一起回。
 * 每房事件 seq 由 EventDb 分配，别的客厅不会串号。
 */
import { randomBytes } from 'node:crypto';
import { withTransaction, type Db } from './db.ts';
import { EventDb } from './event-db.ts';
import { MailDb } from './mail-db.ts';
import {
  RoomSeatError, activeSeatForCoo, activeSeats, getRoom, hashSeatToken, joinSeat, releaseSeat,
  seatByTokenHash, type RoomRow, type SeatRow,
} from './room-seat-db.ts';
import { serverClock } from './clock.ts';
import type { RoomEvent, RoomSnapshot, Seat, SeatKind, WakeTier } from './protocol.ts';

export type HostErrorCode = 'invalid' | 'not_found' | 'forbidden' | 'conflict' | 'full' | 'already_seated';

export class HostError extends Error {
  readonly code: HostErrorCode;

  constructor(code: HostErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'HostError';
  }
}

export interface RoomHostOptions {
  now?: () => number;
  token?: () => string;
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
  private readonly now: () => number;
  private readonly makeToken: () => string;

  constructor(private readonly db: Db, roomId: string, options: RoomHostOptions = {}) {
    this.roomId = roomId;
    this.events = new EventDb(db);
    this.now = options.now ?? Date.now;
    this.mail = new MailDb(db, { now: this.now });
    this.makeToken = options.token ?? makeToken;
  }

  room(): RoomRow {
    return this.requireRoom();
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
      const event = this.events.append(this.roomId, {
        type: 'parlor.joined',
        ts: now,
        from: 'system',
        scope: { kind: 'room' },
        text: `${name} 进了客厅。`,
        data: { seatId: seat.id, name },
      });
      return { seat, token, event };
    });
  }

  leave(cooId: string): LeaveResult {
    this.requireRoom();
    const seat = this.seatOf(cooId);
    if (!seat) throw new HostError('not_found', '你不在这个客厅里');
    const now = this.now();

    return withTransaction(this.db, () => {
      const event = this.events.append(this.roomId, {
        type: 'parlor.left',
        ts: now,
        from: seat.id,
        scope: { kind: 'room' },
        text: `${seat.name} 离开了客厅。`,
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

  /** 原子换房：源客厅写离开事件并释放席位，目标客厅拿新席位并写加入事件。 */
  switchTo(cooId: string, targetRoomId: string, input: { name?: string } = {}): SwitchResult {
    if (targetRoomId === this.roomId) throw new HostError('invalid', '已经在这个客厅里');
    const source = this.requireRoom();
    const target = getRoom(this.db, targetRoomId);
    if (!target) throw new HostError('not_found', '目标客厅不存在');
    if (target.archivedAt !== null) throw new HostError('conflict', '目标客厅已经归档');
    const seat = this.seatOf(cooId);
    if (!seat) throw new HostError('not_found', '你不在当前客厅里');
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
        text: `${seat.name} 离开了客厅，去「${target.name}」。`,
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
        text: `${name} 进了客厅。`,
        data: { seatId: joined.id, name, from: source.id },
      });
      return { released, seat: joined, token, leaveEvent, joinEvent };
    });
  }

  say(cooId: string, text: string): SayResult {
    const seat = this.requireSeat(cooId);
    const body = cleanText(text);
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
        room: this.roomId,
        kind: 'whisper',
        fromName: seat.name,
        text: body,
      });
      return { event, mailSeq: letter.seq };
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

  snapshot(cooId: string, options: { since?: number; limit?: number } = {}): RoomSnapshot {
    const seat = this.requireSeat(cooId);
    const interval = { visibleFromSeq: seat.visibleFromSeq, visibleUntilSeq: seat.visibleToSeq };
    const now = this.now();
    const latest = this.events.latest(this.roomId);
    return {
      id: this.roomId,
      seat: seatOfRow(seat),
      seats: this.seats().map(seatOfRow),
      maxSeats: this.requireRoom().capacity,
      latest,
      now,
      at: serverClock(now),
      events: this.events.recent(this.roomId, {
        cooId,
        interval,
        ...(options.since !== undefined ? { since: options.since } : {}),
        limit: options.limit ?? 30,
      }),
      mailUnread: this.mail.unreadCount(cooId, this.roomId),
    };
  }

  mailUnread(cooId: string): number {
    return this.mail.unreadCount(cooId, this.roomId);
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

  readMail(cooId: string, limit = 10, markRead = true) {
    return this.mail.list(cooId, this.roomId, limit, markRead);
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

