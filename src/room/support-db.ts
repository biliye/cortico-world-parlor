/** 反馈和运营公告与房间聊天分开存，反馈不进入公共事件或回放。 */
import { randomUUID } from 'node:crypto';
import { withTransaction, type Db } from './db.ts';
import { lockCooRows } from './storage/locks.ts';
import { HostError } from './host-error.ts';
import type { Announcement, Feedback } from './support-protocol.ts';

export const SUPPORT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS support_feedback (
  id TEXT PRIMARY KEY,
  coo_id TEXT NOT NULL REFERENCES coos(id),
  name TEXT NOT NULL,
  text TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  reply TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  UNIQUE(coo_id, request_id)
);
CREATE INDEX IF NOT EXISTS ix_support_feedback_coo ON support_feedback(coo_id, created_at);
CREATE TABLE IF NOT EXISTS support_announcements (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
`;

/** 每日新闻：运营手写，一天一版；auto_push=0 的补录只进主动查，不自动推送。 */
export const NEWS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS news_items (
  id TEXT PRIMARY KEY,
  issue_date TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  publish_at BIGINT NOT NULL,
  auto_push INTEGER NOT NULL DEFAULT 1 CHECK (auto_push IN (0,1)),
  created_at BIGINT NOT NULL,
  UNIQUE(issue_date)
);
CREATE INDEX IF NOT EXISTS ix_news_publish ON news_items(publish_at DESC, id DESC);
`;

/**
 * 运营改动留痕。编辑与删除都写一条，删除后还能从这里把原文找回来：
 * 删公告、删新闻都是物理删除——留着 `deleted_at` 会让「一天一版」的唯一索引
 * 把当天重发堵死，所以删除走硬删，历史交给这张表。
 * `before_json` / `after_json` 存整条记录（新闻含正文）；用 TEXT 而不是 JSONB，
 * 因为这份 DDL 在 SQLite 与 PG 上共用。
 */
export const SUPPORT_ADMIN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS support_audit (
  id TEXT PRIMARY KEY,
  at BIGINT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('news.edit','news.delete','announcement.edit','announcement.delete')),
  target_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT
);
CREATE INDEX IF NOT EXISTS ix_support_audit_at ON support_audit(at DESC, id DESC);
`;

/**
 * 运营侧看到的公告：多带一个 `publishId`。
 *
 * 公告的 `id` 是运营自己选的 requestId，删掉之后还能用同一个 requestId 重发，
 * 而 `revision` 又从 1 开始——旧标签页手里的 `revision=1` 会正好命中新的一条。
 * 每次发布一个 `publishId`，改与删都带上它，才能把「这一条」和「上一条」分开。
 */
export interface AnnouncementAdmin extends Announcement {
  revision: number;
  updated_at: number;
  publishId: string;
}

/** 列表与推送只用摘要，正文留给主动查，避免每分钟给所有 Coo 传全文。 */
export interface NewsSummary {
  id: string; issueDate: string; title: string; summary: string; publishAt: number;
  /** 编辑次数，从 1 起；运营列表拿它标「改过几次」。 */
  revision: number;
}
export interface NewsItem extends NewsSummary {
  body: string; autoPush: boolean; createdAt: number;
  /**
   * 这一次发布的唯一标识，每次 INSERT 生成一个 UUID。
   * 同一天删掉重发会沿用同一个 `id`（`news-YYYY-MM-DD`），`createdAt` 也可能撞在同一毫秒，
   * 所以「改 / 删的是不是运营看到的那一期」只认它；`createdAt` 只用于展示。
   */
  publishId: string;
  /** 最后一次编辑时刻；从未编辑过是 0。 */
  updatedAt: number;
}
/** 运营列表多带发布标识与创建时刻：同一天删掉重发后 `id` 不变，靠它们识别「不是同一期」。 */
export interface NewsAdminSummary extends NewsSummary {
  createdAt: number;
  publishId: string;
}

/** 复合游标：同一毫秒发布多条时按 id 继续比较，不会互相吞掉。 */
export interface NewsCursor { publishAt: number; id: string }
export interface NewsFeed {
  item: NewsSummary | null;
  cursor: NewsCursor;
  /** 比 item 更早、这次没推的条数；上限 100。 */
  skipped: number;
  /** 积压超过 101 条，skipped 只是下限。 */
  capped: boolean;
}

export interface NewsInput {
  id?: unknown; issueDate?: unknown; title?: unknown; summary?: unknown;
  body?: unknown; publishAt?: unknown; autoPush?: unknown;
}

/** 编辑只认这几个字段；没给的保持原样，`id` / `issueDate` 不在其中。 */
export interface NewsEditInput {
  id?: unknown; title?: unknown; summary?: unknown;
  body?: unknown; publishAt?: unknown; autoPush?: unknown;
  /**
   * 编辑者手上那一期的 `publishId` 与 `revision`。
   * 同一天删掉重发会沿用同一个 `id`，只比 `revision` 不够——重发也从第 1 版开始；
   * `publishId` 变了就说明「不是同一期」，必须让运营刷新。
   * 不用 `createdAt`：两次发布可以落在同一毫秒，它不是唯一标识。
   */
  publishId?: unknown; revision?: unknown;
}

export type AuditAction = 'news.edit' | 'news.delete' | 'announcement.edit' | 'announcement.delete';

export interface AuditEntry {
  id: string; at: number; action: AuditAction; targetId: string;
  /** 改动前整条记录；删除类操作就靠它找回原文。 */
  before: unknown;
  /** 改动后整条记录；删除为 null。 */
  after: unknown;
}

interface AuditRow {
  id: string; at: number | string; action: AuditAction; target_id: string;
  before_json?: string | null; after_json?: string | null;
}

interface NewsRow {
  id: string; issue_date: string; title: string; summary: string;
  publish_at: number | string; body?: string; auto_push?: number | boolean; created_at?: number | string;
  revision?: number | string; updated_at?: number | string; publish_id?: string | null;
}

const BEIJING_OFFSET_MS = 8 * 3_600_000;
/** 服务端可能跑在任意时区，新闻的「一天」和「10 点」都固定按 UTC+8 算。 */
export const beijingDate = (at: number): string => new Date(at + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
const beijingTen = (date: string): number => Date.parse(`${date}T10:00:00+08:00`);
const validDate = (date: string): boolean => (
  /^\d{4}-\d{2}-\d{2}$/.test(date)
  && Number.isFinite(Date.parse(`${date}T00:00:00+08:00`))
  && beijingDate(Date.parse(`${date}T00:00:00+08:00`)) === date
);

const newsSummary = (row: NewsRow): NewsSummary => ({
  id: row.id, issueDate: row.issue_date, title: row.title,
  summary: row.summary, publishAt: Number(row.publish_at),
  revision: Number(row.revision ?? 1),
});

const newsItem = (row: NewsRow): NewsItem => ({
  ...newsSummary(row),
  body: row.body ?? '',
  autoPush: Number(row.auto_push ?? 1) === 1,
  createdAt: Number(row.created_at ?? 0),
  publishId: row.publish_id ?? '',
  revision: Number(row.revision ?? 1),
  updatedAt: Number(row.updated_at ?? 0),
});
const newsAdminSummary = (row: NewsRow): NewsAdminSummary => ({
  ...newsSummary(row),
  createdAt: Number(row.created_at ?? 0),
  publishId: row.publish_id ?? '',
});

interface AnnouncementRow {
  id: string; text: string; created_at: number | string;
  revision?: number | string; updated_at?: number | string; publish_id?: string | null;
}
/** 运营侧公告统一从这里出：`created_at` 在 PG 上是 bigint 字符串，顺便折成毫秒数。 */
const announcementAdmin = (row: AnnouncementRow): AnnouncementAdmin => ({
  id: row.id,
  text: row.text,
  created_at: Number(row.created_at ?? 0),
  revision: Number(row.revision ?? 1),
  updated_at: Number(row.updated_at ?? 0),
  publishId: row.publish_id || `legacy-${row.id}`,
});

/** 新闻正文上限与反馈/公告不同，单独校验；不要放宽共用的 supportText。 */
export const newsText = (value: unknown, max: number, label: string): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw new HostError('invalid', `${label}要有 1 到 ${max} 个字`);
  return text;
};

export const supportText = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 2000) throw new HostError('invalid', '正文要有 1 到 2000 个字');
  return text;
};
export class SupportDb {
  private readonly db: Db;
  private readonly now: () => number;
  constructor(db: Db, now: () => number = Date.now) { this.db = db; this.now = now; }

  async submit(cooId: string, name: string, value: unknown, requestId: unknown): Promise<Feedback> {
    const text = supportText(value);
    if (typeof requestId !== 'string' || !/^[\w-]{1,100}$/.test(requestId)) {
      throw new HostError('invalid', '需要有效的 requestId；重试请沿用同一个值');
    }
    return withTransaction(this.db, async () => {
      await lockCooRows(this.db, [cooId]);
      const previous = await this.db.prepare('SELECT * FROM support_feedback WHERE coo_id = ? AND request_id = ?')
        .get(cooId, requestId) as unknown as Feedback | undefined;
      if (previous) {
        if (previous.text !== text) throw new HostError('conflict', '同一个 requestId 的正文不能变');
        return previous;
      }
      const count = await this.db.prepare('SELECT COUNT(*) AS n FROM support_feedback WHERE coo_id = ? AND created_at > ?')
        .get(cooId, this.now() - 3_600_000) as { n: number };
      if (Number(count.n) >= 5) throw new HostError('conflict', '每小时最多提交 5 条反馈，请稍后再试');
      const item: Feedback = { id: randomUUID(), coo_id: cooId, name, text, created_at: this.now(), reply: '', status: 'open' };
      await this.db.prepare('INSERT INTO support_feedback(id, coo_id, name, text, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(item.id, cooId, name, text, requestId, item.created_at);
      return item;
    });
  }

  async feedback(cooId?: string): Promise<Feedback[]> {
    return await this.db.prepare(`SELECT id, coo_id, name, text, created_at, reply, status FROM support_feedback
      ${cooId ? 'WHERE coo_id = ?' : ''} ORDER BY created_at DESC, id DESC LIMIT 100`)
      .all(...(cooId ? [cooId] : [])) as unknown as Feedback[];
  }

  async reply(id: string, value: unknown, status: unknown): Promise<void> {
    const text = supportText(value);
    if (status !== 'open' && status !== 'closed') throw new HostError('invalid', '状态只能是 open 或 closed');
    const result = await this.db.prepare('UPDATE support_feedback SET reply = ?, status = ? WHERE id = ?').run(text, status, id);
    if (!result.changes) throw new HostError('not_found', '没有这条反馈');
  }

  async announcements(): Promise<Announcement[]> {
    return await this.db.prepare('SELECT * FROM support_announcements ORDER BY created_at DESC, id DESC LIMIT 50')
      .all() as unknown as Announcement[];
  }

  async announce(value: unknown, id: unknown): Promise<AnnouncementAdmin> {
    const text = supportText(value);
    if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id)) throw new HostError('invalid', '需要有效的 requestId');
    // 每次发布一个唯一标识：同一个 requestId 在删掉之后还能重发，`revision` 又从 1 开始。
    // 同一个 requestId 重试（没删过）会命中 ON CONFLICT，库里那行才是这次发布。
    await this.db.prepare(
      'INSERT INTO support_announcements(id, text, created_at, publish_id) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
    ).run(id, text, this.now(), randomUUID());
    const row = await this.db.prepare('SELECT * FROM support_announcements WHERE id = ?').get(id) as
      AnnouncementRow | undefined;
    if (!row) throw new HostError('conflict', '公告没写成，请重试');
    if (row.text !== text) throw new HostError('conflict', '同一个 requestId 的正文不能变');
    return announcementAdmin(row);
  }

  /**
   * 发布/预录一天一版。一天一版由 UNIQUE(issue_date) 兜住：
   * 同一天第二个不同 id 会被判冲突，同 id 只有逐字段一致才算幂等。
   */
  async publishNews(input: NewsInput): Promise<NewsItem> {
    const title = newsText(input.title, 60, '标题');
    const summary = newsText(input.summary, 200, '摘要');
    const body = newsText(input.body, 4000, '正文');
    const now = this.now();
    const today = beijingDate(now);
    const issueDate = input.issueDate === undefined ? today : String(input.issueDate).trim();
    if (!validDate(issueDate)) throw new HostError('invalid', '日期要写成 YYYY-MM-DD');
    const id = input.id === undefined ? `news-${issueDate}` : String(input.id).trim();
    if (!/^[\w-]{1,100}$/.test(id)) throw new HostError('invalid', 'id 只能含字母、数字、下划线、短横线（1–100 字）');
    // 历史补录一律只进主动查：显式传 autoPush 也不放行，否则补旧闻会一次性推给所有人。
    // 这条只约束**首次创建**；重放判定以库里存下的为准——当天发的稿跨过午夜再重试时，
    // 重新按「历史」算会把一次正常发布判成改了推送设置。
    const historical = issueDate < today;
    const autoPush = historical ? false : input.autoPush === undefined
      ? true
      : input.autoPush === true || input.autoPush === 'true';
    const ten = beijingTen(issueDate);
    // 缺省可见时刻必须是可重放的：当天 10 点后补发取 `now`，重试时 now 已经变了。
    // 已有条目就沿用存下来的那个值。
    const saved = await this.db.prepare('SELECT * FROM news_items WHERE issue_date = ?')
      .get(issueDate) as NewsRow | undefined;
    const fallback = saved ? Number(saved.publish_at) : (ten <= now && autoPush ? now : ten);
    const publishAt = input.publishAt === undefined ? fallback : Number(input.publishAt);
    if (!Number.isFinite(publishAt) || publishAt <= 0) throw new HostError('invalid', '可见时刻要是毫秒时间戳');

    // 每次 INSERT 一个发布标识：同一天删掉重发会沿用同一个 `id`，`createdAt` 也可能
    // 落在同一毫秒，只有它能把「上一期」和「重发的新稿」分开。
    const publishId = randomUUID();
    await this.db.prepare(
      `INSERT INTO news_items(id, issue_date, title, summary, body, publish_at, auto_push, created_at, publish_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    ).run(id, issueDate, title, summary, body, publishAt, autoPush ? 1 : 0, now, publishId);
    const row = await this.db.prepare('SELECT * FROM news_items WHERE issue_date = ?')
      .get(issueDate) as NewsRow | undefined;
    if (!row) {
      const byId = await this.db.prepare('SELECT * FROM news_items WHERE id = ?').get(id) as NewsRow | undefined;
      if (byId) throw new HostError('conflict', `编号 ${id} 已被 ${byId.issue_date} 的新闻占用`);
      throw new HostError('conflict', '新闻没写成，请重试');
    }
    const existing = newsItem(row);
    if (existing.id !== id) throw new HostError('conflict', `今天已经有新闻了：${existing.id}`);
    // 并发提交同一份请求时，两个都可能先读到「还没有条目」，各自算出一个 now 再 INSERT，
    // 后到的那个被 ON CONFLICT 跳过。这时候库里的那行才是唯一事实：缺省的可见时刻与
    // 历史补录的推送设置都按它判，否则同一份请求会因为几毫秒的差异被判成冲突。
    const expectedPublishAt = input.publishAt === undefined ? existing.publishAt : publishAt;
    const expectedAutoPush = historical ? existing.autoPush : autoPush;
    if (existing.title !== title || existing.summary !== summary || existing.body !== body
      || existing.publishAt !== expectedPublishAt || existing.autoPush !== expectedAutoPush) {
      throw new HostError('conflict', '同一天的新闻不能改标题、摘要、正文、可见时刻或推送设置');
    }
    return existing;
  }

  /* ——— 运营侧：改与删 ——— */

  /** 运营取单条（含未到可见时刻的预录），编辑表单要回填正文。 */
  async newsAdminById(id: string): Promise<NewsItem | undefined> {
    const row = await this.db.prepare('SELECT * FROM news_items WHERE id = ?').get(id) as NewsRow | undefined;
    return row ? newsItem(row) : undefined;
  }

  /**
   * 改一条已发布的新闻。
   *
   * - 只改 title / summary / body / publishAt / autoPush；`id` 与 `issueDate` 不动，
   *   「一天一版」的结构不能被编辑打破（要换日期就删掉重发）。
   * - 字段没给就不动；整条都没变化时**不加版本号**，这样表单重提一次不会白涨 revision。
   * - 已推送出去的内容收不回来：Coo 的游标按 `publish_at` 走，改正文不会重推；
   *   大厅小报按列表轮询，下一次拉取就是新文本。
   * - **已可见的新闻不能改 `publishAt`**：游标存的就是旧的 `publish_at`，改晚之后
   *   同一 `id` 会再次落进 `publish_at > 游标` 的窗口，等于给所有 Coo 重推一遍。
   *   只有还没到可见时刻的预录稿可以改期。要改已可见的排期只能删掉重发。
   * - 同一天删掉重发会沿用同一个 `id`，所以写操作要带 `publishId`（本次发布的唯一
   *   标识）与 `revision`（编辑者看到的版本）：前者挡住「重试旧请求删/改到新一稿」，
   *   后者挡住两个人同时编辑时的丢字段。两者都在事务内再校验一次。
   */
  async editNews(input: NewsEditInput): Promise<{ item: NewsItem; changed: boolean }> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) throw new HostError('invalid', '需要新闻 id');
    const expectedPublishId = typeof input.publishId === 'string' ? input.publishId.trim() : '';
    if (!expectedPublishId) {
      throw new HostError('invalid', '需要 publishId（本次发布的唯一标识）');
    }
    const expectedRevision = Number(input.revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new HostError('invalid', '需要 revision（编辑者看到的版本号）');
    }
    return withTransaction(this.db, async () => {
      const row = await this.db.prepare('SELECT * FROM news_items WHERE id = ?').get(id) as NewsRow | undefined;
      if (!row) throw new HostError('not_found', '没有这条新闻');
      const before = newsItem(row);
      // 同一个 id 已经被删掉重发过：手上这份内容属于上一期，不能落到新一稿上。
      if (before.publishId !== expectedPublishId) {
        throw new HostError('conflict', '这一期已经被重发过，请刷新后再改');
      }
      const title = input.title === undefined ? before.title : newsText(input.title, 60, '标题');
      const summary = input.summary === undefined ? before.summary : newsText(input.summary, 200, '摘要');
      const body = input.body === undefined ? before.body : newsText(input.body, 4000, '正文');
      const publishAt = input.publishAt === undefined ? before.publishAt : Number(input.publishAt);
      if (!Number.isFinite(publishAt) || publishAt <= 0) throw new HostError('invalid', '可见时刻要是毫秒时间戳');
      const autoPush = input.autoPush === undefined
        ? before.autoPush
        : input.autoPush === true || input.autoPush === 'true';
      // 与发布同一条规矩：日期早于今天的条目不能开自动推送，否则一次编辑就能把旧闻补推给所有人。
      if (autoPush && !before.autoPush && row.issue_date < beijingDate(this.now())) {
        throw new HostError('conflict', '历史补录不能开启自动推送');
      }
      const at = this.now();
      // 已经可见却要改可见时刻：Coo 的游标按 publishAt 存，改晚就会重推。
      // 预录稿（`publishAt > now`）不受影响，它们还没进过任何人的游标。
      if (publishAt !== before.publishAt && before.publishAt <= at) {
        throw new HostError('conflict', '已可见的新闻不能改可见时刻；只有未到可见时刻的预录稿可以改期');
      }
      if (title === before.title && summary === before.summary && body === before.body
        && publishAt === before.publishAt && autoPush === before.autoPush) {
        return { item: before, changed: false };
      }
      // 目标内容与库里不同，说明不是「上一次请求已经成功」的重提；版本被别的事务推过就拒绝。
      if (before.revision !== expectedRevision) {
        throw new HostError('conflict', '这条新闻刚被改过，请刷新后再试');
      }
      const revision = before.revision + 1;
      // 条件更新是最后一道闸：读与写之间真的挤进另一个事务时，这里的影响行数会是 0。
      const result = await this.db.prepare(
        `UPDATE news_items SET title = ?, summary = ?, body = ?, publish_at = ?, auto_push = ?,
           revision = ?, updated_at = ? WHERE id = ? AND revision = ? AND publish_id = ?`,
      ).run(title, summary, body, publishAt, autoPush ? 1 : 0, revision, at, id, expectedRevision, expectedPublishId);
      if (!result.changes) throw new HostError('conflict', '这条新闻刚被改过，请刷新后再试');
      const after: NewsItem = { ...before, title, summary, body, publishAt, autoPush, revision, updatedAt: at };
      await this.audit('news.edit', id, before, after, at);
      return { item: after, changed: true };
    });
  }

  /**
   * 删一条新闻：物理删除，`UNIQUE(issue_date)` 随之释放，当天可以重发一条。
   * 原文进 `support_audit`，需要找回时从那里取。
   * 找不到时返回 null（重试幂等），不当成错误。
   *
   * `publishId` 是这次发布的唯一标识：同一天删掉重发会沿用同一个 `id`，
   * 旧标签页/重试请求如果只带 id，会把刚重发的新稿删掉。带上它之后，
   * 删的必须是运营当时看到的那一期；不是同一期就报冲突，让页面刷新。
   *
   * 删除用 `DELETE … RETURNING` 一条语句完成，不再「先读再删」：两步之间挤进来的
   * 编辑会让留痕只记到旧版本，被删掉的最新正文就再也找不回来了。
   */
  async deleteNews(id: string, publishId: string): Promise<NewsItem | null> {
    const key = id.trim();
    if (!key) throw new HostError('invalid', '需要新闻 id');
    const expectedPublishId = typeof publishId === 'string' ? publishId.trim() : '';
    if (!expectedPublishId) {
      throw new HostError('invalid', '需要 publishId（本次发布的唯一标识）');
    }
    return withTransaction(this.db, async () => {
      // 实际删掉的那一行才进留痕：并发编辑提交后的最新版本也在这里。
      const rows = await this.db.prepare(
        'DELETE FROM news_items WHERE id = ? AND publish_id = ? RETURNING *',
      ).all(key, expectedPublishId) as NewsRow[];
      const row = rows[0];
      if (!row) {
        // 库里还有这一期、但不是当初看到的那一期：让页面刷新，不要静默返回「已删」。
        const left = await this.db.prepare('SELECT id FROM news_items WHERE id = ?').get(key);
        if (left) throw new HostError('conflict', '这一期已经被重发过，请刷新后再删');
        return null;
      }
      const before = newsItem(row);
      await this.audit('news.delete', key, before, null, this.now());
      return before;
    });
  }

  /**
   * 改一条公告。公告按 id 去重、横幅按 id 记「知道了」，所以改完不会重新弹横幅。
   *
   * `revision` 必须是运营页面实际看到的那一版：服务端「读到的版本」不能当条件，
   * 否则两个标签页同时打开第 1 版，后保存的那个会把先保存的悄悄覆盖成第 3 版。
   * `publishId` 必须是这一条发布时返回的标识：同一条被删掉后重发，版本又从 1 开始，
   * 只有它能拦住旧标签页手里的 `revision=1`。
   */
  async editAnnouncement(
    id: string, value: unknown, revision: unknown, publishId: unknown,
  ): Promise<{ item: AnnouncementAdmin; changed: boolean }> {
    const text = supportText(value);
    const expectedRevision = Number(revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new HostError('invalid', '需要 revision（编辑者看到的版本号）');
    }
    const expectedPublishId = typeof publishId === 'string' ? publishId.trim() : '';
    if (!expectedPublishId) throw new HostError('invalid', '需要 publishId（发布时返回的标识）');
    return withTransaction(this.db, async () => {
      const row = await this.db.prepare('SELECT * FROM support_announcements WHERE id = ?').get(id) as
        AnnouncementRow | undefined;
      if (!row) throw new HostError('not_found', '没有这条公告');
      // 同一段文本重提：不涨版本，也不因为 revision 过期就报冲突（重试幂等）。
      if (row.text === text) return { item: announcementAdmin(row), changed: false };
      // 先认发布标识再看版本：删掉重发之后，旧页面手里的 revision=1 会正好命中新的一条。
      if ((row.publish_id ?? '') !== expectedPublishId) {
        throw new HostError('conflict', '这条公告已经被删掉重发过，请刷新后再改');
      }
      if (Number(row.revision ?? 1) !== expectedRevision) {
        throw new HostError('conflict', '这条公告刚被改过，请刷新后再试');
      }
      const at = this.now();
      const nextRevision = expectedRevision + 1;
      // 与新闻同一条规矩：两个人同时改，后提交的那个不能拿旧文本覆盖先提交的。
      const result = await this.db.prepare(
        `UPDATE support_announcements SET text = ?, revision = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND publish_id = ?`,
      ).run(text, nextRevision, at, id, expectedRevision, expectedPublishId);
      if (!result.changes) throw new HostError('conflict', '这条公告刚被改过，请刷新后再试');
      const before = announcementAdmin(row);
      const after: AnnouncementAdmin = { ...before, text, revision: nextRevision, updated_at: at };
      await this.audit('announcement.edit', id, before, after, at);
      return { item: after, changed: true };
    });
  }

  /**
   * 删一条公告：物理删除；下一轮 60 秒轮询里横幅与列表就会消失。
   * 与新闻相同，带上运营看到的 `revision` 与 `publishId` 并一条语句删完——否则旧标签页
   * 能删掉别人刚改出来的新版，或者删掉用同一个 requestId 重发的下一条。
   */
  async deleteAnnouncement(id: string, revision: unknown, publishId: unknown): Promise<AnnouncementAdmin | null> {
    const key = id.trim();
    if (!key) throw new HostError('invalid', '需要公告 id');
    const expectedRevision = Number(revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new HostError('invalid', '需要 revision（删除者看到的版本号）');
    }
    const expectedPublishId = typeof publishId === 'string' ? publishId.trim() : '';
    if (!expectedPublishId) throw new HostError('invalid', '需要 publishId（发布时返回的标识）');
    return withTransaction(this.db, async () => {
      const rows = await this.db.prepare(
        'DELETE FROM support_announcements WHERE id = ? AND revision = ? AND publish_id = ? RETURNING *',
      ).all(key, expectedRevision, expectedPublishId) as AnnouncementRow[];
      const row = rows[0];
      if (!row) {
        const left = await this.db.prepare('SELECT publish_id FROM support_announcements WHERE id = ?').get(key) as
          { publish_id?: string | null } | undefined;
        if (left) {
          if ((left.publish_id ?? '') !== expectedPublishId) {
            throw new HostError('conflict', '这条公告已经被删掉重发过，请刷新后再删');
          }
          throw new HostError('conflict', '这条公告刚被改过，请刷新后再删');
        }
        return null;
      }
      const before = announcementAdmin(row);
      await this.audit('announcement.delete', key, before, null, this.now());
      return before;
    });
  }

  /** 运营列表：与玩家侧同一批数据，但带 `revision` 与 `publishId`，运营钥匙校验过的路由用。 */
  async announcementAdminList(limit: number): Promise<AnnouncementAdmin[]> {
    const size = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 50) : 20;
    const rows = await this.db.prepare(
      'SELECT * FROM support_announcements ORDER BY created_at DESC, id DESC LIMIT ?',
    ).all(size) as AnnouncementRow[];
    return rows.map(announcementAdmin);
  }

  /** 改动留痕：最近的编辑 / 删除记录，含改前原文。 */
  async auditList(limit: number): Promise<AuditEntry[]> {
    const size = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 50) : 20;
    const rows = await this.db.prepare(
      'SELECT * FROM support_audit ORDER BY at DESC, id DESC LIMIT ?',
    ).all(size) as AuditRow[];
    return rows.map((row) => ({
      id: row.id, at: Number(row.at), action: row.action, targetId: row.target_id,
      before: row.before_json ? JSON.parse(row.before_json) as unknown : null,
      after: row.after_json ? JSON.parse(row.after_json) as unknown : null,
    }));
  }

  private async audit(
    action: AuditAction, targetId: string, before: unknown, after: unknown, at: number,
  ): Promise<void> {
    await this.db.prepare(
      'INSERT INTO support_audit(id, at, action, target_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      randomUUID(), at, action, targetId,
      before === null || before === undefined ? null : JSON.stringify(before),
      after === null || after === undefined ? null : JSON.stringify(after),
    );
  }

  /**
   * 取「比游标新、自动推送、已到可见时刻」的条目：只把最新一条交给宿主，
   * 更早的折成 skipped。倒序取 101 条既能拿到最新，也能给出上限内的积压计数。
   */
  async newsFeed(afterPublish: number, afterId: string): Promise<NewsFeed> {
    const after = Number.isFinite(afterPublish) && afterPublish > 0 ? afterPublish : 0;
    const rows = await this.db.prepare(
      `SELECT id, issue_date, title, summary, publish_at FROM news_items
        WHERE auto_push = 1 AND publish_at <= ?
          AND (publish_at > ? OR (publish_at = ? AND id > ?))
        ORDER BY publish_at DESC, id DESC LIMIT 101`,
    ).all(this.now(), after, after, afterId) as NewsRow[];
    const first = rows[0];
    if (!first) {
      return { item: null, cursor: { publishAt: after, id: afterId }, skipped: 0, capped: false };
    }
    return {
      item: newsSummary(first),
      cursor: { publishAt: Number(first.publish_at), id: first.id },
      skipped: rows.length - 1,
      capped: rows.length === 101,
    };
  }

  /** 主动查列表：补录条目（auto_push=0）也在这里出现，只是不自动推送。 */
  async newsList(limit: number): Promise<NewsSummary[]> {
    const size = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 10) : 5;
    const rows = await this.db.prepare(
      `SELECT id, issue_date, title, summary, publish_at FROM news_items
        WHERE publish_at <= ? ORDER BY publish_at DESC, id DESC LIMIT ?`,
    ).all(this.now(), size) as NewsRow[];
    return rows.map(newsSummary);
  }

  /** 运营列表：含未到可见时刻的预录条目，供运营钥匙校验过的路由使用。 */
  async newsAdminList(limit: number): Promise<NewsAdminSummary[]> {
    const size = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 20) : 10;
    // revision 必须真的查出来：`newsSummary` 缺省按 1 兜底，漏选就会让列表永远显示「第 1 版」。
    const rows = await this.db.prepare(
      `SELECT id, issue_date, title, summary, publish_at, revision, created_at, publish_id FROM news_items
        ORDER BY issue_date DESC, publish_at DESC, id DESC LIMIT ?`,
    ).all(size) as NewsRow[];
    return rows.map(newsAdminSummary);
  }

  async newsById(id: string): Promise<NewsItem | undefined> {
    const row = await this.db.prepare('SELECT * FROM news_items WHERE id = ? AND publish_at <= ?')
      .get(id, this.now()) as NewsRow | undefined;
    return row ? newsItem(row) : undefined;
  }

  async latestNews(): Promise<NewsItem | undefined> {
    const row = await this.db.prepare(
      'SELECT * FROM news_items WHERE publish_at <= ? ORDER BY publish_at DESC, id DESC LIMIT 1',
    ).get(this.now()) as NewsRow | undefined;
    return row ? newsItem(row) : undefined;
  }
}
