/**
 * 每客厅的事件流 + 可见性查询。
 *
 * `rooms.seq` 是房内游标；不同客厅各自从 1 开始，绝不互比。
 * 公开事件（room/hall）按席位可见区间过滤；私聊/牌桌事件额外写 `event_audience`，
 * 按 cooId 授权——同一个 Coo 重进换 seat 仍能看自己过去的私聊/桌聊，但看不到别人。
 *
 * 追加是「rooms.seq +1 → 读回新 seq → 写事件 → 写收件人」一个事务。
 * PostgreSQL 下这条语句串行化靠 rooms 行锁（UPDATE 自带行锁）；
 * 两个并发 append 会排队，后一个读到的是前一个提交后的 seq。
 */
import { withTransaction, type Db } from './db.ts';
import type { RoomEvent, Scope } from './protocol.ts';
import { jsonObject, jsonValue } from './storage/json.ts';
import { touchActivity } from './activity.ts';

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
  scope_seats_json: unknown;
  text: string;
  mentions_json: unknown;
  data_json: unknown;
}

const scopeOf = (row: EventRow): Scope => {
  if (row.scope_kind === 'hall') return { kind: 'hall' };
  if (row.scope_kind === 'seat' && row.scope_seat_id) return { kind: 'seat', seatId: row.scope_seat_id };
  if (row.scope_kind === 'table' && row.scope_table_id) {
    const seats = jsonValue<unknown>(row.scope_seats_json, []);
    return {
      kind: 'table',
      tableId: row.scope_table_id,
      seats: Array.isArray(seats) ? seats.filter((seat): seat is string => typeof seat === 'string') : [],
    };
  }
  return { kind: 'room' };
};

const eventOf = (row: EventRow): RoomEvent => {
  const mentions = jsonValue<unknown>(row.mentions_json, undefined);
  const data = jsonObject<Record<string, unknown>>(row.data_json);
  return {
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    from: row.from_id,
    scope: scopeOf(row),
    text: row.text,
    ...(Array.isArray(mentions) ? { mentions: mentions.filter((item): item is string => typeof item === 'string') } : {}),
    ...(data ? { data } : {}),
  };
};

const clampLimit = (value: number | undefined, fallback = 50): number => (
  Math.max(1, Math.min(200, Math.trunc(value ?? fallback) || fallback))
);

export class EventDb {
  private readonly db: Db;
  /** 提交之后通知网关「这个客厅有新事件」，推送不用等 400ms 节拍。 */
  private readonly onAppend?: () => void;

  constructor(db: Db, onAppend?: () => void) {
    this.db = db;
    this.onAppend = onAppend;
  }

  async latest(roomId: string): Promise<number> {
    const row = await this.db.prepare('SELECT seq FROM rooms WHERE id = ?').get(roomId) as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  async count(roomId: string): Promise<number> {
    const row = await this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE room_id = ?').get(roomId) as { n: number };
    return row.n;
  }

  append(roomId: string, input: AppendEventInput): Promise<RoomEvent> {
    return withTransaction(this.db, async () => {
      // MAX(a,b) 是 SQLite 的标量写法，PG 没有；CASE 两边都认。
      const updated = await this.db.prepare(
        `UPDATE rooms
            SET seq = seq + 1,
                last_active_at = CASE WHEN last_active_at > ? THEN last_active_at ELSE ? END
          WHERE id = ?`,
      ).run(input.ts, input.ts, roomId);
      if (Number(updated.changes) === 0) throw new Error(`客厅不存在：${roomId}`);
      const seq = await this.latest(roomId);

      if (input.from !== 'system' && input.type !== 'parlor.left') {
        const actor = await this.db.prepare('SELECT coo_id FROM room_seats WHERE room_id=? AND id=? AND released_at IS NULL')
          .get(roomId, input.from) as { coo_id: string } | undefined;
        if (actor) await touchActivity(this.db, roomId, actor.coo_id, input.ts);
      }

      const scope = input.scope;
      const scopeSeatId = scope.kind === 'seat' ? scope.seatId : null;
      const scopeTableId = scope.kind === 'table' ? scope.tableId : null;
      const scopeSeatsJson = scope.kind === 'table' ? JSON.stringify(scope.seats) : null;
      const fromKind = input.fromKind ?? (input.from === 'system' ? 'system' : 'seat');

      await this.db.prepare(
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
          const seat = await lookup.get(roomId, scope.seatId) as { coo_id: string } | undefined;
          if (seat) audience.set(seat.coo_id, { cooId: seat.coo_id, seatId: scope.seatId });
        } else {
          if (scope.seats.length > 0) {
            const rows = await this.db.prepare(`SELECT id,coo_id FROM room_seats WHERE room_id=? AND id IN (${scope.seats.map(() => '?').join(',')})`)
              .all(roomId, ...scope.seats) as { id: string; coo_id: string }[];
            for (const seat of rows) audience.set(seat.coo_id, { cooId: seat.coo_id, seatId: seat.id });
          }
        }
        const items = [...audience.values()];
        if (items.length > 0) {
          await this.db.prepare(`INSERT INTO event_audience(room_id, seq, coo_id, seat_id) VALUES
            ${items.map(() => '(?,?,?,?)').join(',')} ON CONFLICT DO NOTHING`)
            .run(...items.flatMap(item => [roomId, seq, item.cooId, item.seatId ?? null]));
        }
      }

      // 提交成功后通知网关（回滚时这条登记会被丢掉）。
      this.db.afterCommit(() => this.onAppend?.());
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
  history(roomId: string, query: EventQuery): Promise<RoomEvent[]> {
    return this.select(roomId, query, 'ASC');
  }

  /** 最近 N 条可见事件，仍按旧到新返回。 */
  async recent(roomId: string, query: EventQuery): Promise<RoomEvent[]> {
    return (await this.select(roomId, query, 'DESC')).reverse();
  }

  /**
   * 清理：删掉早于 beforeTs、且不在最后 keep 条里的事件。
   * 回放是 7 天，所以保留期与「最后 keep 条」两个条件同时满足才删。
   */
  async prune(roomId: string, beforeTs: number, keep = 500): Promise<number> {
    const result = await this.db.prepare(
      `DELETE FROM events
        WHERE room_id = ?
          AND ts < ?
          AND seq < (SELECT COALESCE(MAX(seq), 0) - ? FROM events WHERE room_id = ?)`,
    ).run(roomId, beforeTs, keep, roomId);
    return Number(result.changes);
  }

  /**
   * 回放：这个客厅里某个 coo 历来有权看的全部事件。
   * 公开事件只给「那一次到访区间覆盖到的事件」——历次到访的区间取并集（长期成员资格
   * 不等于能看不在场期间的聊天）；私聊/桌聊仍按 append 时写下的 event_audience 授权。
   * `before` 之前的最后 N 条，按旧到新返回。
   */
  async replay(roomId: string, query: { cooId: string; before?: number; limit?: number }): Promise<{ events: RoomEvent[]; older: boolean }> {
    const limit = clampLimit(query.limit, 50);
    const before = query.before && query.before > 0 ? query.before : null;
    const rows = await this.db.prepare(
      `SELECT e.* FROM events e
       LEFT JOIN event_audience a
         ON a.room_id = e.room_id AND a.seq = e.seq AND a.coo_id = ?
       WHERE e.room_id = ?
         AND (e.seq < COALESCE(?, 2147483647))
         AND (
           (e.scope_kind IN ('room','hall') AND EXISTS (
             SELECT 1 FROM room_seats s
              WHERE s.room_id = e.room_id AND s.coo_id = ?
                AND e.seq > s.visible_from_seq
                AND (s.visible_to_seq IS NULL OR e.seq <= s.visible_to_seq)
           ))
           OR (e.scope_kind NOT IN ('room','hall') AND a.coo_id IS NOT NULL)
         )
       ORDER BY e.seq DESC
       LIMIT ?`,
    ).all(query.cooId, roomId, before, query.cooId, limit + 1) as unknown as EventRow[];
    const older = rows.length > limit;
    const events = rows.slice(0, limit).map(eventOf).reverse();
    return { events, older };
  }

  private async select(roomId: string, query: EventQuery, order: 'ASC' | 'DESC'): Promise<RoomEvent[]> {
    const from = Math.max(query.since ?? 0, query.interval?.visibleFromSeq ?? 0);
    const until = query.interval?.visibleUntilSeq ?? null;
    const limit = clampLimit(query.limit);
    const rows = await this.db.prepare(
      `SELECT e.* FROM events e
       LEFT JOIN event_audience a
         ON a.room_id = e.room_id AND a.seq = e.seq AND a.coo_id = ?
       WHERE e.room_id = ?
         AND e.seq > ?
         AND (e.seq <= COALESCE(?, 2147483647))
         AND (e.scope_kind IN ('room','hall') OR a.coo_id IS NOT NULL)
       ORDER BY e.seq ${order}
       LIMIT ?`,
    ).all(query.cooId, roomId, from, until, limit) as unknown as EventRow[];
    return rows.map(eventOf);
  }
}
