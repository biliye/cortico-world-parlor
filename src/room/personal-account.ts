import type { Db, SqlParam } from './db.ts';

/**
 * 本人跨厅的历史：对局战绩，或收送礼物的流水。
 * 房间只是出处，不是这条查询的权限边界——身份（cooId）才是。
 *
 * 0.38.0 起没有筹码，原来那条「筹码流水」换成了「礼物流水」：
 * 收礼、送礼、喝掉/吃掉都在这条线上，不再有任何金额。
 */
export interface AccountHistoryQuery {
  kind?: 'games' | 'gifts'; game?: string; room?: string;
  from?: number; until?: number; before?: number; limit?: number;
}

export interface AccountHistoryItem {
  id: string; ts: number; room: string; roomName: string;
  kind: string; game?: string; tableId?: string;
  result?: string;
  /** 礼物流水才有：哪件东西、是收到还是送/吃。 */
  itemId?: string; itemName?: string; direction?: 'in' | 'out' | 'used';
  text: string;
}

/** Identity-scoped history. Room is provenance, never the authority for this query. */
export async function personalHistory(db: Db, cooId: string, q: AccountHistoryQuery = {}) {
  const limit = Math.max(1, Math.min(50, Math.trunc(q.limit ?? 20)));
  const kind = q.kind ?? 'games';
  if (!['games', 'gifts'].includes(kind)) throw new Error('记录类型无效');
  for (const value of [q.from, q.until, q.before, q.limit]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error('时间、游标或数量无效');
  }
  if (q.from !== undefined && q.until !== undefined && q.from >= q.until) throw new Error('结束时间须晚于开始时间');
  const params: SqlParam[] = [cooId, cooId, cooId, cooId];
  const clauses = [`(e.from_coo_id=? OR e.to_coo_id=? OR EXISTS(SELECT 1 FROM ledger_participants p WHERE p.entry_id=e.id AND p.coo_id=?)
    OR EXISTS(SELECT 1 FROM ledger_winners w WHERE w.entry_id=e.id AND w.coo_id=?))`];
  if (kind === 'games') clauses.push("e.kind='game'");
  else clauses.push("e.kind IN ('gift','gift_used')");
  for (const [value, sql] of [[q.game, 'e.game=?'], [q.room, 'e.room_id=?'], [q.from, 'e.ts>=?'],
    [q.until, 'e.ts<?'], [q.before, 'e.ord<?']] as const) {
    if (value !== undefined && value !== '') { clauses.push(sql); params.push(value); }
  }
  const rows = await db.prepare(`SELECT e.ord,e.id,e.ts,e.room_id,e.game,e.kind,e.text,r.name AS room_name,
    e.data_json->>'tableId' AS table_id,
    e.data_json->>'itemId' AS item_id,
    e.data_json->>'itemName' AS item_name,
    e.to_coo_id AS to_coo_id,
    CASE WHEN EXISTS(SELECT 1 FROM ledger_winners w WHERE w.entry_id=e.id AND w.coo_id=?)
      THEN CASE WHEN e.data_json->>'tie'='true' THEN 'draw' ELSE 'win' END ELSE 'loss' END AS result
    FROM ledger_entries e LEFT JOIN rooms r ON r.id=e.room_id
    WHERE ${clauses.join(' AND ')} ORDER BY e.ord DESC LIMIT ?`)
    .all(cooId, ...params, limit + 1) as {
      ord: number; id: string; ts: number; room_id: string; game: string; kind: string;
      text: string; room_name: string | null; table_id: string | null;
      item_id: string | null; item_name: string | null;
      to_coo_id: string | null; result: string;
    }[];
  const items = rows.slice(0, limit).map((row): AccountHistoryItem => ({
    id: row.id, ts: Number(row.ts), room: row.room_id, roomName: row.room_name ?? row.room_id,
    kind: row.kind, game: row.game, ...(row.table_id ? { tableId: row.table_id } : {}),
    ...(kind === 'games' ? { result: row.result } : {}),
    ...(row.item_id ? { itemId: row.item_id } : {}),
    ...(row.item_name ? { itemName: row.item_name } : {}),
    ...(kind === 'gifts'
      ? { direction: row.kind === 'gift_used' ? 'used' as const : row.to_coo_id === cooId ? 'in' as const : 'out' as const }
      : {}),
    text: row.text,
  }));
  return { items, next: rows.length > limit ? Number(rows[limit - 1]!.ord) : null };
}
