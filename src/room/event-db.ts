/**
 * 每客厅的事件流 + 可见性查询。
 *
 * `rooms.seq` 是房内游标；不同客厅各自从 1 开始，绝不互比。
 * 公开事件（room/hall）按席位可见区间过滤；私聊/牌桌事件额外写 `event_audience`，
 * 按 cooId 授权——同一个 Coo 重进换 seat 仍能看自己过去的私聊/桌聊，但看不到别人。
 */
import { withTransaction, type Db } from './db.ts';
import type { RoomEvent, Scope } from './protocol.ts';

export interface EventAudience {
  cooId: string;
  seatId?: string;
}

export interface AppendEventInput {
  type: string;
  ts: number;
  /** 发件席位 id；系统事件是 `system`。 */
  from: string;
  fromKind?: 'seat' | 'coo' | 'system';
  scope: Scope;
  text: string;
  mentions?: string[];
  data?: Record<string, unknown>;
  /** seat/table scope 的收件人；不传时按 room_seats 反查。 */
  audience?: EventAudience[];
}

export interface EventInterval {
  visibleFromSeq: number;
  visibleUntilSeq?: number | null;
}

export interface EventQuery {
  cooId: string;
  interval?: EventInterval;
  since?: number;
  limit?: number;
}

interface EventRow {
  room_id: string;
  seq: number;
  ts: number;
  type: string;
  from_kind: string;
  from_id: string;
  scope_kind: string;
  scope_seat_id: string | null;
  scope_table_id: string | null;
  scope_seats_json: string | null;
  text: string;
  mentions_json: string | null;
  data_json: string | null;
}

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

const scopeOf = (row: EventRow): Scope => {
  if (row.scope_kind === 'hall') return { kind: 'hall' };
  if (row.scope_kind === 'seat' && row.scope_seat_id) return { kind: 'seat', seatId: row.scope_seat_id };
  if (row.scope_kind === 'table' && row.scope_table_id) {
    const seats = parseJson<unknown>(row.scope_seats_json, []);
    return {
      kind: 'table',
      tableId: row.scope_table_id,
      seats: Array.isArray(seats) ? seats.filter((seat): seat is string => typeof seat === 'string') : [],
    };
  }
  return { kind: 'room' };
};

const eventOf = (row: EventRow): RoomEvent => {
  const mentions = parseJson<unknown>(row.mentions_json, undefined);
  const data = parseJson<Record<string, unknown> | undefined>(row.data_json, undefined);
  return {
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    from: row.from_id,
    scope: scopeOf(row),
    text: row.text,
    ...(Array.isArray(mentions) ? { mentions: mentions.filter((item): item is string => typeof item === 'string') } : {}),
    ...(data && typeof data === 'object' && !Array.isArray(data) ? { data } : {}),
  };
};

const clampLimit = (value: number | undefined, fallback = 50): number => (
  Math.max(1, Math.min(200, Math.trunc(value ?? fallback) || fallback))
);

export class EventDb {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  latest(roomId: string): number {
    const row = this.db.prepare('SELECT seq FROM rooms WHERE id = ?').get(roomId) as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  count(roomId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE room_id = ?').get(roomId) as { n: number };
    return row.n;
  }

  append(roomId: string, input: AppendEventInput): RoomEvent {
    return withTransaction(this.db, () => {
      const updated = this.db.prepare(
        'UPDATE rooms SET seq = seq + 1, last_active_at = MAX(last_active_at, ?) WHERE id = ?',
      ).run(input.ts, roomId);
      if (Number(updated.changes) === 0) throw new Error(`客厅不存在：${roomId}`);
      const seq = this.latest(roomId);

      const scope = input.scope;
      const scopeSeatId = scope.kind === 'seat' ? scope.seatId : null;
      const scopeTableId = scope.kind === 'table' ? scope.tableId : null;
      const scopeSeatsJson = scope.kind === 'table' ? JSON.stringify(scope.seats) : null;
      const fromKind = input.fromKind ?? (input.from === 'system' ? 'system' : 'seat');

      this.db.prepare(
        `INSERT INTO events(
           room_id, seq, ts, type, from_kind, from_id, scope_kind, scope_seat_id,
           scope_table_id, scope_seats_json, text, mentions_json, data_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        roomId,
        seq,
        input.ts,
        input.type,
        fromKind,
        input.from,
        scope.kind,
        scopeSeatId,
        scopeTableId,
        scopeSeatsJson,
        input.text,
        input.mentions && input.mentions.length > 0 ? JSON.stringify(input.mentions) : null,
        input.data === undefined ? null : JSON.stringify(input.data),
      );

      if (scope.kind === 'seat' || scope.kind === 'table') {
        const audience = new Map<string, EventAudience>();
        for (const item of input.audience ?? []) {
          if (item.cooId) audience.set(item.cooId, item);
        }
        const lookup = this.db.prepare(
          'SELECT coo_id FROM room_seats WHERE room_id = ? AND id = ?',
        );
        if (scope.kind === 'seat') {
          const seat = lookup.get(roomId, scope.seatId) as { coo_id: string } | undefined;
          if (seat) audience.set(seat.coo_id, { cooId: seat.coo_id, seatId: scope.seatId });
        } else {
          for (const seatId of scope.seats) {
            const seat = lookup.get(roomId, seatId) as { coo_id: string } | undefined;
            if (seat) audience.set(seat.coo_id, { cooId: seat.coo_id, seatId });
          }
        }
        const insert = this.db.prepare(
          'INSERT OR IGNORE INTO event_audience(room_id, seq, coo_id, seat_id) VALUES (?, ?, ?, ?)',
        );
        for (const item of audience.values()) insert.run(roomId, seq, item.cooId, item.seatId ?? null);
      }

      return {
        seq,
        ts: input.ts,
        type: input.type,
        from: input.from,
        scope,
        text: input.text,
        ...(input.mentions && input.mentions.length > 0 ? { mentions: input.mentions } : {}),
        ...(input.data === undefined ? {} : { data: input.data }),
      };
    });
  }

  /** 从旧到新，`since` 之后、可见区间内、该 coo 有权看的事件。 */
  history(roomId: string, query: EventQuery): RoomEvent[] {
    return this.select(roomId, query, 'ASC');
  }

  /** 最近 N 条可见事件，仍按旧到新返回。 */
  recent(roomId: string, query: EventQuery): RoomEvent[] {
    return this.select(roomId, query, 'DESC').reverse();
  }

  /**
   * 回放：这个客厅里某个 coo 历来有权看的全部事件（不受某一次席位的可见区间限制）。
   * 公开事件人人可见；私聊/桌聊按 append 时写下的 event_audience 授权。
   * `before` 之前的最后 N 条，按旧到新返回。
   */
  replay(roomId: string, query: { cooId: string; before?: number; limit?: number }): { events: RoomEvent[]; older: boolean } {
    const limit = clampLimit(query.limit, 50);
    const before = query.before && query.before > 0 ? query.before : null;
    const rows = this.db.prepare(
      `SELECT e.* FROM events e
       LEFT JOIN event_audience a
         ON a.room_id = e.room_id AND a.seq = e.seq AND a.coo_id = ?
       WHERE e.room_id = ?
         AND (? IS NULL OR e.seq < ?)
         AND (e.scope_kind IN ('room','hall') OR a.coo_id IS NOT NULL)
       ORDER BY e.seq DESC
       LIMIT ?`,
    ).all(query.cooId, roomId, before, before, limit + 1) as unknown as EventRow[];
    const older = rows.length > limit;
    const events = rows.slice(0, limit).map(eventOf).reverse();
    return { events, older };
  }

  private select(roomId: string, query: EventQuery, order: 'ASC' | 'DESC'): RoomEvent[] {
    const from = Math.max(query.since ?? 0, query.interval?.visibleFromSeq ?? 0);
    const until = query.interval?.visibleUntilSeq ?? null;
    const limit = clampLimit(query.limit);
    const rows = this.db.prepare(
      `SELECT e.* FROM events e
       LEFT JOIN event_audience a
         ON a.room_id = e.room_id AND a.seq = e.seq AND a.coo_id = ?
       WHERE e.room_id = ?
         AND e.seq > ?
         AND (? IS NULL OR e.seq <= ?)
         AND (e.scope_kind IN ('room','hall') OR a.coo_id IS NOT NULL)
       ORDER BY e.seq ${order}
       LIMIT ?`,
    ).all(query.cooId, roomId, from, until, until, limit) as unknown as EventRow[];
    return rows.map(eventOf);
  }
}
