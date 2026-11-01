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

export interface Feedback {
  id: string; coo_id: string; name: string; text: string; created_at: number; reply: string; status: string;
}
export interface Announcement { id: string; text: string; created_at: number }

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
}
