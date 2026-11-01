/**
 * 把来源库逐表搬进目标 PG。
 *
 * 一次导入一个事务：中断就是全没有，不会留下「一半新一半旧」的库。
 * 值按列类型转换：JSON 列解析成对象（PG 侧 JSONB），其余原样；
 * 任何超出 JS 安全整数范围或类型对不上的值都当场中止——宁可停在半路，也不静默改数据。
 */
import { MIGRATION_TABLES, ROW_FILTERS, targetColumns } from './schema-map.ts';
import type { SourceAudit, SqliteHandle } from './source.ts';

/** 只用到 query，不把 pg 的类型拖进来（迁移工具是独立入口）。 */
export interface PgClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export interface CopyOptions {
  /** 每条 INSERT 带多少行；20 列 × 500 行 = 1 万参数，离 PG 的 65535 上限很远。 */
  batch?: number;
  /** 每张表搬完回调一次（打进度用）。 */
  onTable?: (name: string, rows: number) => void;
}

export interface CopyResult {
  counts: Record<string, number>;
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** 一行的目标值；类型不对就抛（带上表名与主键，便于定位）。 */
const convertRow = (
  table: string,
  columns: string[],
  jsonSet: Set<string>,
  keyColumns: string[],
  row: Record<string, unknown>,
): unknown[] => columns.map((column) => {
  const value = row[column];
  if (value === undefined || value === null) return null;
  if (jsonSet.has(column)) {
    // SQLite 里是 TEXT；PG 侧给对象，驱动会序列化成 JSONB。
    if (typeof value === 'string') return JSON.parse(value);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      const where = keyColumns.map((key) => `${key}=${String(row[key])}`).join('&');
      throw new Error(`${table}.${column} 的值 ${String(value)} 不是安全整数（${where}）`);
    }
    return value;
  }
  if (typeof value === 'bigint') {
    if (value > BigInt(MAX_SAFE) || value < BigInt(-MAX_SAFE)) {
      throw new Error(`${table}.${column} 的值 ${value} 超出安全整数范围`);
    }
    return Number(value);
  }
  if (typeof value === 'string') return value;
  throw new Error(`${table}.${column} 出现意外的值类型 ${typeof value}`);
});

const insertSql = (table: string, columns: string[], rows: number): string => {
  const width = columns.length;
  const values: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    const slots: string[] = [];
    for (let slot = 0; slot < width; slot += 1) slots.push(`$${index * width + slot + 1}`);
    values.push(`(${slots.join(', ')})`);
  }
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${values.join(', ')}`;
};

/** 来源库这张表实际有哪些列（审计已保证与目标列一致）。 */
const sourceColumnsOf = (audit: SourceAudit, table: string): string[] => audit.columns[table] ?? [];

export const copyAll = async (
  source: SqliteHandle,
  target: PgClient,
  audit: SourceAudit,
  options: CopyOptions = {},
): Promise<CopyResult> => {
  const batchSize = Math.max(1, Math.trunc(options.batch ?? 500));
  const columns = targetColumns();
  const counts: Record<string, number> = {};

  for (const table of MIGRATION_TABLES) {
    const declared = audit.counts[table.name];
    if (declared === undefined) { counts[table.name] = 0; continue; }
    const columns_ = sourceColumnsOf(audit, table.name);
    if (columns_.length === 0) { counts[table.name] = 0; continue; }
    const jsonSet = new Set(table.json ?? []);
    const statement = source.prepare(
      `SELECT ${columns_.join(', ')} FROM ${table.name} ORDER BY ${table.key.join(', ')}`,
    );
    const skip = ROW_FILTERS[table.name];
    let read = 0;
    let copied = 0;
    let batch: unknown[][] = [];
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      await target.query(insertSql(table.name, columns_, batch.length), batch.flat());
      batch = [];
    };
    for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
      read += 1;
      // meta 里那两行是目标环境自己的，不搬（见 schema-map 的 ROW_FILTERS）。
      if (skip && skip(row)) continue;
      batch.push(convertRow(table.name, columns_, jsonSet, table.key, row));
      copied += 1;
      if (batch.length >= batchSize) await flush();
    }
    await flush();
    counts[table.name] = copied;
    if (read !== declared) {
      throw new Error(`${table.name} 读出来的行数 ${read} 与审计的 ${declared} 不一致（来源库在搬的过程中变过？）`);
    }
    options.onTable?.(table.name, copied);
  }
  return { counts };
};

/**
 * 校准所有 identity 序列：导入时带了旧值，序列自己不会前进。
 * 表为空就把序列留在起点（1），不 setval 到 0。
 */
export const calibrateSequences = async (target: PgClient): Promise<Record<string, number>> => {
  const done: Record<string, number> = {};
  for (const table of MIGRATION_TABLES) {
    if (!table.identity) continue;
    const column = table.identity;
    const row = await target.query(
      `SELECT COALESCE(MAX(${column}), 0) AS top FROM ${table.name}`,
    );
    const top = Number(row.rows[0]?.top ?? 0);
    if (!Number.isFinite(top) || top <= 0) { done[`${table.name}.${column}`] = 0; continue; }
    const seq = await target.query('SELECT pg_get_serial_sequence($1, $2) AS name', [table.name, column]);
    const name = seq.rows[0]?.name;
    if (typeof name !== 'string' || !name) throw new Error(`${table.name}.${column} 找不到 identity 序列`);
    await target.query('SELECT setval($1, $2, true)', [name, top]);
    done[`${table.name}.${column}`] = top;
  }
  return done;
};
