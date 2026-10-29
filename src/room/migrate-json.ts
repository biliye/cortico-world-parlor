/**
 * 旧单客厅 JSON → 多客厅 SQLite 的一次性迁移。
 *
 * 读 `room.json` / `ledger.json` / `mail.json` / `replay.jsonl` / `activity.json`，
 * 写一个新库。规则：
 * - 只迁到空库；不覆盖、不双写、不自动回退。
 * - 席位令牌/家长令牌只存哈希，明文不落库；旧的席位 ID、事件 seq、事件时刻原样保留。
 * - 历史可见性：现有席位从 seq 0 起可见（他们本来就在房间里）；同 cooId 的重复席位
 *   只保留最新的一个，旧的封口到迁移前最后一条事件。
 * - 事件受众按「席位 → cooId」重建；找不到 coo 的（脚本陪练）不写受众。
 * - 账本按原 id/ts/ref/effectId 导入；ref 指向被旧版 5000 条上限截掉的条目时置空并记警告。
 * - 信箱逐封已读；老文件的全局已读游标只用于补 `read_at`。
 * - 大富翁：有未结束的一局时默认拒绝迁移（等它打完）；`abandonMonopoly` 才作废并留档。
 *
 * 全部导入在一个事务里；核对（余额、未读、席位令牌）不过就回滚。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { migrate, openDb, withTransaction, type Db } from './db.ts';
import { hashSeatToken } from './room-seat-db.ts';

export interface LegacyRoomSeat {
  id: string;
  name: string;
  kind: 'pet' | 'human' | 'observer';
  tier: 'full' | 'digest' | 'quiet' | 'off';
  joinedAt: number;
  token: string;
  ownerToken: string;
  cooId?: string;
}

export interface LegacyRoom {
  version: 1;
  id: string;
  maxSeats: number;
  seq: number;
  seatSeq: number;
  seats: LegacyRoomSeat[];
  events: LegacyEvent[];
  epoch?: string;
}

export interface LegacyEvent {
  seq: number;
  ts: number;
  type: string;
  from: string;
  scope: Record<string, unknown>;
  text: string;
  mentions?: string[];
  data?: Record<string, unknown>;
}

interface LegacyTransfer {
  from: string;
  to: string;
  amount: number;
}

interface LegacyLedgerEntry {
  id: string;
  ts: number;
  room: string;
  kind: string;
  from: string;
  to?: string;
  participants?: string[];
  winners?: string[];
  text: string;
  visibility: 'room' | 'private';
  data?: Record<string, unknown>;
  game?: string;
  ref?: string;
  due?: number;
  transfers?: LegacyTransfer[];
  effectId?: string;
}

interface LegacyLedger {
  version: 1;
  identities: Record<string, { secretHash: string; createdAt: number }>;
  entries: LegacyLedgerEntry[];
}

interface LegacyMailItem {
  id: string;
  seq: number;
  ts: number;
  room: string;
  to: string;
  kind: string;
  action?: string;
  fromName: string;
  text: string;
  entryId?: string;
  key?: string;
  read?: boolean;
}

interface LegacyMail {
  version: 1;
  seq: number;
  read?: Record<string, number>;
  items: LegacyMailItem[];
}

interface LegacyActivity {
  version?: number;
  roomId?: string;
  roomEpoch?: string;
  gameId?: string;
  savedAt?: number;
  table?: { status?: string; host?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface MigrationOptions {
  /** 旧数据目录；文件缺失按空处理（例如只有 room.json）。 */
  dataDir: string;
  /** 目标 SQLite 文件；`:memory:` 只用于演练。 */
  dbFile: string;
  /** 客厅 id；默认用 room.json 的 id。 */
  roomId?: string;
  roomName?: string;
  /** 大富翁还有未结束的一局时是否作废（默认拒绝）。 */
  abandonMonopoly?: boolean;
  now?: () => number;
}

export interface MigrationCheck {
  name: string;
  old: number;
  now: number;
  match: boolean;
}

export interface MigrationReport {
  roomId: string;
  dryRun: boolean;
  counts: {
    coos: number; seats: number; releasedSeats: number; events: number;
    ledgerEntries: number; mail: number; audience: number;
  };
  balances: MigrationCheck[];
  unread: MigrationCheck[];
  tokenChecks: Array<{ seat: string; ok: boolean }>;
  warnings: string[];
}

const ROOM_FILE = 'room.json';
const LEDGER_FILE = 'ledger.json';
const MAIL_FILE = 'mail.json';
const REPLAY_FILE = 'replay.jsonl';
const ACTIVITY_FILE = 'activity.json';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const readJson = <T>(file: string): T | null => {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (error) {
    throw new Error(`读不出来：${file}（${error instanceof Error ? error.message : String(error)}）`);
  }
};

const readJsonl = (file: string): LegacyEvent[] => {
  if (!existsSync(file)) return [];
  const events: LegacyEvent[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as LegacyEvent;
      if (parsed && typeof parsed.seq === 'number' && typeof parsed.text === 'string') events.push(parsed);
    } catch { /* 坏行跳过；迁移后核对事件数会写进警告 */ }
  }
  return events;
};

const fileHash = (file: string): string => (
  existsSync(file) ? sha256(readFileSync(file, 'utf8')) : ''
);

const sourceHashes = (dir: string): Record<string, string> => ({
  [ROOM_FILE]: fileHash(join(dir, ROOM_FILE)),
  [LEDGER_FILE]: fileHash(join(dir, LEDGER_FILE)),
  [MAIL_FILE]: fileHash(join(dir, MAIL_FILE)),
  [REPLAY_FILE]: fileHash(join(dir, REPLAY_FILE)),
  [ACTIVITY_FILE]: fileHash(join(dir, ACTIVITY_FILE)),
});

const isCoo = (value: unknown): value is string => (
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
);

/** 老文件里没绑身份的席位也给一个稳定的占位 cooId；不会跟真身份撞。 */
const legacyCooId = (roomId: string, seatId: string): string => {
  const raw = `legacy-${roomId}-${seatId}`;
  return raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
};

/** 旧版给没绑身份的席位用的是 `legacy:<room>:<seat>`；换成合法、稳定的占位 cooId。 */
const normalizeCoo = (value: unknown, roomId: string): string => {
  if (typeof value !== 'string' || !value || value === 'room') return '';
  const legacy = /^legacy:([^:]+):(.+)$/.exec(value);
  if (legacy) return legacyCooId(legacy[1], legacy[2]);
  return isCoo(value) ? value : '';
};

const oldBalance = (entries: LegacyLedgerEntry[], cooId: string): number => {
  let total = 0;
  for (const entry of entries) {
    for (const transfer of entry.transfers ?? []) {
      if (transfer.to === cooId) total += transfer.amount;
      if (transfer.from === cooId) total -= transfer.amount;
    }
  }
  return total;
};

const oldUnread = (mail: LegacyMail | null, cooId: string): number => {
  if (!mail) return 0;
  const cursor = mail.read?.[cooId] ?? 0;
  return (mail.items ?? []).filter((item) => item.to === cooId && item.read !== true && item.seq > cursor).length;
};

const ensureCoo = (db: Db, cooId: string, kind: string, name: string, secretHash: string | null, now: number): void => {
  db.prepare(
    `INSERT OR IGNORE INTO coos(id, kind, display_name, secret_hash, created_at, last_seen_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'active')`,
  ).run(cooId, kind === 'system' ? 'system' : kind === 'human' ? 'human' : kind === 'legacy' ? 'legacy' : 'pet',
    name, secretHash, now, now);
};

const scopeColumns = (scope: Record<string, unknown>): {
  kind: string; seatId: string | null; tableId: string | null; seats: string[];
} => {
  const kind = typeof scope.kind === 'string' ? scope.kind : 'room';
  if (kind === 'seat' && typeof scope.seatId === 'string') {
    return { kind, seatId: scope.seatId, tableId: null, seats: [] };
  }
  if (kind === 'table' && typeof scope.tableId === 'string') {
    const seats = Array.isArray(scope.seats)
      ? scope.seats.filter((id): id is string => typeof id === 'string')
      : [];
    return { kind, seatId: null, tableId: scope.tableId, seats };
  }
  return { kind: kind === 'hall' ? 'hall' : 'room', seatId: null, tableId: null, seats: [] };
};

/**
 * 跑一次迁移。成功返回核对报告；任何核对不过都会抛错并回滚。
 * 目标库已经有数据时拒绝执行（迁移不是合并）。
 */
export function migrateLegacyJson(options: MigrationOptions): MigrationReport {
  const now = options.now ?? Date.now;
  const dryRun = options.dbFile === ':memory:';
  const warnings: string[] = [];

  const roomFile = join(options.dataDir, ROOM_FILE);
  const room = readJson<LegacyRoom>(roomFile);
  if (!room || !Array.isArray(room.seats) || !Array.isArray(room.events)) {
    throw new Error(`没有可迁移的 ${ROOM_FILE}（或格式不对）：${roomFile}`);
  }
  const roomId = options.roomId ?? room.id;
  if (!roomId) throw new Error('room.json 缺 id；用 roomId 指定');
  const roomName = options.roomName ?? '默认客厅';
  const ledger = readJson<LegacyLedger>(join(options.dataDir, LEDGER_FILE));
  const mail = readJson<LegacyMail>(join(options.dataDir, MAIL_FILE));
  const replay = readJsonl(join(options.dataDir, REPLAY_FILE));
  const activity = readJson<LegacyActivity>(join(options.dataDir, ACTIVITY_FILE));

  if (activity && activity.table && activity.table.status && activity.table.status !== 'ended') {
    if (!options.abandonMonopoly) {
      throw new Error(
        `activity.json 里还有一局没结束的大富翁（${activity.table.status}）；`
        + '等它打完再迁移，或加 --abandon-monopoly 把它作废留档。',
      );
    }
    warnings.push('大富翁未结束：按 --abandon-monopoly 作废，存档留在 tables.state_json。');
  }

  const db = openDb(options.dbFile);
  migrate(db);
  const startedAt = now();
  const counts = { coos: 0, seats: 0, releasedSeats: 0, events: 0, ledgerEntries: 0, mail: 0, audience: 0 };
  const report: MigrationReport = {
    roomId: roomId,
    dryRun,
    counts,
    balances: [],
    unread: [],
    tokenChecks: [],
    warnings,
  };

  try {
    const occupied = (db.prepare('SELECT COUNT(*) AS n FROM rooms').get() as { n: number }).n
      + (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
      + (db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get() as { n: number }).n
      + (db.prepare('SELECT COUNT(*) AS n FROM mail').get() as { n: number }).n;
    if (occupied > 0) throw new Error('目标库已经有数据；迁移只写空库，不合并、不覆盖。');

    withTransaction(db, () => {
      // 1. 身份
      ensureCoo(db, 'system-owner', 'system', '系统', null, now());
      for (const [cooId, identity] of Object.entries(ledger?.identities ?? {})) {
        if (!isCoo(cooId) || typeof identity?.secretHash !== 'string') continue;
        ensureCoo(db, cooId, 'pet', '', identity.secretHash, Number(identity.createdAt) || now());
        counts.coos += 1;
      }

      // 2. 客厅
      const firstTs = room.events.length > 0 ? room.events[0].ts : now();
      const lastTs = room.events.length > 0 ? room.events[room.events.length - 1].ts : now();
      db.prepare(
        `INSERT INTO rooms(id, kind, name, owner_coo_id, visibility, capacity, topic, epoch, seq,
           created_at, last_active_at)
         VALUES (?, 'room', ?, 'system-owner', 'unlisted', ?, ?, ?, ?, ?, ?)`,
      ).run(
        roomId,
        roomName,
        Math.min(64, Math.max(2, Number(room.maxSeats) || 8)),
        '从旧单客厅迁移过来的房间。',
        typeof room.epoch === 'string' && room.epoch ? room.epoch : sha256(`${roomId}:${firstTs}`),
        Math.max(0, Number(room.seq) || 0),
        Number(firstTs) || now(),
        Number(lastTs) || now(),
      );

      // 3. 席位：同 cooId 只留最新的活跃席位，旧的封口到迁移前最后一条事件。
      const seatCoo = new Map<string, string>();
      const byCoo = new Map<string, LegacyRoomSeat[]>();
      for (const seat of room.seats) {
        const cooId = normalizeCoo(seat.cooId, roomId) || legacyCooId(roomId, seat.id);
        seatCoo.set(seat.id, cooId);
        if (!byCoo.has(cooId)) byCoo.set(cooId, []);
        byCoo.get(cooId)!.push(seat);
      }
      const lastSeq = Math.max(0, ...room.events.map((event) => event.seq), Number(room.seq) || 0);
      for (const [cooId, seats] of byCoo) {
        const sorted = [...seats].sort((left, right) => (right.joinedAt || 0) - (left.joinedAt || 0));
        const keep = sorted[0];
        ensureCoo(db, cooId, keep.kind, keep.name, ledger?.identities[cooId]?.secretHash ?? null, keep.joinedAt || now());
        let position = 0;
        for (const seat of sorted) {
          const active = seat === keep;
          db.prepare(
            `INSERT INTO room_seats(room_id, id, coo_id, kind, name, tier, token_hash,
               legacy_owner_token_hash, joined_at, last_seen_at, released_at, visible_from_seq, visible_to_seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?)`,
          ).run(
            roomId,
            seat.id,
            cooId,
            seat.kind === 'human' || seat.kind === 'observer' ? seat.kind : 'pet',
            seat.name,
            seat.tier || 'digest',
            hashSeatToken(seat.token),
            seat.ownerToken ? sha256(seat.ownerToken) : null,
            Number(seat.joinedAt) || now(),
            active ? null : now(),
            active ? null : lastSeq,
          );
          db.prepare(
            `INSERT OR IGNORE INTO room_members(room_id, coo_id, joined_at) VALUES (?, ?, ?)`,
          ).run(roomId, cooId, Number(seat.joinedAt) || now());
          counts.seats += 1;
          if (!active) counts.releasedSeats += 1;
          position += 1;
        }
        const current = db.prepare(
          `INSERT INTO coo_sessions(coo_id, session_version, current_room_id, current_seat_id, created_at, last_seen_at)
           VALUES (?, 1, ?, ?, ?, ?)
           ON CONFLICT(coo_id) DO UPDATE SET current_room_id = excluded.current_room_id,
             current_seat_id = excluded.current_seat_id, last_seen_at = excluded.last_seen_at`,
        );
        current.run(cooId, roomId, keep.id, Number(keep.joinedAt) || now(), now());
        if (sorted.length > 1) {
          warnings.push(`席位 ${keep.name}（${cooId}）有 ${sorted.length} 条旧席位；保留 ${keep.id}，其余封口。`);
        }
      }

      // 4. 事件：room.json + replay.jsonl，按 seq 去重后按原序号写入。
      const merged = new Map<number, LegacyEvent>();
      for (const event of [...replay, ...room.events]) {
        if (event && Number.isFinite(event.seq) && !merged.has(event.seq)) merged.set(event.seq, event);
      }
      const insertEvent = db.prepare(
        `INSERT INTO events(room_id, seq, ts, type, from_kind, from_id, scope_kind, scope_seat_id,
           scope_table_id, scope_seats_json, text, mentions_json, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertAudience = db.prepare(
        'INSERT OR IGNORE INTO event_audience(room_id, seq, coo_id, seat_id) VALUES (?, ?, ?, ?)',
      );
      for (const event of [...merged.values()].sort((left, right) => left.seq - right.seq)) {
        const scope = scopeColumns(event.scope ?? {});
        insertEvent.run(
          roomId,
          event.seq,
          Number(event.ts) || now(),
          event.type,
          event.from === 'system' ? 'system' : 'seat',
          event.from,
          scope.kind,
          scope.seatId,
          scope.tableId,
          scope.kind === 'table' ? JSON.stringify(scope.seats) : null,
          event.text,
          event.mentions && event.mentions.length > 0 ? JSON.stringify(event.mentions) : null,
          event.data === undefined ? null : JSON.stringify(event.data),
        );
        counts.events += 1;
        if (scope.kind === 'seat' && scope.seatId) {
          const cooId = seatCoo.get(scope.seatId);
          if (cooId) {
            insertAudience.run(roomId, event.seq, cooId, scope.seatId);
            counts.audience += 1;
          }
        } else if (scope.kind === 'table') {
          for (const seatId of scope.seats) {
            const cooId = seatCoo.get(seatId);
            if (!cooId) continue;
            insertAudience.run(roomId, event.seq, cooId, seatId);
            counts.audience += 1;
          }
        }
      }
      if (Number(room.seq) > lastSeq) warnings.push(`room.seq（${room.seq}）大于最后一条事件（${lastSeq}）。`);

      // 5. 账本：先写条目（ref 置空），再把能对上的 ref 补回去，避免被旧版截断的引用炸外键。
      const entries = [...(ledger?.entries ?? [])].sort((left, right) => (left.ts || 0) - (right.ts || 0));
      const known = new Set(entries.map((entry) => entry.id));
      const ensureLedgerCoo = (cooId: string, name: string): void => {
        if (!cooId || cooId === 'room') return;
        ensureCoo(db, cooId, 'legacy', name, ledger?.identities[cooId]?.secretHash ?? null, now());
      };
      const insertEntry = db.prepare(
        `INSERT INTO ledger_entries(id, ts, room_id, kind, visibility, from_kind, from_coo_id,
           to_kind, to_coo_id, game, text, data_json, due_at, ref_entry_id, effect_id, is_refill)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      );
      const insertParticipant = db.prepare(
        'INSERT OR IGNORE INTO ledger_participants(entry_id, coo_id, position) VALUES (?, ?, ?)',
      );
      const insertWinner = db.prepare('INSERT OR IGNORE INTO ledger_winners(entry_id, coo_id) VALUES (?, ?)');
      const insertTransfer = db.prepare(
        `INSERT INTO ledger_transfers(entry_id, from_kind, from_coo_id, to_kind, to_coo_id, amount)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const entryRooms = new Set([roomId]);
      for (const entry of entries) {
        const entryRoom = typeof entry.room === 'string' && entryRooms.has(entry.room) ? entry.room : roomId;
        if (typeof entry.room === 'string' && entry.room && entry.room !== entryRoom) {
          warnings.push(`账本条目 ${entry.id} 的 room「${entry.room}」不在这次迁移里；归到 ${roomId}。`);
        }
        const fromCoo = normalizeCoo(entry.from, roomId) || null;
        const toCoo = normalizeCoo(entry.to, roomId) || null;
        if (fromCoo) ensureLedgerCoo(fromCoo, typeof entry.data?.fromName === 'string' ? entry.data.fromName : '');
        if (toCoo) ensureLedgerCoo(toCoo, typeof entry.data?.toName === 'string' ? entry.data.toName : '');
        for (const cooId of entry.participants ?? []) ensureLedgerCoo(normalizeCoo(cooId, roomId), '');
        for (const cooId of entry.winners ?? []) ensureLedgerCoo(normalizeCoo(cooId, roomId), '');
        for (const transfer of entry.transfers ?? []) {
          ensureLedgerCoo(normalizeCoo(transfer.from, roomId), '');
          ensureLedgerCoo(normalizeCoo(transfer.to, roomId), '');
        }
        insertEntry.run(
          entry.id,
          Number(entry.ts) || now(),
          entryRoom,
          entry.kind,
          entry.visibility === 'private' ? 'private' : 'room',
          fromCoo ? 'coo' : 'room',
          fromCoo,
          toCoo ? 'coo' : entry.to === 'room' ? 'room' : 'none',
          toCoo,
          entry.game ?? null,
          entry.text,
          entry.data === undefined ? null : JSON.stringify(entry.data),
          typeof entry.due === 'number' ? entry.due : null,
          entry.effectId || null,
          entry.data?.refill === true ? 1 : 0,
        );
        let position = 0;
        for (const raw of entry.participants ?? []) {
          const cooId = normalizeCoo(raw, roomId);
          if (!cooId) continue;
          insertParticipant.run(entry.id, cooId, position);
          position += 1;
        }
        for (const raw of entry.winners ?? []) {
          const cooId = normalizeCoo(raw, roomId);
          if (!cooId) continue;
          insertWinner.run(entry.id, cooId);
        }
        for (const transfer of entry.transfers ?? []) {
          if (!Number.isSafeInteger(transfer.amount) || transfer.amount <= 0) continue;
          const from = transfer.from === 'room' ? 'room' : normalizeCoo(transfer.from, roomId);
          const to = transfer.to === 'room' ? 'room' : normalizeCoo(transfer.to, roomId);
          if (!from || !to) continue;
          insertTransfer.run(
            entry.id,
            from === 'room' ? 'room' : 'coo',
            from === 'room' ? null : from,
            to === 'room' ? 'room' : 'coo',
            to === 'room' ? null : to,
            transfer.amount,
          );
        }
        counts.ledgerEntries += 1;
      }
      const updateRef = db.prepare('UPDATE ledger_entries SET ref_entry_id = ? WHERE id = ?');
      for (const entry of entries) {
        if (!entry.ref) continue;
        if (known.has(entry.ref)) updateRef.run(entry.ref, entry.id);
        else warnings.push(`账本条目 ${entry.id} 的 ref「${entry.ref}」不在旧文件里（被截断）；已置空。`);
      }

      // 6. 信箱：逐封已读；老游标只用来补 read_at。
      const insertMail = db.prepare(
        `INSERT OR IGNORE INTO mail(seq, id, ts, coo_id, room_id, kind, action, from_name, text, entry_id, key, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const cursor = mail?.read ?? {};
      for (const item of mail?.items ?? []) {
        const to = normalizeCoo(item.to, roomId);
        if (!to) { warnings.push(`信 ${item.id} 的收件人格式不对；跳过。`); continue; }
        ensureCoo(db, to, 'legacy', '', ledger?.identities[to]?.secretHash ?? null, Number(item.ts) || now());
        const readAt = item.read === true || item.seq <= (cursor[to] ?? 0)
          ? Number(item.ts) || now()
          : null;
        insertMail.run(
          item.seq,
          item.id,
          Number(item.ts) || now(),
          to,
          roomId,
          ['whisper', 'gift', 'promise', 'ledger', 'invite'].includes(item.kind) ? item.kind : 'ledger',
          item.action ?? null,
          item.fromName,
          item.text,
          item.entryId && known.has(item.entryId) ? item.entryId : null,
          item.key ?? null,
          readAt,
        );
        counts.mail += 1;
      }

      // 7. 大富翁：只有未结束且明确允许作废时才落一条 abandoned 桌子留档。
      if (activity && activity.table && activity.table.status && activity.table.status !== 'ended') {
        const tableId = `legacy-${roomId}-monopoly`;
        db.prepare(
          `INSERT OR IGNORE INTO tables(id, room_id, room_epoch, game, status, host_seat_id, stake,
             state_json, turn_seq, created_at, started_at, ended_at, end_reason, updated_at)
           VALUES (?, ?, ?, 'monopoly', 'abandoned', ?, 0, ?, 0, ?, ?, ?, 'migration', ?)`,
        ).run(
          tableId,
          roomId,
          typeof room.epoch === 'string' ? room.epoch : '',
          typeof activity.table.host === 'string' && seatCoo.has(activity.table.host) ? activity.table.host : null,
          JSON.stringify(activity),
          Number(activity.savedAt) || now(),
          Number(activity.savedAt) || now(),
          now(),
          now(),
        );
        const cancelSeq = lastSeq + 1;
        insertEvent.run(
          roomId, cancelSeq, now(), 'parlor.table.cancel', 'system', 'system', 'room', null, null, null,
          '迁移时大富翁还有一局没结束，这一局作废（存档留在服务器上）。', null,
          JSON.stringify({ game: 'monopoly', reason: 'migration' }),
        );
        db.prepare('UPDATE rooms SET seq = ? WHERE id = ?').run(cancelSeq, roomId);
        counts.events += 1;
      }

      // 8. 核对：余额、未读、席位令牌。任何一项不等就抛错回滚。
      const balanceChecks: MigrationCheck[] = [];
      const cooIds = new Set<string>([
        ...Object.keys(ledger?.identities ?? {}),
        ...(ledger?.entries ?? []).flatMap((entry) => [
          ...(entry.from && entry.from !== 'room' ? [entry.from] : []),
          ...(entry.to && entry.to !== 'room' ? [entry.to] : []),
          ...(entry.participants ?? []),
        ]),
      ]);
      for (const cooId of cooIds) {
        if (!isCoo(cooId)) continue;
        const old = oldBalance(ledger?.entries ?? [], cooId);
        const current = (db.prepare(
          `SELECT (SELECT COALESCE(SUM(amount), 0) FROM ledger_transfers WHERE to_coo_id = ?)
                - (SELECT COALESCE(SUM(amount), 0) FROM ledger_transfers WHERE from_coo_id = ?) AS balance`,
        ).get(cooId, cooId) as { balance: number }).balance;
        const check = { name: cooId, old, now: current, match: old === current };
        balanceChecks.push(check);
        if (!check.match) throw new Error(`余额核对不过：${cooId} 旧 ${old} / 新 ${current}`);
      }

      const unreadChecks: MigrationCheck[] = [];
      for (const cooId of new Set((mail?.items ?? []).map((item) => normalizeCoo(item.to, roomId)))) {
        if (!cooId) continue;
        const old = (mail?.items ?? []).filter((item) => normalizeCoo(item.to, roomId) === cooId
          && item.read !== true && item.seq > ((mail?.read ?? {})[cooId] ?? 0)).length;
        const current = (db.prepare(
          'SELECT COUNT(*) AS n FROM mail WHERE coo_id = ? AND read_at IS NULL',
        ).get(cooId) as { n: number }).n;
        const check = { name: cooId, old, now: current, match: old === current };
        unreadChecks.push(check);
        if (!check.match) throw new Error(`未读核对不过：${cooId} 旧 ${old} / 新 ${current}`);
      }

      const tokenChecks: Array<{ seat: string; ok: boolean }> = [];
      for (const seat of room.seats) {
        const row = db.prepare(
          'SELECT id FROM room_seats WHERE room_id = ? AND token_hash = ?',
        ).get(roomId, hashSeatToken(seat.token)) as { id: string } | undefined;
        const ok = row?.id === seat.id;
        tokenChecks.push({ seat: `${seat.id}/${seat.name}`, ok });
        if (!ok) throw new Error(`席位令牌核对不过：${seat.id}/${seat.name}`);
      }

      const runId = `mig-${sha256(`${roomId}:${startedAt}`).slice(0, 16)}`;
      db.prepare(
        `INSERT INTO migration_runs(id, source_dir, source_hashes_json, started_at, finished_at,
           status, counts_json, notes_json)
         VALUES (?, ?, ?, ?, ?, 'complete', ?, ?)`,
      ).run(
        runId,
        options.dataDir,
        JSON.stringify(sourceHashes(options.dataDir)),
        startedAt,
        now(),
        JSON.stringify(counts),
        JSON.stringify({ warnings }),
      );

      report.balances = balanceChecks;
      report.unread = unreadChecks;
      report.tokenChecks = tokenChecks;
    });
  } finally {
    db.close();
  }

  return report;
}
