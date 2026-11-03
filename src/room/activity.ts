import type { Db } from './db.ts';

/** Only successful user writes renew idle deadlines. Reads, SSE and maintenance never do. */
export async function touchActivity(db: Db, room: string, cooId: string, now: number): Promise<void> {
  if (db.kind !== 'postgres') return; // read-only migration fixtures still use the old schema
  const seat = await db.prepare(`UPDATE room_seats SET business_active_at = GREATEST(business_active_at, ?)
    WHERE room_id = ? AND coo_id = ? AND released_at IS NULL RETURNING id`).get(now, room, cooId);
  if (!seat) throw new Error('席位已经变化，请同步当前位置后重试');
  const updated = await db.prepare(`UPDATE rooms SET business_active_at = GREATEST(business_active_at, ?)
    WHERE id = ? AND archived_at IS NULL RETURNING id`).get(now, room);
  if (!updated) throw new Error('客厅已经归档，请回大厅');
}
