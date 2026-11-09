/** 反馈和运营公告与房间聊天分开存，反馈不进入公共事件或回放。 */
import { randomUUID } from 'node:crypto';
import { withTransaction, type Db } from './db.ts';
import { lockCooRows } from './storage/locks.ts';
import { HostError } from './host-error.ts';

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

export interface Feedback {
  id: string; coo_id: string; name: string; text: string; created_at: number; reply: string; status: string;
}
export interface Announcement { id: string; text: string; created_at: number }

/** 列表与推送只用摘要，正文留给主动查，避免每分钟给所有 Coo 传全文。 */
export interface NewsSummary { id: string; issueDate: string; title: string; summary: string; publishAt: number }
export interface NewsItem extends NewsSummary { body: string; autoPush: boolean; createdAt: number }

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

interface NewsRow {
  id: string; issue_date: string; title: string; summary: string;
  publish_at: number | string; body?: string; auto_push?: number | boolean; created_at?: number | string;
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
});

const newsItem = (row: NewsRow): NewsItem => ({
  ...newsSummary(row),
  body: row.body ?? '',
  autoPush: Number(row.auto_push ?? 1) === 1,
  createdAt: Number(row.created_at ?? 0),
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

  async announce(value: unknown, id: unknown): Promise<Announcement> {
    const text = supportText(value);
    if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id)) throw new HostError('invalid', '需要有效的 requestId');
    await this.db.prepare('INSERT INTO support_announcements(id, text, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
      .run(id, text, this.now());
    const item = await this.db.prepare('SELECT * FROM support_announcements WHERE id = ?').get(id) as unknown as Announcement;
    if (item.text !== text) throw new HostError('conflict', '同一个 requestId 的正文不能变');
    return item;
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
    const autoPush = input.autoPush === undefined
      ? issueDate >= today
      : input.autoPush === true || input.autoPush === 'true';
    const ten = beijingTen(issueDate);
    // 当天 10 点已经过了：补发立即可见；否则按 10 点预录。
    const fallback = ten <= now && autoPush ? now : ten;
    const publishAt = input.publishAt === undefined ? fallback : Number(input.publishAt);
    if (!Number.isFinite(publishAt) || publishAt <= 0) throw new HostError('invalid', '可见时刻要是毫秒时间戳');

    await this.db.prepare(
      `INSERT INTO news_items(id, issue_date, title, summary, body, publish_at, auto_push, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    ).run(id, issueDate, title, summary, body, publishAt, autoPush ? 1 : 0, now);
    const row = await this.db.prepare('SELECT * FROM news_items WHERE issue_date = ?')
      .get(issueDate) as NewsRow | undefined;
    if (!row) {
      const byId = await this.db.prepare('SELECT * FROM news_items WHERE id = ?').get(id) as NewsRow | undefined;
      if (byId) throw new HostError('conflict', `编号 ${id} 已被 ${byId.issue_date} 的新闻占用`);
      throw new HostError('conflict', '新闻没写成，请重试');
    }
    const existing = newsItem(row);
    if (existing.id !== id) throw new HostError('conflict', `今天已经有新闻了：${existing.id}`);
    if (existing.title !== title || existing.summary !== summary || existing.body !== body
      || existing.publishAt !== publishAt || existing.autoPush !== autoPush) {
      throw new HostError('conflict', '同一天的新闻不能改标题、摘要、正文、可见时刻或推送设置');
    }
    return existing;
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
