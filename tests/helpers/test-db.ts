/**
 * 测试用的库工厂。
 *
 * 默认是 SQLite 内存库（快）。设了 `PARLOR_TEST_PG=1` 时换成工位内的
 * 嵌入式 PostgreSQL（`tests/helpers/pg.ts` 负责起停），同一套测试跑两种后端。
 * 设了 `PARLOR_TEST_PG_URL` 时直接用外部 PG。
 *
 * 用法：
 *   let db: Db;
 *   beforeEach(async () => { db = await openTestDb(); });
 *   afterEach(async () => { await closeTestDb(db); });
 *
 * 传文件路径的测试（重启续用同一库）在 SQLite 下就是同一个文件；
 * PG 下会按文件路径映射成同一个库名。
 */
import { migrate, openDb, type Db } from '../../src/room/db.ts';
import { closePgTestDb, openPgTestDb, pgTestEnabled } from './pg.ts';

export const openTestDb = async (file = ':memory:'): Promise<Db> => {
  if (pgTestEnabled()) return openPgTestDb(file);
  const db = openDb(file);
  await migrate(db);
  return db;
};

export const closeTestDb = async (db: Db): Promise<void> => {
  if (pgTestEnabled()) {
    await closePgTestDb(db);
    return;
  }
  await db.close();
};
