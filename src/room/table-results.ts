import type { Db } from './db.ts';
import type { TableSeatResult } from './table-engine.ts';

export const SEAT_RESULTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS table_seat_results (
  table_id TEXT NOT NULL REFERENCES table_finalizations(table_id) ON DELETE CASCADE,
  seat_id TEXT NOT NULL,
  coo_id TEXT REFERENCES coos(id),
  rank INTEGER NOT NULL CHECK (rank > 0),
  team TEXT,
  score INTEGER,
  game TEXT NOT NULL,
  at BIGINT NOT NULL,
  PRIMARY KEY (table_id, seat_id)
);
CREATE INDEX IF NOT EXISTS ix_seat_results_game ON table_seat_results(game, at, table_id);
`;

interface ResultSeat {
  seat_id: string;
  coo_id: string | null;
  is_bot: number;
}

/** 持久化前验证参赛名单、竞赛名次和公开赢家。 */
export function validSeatResults(
  results: readonly TableSeatResult[] | null | undefined,
  seatIds: readonly string[], winners: readonly string[], tie: boolean,
): results is readonly TableSeatResult[] {
  if (!results?.length || results.length !== seatIds.length) return false;
  const unmatched = new Set(seatIds);
  for (const { seatId, rank, score } of results) {
    if (!unmatched.delete(seatId) || !Number.isInteger(rank) || rank < 1 || rank > seatIds.length) return false;
    if (score !== undefined && (!Number.isInteger(score) || score < -2_147_483_648 || score > 2_147_483_647)) return false;
  }
  const ranks = results.map(result => result.rank).sort((a, b) => a - b);
  if (ranks.some((rank, index) => rank !== index + 1 && rank !== ranks[index - 1])) return false;
  const first = results.filter(result => result.rank === 1);
  // 并列第一可同时带 winners 和 tie。无赢家的全桌和局才要求所有席位都排第一。
  return winners.length
    ? first.length === winners.length && first.every(result => winners.includes(result.seatId))
    : tie && first.length === results.length;
}

/** 终局调用者持有牌桌事务。以引擎最终名单排除开打前已离桌的人。 */
export async function writeSeatResults(
  db: Db, tableId: string, game: string, seats: readonly ResultSeat[],
  results: readonly TableSeatResult[], at: number,
): Promise<void> {
  const accounts = new Map(seats.map(seat => [seat.seat_id, seat.is_bot ? null : seat.coo_id]));
  const rowSql = '(?, ?, ?, ?, ?, ?, ?, ?)';
  const params = results.flatMap(({ seatId, rank, team, score }) => [
    tableId, seatId, accounts.get(seatId) ?? null, rank, team ?? null, score ?? null, game, at,
  ]);
  await db.prepare(
    `INSERT INTO table_seat_results(table_id, seat_id, coo_id, rank, team, score, game, at)
     VALUES ${results.map(() => rowSql).join(', ')}`,
  ).run(...params);
}
