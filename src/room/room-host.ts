import { touchActivity } from './activity.ts';
/**
 * 一个客厅的运行时：席位、聊天、私聊、信箱、账本与牌桌。
 *
 * 负责：加入/离开/换房、说话/私聊/送礼/承诺、按可见区间读历史、快照、信箱、一房一桌。
 * 不负责：全局账户/会话（网关层）、大厅目录（RoomRegistry）、家长门户（下一轮）。
 *
 * 所有写操作都包在 withTransaction 里：事件、席位、信箱要么一起成，要么一起回。
 * 每房事件 seq 由 EventDb 分配，别的客厅不会串号。牌桌规则在 table-host.ts。
 *
 * 构造是异步的：TableHost 起来时要恢复本房未结束的牌局（可能作废/退款），
 * 必须等恢复完再开始接请求。用 `RoomHost.create()`，不要 new。
 */
import { randomBytes } from 'node:crypto';
import { withTransaction, type Db } from './db.ts';
import { EventDb } from './event-db.ts';
import { parseHandleQuery } from './handles.ts';
import { registeredHandle } from './global-identity.ts';
import { LedgerDb } from './ledger-db.ts';
import { MailDb } from './mail-db.ts';
import { mentionsInText } from './mentions.ts';
import { lockCooRows, lockRoomRow } from './storage/locks.ts';
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
import type { TablePrivateSummary, TableSummary } from './table-engine.ts';
import type { DeliveryReceipt, RoomEvent, RoomSnapshot, Seat, SeatKind, WakeTier } from './protocol.ts';

export { HostError, type HostErrorCode } from './host-error.ts';

export interface RoomHostOptions {
  now?: () => number;
  token?: () => string;
  /** 每手/每窗时限基准（测试与 staging 调短用；不传用各游戏默认）。 */
  turnMs?: number;
  /** 启动恢复用的健康基准（由网关从 meta.last_healthy_at 读一次，所有客厅共用）。 */
  recovery?: { lastHealthyAt?: number; maxDowntimeMs?: number; minHumanMs?: number };
  /** 事件提交后通知网关；推送用它立刻发，不再等 400ms 节拍。 */
  onCommit?: (roomId: string) => void;
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

const seatOfRow = async (db: Db, row: SeatRow): Promise<Seat> => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  tier: row.tier,
  joinedAt: row.joinedAt,
  handle: await registeredHandle(db, row.cooId),
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

/** 补给扫描的最短间隔：补给本身是 6 小时一次的节奏，30 秒一拍足够。 */
const REFILL_SCAN_MS = 30_000;

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
  /** 下一次扫余额补给的时刻；补给节奏是 6 小时一次，扫描不必每秒。 */
  private nextRefillAt = 0;

  private readonly db: Db;

  private constructor(
    db: Db,
    roomId: string,
    options: RoomHostOptions,
    parts: { mail: MailDb; ledger: LedgerDb; tableHost: TableHost },
  ) {
    this.db = db;
    this.roomId = roomId;
    this.events = new EventDb(db, options.onCommit ? () => options.onCommit!(roomId) : undefined);
    this.now = options.now ?? Date.now;
    this.mail = parts.mail;
    this.ledger = parts.ledger;
    this.makeToken = options.token ?? makeToken;
    this.tableHost = parts.tableHost;
  }

  /**
   * 建一个客厅运行时。等待 TableHost 恢复完本房未结束的牌局再返回——
   * 恢复可能写库（作废、退款、隔离坏存档），必须在接请求之前完成。
   */
  static async create(db: Db, roomId: string, options: RoomHostOptions = {}): Promise<RoomHost> {
    const now = options.now ?? Date.now;
    const mail = new MailDb(db, { now });
    const ledger = new LedgerDb(db, { now });
    // 席位查询直接走 store，不经过 RoomHost 实例：TableHost 恢复时就要用，
    // 那时 RoomHost 还没构造完。
    const tableHost = await TableHost.create({
      db,
      roomId,
      onCommit: options.onCommit,
      now,
      ledger,
      mail,
      ...(options.turnMs !== undefined ? { turnMs: options.turnMs } : {}),
      seats: {
        activeSeat: async (cooId: string) => {
          const seat = await activeSeatForCoo(db, cooId);
          return seat?.roomId === roomId ? seat : null;
        },
        seats: () => activeSeats(db, roomId),
      },
      ...(options.recovery ? { recovery: options.recovery } : {}),
    });
    return new RoomHost(db, roomId, options, { mail, ledger, tableHost });
  }

  room(): Promise<RoomRow> {
    return this.requireRoom();
  }

  /** 这块地方叫什么：大厅是特殊客厅，事件文案别把大厅写成客厅。 */
  private async placeOf(roomId: string): Promise<string> {
    return (await getRoom(this.db, roomId))?.kind === 'hall' ? '大厅' : '客厅';
  }

  latest(): Promise<number> {
    return this.events.latest(this.roomId);
  }

  seats(): Promise<SeatRow[]> {
    return activeSeats(this.db, this.roomId);
  }

  async seatOf(cooId: string): Promise<SeatRow | null> {
    const seat = await activeSeatForCoo(this.db, cooId);
    return seat?.roomId === this.roomId ? seat : null;
  }

  /** 用明文令牌认当前活跃席位；令牌只在这个客厅有效。 */
  async seatByToken(token: string): Promise<SeatRow> {
    const seat = await seatByTokenHash(this.db, hashSeatToken(token));
    if (!seat || seat.roomId !== this.roomId) throw new HostError('forbidden', '席位令牌无效或已经离开');
    return seat;
  }

  /** 同一个席位换一枚新令牌（家长再次下场）：席位、可见区间、账本都不动。 */
  async reissueSeatToken(cooId: string): Promise<{ seat: SeatRow; token: string }> {
    const seat = await this.seatOf(cooId);
    if (!seat) throw new HostError('not_found', '你不在这个客厅里');
    const token = this.makeToken();
    await updateSeatToken(this.db, this.roomId, seat.id, hashSeatToken(token));
    return { seat, token };
  }

  async join(cooId: string, input: { name?: string; kind?: SeatKind; tier?: WakeTier } = {}): Promise<JoinResult> {
    const room = await this.requireRoom();
    if (room.archivedAt !== null) throw new HostError('conflict', '这个客厅已经归档');
    const active = await activeSeatForCoo(this.db, cooId);
    if (active) {
      throw new HostError('already_seated', active.roomId === this.roomId
        ? '你已经在这个客厅里了；用原来的席位令牌'
        : '你已经在另一个客厅里；先离开或换房');
    }
    const name = cleanName(input.name ?? '');
    const token = this.makeToken();
    const visibleFromSeq = await this.events.latest(this.roomId);
    const now = this.now();

    return withTransaction(this.db, async () => {
      let seat: SeatRow;
      try {
        seat = await joinSeat(this.db, {
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
      await this.ledger.ensureGrant(cooId, this.roomId);
      const event = await this.events.append(this.roomId, {
        type: 'parlor.joined',
        ts: now,
        from: 'system',
        scope: { kind: 'room' },
        text: `${seat.name} 进了${await this.placeOf(this.roomId)}。`,
        data: { seatId: seat.id, name: seat.name },
      });
      return { seat, token, event };
    });
  }

  /**
   * 私聊信已经落进信箱了，这里只往对方所在的客厅推一条事件，让在线的人立刻看到；
   * 不再写第二封信（否则信箱里会出现两条）。
   */
  async whisperNotice(fromCooId: string, fromName: string, target: { cooId: string; id: string; name: string }, text: string,
    mail?: { seq: number; ts: number; room: string }): Promise<RoomEvent> {
    const now = this.now();
    const senderSeat = await activeSeatForCoo(this.db, fromCooId);
    return this.events.append(this.roomId, {
      type: 'parlor.whisper',
      ts: now,
      from: senderSeat?.id ?? 'system',
      scope: { kind: 'seat', seatId: target.id },
      text,
      data: { name: fromName, to: target.name, dm: true, ...(mail ? { mail } : {}) },
      audience: [{ cooId: target.cooId, seatId: target.id }],
    });
  }

  async leave(cooId: string): Promise<LeaveResult> {
    await this.requireRoom();
    const seat = await this.seatOf(cooId);
    if (!seat) throw new HostError('not_found', '你不在这个客厅里');
    await this.assertNotLocked(cooId, '离开客厅');
    const now = this.now();

    return withTransaction(this.db, async () => {
      const event = await this.events.append(this.roomId, {
        type: 'parlor.left',
        ts: now,
        from: seat.id,
        scope: { kind: 'room' },
        text: `${seat.name} 离开了${await this.placeOf(this.roomId)}。`,
        data: { seatId: seat.id, name: seat.name },
      });
      let released: SeatRow | null;
      try {
        released = await releaseSeat(this.db, this.roomId, seat.id, event.seq, now);
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
  async releaseOffline(cooId: string, now = this.now()): Promise<LeaveResult | null> {
    const seat = await this.seatOf(cooId);
    if (!seat) return null;
    if (await this.tableHost.lockOf(cooId)) return null;
    return withTransaction(this.db, async () => {
      const event = await this.events.append(this.roomId, {
        type: 'parlor.left',
        ts: now,
        from: seat.id,
        scope: { kind: 'room' },
        text: `${seat.name} 的席位因长时间未上线被释放。`,
        data: { seatId: seat.id, name: seat.name, reason: 'offline' },
      });
      const released = await releaseSeat(this.db, this.roomId, seat.id, event.seq, now);
      return { seat: released, event };
    });
  }

  /**
   * 房主移除成员：立刻停止这一房的访问并释放席位；牌桌锁不拦（牌局由服务器托管到结算）。
   * 调用方先 `markTableAuto`，这里只管席位与事件。
   */
  async remove(cooId: string, now = this.now(), reason: 'removed' | 'room_deleted' = 'removed'): Promise<LeaveResult | null> {
    const seat = await this.seatOf(cooId);
    if (!seat) return null;
    return withTransaction(this.db, async () => {
      const event = await this.events.append(this.roomId, {
        type: 'parlor.left',
        ts: now,
        from: seat.id,
        scope: { kind: 'room' },
        text: reason === 'room_deleted' ? '房主删除了客厅，席位已释放，请回大厅。' : `${seat.name} 被房主移出了${await this.placeOf(this.roomId)}。`,
        data: { seatId: seat.id, name: seat.name, reason },
      });
      const released = await releaseSeat(this.db, this.roomId, seat.id, event.seq, now);
      return { seat: released, event };
    });
  }

  /** 原子换房：源客厅写离开事件并释放席位，目标客厅拿新席位并写入加入事件。 */
  async switchTo(cooId: string, targetRoomId: string, input: { name?: string; token?: string; preserveToken?: boolean; idleBefore?: number } = {}): Promise<SwitchResult> {
    if (targetRoomId === this.roomId) throw new HostError('invalid', '已经在这个客厅里');
    const source = await this.requireRoom();
    const target = await getRoom(this.db, targetRoomId);
    if (!target) throw new HostError('not_found', '目标客厅不存在');
    if (target.archivedAt !== null) throw new HostError('conflict', '目标客厅已经归档');
    const seat = await this.seatOf(cooId);
    if (!seat) throw new HostError('not_found', '你不在当前客厅里');
    await this.assertNotLocked(cooId, '换客厅');
    const name = cleanName(input.name ?? seat.name);
    const token = input.token ?? this.makeToken();
    const now = this.now();
    const targetFrom = await this.events.latest(targetRoomId);

    return withTransaction(this.db, async () => {
      await lockCooRows(this.db, [cooId]);
      for (const roomId of [this.roomId, targetRoomId].sort()) await lockRoomRow(this.db, roomId);
      const current = await this.seatOf(cooId);
      if (!current || current.id !== seat.id) throw new HostError('conflict', '席位已经变化，请刷新后重试');
      if (input.idleBefore !== undefined) {
        const fresh = await this.db.prepare('SELECT business_active_at FROM room_seats WHERE room_id=? AND id=?').get(this.roomId, current.id) as { business_active_at: number };
        if (Number(fresh.business_active_at) > input.idleBefore) throw new HostError('conflict', '席位刚有新活动');
      }
      await this.assertNotLocked(cooId, '换客厅');
      const leaveEvent = await this.events.append(this.roomId, {
        type: 'parlor.left',
        ts: now,
        from: seat.id,
        scope: { kind: 'room' },
        text: `${seat.name} 离开了${await this.placeOf(this.roomId)}，去「${target.name}」。`,
        data: { seatId: seat.id, name: seat.name, to: targetRoomId },
      });
      let released: SeatRow | null;
      try {
        released = await releaseSeat(this.db, this.roomId, seat.id, leaveEvent.seq, now);
      } catch (error) {
        return wrapSeatError(error);
      }
      let joined: SeatRow;
      try {
        if (input.preserveToken) {
          // The old interval stays immutable; only its retired credential hash is discarded.
          await this.db.prepare('UPDATE room_seats SET token_hash=? WHERE room_id=? AND id=?')
            .run(randomBytes(32).toString('hex'), this.roomId, seat.id);
        }
        joined = await joinSeat(this.db, {
          roomId: targetRoomId,
          cooId,
          name,
          token,
          ...(input.preserveToken ? { tokenHash: seat.tokenHash } : {}),
          visibleFromSeq: targetFrom,
          kind: seat.kind,
          tier: seat.tier,
          now,
        });
      } catch (error) {
        return wrapSeatError(error);
      }
      const joinEvent = await this.events.append(targetRoomId, {
        type: 'parlor.joined',
        ts: now,
        from: 'system',
        scope: { kind: 'room' },
        text: `${joined.name} 进了${await this.placeOf(targetRoomId)}。`,
        data: { seatId: joined.id, name: joined.name, from: source.id },
      });
      if (this.db.kind === 'postgres') await this.db.prepare('UPDATE coo_sessions SET return_room_id=? WHERE coo_id=?')
        .run(input.preserveToken ? targetRoomId : null, cooId);
      return { released, seat: joined, token, leaveEvent, joinEvent };
    });
  }

  async say(cooId: string, text: string): Promise<SayResult> {
    const seat = await this.requireSeat(cooId);
    // 狼人杀进行中，参与者的普通客厅公开发言暂不允许：发言走游戏动作，次数才有意义。
    if (await this.tableHost.chatLockedFor(cooId)) {
      throw new HostError('conflict', '你正在狼人杀桌上，局中发言走游戏动作；普通聊天等这局结束');
    }
    const body = cleanText(text);
    this.checkSayGap(cooId);
    const mentions = await this.mentionsIn(body, seat);
    const event = await this.events.append(this.roomId, {
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

  async whisper(cooId: string, to: string, text: string): Promise<WhisperResult> {
    const seat = await this.requireSeat(cooId);
    const target = await this.resolveSeat(to);
    if (target.id === seat.id) throw new HostError('invalid', '不能对自己说私聊');
    // 狼人杀进行中，同桌参与者之间的普通私聊暂不允许：防止绕开单次发言与狼聊限制。
    // 只拦「两端都在同一张进行中狼人杀桌」的组合；桌外人与参与者私聊不受影响。
    if (await this.tableHost.chatLockedFor(cooId) && (await this.tableHost.lockedTablePeerCooIds(cooId)).has(target.cooId)) {
      throw new HostError('conflict', '狼人杀进行中，同桌的人之间不能私聊；想说的留到发言机会或局后再说');
    }
    const body = cleanText(text);
    const now = this.now();

    return withTransaction(this.db, async () => {
      const event = await this.events.append(this.roomId, {
        type: 'parlor.whisper',
        ts: now,
        from: seat.id,
        scope: { kind: 'seat', seatId: target.id },
        text: body,
        data: { name: seat.name, to: target.name },
        audience: [{ cooId: target.cooId, seatId: target.id }],
      });
      const letter = await this.mail.append({
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
  async history(cooId: string, options: { since?: number; limit?: number } = {}): Promise<RoomEvent[]> {
    const interval = await this.latestInterval(cooId);
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
  async pingSeat(cooId: string, text: string, data: Record<string, unknown>, type = 'parlor.invite'): Promise<RoomEvent | null> {
    const seat = await this.seatOf(cooId);
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
  async replay(cooId: string, options: { before?: number; limit?: number } = {}): Promise<{ events: RoomEvent[]; older: boolean }> {
    await this.requireRoom();
    return this.events.replay(this.roomId, {
      cooId,
      ...(options.before !== undefined ? { before: options.before } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
  }

  async snapshot(cooId: string, options: { since?: number; limit?: number } = {}): Promise<RoomSnapshot> {
    const seat = await this.requireSeat(cooId);
    const interval = { visibleFromSeq: seat.visibleFromSeq, visibleUntilSeq: seat.visibleToSeq };
    const now = this.now();
    const latest = await this.events.latest(this.roomId);
    const room = await this.requireRoom();
    const seatRows = await this.seats();
    const handles = seatRows.length ? await this.db.prepare(`SELECT coo_id,handle FROM global_handles WHERE coo_id IN (${seatRows.map(() => '?').join(',')})`).all(...seatRows.map(row => row.cooId)) as { coo_id: string; handle: string }[] : [];
    const handleMap = new Map(handles.map(row => [row.coo_id, row.handle]));
    const seats: Seat[] = seatRows.map(row => ({ id: row.id, name: row.name, kind: row.kind, tier: row.tier, joinedAt: row.joinedAt, handle: handleMap.get(row.cooId) ?? row.cooId.slice(0,8).toLowerCase() }));
    const tablePublic = await this.tableHost.public(cooId);
    return {
      id: this.roomId,
      name: room.name,
      topic: room.topic,
      visibility: room.visibility,
      seat: seats.find(row => row.id === seat.id) ?? await seatOfRow(this.db, seat),
      seats,
      maxSeats: room.capacity,
      latest,
      now,
      at: serverClock(now),
      events: await this.events.recent(this.roomId, {
        cooId,
        interval,
        ...(options.since !== undefined ? { since: options.since } : {}),
        limit: options.limit ?? 30,
      }),
      mailUnread: await this.mail.unreadCount(cooId),
      tables: await this.tableHost.list(),
      ...(tablePublic ? { table: tablePublic } : {}),
      tablePrivate: await this.tableHost.private(seat.id),
      ledger: await this.ledger.summaryFor(cooId),
      ledgerRoom: await this.ledger.publicInRoom(this.roomId, 5),
    };
  }

  /**
   * 牌桌增量：只给「当前桌」需要的那几块（桌列表、指定那张桌、我的私视图）。
   * 不含席位名单、事件、账本与信箱——那些只有整份快照才给。
   * 权限与投影复用 public()/private()：看别人的桌拿不到他的暗牌。
   */
  async tableSlice(cooId: string, tableId?: string): Promise<{
    tables: TableSummary[];
    table: TableSummary | null;
    tablePrivate: TablePrivateSummary | null;
  }> {
    const seat = await this.requireSeat(cooId);
    const table = tableId
      ? (await this.tableHost.tableSummary(tableId, cooId)) ?? null
      : (await this.tableHost.public(cooId)) ?? null;
    return {
      tables: await this.tableHost.list(),
      table,
      tablePrivate: await this.tableHost.private(seat.id),
    };
  }

  /** 这个客厅里的未读；跨厅邀请在全局未读里。 */
  mailUnread(cooId: string): Promise<number> {
    return this.mail.unreadCount(cooId, this.roomId);
  }

  /** 全部客厅的未读（信箱是全局的，邀请也落在这里）。 */
  mailUnreadAll(cooId: string): Promise<number> {
    return this.mail.unreadCount(cooId);
  }

  /** SSE 补看/轮询：从 since 之后、该 coo 可见的事件。 */
  async eventsSince(cooId: string, since: number, limit = 200): Promise<RoomEvent[]> {
    const interval = await this.latestInterval(cooId);
    if (!interval) return [];
    return this.events.history(this.roomId, { cooId, interval, since, limit });
  }

  /** 改当前活跃席位的唤醒挡位。 */
  async setTier(cooId: string, tier: WakeTier): Promise<void> {
    const seat = await this.seatOf(cooId);
    if (!seat) throw new HostError('not_found', '你不在这个客厅里');
    await this.db.prepare(
      'UPDATE room_seats SET tier = ? WHERE room_id = ? AND id = ? AND released_at IS NULL',
    ).run(tier, this.roomId, seat.id);
  }

  readMail(cooId: string, limit = 10, markRead = true, all = false) {
    return this.mail.list(cooId, all ? undefined : this.roomId, limit, markRead);
  }

  /** 最近几封（含已读），不动未读游标；信箱页首屏用。 */
  mailRecent(cooId: string, limit = 12, all = false) {
    return this.mail.recent(cooId, all ? undefined : this.roomId, limit);
  }

  // —— 牌桌 ——

  /** 坐在未结束的牌桌上时不能离厅/换房；返回锁信息给调用方拼错误。 */
  tableLock(cooId: string): Promise<TableLockInfo | null> {
    return this.tableHost.lockOf(cooId);
  }

  async openTable(cooId: string, input: { game?: string; stake?: unknown; clientVersion?: string; matchOpen?: boolean } = {}, requestId?: string): Promise<TableOpenResult> {
    if ((await this.requireRoom()).kind === 'hall') {
      throw new HostError('conflict', '大厅是进场和选房的地方，不能开桌；先走进一个客厅');
    }
    if (input.matchOpen && (await this.requireRoom()).visibility !== 'public') {
      throw new HostError('forbidden', '只有公开客厅里的牌桌可以开放快速匹配');
    }
    if (input.matchOpen && Number(input.stake) > 0) throw new HostError('invalid', '快速匹配只支持无押注牌桌，押注桌可以分享到大厅招募');
    return this.tableHost.open(cooId, input, requestId);
  }

  joinTable(cooId: string, tableId?: string, requestId?: string, clientVersion?: string, transition?: Parameters<TableHost['join']>[4]) {
    return this.tableHost.join(cooId, tableId, requestId, clientVersion, transition);
  }

  refreshClientVersion(cooId: string, version?: string): Promise<boolean> {
    return this.tableHost.refreshClientVersion(cooId, version);
  }

  tableDiscovery(cooId: string, tableId: string, input: { matchOpen?: boolean; text?: string; withdraw?: boolean }, requestId: string) {
    return this.tableHost.discovery(cooId, tableId, input, requestId);
  }

  leaveTable(cooId: string, tableId?: string, requestId?: string): Promise<TableLeaveResult> {
    return this.tableHost.leave(cooId, tableId, requestId);
  }

  startTable(cooId: string, tableId?: string, requestId?: string): Promise<StartReceipt> {
    return this.tableHost.start(cooId, tableId, requestId);
  }

  tableAction(cooId: string, action: unknown, options: { tableId?: string; revision?: number; requestId?: string } = {}): Promise<TableReceipt> {
    return this.tableHost.act(cooId, action, options);
  }

  async tableSay(cooId: string, text: string, tableId?: string): Promise<RoomEvent> {
    const seat = await this.requireSeat(cooId);
    const body = cleanText(text);
    this.checkSayGap(cooId);
    return this.tableHost.say(cooId, body, tableId, await this.mentionsIn(body, seat));
  }

  tablePublic(tableId?: string, cooId?: string) {
    return this.tableHost.tableSummary(tableId, cooId);
  }

  /** 游戏历史查询（狼人杀按天/按人回看与终局复盘）。 */
  tableLog(cooId: string, tableId: string | undefined, query: { day?: number; seatNo?: number; limit?: number; review?: boolean }) {
    return this.tableHost.tableLog(cooId, tableId, query);
  }

  /** 这个 coo 被进行中的游戏锁了普通聊天（狼人杀发言走游戏动作）。 */
  chatLockedFor(cooId: string): Promise<boolean> {
    return this.tableHost.chatLockedFor(cooId);
  }

  /** 同一张锁聊桌上的全部真实身份（含本人）；两端都在桌上才拦私聊。 */
  lockedTablePeerCooIds(cooId: string): Promise<Set<string>> {
    return this.tableHost.lockedTablePeerCooIds(cooId);
  }

  tablePrivate(seatId: string) {
    return this.tableHost.private(seatId);
  }

  /** 被移出客厅的人：牌局里改成托管（结算仍归他）。 */
  markTableAuto(cooId: string): Promise<string[]> {
    return this.tableHost.markAuto(cooId);
  }

  /** 这个客厅的桌（运营诊断用）。 */
  tableList() {
    return this.tableHost.list();
  }

  /** 运营命令：作废一张桌并按开局明细退款。 */
  voidTable(tableId: string, note?: string): Promise<boolean> {
    return this.tableHost.voidTable(tableId, note);
  }

  myTable(cooId: string) {
    return this.tableHost.tableOf(cooId);
  }

  /** 清理超过保留期的事件（回放 7 天；最后 500 条永远留着）。 */
  pruneEvents(beforeTs: number, keep = 500): Promise<number> {
    return this.events.prune(this.roomId, beforeTs, keep);
  }

  /** 网关每秒调一次：开桌超时、牌局超时代打、承诺到期、余额补给。 */
  async tickClock(now = this.now()): Promise<void> {
    await this.tableHost.tick();

    // 补给是 6 小时的节奏，没必要每秒对每个席位查一次余额：按 30 秒一拍扫。
    if (now >= this.nextRefillAt) {
      this.nextRefillAt = now + REFILL_SCAN_MS;
      await this.refillLedger(now);
    }
  }

  /**
   * 下一次这个客厅需要被推一下的时刻：牌桌到点、承诺到期、下一次补给扫描。
   * 都没有就是 undefined——网关据此决定睡到什么时候。
   */
  async nextWakeAt(now = this.now()): Promise<number | undefined> {
    let next = this.tableHost.nextWakeAt(now);
    const occupied = await this.db.prepare('SELECT 1 FROM room_seats WHERE room_id=? AND released_at IS NULL LIMIT 1').get(this.roomId);
    if (occupied && (next === undefined || this.nextRefillAt < next)) next = this.nextRefillAt;
    return next;
  }

  /** 最早一条还没了结的承诺什么时候到期；一条索引查询。 */
  private async nextPromiseAt(): Promise<number | undefined> {
    const row = await this.db.prepare(
      `SELECT MIN(e.due_at) AS at FROM ledger_entries e
        WHERE e.kind = 'promise' AND e.room_id = ? AND e.due_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ledger_entries s
             WHERE s.ref_entry_id = e.id AND s.kind IN ('settle','decline','cancel','default')
          )`,
    ).get(this.roomId) as { at: number | null } | undefined;
    const at = row && row.at !== null && row.at !== undefined ? Number(row.at) : NaN;
    return Number.isFinite(at) ? at : undefined;
  }

  // —— 账本：礼物 / 承诺 / 回应 ——

  async gift(cooId: string, to: string, text: string, chips?: unknown): Promise<{ entry: LedgerEntry; delivered?: DeliveryReceipt[] }> {
    const seat = await this.requireSeat(cooId);
    if (seat.kind === 'observer') throw new HostError('forbidden', '观看者不能写账本');
    const target = await this.requireTarget(seat, to);
    const body = cleanSocial(text);
    const amount = chipsOf(chips);
    await this.checkSocialBudget(cooId);
    // 「查余额 → 扣款」必须在同一个事务里、并锁住双方身份行：
    // PostgreSQL 下两个并发礼物否则会各自通过余额检查而超支。
    return withTransaction(this.db, async () => {
      await lockCooRows(this.db, [cooId, target.cooId]);
      if (amount !== undefined) {
        const balance = await this.ledger.balanceOf(cooId);
        if (balance < amount) throw new HostError('invalid', `你只有 ${balance} 枚筹码`);
      }
      const entry = await this.ledger.record({
        kind: 'gift',
        room: this.roomId,
        from: cooId,
        to: target.cooId,
        text: body,
        visibility: 'private',
        data: { fromName: seat.name, toName: target.name, ...(amount ? { chips: amount } : {}) },
        ...(amount ? { transfers: [{ from: cooId, to: target.cooId, amount }] } : {}),
      });
      await touchActivity(this.db, this.roomId, cooId, this.now());
      const delivered = await this.notify(target.cooId, `收到一份礼物：${body}${amount ? `（${amount} 枚筹码）` : ''}`, {
        kind: 'gift', action: 'gift', from: seat.name, entryId: entry.id, toName: target.name,
      });
      return { entry, delivered: [delivered] };
    });
  }

  async promise(
    cooId: string,
    to: string,
    text: string,
    due?: unknown,
    chips?: unknown,
  ): Promise<{ entry: LedgerEntry; delivered?: DeliveryReceipt[] }> {
    const seat = await this.requireSeat(cooId);
    if (seat.kind === 'observer') throw new HostError('forbidden', '观看者不能写账本');
    const target = await this.requireTarget(seat, to);
    const body = cleanSocial(text);
    const amount = chipsOf(chips);
    const dueAt = dueOf(due, this.now());
    await this.checkSocialBudget(cooId);
    // 「数未了结 → 写入」也要在同一个事务里，否则并发承诺可以绕过上限。
    return withTransaction(this.db, async () => {
      await lockCooRows(this.db, [cooId, target.cooId]);
      const open = await this.ledger.countOpenPromises(cooId);
      if (open >= MAX_OPEN_PROMISES) {
        throw new HostError('invalid', `你已经有 ${MAX_OPEN_PROMISES} 条没了结的承诺，先了结几条`);
      }
      const entry = await this.ledger.record({
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
      const delivered = await this.notify(
        target.cooId,
        `${seat.name} 对你许了个承诺：${body}${dueAt ? `（${dueLabel(dueAt)} 前）` : ''}${amount ? `，${amount} 枚筹码` : ''}。用 parlor_respond 回。`,
        { kind: 'promise', action: 'promise', from: seat.name, entryId: entry.id, toName: target.name },
      );
      return { entry, delivered: [delivered] };
    });
  }

  /** 回应承诺：只有被承诺的人能答应/拒绝/了结；只有提出的人能在回应前撤回。 */
  async respond(
    cooId: string,
    id: string,
    action: 'accept' | 'decline' | 'done' | 'cancel',
  ): Promise<{ entry: LedgerEntry; delivered?: DeliveryReceipt[] }> {
    const seat = await this.requireSeat(cooId);
    if (seat.kind === 'observer') throw new HostError('forbidden', '观看者不能写账本');
    const promise = await this.ledger.find(id);
    if (!promise || (promise.kind !== 'promise' && promise.kind !== 'debt')) {
      throw new HostError('not_found', '找不到这条承诺；用 parlor_ledger 看未了结里的 id');
    }
    if (promise.room !== this.roomId) {
      throw new HostError('not_found', '这条承诺不在这个客厅；回原来的客厅再回应');
    }
    const counterpartCoo = promise.from === cooId ? promise.to : promise.from;
    // 读状态 → 判权限 → 写回应 是一个整体：PG 下两个人的并发回应（答应/撤回）
    // 必须串行，否则会各写一条互相矛盾的终态。锁涉及的双方身份行。
    return withTransaction(this.db, async () => {
      await lockCooRows(this.db, [cooId, promise.from, promise.to, counterpartCoo]);
      const status = await this.ledger.promiseStatus(promise);
      const counterpartSeat = counterpartCoo ? await this.seatOf(counterpartCoo) : null;
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
        const chips = typeof promise.data?.chips === 'number' ? promise.data.chips : 0;
        if (chips > 0) {
          const balance = promise.from ? await this.ledger.balanceOf(promise.from) : 0;
          if (balance < chips) {
            throw new HostError('invalid', `${otherName} 现在只有 ${balance} 枚筹码，还不够 ${chips} 枚`);
          }
        }
      }

      const kind = action === 'done' ? 'settle' : action;
      const amount = action === 'done' && typeof promise.data?.chips === 'number' ? promise.data.chips : 0;
      const prefix = { accept: '已答应', decline: '已拒绝', cancel: '已撤回', done: '已了结' }[action];
      const entry = await this.ledger.record({
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
        ? await this.notify(counterpartCoo, `${seat.name} ${text}`, {
          kind: 'promise', action, from: seat.name, entryId: promise.id, toName: otherName,
        })
        : undefined;
      return { entry, ...(delivered ? { delivered: [delivered] } : {}) };
    });
  }

  /** 到期没结的承诺由服务器追加 default；只扫本客厅的承诺。 */
  async expireLedger(now = this.now()): Promise<LedgerEntry[]> {
    const created = await this.ledger.expire(now, this.roomId);
    for (const entry of created) {
      const [debtorCoo, creditorCoo] = entry.participants ?? [];
      const text = typeof entry.data?.promiseText === 'string' ? entry.data.promiseText : entry.text;
      if (debtorCoo) {
        await this.notify(debtorCoo, `你对 ${entry.data?.toName ?? '对方'} 的承诺到期没结：${text}`, {
          kind: 'promise', action: 'default', entryId: entry.ref ?? entry.id,
        });
      }
      if (creditorCoo) {
        await this.notify(creditorCoo, `${entry.data?.fromName ?? '对方'} 对你的承诺到期没结：${text}`, {
          kind: 'promise', action: 'default', entryId: entry.ref ?? entry.id,
        });
      }
    }
    return created;
  }

  /** 余额见底的人由客厅补一点（每段间隔最多一次），并私下告诉他。 */
  async refillLedger(now = this.now()): Promise<LedgerEntry[]> {
    const created: LedgerEntry[] = [];
    for (const seat of await this.seats()) {
      if (seat.kind === 'observer') continue;
      const entry = await this.ledger.maybeRefill(seat.cooId, this.roomId, now);
      if (!entry) continue;
      created.push(entry);
      const amount = typeof entry.data?.chips === 'number' ? entry.data.chips : 0;
      await this.notify(seat.cooId, `客厅给你补了 ${amount} 枚筹码，现在有 ${await this.ledger.balanceOf(seat.cooId)} 枚。`, {
        kind: 'grant', action: 'refill', entryId: entry.id,
      });
    }
    return created;
  }

  private async assertNotLocked(cooId: string, verb: string): Promise<void> {
    const lock = await this.tableHost.lockOf(cooId);
    if (!lock) return;
    if (lock.status === 'open') {
      const hint = lock.hostSeatId === (await this.seatOf(cooId))?.id
        ? '你是开桌的人，先把桌子收起来'
        : '先退桌';
      throw new HostError('conflict', `你还在${lock.label}桌上（还没开局）：${hint}，再${verb}`);
    }
    throw new HostError('conflict', `${lock.label}牌局还没结束；打完才能${verb}`);
  }

  private async requireTarget(seat: SeatRow, to: string): Promise<SeatRow> {
    if (seat.kind === 'observer') throw new HostError('forbidden', '观看者不能写账本');
    const target = await this.resolveSeat(to);
    if (target.id === seat.id) throw new HostError('invalid', '不能对自己做这件事');
    if (target.kind === 'observer') throw new HostError('invalid', '观看者不参与账本');
    return target;
  }

  private async checkSocialBudget(cooId: string): Promise<void> {
    if (await this.ledger.socialCountSince(cooId, this.now() - 3_600_000) >= MAX_SOCIAL_PER_HOUR) {
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
  private async notify(
    cooId: string,
    text: string,
    data: Record<string, unknown> & { kind: string; entryId?: string },
  ): Promise<DeliveryReceipt> {
    const seat = await this.seatOf(cooId);
    if (seat) {
      await this.events.append(this.roomId, {
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
    const letter = await this.mail.append({
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

  private async requireRoom(): Promise<RoomRow> {
    const room = await getRoom(this.db, this.roomId);
    if (!room) throw new HostError('not_found', `客厅不存在：${this.roomId}`);
    return room;
  }

  private async requireSeat(cooId: string): Promise<SeatRow> {
    await this.requireRoom();
    const seat = await this.seatOf(cooId);
    if (!seat) throw new HostError('forbidden', '你不在这个客厅里');
    return seat;
  }

  private async resolveSeat(value: string): Promise<SeatRow> {
    const needle = value.trim().toLowerCase();
    const seats = await this.seats();
    const handle = parseHandleQuery(value) ?? (value.includes(' #') ? parseHandleQuery('#' + value.split(' #').pop()) : null);
    const exact = seats.find((item) => item.id === value.trim() || item.cooId === value.trim());
    if (exact) return exact;
    const matches: SeatRow[] = [];
    if (handle) {
      for (const item of seats) {
        const registered = await registeredHandle(this.db, item.cooId);
        if (registered === handle || item.cooId.toLowerCase() === handle) matches.push(item);
      }
    } else {
      for (const item of seats) {
        if (item.name.toLowerCase() === needle) matches.push(item);
      }
    }
    if (matches.length > 1) throw new HostError('conflict', '有多个同名席位，请用 #短号');
    const seat = matches[0];
    if (!seat) throw new HostError('not_found', '客厅里没有这个席位：' + value);
    return seat;
  }

  private async mentionsIn(text: string, from: SeatRow): Promise<string[]> {
    const seats = await this.seats();
    const withHandles = [];
    for (const seat of seats) {
      withHandles.push({ ...seat, handle: await registeredHandle(this.db, seat.cooId) });
    }
    return mentionsInText(text, withHandles).filter((id) => id !== from.id);
  }

  private async latestInterval(cooId: string): Promise<{ visibleFromSeq: number; visibleUntilSeq: number | null } | null> {
    const row = await this.db.prepare(
      `SELECT visible_from_seq, visible_to_seq FROM room_seats
       WHERE room_id = ? AND coo_id = ?
       ORDER BY visible_from_seq DESC, joined_at DESC, id DESC LIMIT 1`,
    ).get(this.roomId, cooId) as { visible_from_seq: number; visible_to_seq: number | null } | undefined;
    return row ? { visibleFromSeq: row.visible_from_seq, visibleUntilSeq: row.visible_to_seq } : null;
  }
}
