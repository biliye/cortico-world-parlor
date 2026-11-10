/**
 * 建表与升级。
 *
 * SQLite 沿用原来的「看实际 DDL 再决定要不要重建表」那套（PRAGMA/sqlite_master
 * 只有 SQLite 有），PostgreSQL 走版本号迁移 + advisory lock。
 * 两边都做同一批数据兜底：大厅容量默认值、普通客厅固定 30 席、全局身份开关
 * 决定「同厅活跃席位名唯一」这条索引要不要存在。
 */

import { SCHEMA_SQL, IDENTITY_SCHEMA_SQL, roomsTableSql, tablesTableSql, DB_MAX_ROOM_CAPACITY, HALL_CAPACITY, MAX_USER_ROOM_CAPACITY } from '../schema.ts';
import type { Db } from './types.ts';
import type { SqliteDb } from './sqlite.ts';
import type { PgDb } from './postgres.ts';
import { PG_MIGRATIONS, PG_SCHEMA_VERSION } from './pg-schema.ts';
import { NEWS_SCHEMA_SQL, SUPPORT_ADMIN_SCHEMA_SQL, SUPPORT_SCHEMA_SQL } from '../support-db.ts';
import { TABLE_DISCOVERY_SCHEMA_SQL } from '../table-discovery-db.ts';
import { SEAT_RESULTS_SCHEMA_SQL } from '../table-results.ts';

/** 来源 SQLite 的库结构版本。 */
export const SQLITE_SCHEMA_VERSION = 13;

const roomsCapacityMax = (db: SqliteDb): number | null => {
  const row = db.raw.prepare(
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
const rebuildRooms = (db: SqliteDb): void => {
  const handle = db.raw;
  const indexes = handle.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'rooms' AND sql IS NOT NULL",
  ).all() as { sql: string }[];
  // 别的表上的触发器也会引用 rooms（席位容量闸门就是）；改名那一步 SQLite 会解析它们，
  // 先摘下来、重建完再挂回去。
  const triggers = handle.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL AND sql LIKE '%rooms%'",
  ).all() as { name: string; sql: string }[];
  handle.exec('PRAGMA foreign_keys = OFF');
  try {
    handle.exec('BEGIN IMMEDIATE');
    handle.exec('DROP TABLE IF EXISTS rooms_new');
    for (const trigger of triggers) handle.exec(`DROP TRIGGER IF EXISTS "${trigger.name}"`);
    handle.exec(roomsTableSql('rooms_new'));
    handle.exec(
      `INSERT INTO rooms_new(
         id, kind, name, owner_coo_id, visibility, capacity, topic, invite_code_hash,
         epoch, seq, created_at, last_active_at, archived_at
       )
       SELECT id, kind, name, owner_coo_id, visibility, capacity, topic, invite_code_hash,
              epoch, seq, created_at, last_active_at, archived_at
         FROM rooms`,
    );
    handle.exec('DROP TABLE rooms');
    handle.exec('ALTER TABLE rooms_new RENAME TO rooms');
    for (const index of indexes) handle.exec(index.sql);
    for (const trigger of triggers) handle.exec(trigger.sql);
    handle.exec('COMMIT');
  } catch (error) {
    try { handle.exec('ROLLBACK'); } catch { /* 已经回滚/连接坏了 */ }
    throw error;
  } finally {
    handle.exec('PRAGMA foreign_keys = ON');
  }
  const problems = handle.prepare('PRAGMA foreign_key_check').all();
  if (problems.length > 0) {
    throw new Error(`重建 rooms 后外键检查不干净：${JSON.stringify(problems).slice(0, 300)}`);
  }
};

/** 老库的 tables.game CHECK 还不含这些游戏；含了就不用重建（看实际 DDL，不靠版本号）。 */
const GAME_CHECK_MIN_GAMES = ['werewolf', 'monopoly2d'];

const tablesGameCheckMissing = (db: SqliteDb): boolean => {
  const row = db.raw.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tables'",
  ).get() as { sql?: string } | undefined;
  if (!row?.sql) return false;
  return GAME_CHECK_MIN_GAMES.some((game) => !row.sql!.includes(`'${game}'`));
};

/**
 * SQLite 不能 ALTER CHECK：game 清单加新游戏时，tables 表要整表重建。
 * tables 被 table_seats / active_table_players / action_receipts / table_finalizations /
 * monopoly_* 用外键指着，所以照 rebuildRooms 的路数：关外键 → 事务里建新表/搬数据/
 * 删旧表/改名/补索引 → 开外键 → foreign_key_check。
 */
const rebuildTables = (db: SqliteDb): void => {
  const handle = db.raw;
  const indexes = handle.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tables' AND sql IS NOT NULL",
  ).all() as { sql: string }[];
  const columns = (handle.prepare('PRAGMA table_info(tables)').all() as { name: string }[]).map((row) => row.name).join(', ');
  handle.exec('PRAGMA foreign_keys = OFF');
  try {
    handle.exec('BEGIN IMMEDIATE');
    handle.exec('DROP TABLE IF EXISTS tables_new');
    handle.exec(tablesTableSql('tables_new'));
    handle.exec(`INSERT INTO tables_new(${columns}) SELECT ${columns} FROM tables`);
    handle.exec('DROP TABLE tables');
    handle.exec('ALTER TABLE tables_new RENAME TO tables');
    for (const index of indexes) handle.exec(index.sql);
    handle.exec('COMMIT');
  } catch (error) {
    try { handle.exec('ROLLBACK'); } catch { /* 已经回滚/连接坏了 */ }
    throw error;
  } finally {
    handle.exec('PRAGMA foreign_keys = ON');
  }
  const problems = handle.prepare('PRAGMA foreign_key_check').all();
  if (problems.length > 0) {
    throw new Error(`重建 tables 后外键检查不干净：${JSON.stringify(problems).slice(0, 300)}`);
  }
};

/**
 * 打开库之前先看版本：比本程序新的库不能碰。
 * 这条检查必须在任何 DDL 之前跑（老库没有 meta 表时跳过）。
 */
const assertSchemaSupported = (db: SqliteDb): void => {
  const hasMeta = db.raw.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
  ).get() as { name?: string } | undefined;
  if (!hasMeta) return;
  const row = db.raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
  const current = Number(row?.value ?? 0);
  if (Number.isFinite(current) && current > SQLITE_SCHEMA_VERSION) {
    throw new Error(
      `这个数据库是 schema ${current}，本程序只认到 ${SQLITE_SCHEMA_VERSION}；`
      + '请换回能读新库的程序，或从备份恢复到旧库，不要用旧代码直接打开。',
    );
  }
};

/** 建表/补表；可重复执行。 */
export const migrateSqlite = async (db: SqliteDb): Promise<void> => {
  assertSchemaSupported(db);
  const handle = db.raw;
  handle.exec(SCHEMA_SQL);
  handle.exec(IDENTITY_SCHEMA_SQL);
  handle.exec(SUPPORT_SCHEMA_SQL);
  handle.exec(TABLE_DISCOVERY_SCHEMA_SQL);
  handle.exec(NEWS_SCHEMA_SQL);
  handle.exec(SUPPORT_ADMIN_SCHEMA_SQL);
  handle.exec(SEAT_RESULTS_SCHEMA_SQL);
  // 同上：老库的新闻表与公告表没有编辑留痕的两列，单独补。
  const newsColumns = new Set(
    (handle.prepare('PRAGMA table_info(news_items)').all() as { name: string }[]).map((row) => row.name),
  );
  if (!newsColumns.has('revision')) handle.exec('ALTER TABLE news_items ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
  if (!newsColumns.has('updated_at')) handle.exec('ALTER TABLE news_items ADD COLUMN updated_at BIGINT NOT NULL DEFAULT 0');
  // schema 11：每次发布一个唯一标识。老行没有，按 id 派生一个稳定值——
  // id 本身有主键约束，'legacy-' || id 也就互不相同；新行由 publishNews 写 UUID。
  if (!newsColumns.has('publish_id')) {
    handle.exec("ALTER TABLE news_items ADD COLUMN publish_id TEXT NOT NULL DEFAULT ''");
  }
  handle.exec("UPDATE news_items SET publish_id = 'legacy-' || id WHERE publish_id = ''");
  const announcementColumns = new Set(
    (handle.prepare('PRAGMA table_info(support_announcements)').all() as { name: string }[]).map((row) => row.name),
  );
  if (!announcementColumns.has('revision')) {
    handle.exec('ALTER TABLE support_announcements ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
  }
  if (!announcementColumns.has('updated_at')) {
    handle.exec('ALTER TABLE support_announcements ADD COLUMN updated_at BIGINT NOT NULL DEFAULT 0');
  }
  // schema 12：公告也记每次发布的唯一标识。同一条公告删掉后能用同一个 requestId 重发，
  // revision 又从 1 开始，只有它能分开「这一条」和「上一条」；老行同样按 id 派生。
  if (!announcementColumns.has('publish_id')) {
    handle.exec("ALTER TABLE support_announcements ADD COLUMN publish_id TEXT NOT NULL DEFAULT ''");
  }
  handle.exec("UPDATE support_announcements SET publish_id = 'legacy-' || id WHERE publish_id = ''");
  // CREATE TABLE IF NOT EXISTS 不给老库补列；招募版本列单独补。
  const discoveryColumns = new Set(
    (handle.prepare('PRAGMA table_info(table_discovery)').all() as { name: string }[]).map((row) => row.name),
  );
  if (!discoveryColumns.has('recruit_version')) {
    handle.exec('ALTER TABLE table_discovery ADD COLUMN recruit_version BIGINT NOT NULL DEFAULT 0');
  }
  const global = handle.prepare("SELECT 1 FROM meta WHERE key='global_identity' AND value='1'").get();
  if (global) handle.exec('DROP INDEX IF EXISTS ux_active_seat_name');
  else handle.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_active_seat_name ON room_seats(room_id,name COLLATE NOCASE) WHERE released_at IS NULL');
  // CREATE TABLE IF NOT EXISTS 不会给老库加列；新列在这里补。
  const columns = new Set(
    (handle.prepare('PRAGMA table_info(accounts)').all() as { name: string }[]).map((row) => row.name),
  );
  if (!columns.has('player_coo_id')) {
    handle.exec('ALTER TABLE accounts ADD COLUMN player_coo_id TEXT REFERENCES coos(id)');
  }
  // 私聊会话需要知道「谁发的那封」；老信没有这一列，按 NULL 处理（不进会话）。
  const mailColumns = new Set(
    (handle.prepare('PRAGMA table_info(mail)').all() as { name: string }[]).map((row) => row.name),
  );
  if (!mailColumns.has('from_coo_id')) {
    handle.exec('ALTER TABLE mail ADD COLUMN from_coo_id TEXT REFERENCES coos(id)');
  }
  if (!mailColumns.has('invitation_id')) {
    handle.exec('ALTER TABLE mail ADD COLUMN invitation_id TEXT');
  }
  // 索引要等列补上再建：写在 SCHEMA_SQL 里会在老库上炸（建索引时那列还不存在）。
  handle.exec('CREATE INDEX IF NOT EXISTS ix_mail_peer ON mail(coo_id, from_coo_id, seq)');

  // —— schema 5：多桌 / 可靠存档 / 准入 ——
  // 老库的 tables 没有这些列；CREATE TABLE IF NOT EXISTS 不会补。
  const tableColumns = new Set(
    (handle.prepare('PRAGMA table_info(tables)').all() as { name: string }[]).map((row) => row.name),
  );
  if (!tableColumns.has('revision')) handle.exec('ALTER TABLE tables ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  if (!tableColumns.has('state_version')) handle.exec('ALTER TABLE tables ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0');
  if (!tableColumns.has('frozen_at')) handle.exec('ALTER TABLE tables ADD COLUMN frozen_at INTEGER');
  if (!tableColumns.has('recovery_error')) handle.exec('ALTER TABLE tables ADD COLUMN recovery_error TEXT');

  const tableSeatColumns = new Set(
    (handle.prepare('PRAGMA table_info(table_seats)').all() as { name: string }[]).map((row) => row.name),
  );
  if (!tableSeatColumns.has('auto')) handle.exec('ALTER TABLE table_seats ADD COLUMN auto INTEGER NOT NULL DEFAULT 0');

  // 一房一桌的约束从这一版起取消；多桌的「一人一桌」由 active_table_players 保证。
  handle.exec('DROP INDEX IF EXISTS ux_live_table_per_room');

  // 老库的 rooms.capacity CHECK 还是 2–64；放宽的唯一办法是重建表。
  // 用实际 DDL 判断（而不是只看版本号），新库与已升级的库都不会白重建一次。
  if (roomsCapacityMax(db) !== DB_MAX_ROOM_CAPACITY) rebuildRooms(db);

  // tables.game 的 CHECK 加了新游戏（狼人杀、快局大富翁）；老库照 rooms 的先例整表重建。
  if (tablesGameCheckMissing(db)) rebuildTables(db);

  // 大厅最初写死 32；只抬这个默认值，手工改过的不动。
  handle.prepare('UPDATE rooms SET capacity = ? WHERE kind = ? AND capacity = ?')
    .run(HALL_CAPACITY, 'hall', 32);

  // 所有普通客厅固定 30 席，含归档厅；大厅不动。
  handle.prepare('UPDATE rooms SET capacity = ? WHERE kind = ? AND capacity <> ?')
    .run(MAX_USER_ROOM_CAPACITY, 'room', MAX_USER_ROOM_CAPACITY);

  // —— schema 9：筹码下线 ——
  // 老库还留着转移明细表与「非 refill 发放」唯一索引，一并清掉。
  // `is_refill` / `tables.stake` 两列故意不删：SQLite 的 DROP COLUMN 对带索引的列
  // 不稳，而且这两列都有默认值、新代码不再读写，留着不影响任何行为。
  handle.exec('DROP INDEX IF EXISTS ux_ledger_grant_once');
  handle.exec('DROP TABLE IF EXISTS ledger_transfers');

  const stmt = handle.prepare(
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  stmt.run('schema_version', String(SQLITE_SCHEMA_VERSION));
  stmt.run('storage_mode', 'sqlite');
};

/**
 * PostgreSQL 的建表/升级：拿一条专用连接 + advisory lock，按版本号逐段执行。
 * 比本程序新的库直接拒绝，和 SQLite 侧同一条规矩。
 */
export const migratePg = async (db: PgDb): Promise<void> => {
  await db.withClient(async (client) => {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['cortico-world-parlor-schema']);
    try {
      const reg = await client.query("SELECT to_regclass('public.meta') AS rel");
      const hasMeta = Boolean((reg.rows[0] as { rel?: string | null } | undefined)?.rel);
      let current = 0;
      if (hasMeta) {
        const row = await client.query("SELECT value FROM meta WHERE key = 'schema_version'");
        current = Number((row.rows[0] as { value?: string } | undefined)?.value ?? 0);
        if (Number.isFinite(current) && current > PG_SCHEMA_VERSION) {
          throw new Error(
            `这个 PostgreSQL 库是 schema ${current}，本程序只认到 ${PG_SCHEMA_VERSION}；`
            + '请换回能读新库的程序，或从备份恢复，不要用旧代码直接打开。',
          );
        }
      }

      for (const migration of PG_MIGRATIONS) {
        if (migration.version <= current) continue;
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query(
            `INSERT INTO meta(key, value) VALUES ('schema_version', $1)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
            [String(migration.version)],
          );
          await client.query('COMMIT');
          current = migration.version;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }

      // 与 SQLite 侧同一批数据兜底。都在版本迁移之后，可重复执行。
      await applyPgDataRules((sql, params) => client.query(sql, params));
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['cortico-world-parlor-schema']);
    }
  });
};

/**
 * 版本迁移之外的「数据兜底」：每次打开都对一遍，可重复执行。
 *
 * 迁移工具导入完也要跑一遍——它启动时 `migrate()` 看到的是空库（那时
 * `global_identity` 还没搬过来，建的是「同名唯一」索引），导入之后必须按来源库的
 * 真实开关重来一次。
 */
export const applyPgDataRules = async (
  query: (sql: string, params?: unknown[]) => Promise<unknown>,
): Promise<void> => {
  const global = await query("SELECT 1 FROM meta WHERE key = 'global_identity' AND value = '1'") as { rowCount?: number; rows?: unknown[] } | unknown[];
  const enabled = Array.isArray(global) ? global.length > 0 : Number((global as { rowCount?: number })?.rowCount ?? 0) > 0;
  if (enabled) {
    await query('DROP INDEX IF EXISTS ux_active_seat_name');
  } else {
    await query(
      'CREATE UNIQUE INDEX IF NOT EXISTS ux_active_seat_name ON room_seats(room_id, lower(name)) WHERE released_at IS NULL',
    );
  }
  await query('UPDATE rooms SET capacity = $1 WHERE kind = $2 AND capacity = $3', [HALL_CAPACITY, 'hall', 32]);
  await query('UPDATE rooms SET capacity = $1 WHERE kind = $2 AND capacity <> $1', [MAX_USER_ROOM_CAPACITY, 'room']);
  await query(
    "INSERT INTO meta(key, value) VALUES ('storage_mode', 'postgres') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );
  // 老 SQLite 备份里没有发布标识这一列：离线导入按「来源与目标的列交集」拷贝，
  // 新列会留成空串，运营侧就改不动也删不掉这些老公告。按 id 补一个稳定值，
  // 与 v11 迁移的兜底一致；正常库 0 行，可重复执行。
  await query("UPDATE support_announcements SET publish_id = 'legacy-' || id WHERE publish_id = ''");
};

/** 按库的类型分派。 */
export const migrate = async (db: Db): Promise<void> => {
  if (db.kind === 'postgres') {
    await migratePg(db as PgDb);
    return;
  }
  await migrateSqlite(db as SqliteDb);
};
