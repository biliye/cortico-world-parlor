/**
 * SQLite → PostgreSQL 的表映射。
 *
 * 只描述「怎么搬」：顺序（外键依赖）、主键（分页与排序）、自增列（导入后校准序列）、
 * JSON 列（TEXT → JSONB）。列清单不在这里手抄一遍，而是从 PG 的 DDL 解析出来——
 * 两边 schema 一旦漂移，先在这里被拦下，不会悄悄漏列。
 */
import { PG_SCHEMA_SQL } from '../storage/pg-schema.ts';

export interface TableMap {
  name: string;
  /** 主键列；分页与「两边逐行比对」都按它排序。 */
  key: string[];
  /** PG 侧的自增列；导入后要 setval 到 MAX。 */
  identity?: string;
  /** SQLite 里是 TEXT、PG 里是 JSONB 的列。 */
  json?: string[];
}

/**
 * 搬运顺序：外键依赖从前到后。`ledger_entries` 的自引用（settle 指向 promise）
 * 靠 `ord` 升序自然满足——引用永远指向更早的条目。
 */
export const MIGRATION_TABLES: TableMap[] = [
  { name: 'meta', key: ['key'] },
  { name: 'coos', key: ['id'] },
  { name: 'accounts', key: ['id'] },
  { name: 'rooms', key: ['id'] },
  { name: 'room_members', key: ['room_id', 'coo_id'] },
  { name: 'room_seats', key: ['room_id', 'id'] },
  { name: 'account_sessions', key: ['id'] },
  { name: 'coo_sessions', key: ['coo_id'] },
  { name: 'events', key: ['room_id', 'seq'], json: ['scope_seats_json', 'mentions_json', 'data_json'] },
  { name: 'event_audience', key: ['room_id', 'seq', 'coo_id'] },
  {
    name: 'ledger_entries',
    key: ['ord'],
    identity: 'ord',
    json: ['data_json'],
  },
  { name: 'ledger_participants', key: ['entry_id', 'coo_id'] },
  { name: 'ledger_winners', key: ['entry_id', 'coo_id'] },
  { name: 'ledger_transfers', key: ['id'], identity: 'id' },
  { name: 'mail', key: ['seq'], identity: 'seq' },
  { name: 'tables', key: ['id'], json: ['state_json'] },
  { name: 'table_seats', key: ['table_id', 'seat_id'] },
  { name: 'active_table_players', key: ['coo_id'] },
  { name: 'action_receipts', key: ['coo_id', 'request_id'], json: ['receipt_json'] },
  { name: 'table_finalizations', key: ['table_id'], json: ['payload_json'] },
  { name: 'room_access', key: ['room_id', 'coo_id'] },
  { name: 'room_invitations', key: ['id'] },
  { name: 'monopoly_requests', key: ['game_id', 'key'], json: ['receipt_json'] },
  { name: 'monopoly_pending', key: ['game_id'], json: ['action_json', 'dice_json'] },
  { name: 'monopoly_signups', key: ['room_id'], json: ['seats_json'] },
  {
    name: 'migration_runs',
    key: ['id'],
    json: ['source_hashes_json', 'counts_json', 'notes_json'],
  },
  { name: 'global_handles', key: ['coo_id'] },
  { name: 'identity_tickets', key: ['token_hash'] },
];

/** 从 PG 的 DDL 里解析出每张表的列名，供「来源库列 === 目标库列」的比对用。 */
export const targetColumns = (): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  const blocks = PG_SCHEMA_SQL.split(/CREATE TABLE IF NOT EXISTS /).slice(1);
  for (const block of blocks) {
    const name = /^([a-z_][a-z0-9_]*)/.exec(block)?.[1];
    if (!name) continue;
    const open = block.indexOf('(');
    const close = block.indexOf('\n);');
    if (open < 0 || close < 0) continue;
    const columns: string[] = [];
    for (const line of block.slice(open + 1, close).split('\n')) {
      // 只认「两个空格 + 列名 + 类型」的行；CHECK / PRIMARY KEY / FOREIGN KEY 都不是列。
      const match = /^ {2}([a-z_][a-z0-9_]*)\s+(?:TEXT|INTEGER|BIGINT|SMALLINT|JSONB)\b/.exec(line);
      if (match) columns.push(match[1]);
    }
    out.set(name, columns);
  }
  return out;
};

/** 表名 → 映射。 */
export const TABLE_BY_NAME = new Map(MIGRATION_TABLES.map((table) => [table.name, table]));

/**
 * 逐行过滤：返回 true = 这一行不搬。
 *
 * `meta` 里有两行是**目标环境自己的**，不能照搬：
 * - `schema_version`：来源是 SQLite 的 6，目标必须留在 PG 的 1，否则新程序会以为
 *   这是一个「比它新」的库直接拒绝启动；
 * - `storage_mode`：由目标库的迁移自己写成 postgres。
 * 其余（`global_identity`、`last_healthy_at`、`invite` 之类）照搬。
 */
export const ROW_FILTERS: Record<string, (row: Record<string, unknown>) => boolean> = {
  meta: (row) => row.key === 'schema_version' || row.key === 'storage_mode',
};
