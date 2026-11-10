import { Worker } from 'node:worker_threads';
import type { Db } from '../db.ts';
import type { RankedSeat, Rating } from './bt.ts';
import type { RatingBoard } from './types.ts';

export const MIN_RATING_GAMES = 10;
const CACHE_MS = 30_000;

interface SeatRow {
  table_id: string;
  coo_id: string | null;
  rank: number;
  team: string | null;
  at: number | string;
  name: string | null;
}

interface Snapshot {
  until: number;
  since: number | null;
  names: Map<string, string>;
  groups: Rating[][];
}

function fit(tables: RankedSeat[][]): Promise<Rating[][]> {
  if (tables.length === 0) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      workerData: tables,
      execArgv: ['--experimental-strip-types'],
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => reject(new Error(`等级分计算进程已退出（${code}）`)));
  });
}

export class RatingBoards {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly cache = new Map<string, Snapshot>();
  private readonly pending = new Map<string, Promise<Snapshot>>();

  constructor(db: Db, now: () => number) {
    this.db = db;
    this.now = now;
  }

  invalidate(game: string): void {
    this.cache.delete(game);
    this.pending.delete(game);
  }

  async get(game: string, cooId: string, limit?: number): Promise<RatingBoard> {
    const snapshot = await this.snapshot(game);
    const mine = snapshot.groups.flat().find(row => row.cooId === cooId);
    const groups = snapshot.groups.map(group => {
      let position = 0;
      let lastRating: number | undefined;
      const rows = group.filter(row => row.games >= MIN_RATING_GAMES).map((row, index) => {
        if (row.rating !== lastRating) position = index + 1;
        lastRating = row.rating;
        return {
          name: snapshot.names.get(row.cooId) || '会馆成员',
          position, games: row.games, rating: row.rating, mine: row.cooId === cooId,
        };
      });
      return { rows };
    }).filter(group => group.rows.length > 0)
      .sort((a, b) => b.rows.length - a.rows.length);
    let remaining = limit ?? Infinity;
    const visible: RatingBoard['groups'] = [];
    for (const group of groups) {
      if (remaining === 0) break;
      const rows = group.rows.slice(0, remaining);
      visible.push({ rows });
      remaining -= rows.length;
    }
    return {
      game, since: snapshot.since, minGames: MIN_RATING_GAMES,
      mine: { games: mine?.games ?? 0, rating: mine?.rating ?? null }, groups: visible,
      truncated: Number.isFinite(remaining) && groups.some((group, i) => visible[i]?.rows.length !== group.rows.length),
    };
  }

  private async snapshot(game: string): Promise<Snapshot> {
    const cached = this.cache.get(game);
    if (cached && cached.until > this.now()) return cached;
    const pending = this.pending.get(game);
    if (pending) return pending;
    const read = this.read(game);
    this.pending.set(game, read);
    try {
      const snapshot = await read;
      if (this.pending.get(game) === read) this.cache.set(game, snapshot);
      return snapshot;
    } finally {
      if (this.pending.get(game) === read) this.pending.delete(game);
    }
  }

  private async read(game: string): Promise<Snapshot> {
    const rows = await this.db.prepare(
      `SELECT r.table_id, r.coo_id, r.rank, r.team, r.at, c.display_name AS name
         FROM table_seat_results r LEFT JOIN coos c ON c.id = r.coo_id
        WHERE r.game = ? ORDER BY r.at, r.table_id, r.seat_id`,
    ).all<SeatRow>(game);
    const names = new Map<string, string>();
    const tables = new Map<string, RankedSeat[]>();
    for (const row of rows) {
      const seats = tables.get(row.table_id) ?? [];
      seats.push({ cooId: row.coo_id, rank: row.rank, team: row.team });
      tables.set(row.table_id, seats);
      if (row.coo_id && row.name) names.set(row.coo_id, row.name);
    }
    const groups = await fit([...tables.values()]);
    return {
      until: this.now() + CACHE_MS, since: rows[0] ? Number(rows[0].at) : null, names, groups,
    };
  }
}
