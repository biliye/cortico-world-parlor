import { globalIdentityEnabled } from './global-identity.ts';
/**
 * 客厅、成员、席位与可见区间的 SQLite store。
 *
 * 这一层只回答“哪个客厅归谁、谁有成员资格、谁现在坐着、从哪条事件看到哪条事件”：
 * - 不分配事件 seq；visibleFromSeq/visibleToSeq 由调用方（世界/房间内核）传入。
 * - 不判断事件 scope；只存区间、查区间，scope 过滤仍归 RoomKernel/protocol。
 * - 一个 Coo 全局同时最多一个活跃席位：唯一索引兜底，joinSeat 先做预检给出可读错误。
 * - 成员资格长期保留；离开客厅只释放席位，不动 room_members。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withTransaction, type Db } from './db.ts';
import { isCooId } from './ledger.ts';
import { MAX_USER_ROOM_CAPACITY } from './schema.ts';
import type { SeatKind, WakeTier } from './protocol.ts';

export const MIN_ROOM_CAPACITY = 2;
/** 建厅/改容量的上限：普通客厅 30 人；大厅另由 HALL_CAPACITY 管，库级兜底 500。 */
export const MAX_ROOM_CAPACITY = MAX_USER_ROOM_CAPACITY;
export const DEFAULT_ROOM_CAPACITY = MAX_USER_ROOM_CAPACITY;
export const MAX_ROOM_NAME = 32;
export const MAX_ROOM_TOPIC = 80;
export const MAX_SEAT_NAME = 24;

export type RoomKind = 'hall' | 'room';
export type RoomVisibility = 'public' | 'unlisted' | 'private';

const ROOM_VISIBILITIES: readonly RoomVisibility[] = ['public', 'unlisted', 'private'];
const SEAT_KINDS: readonly SeatKind[] = ['pet', 'human', 'observer'];
const WAKE_TIERS: readonly WakeTier[] = ['full', 'digest', 'quiet', 'off'];
const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type RoomSeatErrorCode =
  | 'invalid'
  | 'unknown_coo'
  | 'room_not_found'
  | 'room_exists'
  | 'room_archived'
  | 'room_full'
  | 'name_taken'
  | 'already_seated'
  | 'seat_not_found';

export class RoomSeatError extends Error {
  readonly code: RoomSeatErrorCode;

  constructor(code: RoomSeatErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'RoomSeatError';
  }
}

export interface RoomRow {
  id: string;
  kind: RoomKind;
  name: string;
  ownerCooId: string | null;
  visibility: RoomVisibility;
  capacity: number;
  topic: string;
  epoch: string;
  /** 事件序号由房间内核维护；这一层不碰。 */
  seq: number;
  createdAt: number;
  lastActiveAt: number;
  archivedAt: number | null;
}

export interface MemberRow {
  roomId: string;
  cooId: string;
  joinedAt: number;
  removedAt: number | null;
}

export interface SeatRow {
  roomId: string;
  id: string;
  cooId: string;
  kind: SeatKind;
  name: string;
  tier: WakeTier;
  tokenHash: string;
  joinedAt: number;
  lastSeenAt: number | null;
  releasedAt: number | null;
  visibleFromSeq: number;
  visibleToSeq: number | null;
}

export interface SeatInterval {
  visibleFromSeq: number;
  visibleToSeq: number | null;
}

export interface CreateRoomInput {
  /** 不传就生成 `r-...`。 */
  id?: string;
  name: string;
  ownerCooId: string;
  visibility?: RoomVisibility;
  capacity?: number;
  topic?: string;
}

export interface ListRoomsOptions {
  /** 默认只列普通客厅（kind = 'room'）；大厅不是目录条目。 */
  kind?: RoomKind;
  visibility?: RoomVisibility;
  includeArchived?: boolean;
}

export interface JoinSeatInput {
  roomId: string;
  cooId: string;
  name: string;
  /** 明文令牌；库里只存 SHA-256。 */
  token: string;
  visibleFromSeq: number;
  kind?: SeatKind;
  tier?: WakeTier;
  now?: number;
}

export interface SwitchSeatInput {
  fromRoomId: string;
  fromSeatId: string;
  /** 源席位可见区间的终点：通常是换房事务里那条事件之后的下一个 seq。 */
  visibleToSeq: number;
  to: JoinSeatInput;
  now?: number;
}

export interface SwitchSeatResult {
  released: SeatRow;
  seat: SeatRow;
}

interface RoomDbRow {
  id: string;
  kind: RoomKind;
  name: string;
  owner_coo_id: string | null;
  visibility: RoomVisibility;
  capacity: number;
  topic: string | null;
  epoch: string;
  seq: number;
  created_at: number;
  last_active_at: number;
  archived_at: number | null;
}

interface MemberDbRow {
  room_id: string;
  coo_id: string;
  joined_at: number;
  removed_at: number | null;
}

interface SeatDbRow {
  room_id: string;
  id: string;
  coo_id: string;
  kind: SeatKind;
  name: string;
  tier: WakeTier;
  token_hash: string;
  joined_at: number;
  last_seen_at: number | null;
  released_at: number | null;
  visible_from_seq: number;
  visible_to_seq: number | null;
}

const ROOM_COLUMNS = `SELECT id, kind, name, owner_coo_id, visibility, capacity, topic, epoch, seq,
  created_at, last_active_at, archived_at FROM rooms`;

const SEAT_COLUMNS = `SELECT room_id, id, coo_id, kind, name, tier, token_hash, joined_at,
  last_seen_at, released_at, visible_from_seq, visible_to_seq FROM room_seats`;

const toRoom = (row: RoomDbRow): RoomRow => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  ownerCooId: row.owner_coo_id,
  visibility: row.visibility,
  capacity: row.capacity,
  topic: row.topic ?? '',
  epoch: row.epoch,
  seq: row.seq,
  createdAt: row.created_at,
  lastActiveAt: row.last_active_at,
  archivedAt: row.archived_at,
});

const toMember = (row: MemberDbRow): MemberRow => ({
  roomId: row.room_id,
  cooId: row.coo_id,
  joinedAt: row.joined_at,
  removedAt: row.removed_at,
});

const toSeat = (row: SeatDbRow): SeatRow => ({
  roomId: row.room_id,
  id: row.id,
  cooId: row.coo_id,
  kind: row.kind,
  name: row.name,
  tier: row.tier,
  tokenHash: row.token_hash,
  joinedAt: row.joined_at,
  lastSeenAt: row.last_seen_at,
  releasedAt: row.released_at,
  visibleFromSeq: row.visible_from_seq,
  visibleToSeq: row.visible_to_seq,
});

const isVisibility = (value: unknown): value is RoomVisibility => (
  typeof value === 'string' && (ROOM_VISIBILITIES as readonly string[]).includes(value)
);

const isSeatKind = (value: unknown): value is SeatKind => (
  typeof value === 'string' && (SEAT_KINDS as readonly string[]).includes(value)
);

const isWakeTier = (value: unknown): value is WakeTier => (
  typeof value === 'string' && (WAKE_TIERS as readonly string[]).includes(value)
);

const cleanRoomName = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (text.length < 2 || text.length > MAX_ROOM_NAME) {
    throw new RoomSeatError('invalid', `客厅名字要 2–${MAX_ROOM_NAME} 个字`);
  }
  return text;
};

const cleanTopic = (value: unknown): string => (
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, MAX_ROOM_TOPIC) : ''
);

const cleanCapacity = (value: unknown): number => {
  const capacity = value === undefined ? DEFAULT_ROOM_CAPACITY : value;
  if (!Number.isInteger(capacity) || (capacity as number) < MIN_ROOM_CAPACITY || (capacity as number) > MAX_ROOM_CAPACITY) {
    throw new RoomSeatError('invalid', `席位上限要在 ${MIN_ROOM_CAPACITY}–${MAX_ROOM_CAPACITY} 之间`);
  }
  // 兼容旧客户端的 2–30 参数，最终统一为 30 席。
  return DEFAULT_ROOM_CAPACITY;
};

const cleanRoomId = (value: unknown): string => {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!ROOM_ID.test(id)) throw new RoomSeatError('invalid', '客厅 id 只能用字母、数字、下划线、连字符，最多 64 个字');
  return id;
};

const cleanSeatName = (value: unknown): string => {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, MAX_SEAT_NAME) : '';
  if (!name) throw new RoomSeatError('invalid', '席位名字不能为空');
  return name;
};

const cleanSeq = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RoomSeatError('invalid', `${label} 要是 0 或正整数`);
  }
  return value as number;
};

const makeRoomId = (): string => `r-${randomBytes(6).toString('base64url')}`;
const makeSeatId = (): string => `s-${randomBytes(6).toString('base64url')}`;

/** 令牌只以 SHA-256 十六进制入库；明文的保存与轮换归调用方。 */
export const hashSeatToken = (token: string): string => {
  if (typeof token !== 'string' || token.length === 0) {
    throw new RoomSeatError('invalid', '席位令牌不能为空');
  }
  return createHash('sha256').update(token).digest('hex');
};

const requireCoo = (db: Db, cooId: string, label: string): void => {
  if (!isCooId(cooId)) throw new RoomSeatError('invalid', `${label} cooId 格式不对`);
  const found = db.prepare('SELECT 1 AS ok FROM coos WHERE id = ?').get(cooId);
  if (!found) throw new RoomSeatError('unknown_coo', `没有这个 Coo：${cooId}`);
};

const roomRow = (db: Db, id: string): RoomRow | null => {
  const row = db.prepare(`${ROOM_COLUMNS} WHERE id = ?`).get(id) as unknown as RoomDbRow | undefined;
  return row ? toRoom(row) : null;
};

const requireRoom = (db: Db, id: string): RoomRow => {
  const room = roomRow(db, id);
  if (!room) throw new RoomSeatError('room_not_found', `没有这个客厅：${id}`);
  return room;
};

const seatRow = (db: Db, roomId: string, seatId: string): SeatRow | null => {
  const row = db.prepare(`${SEAT_COLUMNS} WHERE room_id = ? AND id = ?`).get(roomId, seatId) as unknown as SeatDbRow | undefined;
  return row ? toSeat(row) : null;
};

// —— 客厅 ——

const createRoomTx = (db: Db, input: CreateRoomInput, now: number): RoomRow => {
  requireCoo(db, input.ownerCooId, '主人');
  const name = cleanRoomName(input.name);
  const visibility = input.visibility ?? 'unlisted';
  if (!isVisibility(visibility)) throw new RoomSeatError('invalid', '可见性不对');
  const capacity = cleanCapacity(input.capacity);
  const topic = cleanTopic(input.topic);

  let id: string;
  if (input.id !== undefined) {
    id = cleanRoomId(input.id);
    if (roomRow(db, id)) throw new RoomSeatError('room_exists', `客厅 id 已经存在：${id}`);
  } else {
    id = makeRoomId();
    for (let attempt = 0; attempt < 20 && roomRow(db, id); attempt += 1) id = makeRoomId();
    if (roomRow(db, id)) throw new RoomSeatError('invalid', '客厅 id 生成失败，换一个');
  }

  db.prepare(
    `INSERT INTO rooms(id, kind, name, owner_coo_id, visibility, capacity, topic, epoch, seq, created_at, last_active_at)
     VALUES (?, 'room', ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(id, name, input.ownerCooId, visibility, capacity, topic || null, randomUUID(), now, now);

  return requireRoom(db, id);
};

/** 建一个普通客厅（kind = 'room'）。固定 30 席；兼容旧客户端的 2–30 参数。 */
export const createRoom = (db: Db, input: CreateRoomInput, now = Date.now()): RoomRow => (
  withTransaction(db, () => createRoomTx(db, input, now))
);

export const getRoom = (db: Db, id: string): RoomRow | null => roomRow(db, id);

/** id 优先，其次大小写不敏感的名字；同名时优先未归档、最近活跃的。 */
export const resolveRoom = (db: Db, value: string): RoomRow | null => {
  const needle = typeof value === 'string' ? value.trim() : '';
  if (!needle) return null;
  const byId = roomRow(db, needle);
  if (byId) return byId;
  const row = db.prepare(
    `${ROOM_COLUMNS} WHERE name = ? COLLATE NOCASE
     ORDER BY archived_at IS NOT NULL, last_active_at DESC, created_at DESC, id ASC LIMIT 1`,
  ).get(needle) as unknown as RoomDbRow | undefined;
  return row ? toRoom(row) : null;
};

export const listRooms = (db: Db, options: ListRoomsOptions = {}): RoomRow[] => {
  const where: string[] = ['kind = ?'];
  const params: Array<string | number> = [options.kind ?? 'room'];
  if (!options.includeArchived) where.push('archived_at IS NULL');
  if (options.visibility !== undefined) {
    if (!isVisibility(options.visibility)) throw new RoomSeatError('invalid', '可见性不对');
    where.push('visibility = ?');
    params.push(options.visibility);
  }
  const rows = db.prepare(
    `${ROOM_COLUMNS} WHERE ${where.join(' AND ')}
     ORDER BY last_active_at DESC, created_at DESC, id ASC`,
  ).all(...params) as unknown as RoomDbRow[];
  return rows.map(toRoom);
};

const touchRoomTx = (db: Db, id: string, now: number): boolean => {
  const result = db.prepare('UPDATE rooms SET last_active_at = ? WHERE id = ?').run(now, id);
  return Number(result.changes) > 0;
};

export const touch = (db: Db, id: string, now = Date.now()): boolean => withTransaction(db, () => touchRoomTx(db, id, now));

const archiveRoomTx = (db: Db, id: string, now: number): RoomRow | null => {
  db.prepare('UPDATE rooms SET archived_at = COALESCE(archived_at, ?) WHERE id = ?').run(now, id);
  return roomRow(db, id);
};

/** 归档幂等：已经归档时保留第一次的 archived_at。 */
export const archive = (db: Db, id: string, now = Date.now()): RoomRow | null => (
  withTransaction(db, () => archiveRoomTx(db, id, now))
);

const unarchiveRoomTx = (db: Db, id: string, now: number): RoomRow | null => {
  db.prepare('UPDATE rooms SET archived_at = NULL, last_active_at = ? WHERE id = ? AND archived_at IS NOT NULL').run(now, id);
  return roomRow(db, id);
};

export const unarchive = (db: Db, id: string, now = Date.now()): RoomRow | null => (
  withTransaction(db, () => unarchiveRoomTx(db, id, now))
);

// —— 成员 ——

const memberRow = (db: Db, roomId: string, cooId: string): MemberRow | null => {
  const row = db.prepare(
    'SELECT room_id, coo_id, joined_at, removed_at FROM room_members WHERE room_id = ? AND coo_id = ?',
  ).get(roomId, cooId) as unknown as MemberDbRow | undefined;
  return row ? toMember(row) : null;
};

const upsertMemberTx = (db: Db, roomId: string, cooId: string, now: number): MemberRow => {
  requireRoom(db, roomId);
  requireCoo(db, cooId, '成员');
  const existing = memberRow(db, roomId, cooId);
  if (existing) {
    if (existing.removedAt !== null) {
      db.prepare('UPDATE room_members SET joined_at = ?, removed_at = NULL WHERE room_id = ? AND coo_id = ?')
        .run(now, roomId, cooId);
    }
    return memberRow(db, roomId, cooId)!;
  }
  db.prepare('INSERT INTO room_members(room_id, coo_id, joined_at) VALUES (?, ?, ?)').run(roomId, cooId, now);
  return memberRow(db, roomId, cooId)!;
};

/** 加入/恢复成员资格；已在的成员不动 joined_at。 */
export const upsertMember = (db: Db, roomId: string, cooId: string, now = Date.now()): MemberRow => (
  withTransaction(db, () => upsertMemberTx(db, roomId, cooId, now))
);

/** 当前有效的成员资格；被移除过就是 null（记录仍在库里，upsertMember 可恢复）。 */
export const memberOf = (db: Db, roomId: string, cooId: string): MemberRow | null => {
  const row = memberRow(db, roomId, cooId);
  return row && row.removedAt === null ? row : null;
};

/** 当前成员，按加入时间排序。 */
export const membersOf = (db: Db, roomId: string): MemberRow[] => {
  const rows = db.prepare(
    'SELECT room_id, coo_id, joined_at, removed_at FROM room_members WHERE room_id = ? AND removed_at IS NULL ORDER BY joined_at ASC, coo_id ASC',
  ).all(roomId) as unknown as MemberDbRow[];
  return rows.map(toMember);
};

// —— 席位 ——

const activeSeatRow = (db: Db, cooId: string): SeatRow | null => {
  const row = db.prepare(`${SEAT_COLUMNS} WHERE coo_id = ? AND released_at IS NULL`).get(cooId) as unknown as SeatDbRow | undefined;
  return row ? toSeat(row) : null;
};

const countSeatedTx = (db: Db, roomId: string): number => {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM room_seats WHERE room_id = ? AND released_at IS NULL AND kind <> 'observer'",
  ).get(roomId) as unknown as { n: number };
  return row.n;
};

const activeNameTaken = (db: Db, roomId: string, name: string): boolean => (
  !!db.prepare(
    'SELECT 1 AS ok FROM room_seats WHERE room_id = ? AND released_at IS NULL AND name = ? COLLATE NOCASE',
  ).get(roomId, name)
);

/** 自动加序号的上限：正常客厅远到不了，纯粹防死循环。 */
const MAX_NAME_SUFFIX = 50;

/** 截到 24 字以内再接「 2」「 3」；按码位截，别把 emoji 劈成半个。 */
const suffixedSeatName = (base: string, index: number): string => {
  const suffix = ` ${index}`;
  const keep = Math.max(1, MAX_SEAT_NAME - suffix.length);
  return Array.from(base).slice(0, keep).join('') + suffix;
};

/**
 * Coo 的席位名来自 bot 显示名/配置，撞名时自动加序号，别让它整个启动失败；
 * 真人/观看者仍然报 name_taken，让网页用户自己换一个。
 */
const resolveJoinName = (db: Db, roomId: string, kind: SeatKind, base: string): string => {
  if (globalIdentityEnabled(db) || !activeNameTaken(db, roomId, base)) return base;
  if (kind !== 'pet') throw new RoomSeatError('name_taken', `已经有叫「${base}」的活跃席位`);
  for (let index = 2; index <= MAX_NAME_SUFFIX + 1; index += 1) {
    const candidate = suffixedSeatName(base, index);
    if (!activeNameTaken(db, roomId, candidate)) return candidate;
  }
  throw new RoomSeatError('name_taken', `已经有叫「${base}」的活跃席位，自动编号也排满了`);
};

const setPresenceTx = (db: Db, cooId: string, roomId: string, seatId: string, now: number): void => {
  db.prepare(
    `INSERT INTO coo_sessions(coo_id, session_version, current_room_id, current_seat_id, created_at, last_seen_at)
     VALUES (?, 1, ?, ?, ?, ?)
     ON CONFLICT(coo_id) DO UPDATE SET
       current_room_id = excluded.current_room_id,
       current_seat_id = excluded.current_seat_id,
       last_seen_at = excluded.last_seen_at`,
  ).run(cooId, roomId, seatId, now, now);
};

const clearPresenceTx = (db: Db, cooId: string, roomId: string, seatId: string): void => {
  db.prepare(
    `UPDATE coo_sessions SET current_room_id = NULL, current_seat_id = NULL
     WHERE coo_id = ? AND current_room_id = ? AND current_seat_id = ?`,
  ).run(cooId, roomId, seatId);
};

const joinSeatTx = (db: Db, input: JoinSeatInput, now: number): SeatRow => {
  const room = requireRoom(db, input.roomId);
  if (room.archivedAt !== null) throw new RoomSeatError('room_archived', '客厅已经归档，不能再进');
  requireCoo(db, input.cooId, '席位');
  const name = cleanSeatName(input.name);
  const kind = input.kind ?? 'pet';
  if (!isSeatKind(kind)) throw new RoomSeatError('invalid', '席位类型不对');
  const tier = input.tier ?? 'digest';
  if (!isWakeTier(tier)) throw new RoomSeatError('invalid', '提醒挡位不对');
  const visibleFromSeq = cleanSeq(input.visibleFromSeq, 'visibleFromSeq');
  const tokenHash = hashSeatToken(input.token);

  const current = activeSeatRow(db, input.cooId);
  if (current) {
    throw new RoomSeatError('already_seated', `这个 Coo 已经在 ${current.roomId}/${current.id} 坐着，先释放席位`);
  }
  const seatName = resolveJoinName(db, room.id, kind, name);
  if (kind !== 'observer' && countSeatedTx(db, room.id) >= room.capacity) {
    throw new RoomSeatError('room_full', `客厅最多 ${room.capacity} 个会说话的席位`);
  }
  if (db.prepare('SELECT 1 AS ok FROM room_seats WHERE token_hash = ?').get(tokenHash)) {
    throw new RoomSeatError('invalid', '这个席位令牌已经用过，换一个');
  }

  let seatId = makeSeatId();
  for (let attempt = 0; attempt < 20 && seatRow(db, room.id, seatId); attempt += 1) seatId = makeSeatId();

  try {
    db.prepare(
      `INSERT INTO room_seats(room_id, id, coo_id, kind, name, tier, token_hash, joined_at, last_seen_at, visible_from_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(room.id, seatId, input.cooId, kind, seatName, tier, tokenHash, now, now, visibleFromSeq);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('room_full')) throw new RoomSeatError('room_full', `客厅最多 ${room.capacity} 个会说话的席位`);
    if (message.includes('room_seats.coo_id')) throw new RoomSeatError('already_seated', '这个 Coo 已经有一个活跃席位');
    if (message.includes('room_seats.room_id, room_seats.name')) throw new RoomSeatError('name_taken', `已经有叫「${seatName}」的活跃席位`);
    if (message.includes('room_seats.token_hash')) throw new RoomSeatError('invalid', '这个席位令牌已经用过，换一个');
    throw error;
  }

  upsertMemberTx(db, room.id, input.cooId, now);
  setPresenceTx(db, input.cooId, room.id, seatId, now);
  return seatRow(db, room.id, seatId)!;
};

/**
 * 进客厅：容量只看活跃非 observer 席位；同名活跃席位拒绝；
 * 一个 Coo 已有活跃席位时拒绝（换房用 switchSeat，或调用方自己 release + join 包一层 withTransaction）。
 */
export const joinSeat = (db: Db, input: JoinSeatInput): SeatRow => {
  const now = input.now ?? Date.now();
  return withTransaction(db, () => joinSeatTx(db, input, now));
};

const releaseSeatTx = (db: Db, roomId: string, seatId: string, visibleToSeq: number, now: number): SeatRow | null => {
  const seat = seatRow(db, roomId, seatId);
  if (!seat) return null;
  if (seat.releasedAt !== null) return seat;
  const until = cleanSeq(visibleToSeq, 'visibleToSeq');
  if (until < seat.visibleFromSeq) {
    throw new RoomSeatError('invalid', `visibleToSeq（${until}）不能小于 visibleFromSeq（${seat.visibleFromSeq}）`);
  }
  db.prepare('UPDATE room_seats SET released_at = ?, visible_to_seq = ? WHERE room_id = ? AND id = ? AND released_at IS NULL')
    .run(now, until, roomId, seatId);
  clearPresenceTx(db, seat.cooId, roomId, seatId);
  return seatRow(db, roomId, seatId);
};

/**
 * 离开客厅：只封口可见区间、释放席位；成员资格保留。
 * 已经释放的席位原样返回，不改第一次的 released_at/visible_to_seq。
 */
export const releaseSeat = (
  db: Db,
  roomId: string,
  seatId: string,
  visibleToSeq: number,
  now = Date.now(),
): SeatRow | null => withTransaction(db, () => releaseSeatTx(db, roomId, seatId, visibleToSeq, now));

const switchSeatTx = (db: Db, input: SwitchSeatInput, now: number): SwitchSeatResult => {
  const source = seatRow(db, input.fromRoomId, input.fromSeatId);
  if (!source) throw new RoomSeatError('seat_not_found', `没有这个源席位：${input.fromRoomId}/${input.fromSeatId}`);
  if (source.releasedAt !== null) throw new RoomSeatError('invalid', '源席位已经释放，不是换房');
  if (source.cooId !== input.to.cooId) throw new RoomSeatError('invalid', '只能换自己的席位');
  const released = releaseSeatTx(db, input.fromRoomId, input.fromSeatId, input.visibleToSeq, now);
  if (!released) throw new RoomSeatError('seat_not_found', `没有这个源席位：${input.fromRoomId}/${input.fromSeatId}`);
  const seat = joinSeatTx(db, { ...input.to, now }, now);
  return { released, seat };
};

/**
 * 换房：释放源席位 + 在目标客厅拿新席位，一个事务。
 * 目标满、重名、额度不够都会让源席位一起回滚，不会出现“两头都不在”的中间态。
 * 如果调用方需要同时写事件/账本，把 releaseSeat + joinSeat 自己包进 withTransaction 也可以。
 */
export const switchSeat = (db: Db, input: SwitchSeatInput): SwitchSeatResult => {
  const now = input.now ?? input.to.now ?? Date.now();
  return withTransaction(db, () => switchSeatTx(db, input, now));
};

/** 这个 Coo 现在坐着的唯一活跃席位。 */
export const activeSeatForCoo = (db: Db, cooId: string): SeatRow | null => activeSeatRow(db, cooId);

/** 客厅里所有活跃席位（含 observer），按进厅时间排序。容量请用非 observer 计数。 */
export const activeSeats = (db: Db, roomId: string): SeatRow[] => {
  const rows = db.prepare(
    `${SEAT_COLUMNS} WHERE room_id = ? AND released_at IS NULL ORDER BY joined_at ASC, id ASC`,
  ).all(roomId) as unknown as SeatDbRow[];
  return rows.map(toSeat);
};

/** 离线清理的候选：按席位类型取；pet 是 Coo，human 是网页真人，observer 不清理。 */
export interface OfflineSeatCandidate {
  roomId: string;
  id: string;
  cooId: string;
  name: string;
  lastSeenAt: number;
}

export const seatsForOfflineRelease = (db: Db, kind: 'human' | 'pet'): OfflineSeatCandidate[] => {
  const rows = db.prepare(
    `SELECT room_id, id, coo_id, name, COALESCE(last_seen_at, joined_at) AS last_seen_at
       FROM room_seats
      WHERE released_at IS NULL AND kind = ?`,
  ).all(kind) as unknown as {
    room_id: string; id: string; coo_id: string; name: string; last_seen_at: number;
  }[];
  return rows.map((row) => ({
    roomId: row.room_id,
    id: row.id,
    cooId: row.coo_id,
    name: row.name,
    lastSeenAt: Number(row.last_seen_at),
  }));
};

/** SSE 连上/断开时刷新；离线清理用它判断多久没见。 */
export const touchSeatSeen = (db: Db, roomId: string, seatId: string, now = Date.now()): void => {
  db.prepare(
    'UPDATE room_seats SET last_seen_at = ? WHERE room_id = ? AND id = ? AND released_at IS NULL',
  ).run(now, roomId, seatId);
};

/** 只认活跃席位；释放后的令牌不能再用来行动。 */
export const seatByTokenHash = (db: Db, tokenHash: string): SeatRow | null => {
  if (typeof tokenHash !== 'string' || !tokenHash) return null;
  const row = db.prepare(`${SEAT_COLUMNS} WHERE token_hash = ? AND released_at IS NULL`)
    .get(tokenHash) as unknown as SeatDbRow | undefined;
  return row ? toSeat(row) : null;
};

/** 给同一个席位换一枚新令牌（家长在同一间客厅再次下场时用）；旧令牌立即失效。 */
export const updateSeatToken = (db: Db, roomId: string, seatId: string, tokenHash: string): void => {
  db.prepare('UPDATE room_seats SET token_hash = ? WHERE room_id = ? AND id = ?')
    .run(tokenHash, roomId, seatId);
};

/** 改席位名；同厅已有同名活跃席位时 name_taken（改成自己原来的名字不算冲突）。 */
export const renameSeat = (db: Db, roomId: string, seatId: string, name: string): SeatRow => {
  const clean = cleanSeatName(name);
  return withTransaction(db, () => {
    const seat = seatRow(db, roomId, seatId);
    if (!seat || seat.releasedAt !== null) throw new RoomSeatError('seat_not_found', '席位不存在或已经离开');
    if (!globalIdentityEnabled(db) && seat.name.toLowerCase() !== clean.toLowerCase() && activeNameTaken(db, roomId, clean)) {
      throw new RoomSeatError('name_taken', `已经有叫「${clean}」的活跃席位`);
    }
    try {
      db.prepare('UPDATE room_seats SET name = ? WHERE room_id = ? AND id = ?').run(clean, roomId, seatId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('room_seats.room_id, room_seats.name')) {
        throw new RoomSeatError('name_taken', `已经有叫「${clean}」的活跃席位`);
      }
      throw error;
    }
    return seatRow(db, roomId, seatId)!;
  });
};

/** 可见区间查询；scope 过滤不在这里做。席位不存在返回 null。 */
export const seatInterval = (db: Db, roomId: string, seatId: string): SeatInterval | null => {
  const row = db.prepare(
    'SELECT visible_from_seq, visible_to_seq FROM room_seats WHERE room_id = ? AND id = ?',
  ).get(roomId, seatId) as unknown as { visible_from_seq: number; visible_to_seq: number | null } | undefined;
  return row ? { visibleFromSeq: row.visible_from_seq, visibleToSeq: row.visible_to_seq } : null;
};
