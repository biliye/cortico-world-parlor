import type { Db } from './db.ts';
import { EventDb } from './event-db.ts';
import { HostError } from './host-error.ts';
import { REPLAY_RETENTION_DAYS, REPLAY_RETENTION_MS } from './replay.ts';
import { GAME_RESPONSE_MAX_BYTES } from './table-engine.ts';

export const TABLE_REPLAY_LIMIT = 50;

export interface TableReplayQuery {
  table?: string;
  before?: number;
  limit: number;
  seq?: number;
}

interface ReplayTableRow {
  id: string;
  room_id: string;
  game: string;
  status: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
  final_kind: 'result' | 'refund' | null;
}

// Finished seats are released at settlement. A settled result also records the exact participants.
// That extra check excludes someone who left the waiting table at the same clock tick.
const replayTables = `SELECT t.id, t.room_id, t.game, t.status, t.created_at, t.started_at,
  COALESCE(f.at, t.ended_at) AS ended_at, t.end_reason, f.kind AS final_kind
  FROM tables t LEFT JOIN table_finalizations f ON f.table_id = t.id
  WHERE EXISTS (
    SELECT 1 FROM table_seats s WHERE s.table_id = t.id AND s.coo_id = ?
      AND (s.left_at IS NULL OR s.left_at = COALESCE(f.at, t.ended_at))
  ) AND (f.kind IS DISTINCT FROM 'result' OR jsonb_exists(f.payload_json -> 'participants', ?))`;

function replaySummary(row: ReplayTableRow) {
  return {
    tableId: row.id,
    room: row.room_id,
    game: row.game,
    status: row.final_kind === 'refund' || row.status === 'abandoned' ? 'abandoned' : 'ended',
    startedAt: row.started_at,
    endedAt: row.ended_at,
    ...(row.end_reason ? { endReason: row.end_reason } : {}),
  };
}

export async function readTableReplay(
  db: Db, cooId: string, query: TableReplayQuery, now: number, envelope: Record<string, unknown>,
) {
  const cutoff = now - REPLAY_RETENTION_MS;
  const base = { ...envelope, retentionDays: REPLAY_RETENTION_DAYS };
  if (query.table === undefined) {
    const rows = await db.prepare(
      `${replayTables} AND t.status IN ('ended','abandoned') AND t.started_at IS NOT NULL
         AND COALESCE(f.at, t.ended_at) >= ?
       ORDER BY ended_at DESC, t.id DESC LIMIT ?`,
    ).all(cooId, cooId, cutoff, query.limit) as unknown as ReplayTableRow[];
    return { ...base, replays: rows.map(replaySummary) };
  }

  const row = await db.prepare(`${replayTables} AND t.id = ?`).get(cooId, cooId, query.table) as ReplayTableRow | undefined;
  if (!row) throw new HostError('not_found', '找不到你的这局回放');
  if (row.status !== 'ended' && row.status !== 'abandoned') throw new HostError('conflict', '牌局还在进行，结算后才能回看');
  if (row.started_at === null || row.ended_at === null) throw new HostError('not_found', '这张桌没有开局回放');
  if (row.ended_at < cutoff) throw new HostError('gone', `这局已超出 ${REPLAY_RETENTION_DAYS} 天回放保留期`);

  const eventDb = new EventDb(db);
  const events = { cooId, tableId: row.id, sinceAt: Math.max(cutoff, row.created_at), endedAt: row.ended_at };
  if (query.seq !== undefined) {
    const step = await eventDb.replayTableSnapshot(row.room_id, { ...events, seq: query.seq });
    if (!step) throw new HostError('not_found', '这一步没有你的私视图');
    return { ...base, tableId: row.id, seq: query.seq, ts: step.ts, snapshot: step.snapshot };
  }

  const seats = await db.prepare(
    `SELECT s.seat_id AS "seatId", COALESCE(r.name, CASE WHEN s.is_bot = 1 THEN '陪练' ELSE s.seat_id END) AS name
     FROM table_seats s LEFT JOIN room_seats r ON r.room_id = s.room_id AND r.id = s.seat_id
     WHERE s.table_id = ? AND (s.left_at IS NULL OR s.left_at = ?) ORDER BY s.position`,
  ).all(row.id, row.ended_at) as unknown as Array<{ seatId: string; name: string }>;
  const table = { ...replaySummary(row), seats, partial: row.started_at < cutoff };
  const recent = await eventDb.replayTable(row.room_id, { ...events, before: query.before, limit: query.limit + 1 });
  const steps = [];
  // Reserve the actual envelope plus space for the largest possible cursor.
  let bytes = Buffer.byteLength(JSON.stringify({ ...base, table, steps: [], older: false, nextBefore: Number.MAX_SAFE_INTEGER }));
  for (const step of recent.slice(0, query.limit)) {
    bytes += Buffer.byteLength(JSON.stringify(step)) + 1;
    if (bytes > GAME_RESPONSE_MAX_BYTES) break;
    steps.push(step);
  }
  const older = recent.length > steps.length;
  const nextBefore = older ? steps.at(-1)?.seq ?? null : null;
  return { ...base, table, steps: steps.reverse(), older, nextBefore };
}
