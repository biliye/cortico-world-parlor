/**
 * SQLite → PostgreSQL 迁移：审计 → 建目标结构 → 导入 → 校准序列 → 逐项核验 → 落审计记录。
 *
 * 三条硬规矩：
 * - 来源只读打开；不调应用的 migrate/recover，不在来源库上产生任何副作用；
 * - 目标非空默认拒绝（`--force` 只允许同一批次的重跑）；
 * - 全程一个事务：核验不过就整笔回滚，目标库里不会留下半份数据。
 */
import { randomUUID } from 'node:crypto';
import { openStorage } from '../storage/open.ts';
import { applyPgDataRules, migrate } from '../storage/migrate.ts';
import type { Db } from '../storage/types.ts';
import { MIGRATION_TABLES, targetColumns } from './schema-map.ts';
import { auditSource, openSource, type SourceAudit, type SqliteHandle } from './source.ts';
import { calibrateSequences, copyAll, type PgClient } from './copy.ts';
import { verifyAll, type VerifyReport } from './verify.ts';

export type MigrationStage = 'audit' | 'target' | 'copy' | 'verify' | 'record' | 'done';

export interface MigrateOptions {
  source: string;
  /** 目标空库的连接串；dry-run 不需要。 */
  targetUrl?: string;
  dryRun?: boolean;
  /** 允许在「同一批次（同一来源哈希）重跑」的目标上继续。 */
  force?: boolean;
  batch?: number;
  /** 深审计（逐行查 JSON）；默认开。 */
  deep?: boolean;
  /** 工具版本，写进审计记录。 */
  version?: string;
  now?: () => number;
  log?: (line: string) => void;
}

export interface MigrateReport {
  ok: boolean;
  stage: MigrationStage;
  source: { file: string; bytes: number; sha256: string; schemaVersion: number };
  audit: SourceAudit;
  counts?: Record<string, number>;
  sequences?: Record<string, number>;
  verify?: VerifyReport;
  runId?: string;
  /** 中止原因（人话）。 */
  error?: string;
}

const emptyReport = (audit: SourceAudit, stage: MigrationStage, error?: string): MigrateReport => ({
  ok: false,
  stage,
  source: {
    file: audit.file,
    bytes: audit.bytes,
    sha256: audit.sha256,
    schemaVersion: audit.schemaVersion,
  },
  audit,
  ...(error ? { error } : {}),
});

/** 用应用的 Db 当 PgClient：SQL 写 `?`，参数与结果归一化都走适配器那一套。 */
const clientOf = (db: Db): PgClient => ({
  query: async (text, params = []) => {
    const statement = db.prepare(text);
    // 有占位符的用 all()；DDL/无参数的也用 all()（返回空行）。
    const rows = await statement.all(...(params as (string | number | null)[]));
    return { rows: rows as Record<string, unknown>[], rowCount: rows.length };
  },
});

/** 目标库里已经有多少行：非 0 说明不是空库。 */
const targetFill = async (db: Db): Promise<{ table: string; rows: number }[]> => {
  const filled: { table: string; rows: number }[] = [];
  for (const table of MIGRATION_TABLES) {
    const exists = await db.prepare('SELECT to_regclass(?) AS name').get(`public.${table.name}`) as { name: string | null } | undefined;
    if (!exists?.name) continue;
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table.name}`).get() as { n: number } | undefined;
    const rows = Number(row?.n ?? 0);
    if (rows > 0) filled.push({ table: table.name, rows });
  }
  return filled;
};

/** 同一来源已经在这里跑过一次吗（重跑识别）。 */
const sameBatch = async (db: Db, sha256: string): Promise<string | undefined> => {
  const exists = await db.prepare('SELECT to_regclass(?) AS name').get('public.migration_runs') as { name: string | null } | undefined;
  if (!exists?.name) return undefined;
  const rows = await db.prepare('SELECT id, source_hashes_json FROM migration_runs').all() as {
    id: string; source_hashes_json: unknown;
  }[];
  for (const row of rows) {
    const hashes = typeof row.source_hashes_json === 'string'
      ? JSON.parse(row.source_hashes_json) as { sha256?: string }
      : row.source_hashes_json as { sha256?: string } | null;
    if (hashes?.sha256 === sha256) return row.id;
  }
  return undefined;
};

export const runMigration = async (options: MigrateOptions): Promise<MigrateReport> => {
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const source = openSource(options.source);
  let audit: SourceAudit;
  try {
    audit = auditSource(source, options.source, { deep: options.deep ?? true });
  } catch (error) {
    source.close();
    throw error;
  }
  log(`审计：${audit.counts ? Object.values(audit.counts).reduce((sum, n) => sum + n, 0) : 0} 行、`
    + `${Object.keys(audit.counts).length} 张表、schema ${audit.schemaVersion}、sha256 ${audit.sha256.slice(0, 12)}…`);
  if (audit.warnings.length > 0) {
    for (const warning of audit.warnings) log(`提醒[${warning.code}] ${warning.table ?? ''} ${warning.detail}`);
  }
  if (audit.issues.length > 0) {
    source.close();
    for (const issue of audit.issues) log(`中止[${issue.code}] ${issue.table ?? ''} ${issue.detail}`);
    return emptyReport(audit, 'audit', `${audit.issues.length} 条结构/数据问题，未接触目标库`);
  }
  if (options.dryRun) {
    source.close();
    log('dry-run：只审计，不连目标库、不写任何东西。');
    for (const table of MIGRATION_TABLES) {
      const count = audit.counts[table.name];
      if (count === undefined) continue;
      log(`  将搬 ${table.name}: ${count} 行`);
    }
    return {
      ok: true,
      stage: 'done',
      source: {
        file: audit.file, bytes: audit.bytes, sha256: audit.sha256, schemaVersion: audit.schemaVersion,
      },
      audit,
      counts: audit.counts,
    };
  }
  if (!options.targetUrl) {
    source.close();
    return emptyReport(audit, 'target', '没有给目标库连接串（--target），也不是 dry-run');
  }

  const db = await openStorage({ storage: 'postgres', url: options.targetUrl, poolMax: 4 });
  let closed = false;
  try {
    const filled = await targetFill(db);
    if (filled.length > 0) {
      const batch = await sameBatch(db, audit.sha256);
      if (!options.force || !batch) {
        return emptyReport(
          audit, 'target',
          `目标库不是空的（${filled.map((entry) => `${entry.table} ${entry.rows} 行`).slice(0, 5).join('、')}`
          + `${filled.length > 5 ? ' 等' : ''}）；${batch ? `这是同一批次 ${batch}，可加 --force 重跑` : '换一个空库'}`,
        );
      }
      const previous = await db.prepare('SELECT status FROM migration_runs WHERE id = ?').get(batch) as
        { status: string } | undefined;
      if (previous?.status !== 'failed' || filled.some((entry) => !['meta', 'migration_runs'].includes(entry.table))) {
        return emptyReport(audit, 'target',
          '该批次已完成或目标已有业务数据，禁止 --force 覆盖；请使用新的空目标库，保留现有数据');
      }
      log(`目标只有同一失败批次 ${batch} 的审计记录：--force 允许清理审计后重跑。`);
      await db.runInTransaction(async () => {
        for (const table of [...MIGRATION_TABLES].reverse()) {
          const exists = await db.prepare('SELECT to_regclass(?) AS name').get(`public.${table.name}`) as { name: string | null } | undefined;
          if (exists?.name) await db.exec(`TRUNCATE TABLE ${table.name} CASCADE`);
        }
      });
    }

    // 目标结构：与应用完全同一套 DDL/迁移（触发器、索引、约束都在里面）。
    await migrate(db);
    const expected = targetColumns();
    for (const table of MIGRATION_TABLES) {
      const want = expected.get(table.name) ?? [];
      const rows = await db.prepare(
        `SELECT column_name AS name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ? ORDER BY ordinal_position`,
      ).all(table.name) as { name: string }[];
      const actual = rows.map((row) => row.name);
      const missing = want.filter((column) => !actual.includes(column));
      if (missing.length > 0) {
        return emptyReport(audit, 'target', `目标库 ${table.name} 缺列：${missing.join(', ')}`);
      }
    }
    log('目标结构就位（28 张表、索引、容量触发器）。');

    const runId = `mig-${randomUUID()}`;
    const startedAt = now();
    let counts: Record<string, number> = {};
    let sequences: Record<string, number> = {};
    let verify: VerifyReport | undefined;
    let failure = '';
    // 整笔一个事务：拷贝、序列校准、核验都在里面。核验不过就整笔回滚，
    // 目标库里不会留下半份数据；回滚之后再补一条 failed 的审计记录。
    try {
      await db.runInTransaction(async () => {
        // 空 PG 库默认保留旧身份模式的重名限制。统一身份源允许重名，必须在
        // 插入 room_seats 之前移除索引；导入完才移除已经来不及。
        const globalIdentity = source.prepare("SELECT value FROM meta WHERE key = 'global_identity'").get() as
          { value?: string } | undefined;
        if (globalIdentity?.value === '1') await db.exec('DROP INDEX IF EXISTS ux_active_seat_name');
        await db.prepare(
          `INSERT INTO migration_runs(id, source_dir, source_hashes_json, started_at, status, notes_json)
           VALUES (?, ?, ?, ?, 'running', ?)`,
        ).run(
          runId,
          audit.file,
          JSON.stringify({ file: audit.file, sha256: audit.sha256, schemaVersion: audit.schemaVersion }),
          startedAt,
          JSON.stringify({ tool: options.version ?? 'unknown', phase: 'copy' }),
        );
        const copied = await copyAll(source, clientOf(db), audit, {
          ...(options.batch !== undefined ? { batch: options.batch } : {}),
          onTable: (name, rows) => log(`  ${name}: ${rows} 行`),
        });
        counts = copied.counts;
        sequences = await calibrateSequences(clientOf(db));
        log(`序列校准：${Object.entries(sequences).map(([name, top]) => `${name}=${top}`).join('、') || '没有自增列'}`);
        // meta 里的 global_identity 刚搬过来：同名唯一索引要按它重来一次。
        await applyPgDataRules((sql, params) => db.prepare(sql).all(...((params ?? []) as (string | number)[])));
        log('数据兜底（同名唯一索引 / 席位容量 / storage_mode）已按来源库的设置重做。');
        log('导入完成，开始逐行核验……');
        verify = await verifyAll(source, clientOf(db), audit, {
          // 本次的审计记录是工具自己写的，来源里没有这一行；核验时两边都跳过。
          rowFilters: { migration_runs: (row) => row.id === runId },
          onTable: (digest) => log(`  ${digest.table}: ${digest.rows} 行 ${digest.digest.slice(0, 10)}…`),
        });
        for (const entry of verify.contrasts) {
          log(`  ${entry.ok ? '✓' : '✗'} ${entry.name}` + (entry.ok
            ? ''
            : `：${entry.differences.map((diff) => `${diff.key} 来源=${diff.source} 目标=${diff.target}`).join('；')}`));
        }
        if (!verify.ok) {
          failure = '核验不一致，整笔回滚';
          throw new Error(failure);
        }
        await db.prepare("UPDATE migration_runs SET status = 'complete', finished_at = ?, counts_json = ?, notes_json = ? WHERE id = ?")
          .run(
            now(),
            JSON.stringify(counts),
            JSON.stringify({ tool: options.version ?? 'unknown', sequences }),
            runId,
          );
      });
    } catch (error) {
      const reason = failure || (error instanceof Error ? error.message : String(error));
      try {
        await db.runInTransaction(async () => {
          await db.prepare(
            `INSERT INTO migration_runs(id, source_dir, source_hashes_json, started_at, finished_at, status, notes_json)
             VALUES (?, ?, ?, ?, ?, 'failed', ?)`,
          ).run(
            runId,
            audit.file,
            JSON.stringify({ file: audit.file, sha256: audit.sha256, schemaVersion: audit.schemaVersion }),
            startedAt,
            now(),
            JSON.stringify({ tool: options.version ?? 'unknown', reason }),
          );
        });
      } catch { /* 连审计记录都写不进去：下面的报告里有原因 */ }
      return {
        ...emptyReport(audit, 'verify', reason), counts, sequences,
        ...(verify ? { verify } : {}), runId,
      };
    }
    log('核验全过。迁移完成。');
    return {
      ok: true,
      stage: 'done',
      source: { file: audit.file, bytes: audit.bytes, sha256: audit.sha256, schemaVersion: audit.schemaVersion },
      audit, counts, sequences, verify: verify!, runId,
    };
  } finally {
    source.close();
    if (!closed) {
      closed = true;
      await db.close();
    }
  }
};
