/**
 * 行锁与资源顺序。
 *
 * SQLite 只有单写者，`BEGIN IMMEDIATE` 已经把整笔事务独占，不需要（也不支持）
 * `FOR UPDATE`。PostgreSQL 下 `BEGIN` 不会挡住并发事务，所以凡是
 * 「先读再据此写」的地方都要显式锁住那一行。
 *
 * 统一顺序（方案 §4.3）：身份按 id 排序 → 房间按 id 排序 → 牌桌按 id 排序。
 * 一次事务里只按这个顺序取锁，避免死锁。
 */

import type { Db } from './types.ts';

/** 锁住这些 coo 行（按 id 排序，避免 AB/BA 死锁）。SQLite 下是空操作。 */
export const lockCooRows = async (db: Db, cooIds: Array<string | null | undefined>): Promise<void> => {
  if (db.kind !== 'postgres') return;
  const ids = [...new Set(cooIds.filter((id): id is string => typeof id === 'string' && id.length > 0))].sort();
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  await db.prepare(`SELECT id FROM coos WHERE id IN (${placeholders}) ORDER BY id FOR UPDATE`).all(...ids);
};

/** 锁住房间行并返回最新序号（入座/开桌/归档前用）。 */
export const lockRoomRow = async (db: Db, roomId: string): Promise<void> => {
  if (db.kind !== 'postgres') return;
  await db.prepare('SELECT id FROM rooms WHERE id = ? FOR UPDATE').get(roomId);
};

/**
 * 锁住牌桌行并读回「库里已提交的 revision」。
 * 调用方拿它和内存里的 revision 比对：不一致说明别的写者已经推进过，
 * 不能拿旧草稿直接提交。SQLite 下同样读回，但由 BEGIN IMMEDIATE 保证不被插队。
 */
export const lockTableRow = async (db: Db, tableId: string): Promise<number | undefined> => {
  const sql = db.kind === 'postgres'
    ? 'SELECT revision FROM tables WHERE id = ? FOR UPDATE'
    : 'SELECT revision FROM tables WHERE id = ?';
  const row = await db.prepare(sql).get(tableId) as { revision?: number } | undefined;
  return typeof row?.revision === 'number' ? row.revision : undefined;
};
