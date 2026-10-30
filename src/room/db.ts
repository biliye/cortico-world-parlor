/**
 * SQLite 薄适配：只用 node:sqlite 的 DatabaseSync / prepare / exec / 事务。
 *
 * Node >= 22.13 才免 flag；package.json 的 engines 已按这个下限写。
 * 多客厅/账户/账本/信箱都落这一个库；每客厅的事件、席位、牌桌也在这里，
 * 但查询和可见性仍由 RoomKernel/RoomHost 负责。
 */
import {
  DB_MAX_ROOM_CAPACITY,
  HALL_CAPACITY,
  SCHEMA_SQL,
  roomsTableSql,
} from './schema.ts';

/** 库结构版本。4 = rooms.capacity 的 CHECK 放宽到 500。 */
const SCHEMA_VERSION = 4;

// Vite 5 的 builtin 列表还不认识 node:sqlite，静态 import 会被当成名为 sqlite 的包。
// process.getBuiltinModule 在运行时直接拿内置模块，绕过打包器解析。
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

export type Db = InstanceType<typeof DatabaseSync>;

export const openDb = (file = ':memory:'): Db => {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
};

const roomsCapacityMax = (db: Db): number | null => {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rooms'",
  ).get() as { sql?: string } | undefined;
  if (!row?.sql) return null;
  const match = row.sql.match(/capacity\s+INTEGER\s+NOT\s+NULL\s+CHECK\s*\(\s*capacity\s+BETWEEN\s+\d+\s+AND\s+(\d+)\s*\)/i);
  return match ? Number(match[1]) : null;
};

/**
 * SQLite 不能 ALTER CHECK，只能重建 rooms 表。
 * rooms 被 room_seats/events/mail/tables 等外键指着，所以：
 * 关外键 → 一个事务里建新表/搬数据/删旧表/改名/补索引 → 开外键 → foreign_key_check。
 * 索引从 sqlite_master 现取，避免以后加了索引忘了在这里补。
 */
const rebuildRooms = (db: Db): void => {
  const indexes = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'rooms' AND sql IS NOT NULL",
  ).all() as { sql: string }[];
  // 别的表上的触发器也会引用 rooms（席位容量闸门就是）；改名那一步 SQLite 会解析它们，
  // 先摘下来、重建完再挂回去。
  const triggers = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL AND sql LIKE '%rooms%'",
  ).all() as { name: string; sql: string }[];
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('DROP TABLE IF EXISTS rooms_new');
    for (const trigger of triggers) db.exec(`DROP TRIGGER IF EXISTS "${trigger.name}"`);
    db.exec(roomsTableSql('rooms_new'));
    db.exec(
      `INSERT INTO rooms_new(
         id, kind, name, owner_coo_id, visibility, capacity, topic, invite_code_hash,
         epoch, seq, created_at, last_active_at, archived_at
       )
       SELECT id, kind, name, owner_coo_id, visibility, capacity, topic, invite_code_hash,
              epoch, seq, created_at, last_active_at, archived_at
         FROM rooms`,
    );
    db.exec('DROP TABLE rooms');
    db.exec('ALTER TABLE rooms_new RENAME TO rooms');
    for (const index of indexes) db.exec(index.sql);
    for (const trigger of triggers) db.exec(trigger.sql);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 已经回滚/连接坏了 */ }
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  const problems = db.prepare('PRAGMA foreign_key_check').all();
  if (problems.length > 0) {
    throw new Error(`重建 rooms 后外键检查不干净：${JSON.stringify(problems).slice(0, 300)}`);
  }
};

/** 建表/补表；可重复执行。 */
export const migrate = (db: Db): void => {
  db.exec(SCHEMA_SQL);
  // CREATE TABLE IF NOT EXISTS 不会给老库加列；新列在这里补。
  const columns = new Set(
    (db.prepare('PRAGMA table_info(accounts)').all() as { name: string }[]).map((row) => row.name),
  );
  if (!columns.has('player_coo_id')) {
    db.exec('ALTER TABLE accounts ADD COLUMN player_coo_id TEXT REFERENCES coos(id)');
  }
  // 私聊会话需要知道「谁发的那封」；老信没有这一列，按 NULL 处理（不进会话）。
  const mailColumns = new Set(
    (db.prepare('PRAGMA table_info(mail)').all() as { name: string }[]).map((row) => row.name),
  );
  if (!mailColumns.has('from_coo_id')) {
    db.exec('ALTER TABLE mail ADD COLUMN from_coo_id TEXT REFERENCES coos(id)');
  }
  // 索引要等列补上再建：写在 SCHEMA_SQL 里会在老库上炸（建索引时那列还不存在）。
  db.exec('CREATE INDEX IF NOT EXISTS ix_mail_peer ON mail(coo_id, from_coo_id, seq)');

  // 老库的 rooms.capacity CHECK 还是 2–64；放宽的唯一办法是重建表。
  // 用实际 DDL 判断（而不是只看版本号），新库与已升级的库都不会白重建一次。
  if (roomsCapacityMax(db) !== DB_MAX_ROOM_CAPACITY) rebuildRooms(db);

  // 大厅最初写死 32；只抬这个默认值，手工改过的不动。
  db.prepare('UPDATE rooms SET capacity = ? WHERE kind = ? AND capacity = ?')
    .run(HALL_CAPACITY, 'hall', 32);

  const stmt = db.prepare(
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  stmt.run('schema_version', String(SCHEMA_VERSION));
  stmt.run('storage_mode', 'sqlite');
};

const transactionDepth = new WeakMap<Db, number>();
let savepointSeq = 0;

/**
 * 写事务：最外层 BEGIN IMMEDIATE，嵌套用 SAVEPOINT。
 * 这样 RoomHost 可以把「事件 + 席位 + 信箱」包在一个事务里，而 store 内部
 * 仍然可以各自调用 withTransaction，不用知道外层有没有事务。
 * 事务里不要 await 网络/文件；提交后再广播事件。
 */
export const withTransaction = <T>(db: Db, fn: () => T): T => {
  const depth = transactionDepth.get(db) ?? 0;
  if (depth === 0) {
    db.exec('BEGIN IMMEDIATE');
    transactionDepth.set(db, 1);
    try {
      const result = fn();
      db.exec('COMMIT');
      transactionDepth.set(db, 0);
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* 已经回滚/连接坏了 */ }
      transactionDepth.set(db, 0);
      throw error;
    }
  }

  const name = `sp_${savepointSeq}`;
  savepointSeq += 1;
  db.exec(`SAVEPOINT ${name}`);
  transactionDepth.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    transactionDepth.set(db, depth);
    return result;
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
    } catch { /* 外层可能已经回滚 */ }
    transactionDepth.set(db, depth);
    throw error;
  }
};
