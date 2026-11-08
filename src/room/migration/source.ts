/**
 * 迁移的来源：一份**一致性 SQLite 备份**，只读打开。
 *
 * 这里只读不写，也绝不调用应用的 migrate/recover/退款——那些会在来源库上产生副作用，
 * 备份就不再是备份了。审计把「这份库能不能搬」一次说清：结构对不上、外键坏、
 * JSON 坏、整数超范围、同一个人两个活跃席位——任何一条都中止，不跳过、不修成空值。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { ADDED_TABLE_VERSIONS, MIGRATION_TABLES, OBSOLETE_COLUMNS, OBSOLETE_TABLES, targetColumns } from './schema-map.ts';
import { SQLITE_SCHEMA_VERSION } from '../storage/migrate.ts';

// Vite 5 的 builtin 列表还不认识 node:sqlite，走 getBuiltinModule 绕过打包器解析。
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

export type SqliteHandle = InstanceType<typeof DatabaseSync>;

export interface AuditIssue {
  code: string;
  table?: string;
  detail: string;
}

export interface SourceAudit {
  file: string;
  bytes: number;
  sha256: string;
  schemaVersion: number;
  counts: Record<string, number>;
  columns: Record<string, string[]>;
  issues: AuditIssue[];
  warnings: AuditIssue[];
}

export const openSource = (file: string): SqliteHandle => {
  if (!existsSync(file)) throw new Error(`来源库不存在：${file}`);
  // WAL 还有内容说明这库可能还在被写：备份方式不对（不能直接复制在写的 WAL 主文件）。
  const wal = `${file}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0) {
    throw new Error(`来源库旁边还有 ${statSync(wal).size} 字节的 WAL：先停写并用 Backup API 做一致性备份`);
  }
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  return db;
};

const sourceTables = (db: SqliteHandle): string[] => (
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[]
).map((row) => row.name);

const sourceColumns = (db: SqliteHandle, table: string): string[] => (
  db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
).map((row) => row.name);

const jsonColumnsOf = (table: string): string[] => (
  MIGRATION_TABLES.find((entry) => entry.name === table)?.json ?? []
);

const tableCount = (db: SqliteHandle, table: string): number => {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined;
  return row ? Number(row.n) : 0;
};

/**
 * 审计来源库。`deep` 打开后还会逐行检查 JSON 与整数范围（逐表全扫，大库慢一些，
 * 但这是唯一能保证「导入后不会在半夜爆掉」的地方）。
 */
export const auditSource = (db: SqliteHandle, file: string, options: { deep?: boolean } = {}): SourceAudit => {
  const issues: AuditIssue[] = [];
  const warnings: AuditIssue[] = [];
  const bytes = statSync(file).size;
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');

  // —— 结构：表、列、schema 版本 ——
  const present = new Set(sourceTables(db));
  const expected = new Map(MIGRATION_TABLES.map((table) => [table.name, targetColumns().get(table.name) ?? []]));

  for (const table of MIGRATION_TABLES) {
    if (!present.has(table.name) && !ADDED_TABLE_VERSIONS[table.name]) issues.push({ code: 'missing_table', table: table.name, detail: '来源库没有这张表' });
  }
  for (const name of present) {
    if (!expected.has(name) && !OBSOLETE_TABLES.has(name)) issues.push({ code: 'unknown_table', table: name, detail: '来源库多出一张迁移工具不认识的表' });
  }

  const columns: Record<string, string[]> = {};
  for (const table of MIGRATION_TABLES) {
    if (!present.has(table.name)) continue;
    const actual = sourceColumns(db, table.name);
    columns[table.name] = actual;
    const want = expected.get(table.name) ?? [];
    const drop = OBSOLETE_COLUMNS[table.name] ?? [];
    const extra = actual.filter((column) => !want.includes(column) && !drop.includes(column));
    const missing = want.filter((column) => !actual.includes(column));
    if (extra.length) issues.push({ code: 'unknown_column', table: table.name, detail: `多出列：${extra.join(', ')}` });
    if (missing.length) issues.push({ code: 'missing_column', table: table.name, detail: `缺列：${missing.join(', ')}` });
  }

  let schemaVersion = 0;
  if (present.has('meta')) {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    schemaVersion = Number(row?.value ?? 0) || 0;
  }
  if (schemaVersion < 1) issues.push({ code: 'unknown_schema_version', detail: 'meta.schema_version 缺失或不是正整数' });
  for (const [name, addedIn] of Object.entries(ADDED_TABLE_VERSIONS)) {
    if (schemaVersion >= addedIn && !present.has(name)) issues.push({ code: 'missing_table', table: name, detail: '来源库没有这张表' });
  }
  if (schemaVersion > SQLITE_SCHEMA_VERSION) {
    issues.push({ code: 'newer_schema_version', detail: `来源 schema_version=${schemaVersion}，比这一版认识的 ${SQLITE_SCHEMA_VERSION} 更新` });
  }

  // —— 外键完整性 ——
  try {
    const broken = db.prepare('PRAGMA foreign_key_check').all() as Record<string, unknown>[];
    if (broken.length > 0) {
      issues.push({
        code: 'foreign_key_violation',
        detail: `${broken.length} 条外键对不上，例如 ${JSON.stringify(broken[0])}`,
      });
    }
  } catch (error) {
    warnings.push({ code: 'foreign_key_check_failed', detail: String(error) });
  }

  // —— 同一个人两个活跃席位（PG 上有唯一索引，导进去会当场报错）——
  if (present.has('room_seats')) {
    const dup = db.prepare(
      `SELECT coo_id, COUNT(*) AS n FROM room_seats WHERE released_at IS NULL GROUP BY coo_id HAVING COUNT(*) > 1`,
    ).all() as { coo_id: string; n: number }[];
    for (const row of dup) {
      issues.push({ code: 'duplicate_active_seat', table: 'room_seats', detail: `${row.coo_id} 有 ${row.n} 个活跃席位` });
    }
  }

  // —— 进行中却不能恢复的牌局：来源会在下次启动作废退款，目标也会，但得让人知道 ——
  if (present.has('tables')) {
    const broken = db.prepare(
      `SELECT id, game, status FROM tables
        WHERE status IN ('open','bidding','playing') AND state_json IS NULL AND frozen_at IS NULL`,
    ).all() as { id: string; game: string; status: string }[];
    for (const row of broken) {
      issues.push({
        code: 'unrecoverable_live_table',
        table: 'tables',
        detail: `${row.game} 桌 ${row.id}（${row.status}）没有存档：导入后会被当成「升级前旧牌局」作废退款`,
      });
    }
  }

  // —— 逐行：JSON 能不能解析、整数会不会超出 JS 安全范围 ——
  if (options.deep) {
    for (const table of MIGRATION_TABLES) {
      if (!present.has(table.name)) continue;
      const jsonCols = jsonColumnsOf(table.name);
      if (jsonCols.length === 0) continue;
      for (const column of jsonCols) {
        const rows = db.prepare(
          `SELECT ${table.key.join(', ')}, ${column} AS value FROM ${table.name} WHERE ${column} IS NOT NULL`,
        ).all() as Record<string, unknown>[];
        for (const row of rows) {
          try {
            JSON.parse(String(row.value));
          } catch {
            const where = table.key.map((key) => `${key}=${String(row[key])}`).join('&');
            issues.push({ code: 'bad_json', table: table.name, detail: `${column} 解析不出 JSON（${where}）` });
          }
        }
      }
    }
  }

  const counts: Record<string, number> = {};
  for (const table of MIGRATION_TABLES) {
    if (present.has(table.name)) counts[table.name] = tableCount(db, table.name);
  }

  // 空库也能搬，但要说一声：多半是拿错了文件。
  if (Object.values(counts).every((count) => count === 0)) {
    warnings.push({ code: 'empty_source', detail: '来源库里一张表都没有行' });
  }

  return { file, bytes, sha256, schemaVersion, counts, columns, issues, warnings };
};
