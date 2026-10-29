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
  const stmt = db.prepare(
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  stmt.run('schema_version', '1');
  stmt.run('storage_mode', 'sqlite');
};

/**
 * 写事务：BEGIN IMMEDIATE，成功 COMMIT，失败 ROLLBACK。
 * 事务里不要 await 网络/文件；提交后再广播事件。
 */
export const withTransaction = <T>(db: Db, fn: () => T): T => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 已经回滚/连接坏了 */ }
    throw error;
  }
};
