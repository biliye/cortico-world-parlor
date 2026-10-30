/**
 * 全局信箱的 SQLite store。
 *
 * 与 mail.ts 的 JSON 版是同一组语义：
 * - 已读按「每一封」记在 mail.read_at；没有 coo 级已读游标。
 * - `room` 只是来源/筛选，先读 B 厅不会吞掉 A 厅更早的未读。
 * - 对外只给 MailView，不带收件人 cooId。
 *
 * 表结构见 schema.ts；写入沿用 db.ts 的 withTransaction。
 * 外层已经开了事务时（例如私聊 + 账本 + 信箱要一个事务），这里直接并入，
 * 不再套一层 BEGIN。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { migrate, openDb, withTransaction, type Db } from './db.ts';
import type { MailItem, MailKind, MailPage, MailView } from './mail.ts';

/** 投递一封新信时需要的字段；id/seq/ts/read 由 store 填。 */
export type MailInput = Omit<MailItem, 'id' | 'seq' | 'ts' | 'read'>;

export interface DmThreadSummary {
  peer: string;
  lastSeq: number;
  lastTs: number;
  lastText: string;
  lastFromMe: boolean;
  unread: number;
}

export interface DmThreadMessage {
  seq: number;
  ts: number;
  text: string;
  fromName: string;
  fromMe: boolean;
  unread: boolean;
}

export interface MailDbOptions {
  now?: () => number;
}

/** unreadPage 的一页；nextAfter 交给下一次调用继续翻。 */
export interface UnreadPage extends MailPage {
  /** 下一页的起点；null 表示这已经是最后一页。 */
  nextAfter: number | null;
}

/** 旧 mail.json 的结构，只保留迁移用得到的字段。 */
export interface LegacyMailState {
  version?: number;
  seq?: number;
  /** 旧版的 coo 级全局已读游标；只在没有逐封 read 时使用。 */
  read?: Record<string, number>;
  items?: unknown[];
}

export interface LegacyImportResult {
  imported: number;
  skipped: number;
}

const KINDS: readonly MailKind[] = ['whisper', 'gift', 'promise', 'ledger', 'invite'];
const MAX_PAGE = 50;
const DEFAULT_PAGE = 10;
const DEFAULT_RECENT = 3;

/** 视图列：带 room 与 read，不带 coo_id。 */
const VIEW_COLUMNS = `id, seq, ts, room_id, kind, action, from_name, text, entry_id, invitation_id, from_coo_id,
  (read_at IS NOT NULL) AS read_flag`;

const clampPage = (limit: number, fallback: number): number => {
  const value = Math.trunc(Number(limit));
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_PAGE, value));
};

const toView = (row: Record<string, unknown>): MailView => ({
  id: String(row.id),
  seq: Number(row.seq),
  ts: Number(row.ts),
  room: String(row.room_id),
  ...(typeof row.from_coo_id === 'string' ? { fromCooId: row.from_coo_id } : {}),
  kind: row.kind as MailKind,
  ...(typeof row.action === 'string' ? { action: row.action } : {}),
  fromName: String(row.from_name),
  text: String(row.text),
  ...(typeof row.entry_id === 'string' ? { entryId: row.entry_id } : {}),
  ...(typeof row.invitation_id === 'string' ? { invitationId: row.invitation_id } : {}),
  read: Boolean(row.read_flag),
});

interface LegacyMailItem extends MailInput {
  id: string;
  seq: number;
  ts: number;
  read?: boolean;
}

const isLegacyItem = (value: unknown): value is LegacyMailItem => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<LegacyMailItem>;
  return typeof item.id === 'string'
    && typeof item.seq === 'number' && Number.isFinite(item.seq)
    && typeof item.ts === 'number' && Number.isFinite(item.ts)
    && typeof item.room === 'string'
    && typeof item.to === 'string'
    && typeof item.fromName === 'string'
    && typeof item.text === 'string'
    && KINDS.includes(item.kind as MailKind)
    && (item.action === undefined || typeof item.action === 'string')
    && (item.entryId === undefined || typeof item.entryId === 'string')
    && (item.key === undefined || typeof item.key === 'string')
    && (item.read === undefined || typeof item.read === 'boolean');
};

const readCursors = (raw: LegacyMailState['read']): Record<string, number> => {
  const cursors: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return cursors;
  for (const [cooId, cursor] of Object.entries(raw)) {
    const value = Number(cursor);
    if (Number.isFinite(value) && value > 0) cursors[cooId] = value;
  }
  return cursors;
};

const parseLegacyFile = (file: string): LegacyMailState => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as LegacyMailState;
  } catch (error) {
    throw new Error(`旧信箱文件读不出来：${file}`, { cause: error });
  }
};

export class MailDb {
  private readonly db: Db;
  private readonly now: () => number;

  constructor(db: Db, options: MailDbOptions = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
  }

  /** 开库并建表；路径/权限问题会在这里抛出，不吞。 */
  static open(file = ':memory:', options: MailDbOptions = {}): MailDb {
    const db = openDb(file);
    migrate(db);
    return new MailDb(db, options);
  }

  /** 关掉这个 store 用的库；只有自己用 MailDb.open 开的时候才调。 */
  close(): void {
    this.db.close();
  }

  /** 投一封新信；返回视图（不带收件人）。 */
  append(input: MailInput): MailView {
    return this.tx(() => this.insert(input, input.key ?? null));
  }

  /**
   * 幂等投递：同一个 key 已经投过就返回旧的那封，不新增。
   * 唯一约束是 schema 里的 ux_mail_key，重复靠事务内先查再插兜底。
   */
  appendOnce(key: string, input: MailInput): MailView {
    return this.tx(() => {
      const existing = this.db.prepare(`SELECT ${VIEW_COLUMNS} FROM mail WHERE key = ?`).get(key);
      if (existing) return toView(existing);
      return this.insert(input, key);
    });
  }

  private insert(input: MailInput, key: string | null): MailView {
    const id = randomUUID();
    const ts = this.now();
    const action = input.action ?? null;
    const entryId = input.entryId ?? null;
    const fromCooId = input.fromCooId ?? null;
    const invitationId = input.invitationId ?? null;
    const result = this.db.prepare(
      `INSERT INTO mail(id, ts, coo_id, from_coo_id, room_id, kind, action, from_name, text, entry_id, invitation_id, key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, ts, input.to, fromCooId, input.room, input.kind, action, input.fromName, input.text, entryId, invitationId, key);
    return {
      id,
      seq: Number(result.lastInsertRowid),
      ts,
      room: input.room,
      ...(fromCooId ? { fromCooId } : {}),
      kind: input.kind,
      ...(action ? { action } : {}),
      fromName: input.fromName,
      text: input.text,
      ...(entryId ? { entryId } : {}),
      ...(invitationId ? { invitationId } : {}),
      read: false,
    };
  }

  /** 未读数；给了 room 就只算那个客厅，不给算全部。 */
  unreadCount(cooId: string, room?: string): number {
    return this.countUnread(cooId, room);
  }

  /** 每个客厅各多少未读；没有未读的客厅不出现。 */
  unreadByRoom(cooId: string): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT room_id, COUNT(*) AS n
         FROM mail
        WHERE coo_id = ? AND read_at IS NULL
        GROUP BY room_id
        ORDER BY room_id`,
    ).all(cooId);
    const counts: Record<string, number> = {};
    for (const row of rows) counts[String(row.room_id)] = Number(row.n);
    return counts;
  }

  /**
   * 读最旧的未读；markRead=false 时只看不标记（peek）。
   * 给了 room 就只读那个客厅；回执里的 unreadByRoom 仍是所有客厅的。
   */
  list(cooId: string, room?: string, limit = DEFAULT_PAGE, markRead = true): MailPage {
    const size = clampPage(limit, DEFAULT_PAGE);
    return this.tx(() => {
      const rows = this.selectUnread(cooId, room, size);
      const unread = this.countUnread(cooId, room);
      if (markRead && rows.length > 0) {
        const at = this.now();
        const update = this.db.prepare(
          'UPDATE mail SET read_at = ? WHERE coo_id = ? AND seq = ? AND read_at IS NULL',
        );
        for (const row of rows) update.run(at, cooId, Number(row.seq));
      }
      return {
        unread,
        remaining: Math.max(0, unread - rows.length),
        items: rows.map(toView),
        marked: markRead && rows.length > 0,
        unreadByRoom: this.unreadByRoom(cooId),
      };
    });
  }

  /** 只标记一封；这封不存在、已经是已读、或不是他的信都返回 false。 */
  readOne(cooId: string, seq: number): boolean {
    const result = this.db.prepare(
      'UPDATE mail SET read_at = ? WHERE coo_id = ? AND seq = ? AND read_at IS NULL',
    ).run(this.now(), cooId, seq);
    return Number(result.changes) > 0;
  }

  /** 最近几封（含已读），新的在前；不动已读状态。 */
  recent(cooId: string, room?: string, limit = DEFAULT_RECENT): MailView[] {
    const requested = Math.trunc(Number(limit));
    const size = Number.isFinite(requested) ? Math.max(1, requested) : DEFAULT_RECENT;
    const rows = room === undefined
      ? this.db.prepare(
        `SELECT ${VIEW_COLUMNS} FROM mail WHERE coo_id = ? ORDER BY seq DESC LIMIT ?`,
      ).all(cooId, size)
      : this.db.prepare(
        `SELECT ${VIEW_COLUMNS} FROM mail WHERE coo_id = ? AND room_id = ? ORDER BY seq DESC LIMIT ?`,
      ).all(cooId, room, size);
    return rows.map(toView);
  }

  /** 私聊会话摘要：每个对方一条，按最后一条排序。只算带 from_coo_id 的信。 */
  threads(cooId: string): DmThreadSummary[] {
    const rows = this.db.prepare(
      `SELECT seq, ts, coo_id, from_coo_id, text
         FROM mail
        WHERE from_coo_id IS NOT NULL AND (coo_id = ? OR from_coo_id = ?)
        ORDER BY seq DESC LIMIT 500`,
    ).all(cooId, cooId) as Record<string, unknown>[];
    const last = new Map<string, DmThreadSummary>();
    for (const row of rows) {
      const mine = String(row.coo_id) === cooId;
      const peer = mine ? String(row.from_coo_id) : String(row.coo_id);
      if (last.has(peer)) continue;
      last.set(peer, {
        peer,
        lastSeq: Number(row.seq),
        lastTs: Number(row.ts),
        lastText: String(row.text),
        lastFromMe: !mine,
        unread: 0,
      });
    }
    const unreadRows = this.db.prepare(
      `SELECT from_coo_id AS peer, COUNT(*) AS n
         FROM mail
        WHERE coo_id = ? AND from_coo_id IS NOT NULL AND read_at IS NULL
        GROUP BY from_coo_id`,
    ).all(cooId) as { peer: string; n: number }[];
    for (const row of unreadRows) {
      const item = last.get(row.peer);
      if (item) item.unread = Number(row.n);
    }
    return [...last.values()].sort((a, b) => b.lastSeq - a.lastSeq);
  }

  /** 和某一个人的私聊历史；before=0 表示最新一页。 */
  thread(cooId: string, peer: string, before = 0, limit = 50): { messages: DmThreadMessage[]; hasMore: boolean } {
    const size = Math.max(1, Math.min(100, Math.trunc(Number(limit)) || 50));
    const cursor = Number.isFinite(before) ? Math.max(0, Math.trunc(before)) : 0;
    const rows = this.db.prepare(
      `SELECT seq, ts, text, from_name, (read_at IS NULL) AS unread, (from_coo_id = ?) AS out_flag
         FROM mail
        WHERE from_coo_id IS NOT NULL
          AND ((coo_id = ? AND from_coo_id = ?) OR (coo_id = ? AND from_coo_id = ?))
          AND (? = 0 OR seq < ?)
        ORDER BY seq DESC LIMIT ?`,
    ).all(cooId, cooId, peer, peer, cooId, cursor, cursor, size + 1) as Record<string, unknown>[];
    const hasMore = rows.length > size;
    const page = rows.slice(0, size).reverse();
    return {
      hasMore,
      messages: page.map((row) => ({
        seq: Number(row.seq),
        ts: Number(row.ts),
        text: String(row.text),
        fromName: String(row.from_name),
        fromMe: Boolean(row.out_flag),
        unread: Boolean(row.unread),
      })),
    };
  }

  /** 把和某个人的来信全部标成已读；返回这次标了几封。 */
  markThreadRead(cooId: string, peer: string): number {
    const result = this.db.prepare(
      'UPDATE mail SET read_at = ? WHERE coo_id = ? AND from_coo_id = ? AND read_at IS NULL',
    ).run(this.now(), cooId, peer);
    return Number(result.changes);
  }

  /** 私聊未读总数（信箱角标用）。 */
  dmUnread(cooId: string): number {
    return Number(this.db.prepare(
      'SELECT COUNT(*) AS n FROM mail WHERE coo_id = ? AND from_coo_id IS NOT NULL AND read_at IS NULL',
    ).get(cooId)?.n ?? 0);
  }

  /** 全库信件数；迁移/巡检用。 */
  count(): number {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM mail').get()?.n ?? 0);
  }

  /**
   * 只读一页未读，不改已读状态。after 传上一页的 nextAfter 继续往下翻；
   * 不给 after 时从最旧的未读开始。
   */
  unreadPage(cooId: string, room?: string, limit = DEFAULT_PAGE, after = 0): UnreadPage {
    const size = clampPage(limit, DEFAULT_PAGE);
    const cursor = Number.isFinite(after) ? Math.trunc(after) : 0;
    const rows = this.selectUnreadAfter(cooId, room, size, cursor);
    const unread = this.countUnreadAfter(cooId, room, cursor);
    const last = rows.length > 0 ? Number(rows[rows.length - 1].seq) : cursor;
    const remaining = Math.max(0, unread - rows.length);
    return {
      unread,
      remaining,
      items: rows.map(toView),
      marked: false,
      unreadByRoom: this.unreadByRoom(cooId),
      nextAfter: remaining > 0 ? last : null,
    };
  }

  /**
   * 把旧 mail.json 导进 mail 表。
   *
   * 老文件只有 coo 级全局游标（read map）；没有逐封 read 时按
   * `cursor[to] >= item.seq` 换算成 read_at，保证旧已读不会被重新当成未读。
   * 表为空时保留旧 seq（World 游标可以接着用）；已有新信时交给 AUTOINCREMENT。
   * 缺 coo/客厅、重复 id/key 的信跳过并计数；entryId 指向还没导入的账本条目时
   * 保留信本身、只去掉链接，不让一条悬空外键毁掉整批迁移。
   */
  importLegacy(source: string | LegacyMailState): LegacyImportResult {
    const state = typeof source === 'string' ? parseLegacyFile(source) : source;
    if (!state || state.version !== 1) throw new Error('旧信箱文件的 version 不是 1，拒绝导入');
    const items = Array.isArray(state.items) ? state.items.filter(isLegacyItem) : [];
    const cursors = readCursors(state.read);
    const reuseSeq = this.count() === 0;

    const cooExists = this.db.prepare('SELECT 1 AS ok FROM coos WHERE id = ?');
    const roomExists = this.db.prepare('SELECT 1 AS ok FROM rooms WHERE id = ?');
    const entryExists = this.db.prepare('SELECT 1 AS ok FROM ledger_entries WHERE id = ?');
    const insertWithSeq = this.db.prepare(
      `INSERT INTO mail(seq, id, ts, coo_id, room_id, kind, action, from_name, text, entry_id, key, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    );
    const insertAuto = this.db.prepare(
      `INSERT INTO mail(id, ts, coo_id, room_id, kind, action, from_name, text, entry_id, key, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    );

    return this.tx(() => {
      let imported = 0;
      let skipped = 0;
      for (const item of [...items].sort((left, right) => left.seq - right.seq)) {
        if (!cooExists.get(item.to) || !roomExists.get(item.room)) {
          skipped += 1;
          continue;
        }
        const read = typeof item.read === 'boolean'
          ? item.read
          : (cursors[item.to] ?? 0) >= item.seq;
        const entryId = item.entryId && entryExists.get(item.entryId) ? item.entryId : null;
        const values = [
          item.id,
          item.ts,
          item.to,
          item.room,
          item.kind,
          item.action ?? null,
          item.fromName,
          item.text,
          entryId,
          item.key ?? null,
          read ? item.ts : null,
        ];
        const result = reuseSeq && item.seq > 0
          ? insertWithSeq.run(item.seq, ...values)
          : insertAuto.run(...values);
        if (Number(result.changes) > 0) imported += 1;
        else skipped += 1;
      }
      return { imported, skipped };
    });
  }

  /** 外层已开事务时并入，避免 BEGIN 套 BEGIN。 */
  private tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    return withTransaction(this.db, fn);
  }

  private countUnread(cooId: string, room?: string): number {
    const row = room === undefined
      ? this.db.prepare(
        'SELECT COUNT(*) AS n FROM mail WHERE coo_id = ? AND read_at IS NULL',
      ).get(cooId)
      : this.db.prepare(
        'SELECT COUNT(*) AS n FROM mail WHERE coo_id = ? AND room_id = ? AND read_at IS NULL',
      ).get(cooId, room);
    return Number(row?.n ?? 0);
  }

  private countUnreadAfter(cooId: string, room: string | undefined, after: number): number {
    const row = room === undefined
      ? this.db.prepare(
        'SELECT COUNT(*) AS n FROM mail WHERE coo_id = ? AND read_at IS NULL AND seq > ?',
      ).get(cooId, after)
      : this.db.prepare(
        'SELECT COUNT(*) AS n FROM mail WHERE coo_id = ? AND room_id = ? AND read_at IS NULL AND seq > ?',
      ).get(cooId, room, after);
    return Number(row?.n ?? 0);
  }

  private selectUnread(cooId: string, room: string | undefined, limit: number): Record<string, unknown>[] {
    return room === undefined
      ? this.db.prepare(
        `SELECT ${VIEW_COLUMNS} FROM mail WHERE coo_id = ? AND read_at IS NULL ORDER BY seq ASC LIMIT ?`,
      ).all(cooId, limit)
      : this.db.prepare(
        `SELECT ${VIEW_COLUMNS} FROM mail WHERE coo_id = ? AND room_id = ? AND read_at IS NULL ORDER BY seq ASC LIMIT ?`,
      ).all(cooId, room, limit);
  }

  private selectUnreadAfter(
    cooId: string,
    room: string | undefined,
    limit: number,
    after: number,
  ): Record<string, unknown>[] {
    return room === undefined
      ? this.db.prepare(
        `SELECT ${VIEW_COLUMNS} FROM mail
          WHERE coo_id = ? AND read_at IS NULL AND seq > ?
          ORDER BY seq ASC LIMIT ?`,
      ).all(cooId, after, limit)
      : this.db.prepare(
        `SELECT ${VIEW_COLUMNS} FROM mail
          WHERE coo_id = ? AND room_id = ? AND read_at IS NULL AND seq > ?
          ORDER BY seq ASC LIMIT ?`,
      ).all(cooId, room, after, limit);
  }
}
