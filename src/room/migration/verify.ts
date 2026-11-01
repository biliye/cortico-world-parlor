/**
 * 导入之后的核验。
 *
 * 两层：
 * 1. 逐行摘要：两边按主键同序读出来，把每一行规范成同一个字符串（JSON 按键排序、
 *    数字统一成字符串），算一条 sha256。行数一样不代表内容一样，这一层才管内容。
 * 2. 语义对照：余额、胜负、未读、活跃席位、房间 seq、事件受众、回执、身份号与票据——
 *    每条都写成同一句可移植 SQL，两边各跑一次，逐项比。差异打印成「谁、哪一项、两边各是多少」，
 *    而不是只丢一句「不一致」。
 */
import { createHash } from 'node:crypto';
import { MIGRATION_TABLES, ROW_FILTERS, targetColumns } from './schema-map.ts';
import type { SourceAudit, SqliteHandle } from './source.ts';
import type { PgClient } from './copy.ts';
import { toPgPlaceholders } from '../storage/translate.ts';

export type RowFilters = Record<string, (row: Record<string, unknown>) => boolean>;

/** 表级过滤：内置的（meta 那两行）+ 这次调用额外指定的（比如本批次的 migration_runs 行）。 */
const filterFor = (table: string, extra: RowFilters): ((row: Record<string, unknown>) => boolean) | undefined => {
  const builtin = ROW_FILTERS[table];
  const mine = extra[table];
  if (builtin && mine) return (row) => builtin(row) || mine(row);
  return mine ?? builtin;
};

export interface TableDigest {
  table: string;
  rows: number;
  digest: string;
}

export interface ContrastRow {
  key: string;
  value: string;
}

export interface ContrastCheck {
  name: string;
  sql: string;
  /** 最多打印几条差异；默认 5。 */
  limit?: number;
}

export interface VerifyReport {
  ok: boolean;
  digests: TableDigest[];
  mismatched: Array<{ table: string; source: { rows: number; digest: string }; target: { rows: number; digest: string } }>;
  contrasts: Array<{ name: string; ok: boolean; differences: Array<{ key: string; source: string | null; target: string | null }> }>;
}

/** JSON 值规范化：对象按键排序、数组保序、数字统一成最短表示。 */
const canonicalJson = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value);
};

/** 非 JSON 列的规范化：PG 的 int8 是字符串、SQLite 是数字，统一成同一种写法。 */
const canonicalScalar = (value: unknown): string => {
  if (value === null || value === undefined) return '\u0000';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? '1' : '0';
  const text = String(value);
  // int8 走字符串：纯整数写法统一成数字写法，别的字符串原样（带引号区分）。
  if (/^-?\d+$/.test(text)) return String(Number(text));
  return JSON.stringify(text);
};

const canonicalRow = (
  columns: string[],
  jsonSet: Set<string>,
  row: Record<string, unknown>,
): string => JSON.stringify(columns.map((column) => {
  const value = row[column];
  if (jsonSet.has(column)) {
    if (value === null || value === undefined) return null;
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return canonicalJson(parsed);
  }
  return canonicalScalar(value);
}));

const keysetPredicate = (keyColumns: string[], paramBase: '?' | '$'): string => {
  if (paramBase === '?') {
    return keyColumns.length === 1
      ? `${keyColumns[0]} > ?`
      : `(${keyColumns.join(', ')}) > (${keyColumns.map(() => '?').join(', ')})`;
  }
  const slots = keyColumns.map((_, index) => `$${index + 1}`);
  return keyColumns.length === 1
    ? `${keyColumns[0]} > $1`
    : `(${keyColumns.join(', ')}) > (${slots.join(', ')})`;
};

export const digestSource = async (
  source: SqliteHandle,
  audit: SourceAudit,
  tableName: string,
  limit = 2_000,
  extraFilters: RowFilters = {},
): Promise<TableDigest | null> => {
  const table = MIGRATION_TABLES.find((entry) => entry.name === tableName);
  if (!table) throw new Error(`不认识的表：${tableName}`);
  if (audit.counts[tableName] === undefined) return null;
  const columns = audit.columns[tableName] ?? [];
  if (columns.length === 0) return null;
  const jsonSet = new Set(table.json ?? []);
  const hash = createHash('sha256');
  const statement = source.prepare(
    `SELECT ${columns.join(', ')} FROM ${tableName}`
    + ` WHERE ${keysetPredicate(table.key, '?')} ORDER BY ${table.key.join(', ')} LIMIT ?`,
  );
  // 第一页没有下界；后续页用键集。
  const first = source.prepare(
    `SELECT ${columns.join(', ')} FROM ${tableName} ORDER BY ${table.key.join(', ')} LIMIT ?`,
  );
  let rows: Record<string, unknown>[] = first.all(limit) as Record<string, unknown>[];
  const skip = filterFor(tableName, extraFilters);
  const digestRows = (page: Record<string, unknown>[]): number => {
    let kept = 0;
    for (const row of page) {
      // 与导入时同一套过滤：meta 里那两行属于目标环境自己，两边都不算。
      if (skip && skip(row)) continue;
      hash.update(canonicalRow(columns, jsonSet, row) + '\n');
      kept += 1;
    }
    return kept;
  };
  let count = digestRows(rows);
  let after: unknown[] | undefined = rows.length > 0
    ? table.key.map((column) => rows[rows.length - 1]![column])
    : undefined;
  while (after && rows.length === limit) {
    rows = statement.all(...(after as (string | number | null)[]), limit) as Record<string, unknown>[];
    if (rows.length === 0) break;
    count += digestRows(rows);
    after = table.key.map((column) => rows[rows.length - 1]![column]);
  }
  return { table: tableName, rows: count, digest: hash.digest('hex') };
};

export const digestTarget = async (
  target: PgClient,
  tableName: string,
  limit = 2_000,
  extraFilters: RowFilters = {},
): Promise<TableDigest | null> => {
  const table = MIGRATION_TABLES.find((entry) => entry.name === tableName);
  if (!table) throw new Error(`不认识的表：${tableName}`);
  const columns = targetColumns().get(tableName) ?? [];
  if (columns.length === 0) return null;
  const jsonSet = new Set(table.json ?? []);
  const hash = createHash('sha256');
  const skip = filterFor(tableName, extraFilters);
  // 与导入时同一套过滤：meta 里那两行属于目标环境自己，两边都不算。
  const digestRows = (page: Record<string, unknown>[]): number => {
    let kept = 0;
    for (const row of page) {
      if (skip && skip(row)) continue;
      hash.update(canonicalRow(columns, jsonSet, row) + '\n');
      kept += 1;
    }
    return kept;
  };
  let count = 0;
  const first = await target.query(
    `SELECT ${columns.join(', ')} FROM ${tableName} ORDER BY ${table.key.join(', ')} LIMIT ${limit}`,
  );
  let rows = first.rows;
  count += digestRows(rows);
  while (rows.length === limit) {
    const after = table.key.map((column) => rows[rows.length - 1]![column]);
    const slots = table.key.map((_, index) => `$${index + 1}`);
    const predicate = table.key.length === 1
      ? `${table.key[0]} > $1`
      : `(${table.key.join(', ')}) > (${slots.join(', ')})`;
    const next = await target.query(
      `SELECT ${columns.join(', ')} FROM ${tableName} WHERE ${predicate}`
      + ` ORDER BY ${table.key.join(', ')} LIMIT ${limit}`,
      after,
    );
    rows = next.rows;
    if (rows.length === 0) break;
    count += digestRows(rows);
  }
  return { table: tableName, rows: count, digest: hash.digest('hex') };
};

/**
 * 语义对照：每条是一句可移植 SQL，返回 (k, v)；两边各跑一遍，逐项比。
 * 这些是「人会去看的东西」——账本余额、战绩、未读、席位、房间进度、回执、身份号。
 */
export const CONTRAST_CHECKS: ContrastCheck[] = [
  {
    name: '账本余额（按身份）',
    sql: `SELECT k, SUM(v) AS v FROM (
            SELECT to_coo_id AS k, amount AS v FROM ledger_transfers
             WHERE to_kind = 'coo' AND to_coo_id IS NOT NULL
            UNION ALL
            SELECT from_coo_id AS k, -amount AS v FROM ledger_transfers
             WHERE from_kind = 'coo' AND from_coo_id IS NOT NULL
          ) GROUP BY k ORDER BY k`,
  },
  {
    name: '局数与胜场（按身份）',
    sql: `SELECT p.coo_id AS k, COUNT(*) AS v
          FROM ledger_participants p JOIN ledger_entries e ON e.id = p.entry_id
          WHERE e.kind = 'game'
          GROUP BY p.coo_id ORDER BY p.coo_id`,
  },
  {
    name: '未读信件（按身份）',
    sql: `SELECT coo_id AS k, COUNT(*) AS v FROM mail WHERE read_at IS NULL GROUP BY coo_id ORDER BY coo_id`,
  },
  {
    name: '活跃席位（按客厅）',
    sql: `SELECT room_id AS k, COUNT(*) AS v FROM room_seats WHERE released_at IS NULL GROUP BY room_id ORDER BY room_id`,
  },
  {
    name: '客厅进度 seq',
    sql: 'SELECT id AS k, seq AS v FROM rooms ORDER BY id',
  },
  {
    name: '事件条数（按客厅）',
    sql: 'SELECT room_id AS k, COUNT(*) AS v FROM events GROUP BY room_id ORDER BY room_id',
  },
  {
    name: '事件受众条数（按客厅）',
    sql: 'SELECT room_id AS k, COUNT(*) AS v FROM event_audience GROUP BY room_id ORDER BY room_id',
  },
  {
    name: '动作回执（按身份）',
    sql: 'SELECT coo_id AS k, COUNT(*) AS v FROM action_receipts GROUP BY coo_id ORDER BY coo_id',
  },
  {
    name: '短号（按身份）',
    sql: 'SELECT coo_id AS k, handle AS v FROM global_handles ORDER BY coo_id',
  },
  {
    name: '身份票据（按 audience）',
    sql: 'SELECT audience AS k, COUNT(*) AS v FROM identity_tickets GROUP BY audience ORDER BY audience',
  },
  {
    name: '进行中的牌局（按客厅）',
    sql: `SELECT room_id AS k, COUNT(*) AS v FROM tables
          WHERE status IN ('open','bidding','playing') GROUP BY room_id ORDER BY room_id`,
  },
  {
    name: '账本条目（按种类）',
    sql: 'SELECT kind AS k, COUNT(*) AS v FROM ledger_entries GROUP BY kind ORDER BY kind',
  },
];

const normalizeContrast = (rows: Record<string, unknown>[]): Map<string, string> => {
  const map = new Map<string, string>();
  for (const row of rows) map.set(String(row.k), canonicalScalar(row.v));
  return map;
};

export const verifyAll = async (
  source: SqliteHandle,
  target: PgClient,
  audit: SourceAudit,
  options: { limit?: number; onTable?: (digest: TableDigest) => void; rowFilters?: RowFilters } = {},
): Promise<VerifyReport> => {
  const digests: TableDigest[] = [];
  const mismatched: VerifyReport['mismatched'] = [];
  const extra = options.rowFilters ?? {};

  for (const table of MIGRATION_TABLES) {
    const left = await digestSource(source, audit, table.name, options.limit, extra);
    const right = await digestTarget(target, table.name, options.limit, extra);
    if (!left && !right) continue;
    if (!left || !right) {
      mismatched.push({
        table: table.name,
        source: left ?? { rows: 0, digest: '' },
        target: right ?? { rows: 0, digest: '' },
      });
      continue;
    }
    digests.push(left);
    options.onTable?.(left);
    if (left.rows !== right.rows || left.digest !== right.digest) {
      mismatched.push({ table: table.name, source: left, target: right });
    }
  }

  const contrasts: VerifyReport['contrasts'] = [];
  for (const check of CONTRAST_CHECKS) {
    let sourceRows: Record<string, unknown>[] = [];
    let targetRows: Record<string, unknown>[] = [];
    try {
      sourceRows = source.prepare(check.sql).all() as Record<string, unknown>[];
    } catch (error) {
      contrasts.push({ name: check.name, ok: false, differences: [{ key: '（来源库查询失败）', source: String(error), target: null }] });
      continue;
    }
    try {
      targetRows = (await target.query(toPgPlaceholders(check.sql))).rows;
    } catch (error) {
      contrasts.push({ name: check.name, ok: false, differences: [{ key: '（目标库查询失败）', source: null, target: String(error) }] });
      continue;
    }
    const before = normalizeContrast(sourceRows);
    const after = normalizeContrast(targetRows);
    const differences: Array<{ key: string; source: string | null; target: string | null }> = [];
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(key) ?? null;
      const b = after.get(key) ?? null;
      if (a !== b) differences.push({ key, source: a, target: b });
    }
    contrasts.push({ name: check.name, ok: differences.length === 0, differences: differences.slice(0, check.limit ?? 5) });
  }

  return {
    ok: mismatched.length === 0 && contrasts.every((entry) => entry.ok),
    digests,
    mismatched,
    contrasts,
  };
};
