/**
 * 数据访问的门面。
 *
 * 具体实现在 storage/ 下：sqlite.ts 把 node:sqlite 包成异步接口，
 * postgres.ts 用 node-postgres 连接池。调用方只认这里的 Db / withTransaction，
 * 看不到后端差异。
 *
 * 迁移（建表）是异步的：开库只建连接，`migrate(db)` 才做 DDL，
 * 服务启动时必须先 await 完迁移再开始接请求。
 */

import type { Db } from './storage/types.ts';

export type { Db, DbKind, PreparedStatement, RunResult, SqlParam } from './storage/types.ts';
export { migrate } from './storage/migrate.ts';
export { SQLITE_SCHEMA_VERSION as SCHEMA_VERSION } from './storage/migrate.ts';

export const isPostgres = (db: Db): boolean => db.kind === 'postgres';

/**
 * 写事务：最外层按后端开事务（SQLite BEGIN IMMEDIATE / PG BEGIN），
 * 嵌套时用 SAVEPOINT。回调必须是异步的——事务里不要 await 网络、模型调用、
 * 文件或 SSE 写入，只做有界的计算和 SQL。
 */
export const withTransaction = <T>(db: Db, fn: () => Promise<T> | T): Promise<T> => (
  db.runInTransaction(() => Promise.resolve().then(fn))
);
