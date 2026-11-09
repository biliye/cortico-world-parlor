/**
 * 招募快照：给 inbox 用的一份「现在能加入的桌」。
 *
 * 与 TableDiscovery.recruits()/matchables() 的区别是**不逐桌读完整桌面**：
 * 人数用一次子查询拿到，容量在 JS 里按游戏算，避免 100 行候选 × 每桌一次
 * tablePublic 的 N+1。结果只在进程内缓存 30 秒——132 个 Coo 每分钟要的是同一份。
 */
import type { Db } from './db.ts';
import { tableCapacity } from './table-discovery-db.ts';

export interface RecruitCandidate {
  tableId: string;
  room: string;
  roomName: string;
  game: string;
  seats: number;
  capacity: number;
  deadlineAt: number;
  /** 与同厅事件共用的招募版本；Coo 按 tableId:recruitVersion 去重。 */
  recruitVersion: number;
}

interface SnapshotRow {
  table_id: string; room_id: string; room_name: string; game: string;
  recruit_version: number | string; deadline_at: number | string;
  seats: number | string; werewolf_state?: unknown;
}

const WEREWOLF_SEATS = [6, 9, 12];

/** 狼人杀容量按开局人数（6/9/12）定；JSONB 在 PG 是对象、SQLite 是字符串，两种都认。 */
const werewolfCapacity = (state: unknown): number => {
  let value = state;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return 0; }
  }
  if (!value || typeof value !== 'object') return 0;
  const seats = Number((value as { seatCount?: unknown }).seatCount);
  return WEREWOLF_SEATS.includes(seats) ? seats : 0;
};

export class RecruitSnapshot {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private cache?: { at: number; value: RecruitCandidate[] };

  constructor(db: Db, now: () => number = Date.now, ttlMs = 30_000) {
    this.db = db;
    this.now = now;
    this.ttlMs = ttlMs;
  }

  /** 最多给 limit 桌；缓存的是过滤排序后的完整候选，截断在返回时做。 */
  async take(limit = 3): Promise<RecruitCandidate[]> {
    const now = this.now();
    if (!this.cache || now - this.cache.at >= this.ttlMs) {
      this.cache = { at: now, value: await this.query(now) };
    }
    return this.cache.value.slice(0, Math.max(1, limit));
  }

  private async query(now: number): Promise<RecruitCandidate[]> {
    const rows = await this.db.prepare(
      `SELECT t.id AS table_id, t.room_id, r.name AS room_name, t.game,
              d.recruit_version, t.deadline_at,
              (SELECT COUNT(*) FROM table_seats s WHERE s.table_id = t.id AND s.left_at IS NULL) AS seats,
              CASE WHEN t.game = 'werewolf' THEN t.state_json ELSE NULL END AS werewolf_state
         FROM table_discovery d
         JOIN tables t ON t.id = d.table_id
         JOIN rooms r ON r.id = t.room_id
        WHERE d.match_open = 1 AND t.status = 'open' AND t.frozen_at IS NULL
          AND t.deadline_at > ? AND r.visibility = 'public' AND r.archived_at IS NULL
        ORDER BY d.updated_at DESC, t.id
        LIMIT 20`,
    ).all(now) as SnapshotRow[];

    const result: RecruitCandidate[] = [];
    for (const row of rows) {
      const capacity = (row.game === 'werewolf' ? werewolfCapacity(row.werewolf_state) : 0)
        || tableCapacity(row.game);
      const seats = Number(row.seats);
      if (!capacity || seats >= capacity) continue;
      result.push({
        tableId: row.table_id,
        room: row.room_id,
        roomName: row.room_name,
        game: row.game,
        seats,
        capacity,
        deadlineAt: Number(row.deadline_at),
        recruitVersion: Number(row.recruit_version ?? 0),
      });
    }
    // 越接近坐满越优先；同样满的按截止时间早的优先；再并列按桌号，次序写死。
    result.sort((left, right) => (
      right.seats * left.capacity - left.seats * right.capacity
      || left.deadlineAt - right.deadlineAt
      || left.tableId.localeCompare(right.tableId)
    ));
    return result;
  }
}
