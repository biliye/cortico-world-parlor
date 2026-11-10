import type { Db } from './db.ts';
import type { TableEvent } from './table-engine.ts';

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

interface Finish {
  rank: number;
  team: string | null;
  score: number | null;
}

function finishOrder(game: string, seatIds: readonly string[], event: TableEvent): Finish[] {
  const data = event.data ?? {};
  if (game === 'monopoly2d' && Array.isArray(data.ranking)) {
    const bySeat = new Map<string, Finish>(data.ranking.map(row => [
      row.seat, { rank: row.rank, team: null, score: row.total },
    ]));
    const ranks = seatIds.map(id => bySeat.get(id));
    if (ranks.every(result => result !== undefined)) return ranks;
  }
  if (game === 'dice' && Array.isArray(data.revealed)) {
    const scoreBySeat = new Map<string, number>(data.revealed.map(row => [row.id, row.total]));
    const totals = seatIds.map(id => scoreBySeat.get(id));
    if (totals.every(score => score !== undefined)) {
      return totals.map(score => ({
        rank: 1 + totals.filter(other => other > score).length,
        team: null,
        score,
      }));
    }
  }
  const winners = new Set(Array.isArray(data.winners) ? data.winners : []);
  const firstCount = seatIds.filter(id => winners.has(id)).length;
  if (!firstCount && data.tie !== true) return [];
  return seatIds.map(id => ({
    rank: firstCount === 0 || winners.has(id) ? 1 : firstCount + 1,
    team: game === 'ddz' ? (id === data.landlord ? 'landlord' : 'farmers') : event.teamBySeat?.[id] ?? null,
    score: null,
  }));
}

/** 终局调用者持有牌桌事务。以引擎最终名单排除开打前已离桌的人。 */
export async function writeSeatResults(
  db: Db, tableId: string, game: string, seats: readonly ResultSeat[],
  seatIds: readonly string[], event: TableEvent, at: number,
): Promise<void> {
  const ranks = finishOrder(game, seatIds, event);
  if (!ranks.length) return;
  const accounts = new Map(seats.map(seat => [seat.seat_id, seat.is_bot ? null : seat.coo_id]));
  const rowSql = '(?, ?, ?, ?, ?, ?, ?, ?)';
  const params = seatIds.flatMap((seatId, i) => {
    const { rank, team, score } = ranks[i]!;
    return [tableId, seatId, accounts.get(seatId) ?? null, rank, team, score, game, at];
  });
  await db.prepare(
    `INSERT INTO table_seat_results(table_id, seat_id, coo_id, rank, team, score, game, at)
     VALUES ${seatIds.map(() => rowSql).join(', ')}`,
  ).run(...params);
}
