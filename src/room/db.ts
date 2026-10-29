/**
 * SQLite 薄适配：只用 node:sqlite 的 DatabaseSync / prepare / exec / 事务。
 *
 * Node >= 22.13 才免 flag；package.json 的 engines 已按这个下限写。
 * 多客厅/账户/账本/信箱都落这一个库；每客厅的事件、席位、牌桌也在这里，
 * 但查询和可见性仍由 RoomKernel/RoomHost 负责。
 */
import { SCHEMA_SQL } from './schema.ts';

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
  const stmt = db.prepare(
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  stmt.run('schema_version', '2');
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
