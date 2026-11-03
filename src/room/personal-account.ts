import type { Db, SqlParam } from './db.ts';

export interface AccountHistoryQuery {
  kind?: 'games' | 'chips'; game?: string; room?: string;
  from?: number; until?: number; before?: number; limit?: number;
}

/** Identity-scoped history. Room is provenance, never the authority for this query. */
export async function personalHistory(db: Db, cooId: string, q: AccountHistoryQuery = {}) {
  const limit = Math.max(1, Math.min(50, Math.trunc(q.limit ?? 20)));
  const kind = q.kind ?? 'games';
  if (!['games', 'chips'].includes(kind)) throw new Error('记录类型无效');
  for (const value of [q.from, q.until, q.before, q.limit]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error('时间、游标或数量无效');
  }
  if (q.from !== undefined && q.until !== undefined && q.from >= q.until) throw new Error('结束时间须晚于开始时间');
  const params: SqlParam[] = [cooId, cooId, cooId, cooId];
  const clauses = [`(e.from_coo_id=? OR e.to_coo_id=? OR EXISTS(SELECT 1 FROM ledger_participants p WHERE p.entry_id=e.id AND p.coo_id=?)
    OR EXISTS(SELECT 1 FROM ledger_winners w WHERE w.entry_id=e.id AND w.coo_id=?))`];
  if (kind === 'games') clauses.push("e.kind='game'");
  else { clauses.push('EXISTS(SELECT 1 FROM ledger_transfers tr WHERE tr.entry_id=e.id AND (tr.to_coo_id=? OR tr.from_coo_id=?))'); params.push(cooId, cooId); }
  for (const [value, sql] of [[q.game, 'e.game=?'], [q.room, 'e.room_id=?'], [q.from, 'e.ts>=?'],
    [q.until, 'e.ts<?'], [q.before, 'e.ord<?']] as const) {
    if (value !== undefined && value !== '') { clauses.push(sql); params.push(value); }
  }
  const rows = await db.prepare(`SELECT e.ord,e.id,e.ts,e.room_id,e.game,e.kind,e.text,r.name AS room_name,
    e.data_json->>'tableId' AS table_id,
    CASE WHEN EXISTS(SELECT 1 FROM ledger_winners w WHERE w.entry_id=e.id AND w.coo_id=?)
      THEN CASE WHEN e.data_json->>'tie'='true' THEN 'draw' ELSE 'win' END ELSE 'loss' END AS result,
    COALESCE((SELECT SUM(CASE WHEN tr.to_coo_id=? THEN tr.amount ELSE 0 END - CASE WHEN tr.from_coo_id=? THEN tr.amount ELSE 0 END)
      FROM ledger_transfers tr JOIN ledger_entries le ON le.id=tr.entry_id
      WHERE le.id=e.id ${kind === 'games' ? "OR le.effect_id IN ((e.data_json->>'tableId') || '/ante', (e.data_json->>'tableId') || '/refund')" : ''}),0) AS chips
    FROM ledger_entries e LEFT JOIN rooms r ON r.id=e.room_id
    WHERE ${clauses.join(' AND ')} ORDER BY e.ord DESC LIMIT ?`)
    .all(cooId, cooId, cooId, ...params, limit + 1) as {
      ord: number; id: string; ts: number; room_id: string; game: string; kind: string;
      text: string; room_name: string | null; table_id: string | null; result: string; chips: number;
    }[];
  const items = rows.slice(0, limit).map(row => ({
    id: row.id, ts: Number(row.ts), room: row.room_id, roomName: row.room_name ?? row.room_id,
    kind: row.kind, game: row.game, tableId: row.table_id,
    ...(kind === 'games' ? { result: row.result } : {}), chips: Number(row.chips), text: row.text,
  }));
  return { items, next: rows.length > limit ? Number(rows[limit - 1]!.ord) : null };
}
