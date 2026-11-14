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
  parentMessagesOnly?: boolean;
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

// Public events follow historical room visits. Private events follow the audience at write time.
const replayVisibility = `(
  (e.scope_kind IN ('room','hall') AND EXISTS (
    SELECT 1 FROM room_seats s
    WHERE s.room_id = e.room_id AND s.coo_id = ?
      AND e.seq > s.visible_from_seq
      AND (s.visible_to_seq IS NULL OR e.seq <= s.visible_to_seq)
  ))
  OR (e.scope_kind NOT IN ('room','hall') AND a.coo_id IS NOT NULL)
)`;

const replayTableMatch = `(e.scope_table_id = ? OR e.data_json ->> 'tableId' = ?)`;
const replayOwnTurn = `e.scope_kind = 'seat' AND e.type = 'parlor.table.turn'
  AND e.scope_seat_id = a.seat_id AND jsonb_typeof(e.data_json -> 'table') = 'object'`;

export interface TableReplayStep {
  seq: number;
  ts: number;
  type: string;
  text: string;
  revision: number | null;
  hasSnapshot: boolean;
}

interface TableReplayEventQuery {
  cooId: string;
  tableId: string;
  sinceAt: number;
  endedAt: number;
}

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
      const data = await this.presenceData(roomId, input);

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
        data === undefined ? null : JSON.stringify(data),
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
        ...(data === undefined ? {} : { data }),
      };
    });
  }

  /** 房间行锁内判定通知额度；原始事件保留，换席位或重启不会重置20分钟窗口。 */
  private async presenceData(roomId: string, input: AppendEventInput): Promise<AppendEventInput['data']> {
    if (input.type !== 'parlor.joined' && input.type !== 'parlor.left') return input.data;
    const seatId = input.data?.seatId;
    if (typeof seatId !== 'string') return input.data;
    const actor = await this.db.prepare('SELECT coo_id FROM room_seats WHERE room_id=? AND id=?')
      .get(roomId, seatId) as { coo_id: string } | undefined;
    if (!actor) return input.data;
    const recent = await this.db.prepare(`SELECT e.type,e.data_json FROM events e
      JOIN room_seats s ON s.room_id=e.room_id AND s.id=(e.data_json ->> 'seatId')
      WHERE e.room_id=? AND e.ts>? AND s.coo_id=? AND e.type IN ('parlor.joined','parlor.left')`)
      .all(roomId, input.ts - 20 * 60_000, actor.coo_id) as { type: string; data_json: unknown }[];
    const flags = recent.map(row => ({ type: row.type, data: jsonObject<Record<string, unknown>>(row.data_json) }));
    return {
      ...input.data,
      presenceWeb: !flags.some(row => row.data?.presenceWeb !== false),
      presenceCoo: input.type === 'parlor.joined'
        && !flags.some(row => row.type === 'parlor.joined' && row.data?.presenceCoo !== false),
    };
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
    const page = await this.visiblePage(roomId, query, false);
    return { events: page.events.reverse(), older: page.more };
  }

  /** Summaries only. Turn text can include hidden cards, roles and team chat. */
  async replayTable(roomId: string, query: TableReplayEventQuery & { before?: number; limit: number }): Promise<TableReplayStep[]> {
    const rows = await this.db.prepare(
      `SELECT e.seq, e.ts, e.type,
         CASE WHEN e.scope_kind = 'seat' THEN '本人行动记录' ELSE LEFT(e.text, 160) END AS text,
         COALESCE(e.data_json #>> '{table,revision}', e.data_json ->> 'revision') AS revision,
         COALESCE((${replayOwnTurn}), false) AS "hasSnapshot"
       FROM events e
       LEFT JOIN event_audience a ON a.room_id = e.room_id AND a.seq = e.seq AND a.coo_id = ?
       WHERE e.room_id = ? AND e.ts BETWEEN ? AND ? AND e.seq < COALESCE(?, 2147483648::bigint)
         AND ${replayTableMatch} AND ${replayVisibility}
       ORDER BY e.seq DESC LIMIT ?`,
    ).all(query.cooId, roomId, query.sinceAt, query.endedAt, query.before ?? null,
      query.tableId, query.tableId, query.cooId, query.limit) as unknown as Array<Omit<TableReplayStep, 'revision'> & { revision: string | null }>;
    return rows.map(row => ({ ...row, revision: row.revision === null ? null : Number(row.revision) }));
  }

  async replayTableSnapshot(roomId: string, query: TableReplayEventQuery & { seq: number }) {
    const row = await this.db.prepare(
      `SELECT e.ts, e.data_json -> 'table' AS snapshot
       FROM events e
       JOIN event_audience a ON a.room_id = e.room_id AND a.seq = e.seq AND a.coo_id = ?
       WHERE e.room_id = ? AND e.seq = ? AND e.ts BETWEEN ? AND ?
         AND ${replayTableMatch} AND ${replayOwnTurn}`,
    ).get(query.cooId, roomId, query.seq, query.sinceAt, query.endedAt, query.tableId, query.tableId) as
      { ts: number; snapshot: Record<string, unknown> } | undefined;
    return row;
  }

  /** 本机补档：只读 after 后的可见事件，正序分页，与回放共用到访区间/收件人授权。 */
  archive(roomId: string, query: { cooId: string; after: number; limit?: number }): Promise<{ events: RoomEvent[]; more: boolean }> {
    return this.visiblePage(roomId, query, true);
  }

  private async visiblePage(
    roomId: string,
    query: { cooId: string; before?: number; after?: number; limit?: number },
    forward: boolean,
  ): Promise<{ events: RoomEvent[]; more: boolean }> {
    const limit = clampLimit(query.limit, 50);
    const before = query.before && query.before > 0 ? query.before : 2147483647;
    const order = forward ? 'ASC' : 'DESC';
    // Start from the viewer's visits and audience entries. Each visit can use
    // the room/seq index directly. UNION deduplicates overlapping old visits
    // before the page limit, and only the winning rows fetch event payloads.
    const rows = await this.db.prepare(
      `WITH viewer AS (
         SELECT ?::text AS room_id, ?::text AS coo_id,
                ?::bigint AS after_seq, ?::bigint AS before_seq
       ), page AS (
         SELECT visible.seq
         FROM viewer v
         JOIN room_seats s ON s.room_id = v.room_id AND s.coo_id = v.coo_id
         CROSS JOIN LATERAL (
           SELECT e.seq FROM events e
           WHERE e.room_id = v.room_id
             AND e.seq > GREATEST(v.after_seq, s.visible_from_seq)
             AND e.seq < v.before_seq
             AND e.seq <= COALESCE(s.visible_to_seq, 2147483647)
             AND e.scope_kind IN ('room','hall')
           ORDER BY e.seq ${order} LIMIT ?
         ) visible
         UNION
         (SELECT a.seq
          FROM viewer v
          JOIN event_audience a ON a.room_id = v.room_id AND a.coo_id = v.coo_id
          JOIN events e ON e.room_id = a.room_id AND e.seq = a.seq
          WHERE a.seq > v.after_seq AND a.seq < v.before_seq
            AND e.scope_kind NOT IN ('room','hall')
          ORDER BY a.seq ${order} LIMIT ?)
         ORDER BY seq ${order} LIMIT ?
       )
       SELECT e.* FROM page p
       JOIN events e ON e.room_id = (SELECT room_id FROM viewer) AND e.seq = p.seq
       ORDER BY p.seq ${order}`,
    ).all<EventRow>(roomId, query.cooId, query.after ?? 0, before, limit + 1, limit + 1, limit + 1);
    return { events: rows.slice(0, limit).map(eventOf), more: rows.length > limit };
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
         ${query.parentMessagesOnly ? `AND (e.type NOT LIKE 'parlor.table.%' OR e.type = 'parlor.table.say')
           AND (e.type NOT IN ('parlor.joined', 'parlor.left')
                OR (e.data_json -> 'presenceWeb') IS DISTINCT FROM 'false'::jsonb)` : ''}
       ORDER BY e.seq ${order}
       LIMIT ?`,
    ).all(query.cooId, roomId, from, until, limit) as unknown as EventRow[];
    return rows.map(eventOf);
  }
}
