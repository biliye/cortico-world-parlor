/** Coo 自有消息档案。独立于客厅服务器的 7 天回放，不自动清理。 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
// 与现有 SQLite 适配器一致，避免 Vite 5 把 node:sqlite 误识别成外部包。
const { DatabaseSync: NativeDatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

export interface HistoryMessage {
  id: string;
  ts: number;
  room: string;
  type: string;
  direction: 'sent' | 'received';
  sender: string;
  recipient: string;
  text: string;
  private?: boolean;
}

export interface HistoryQuery {
  from?: number;
  until?: number;
  room?: string;
  direction?: 'sent' | 'received';
  before?: { ts: number; id: string };
  limit?: number;
}

export class LocalHistory {
  readonly file: string;
  private db?: DatabaseSync;

  constructor(dataDir: string, server: string, cooId: string) {
    const namespace = createHash('sha256').update(JSON.stringify([server, cooId])).digest('hex').slice(0, 24);
    this.file = join(dataDir, 'parlor-history', namespace, 'messages.sqlite');
  }

  private open(): DatabaseSync {
    if (this.db) return this.db;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const db = new NativeDatabaseSync(this.file);
    chmodSync(this.file, 0o600);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, ts INTEGER NOT NULL, room TEXT NOT NULL, type TEXT NOT NULL,
        direction TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL,
        text TEXT NOT NULL, private INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS history_time ON messages(ts DESC, id DESC);
      CREATE INDEX IF NOT EXISTS history_room_time ON messages(room, ts DESC, id DESC);
      CREATE TABLE IF NOT EXISTS progress (key TEXT PRIMARY KEY, seq INTEGER NOT NULL);`);
    this.db = db;
    return db;
  }

  append(message: HistoryMessage): void {
    if (!message.id || !Number.isSafeInteger(message.ts) || message.ts < 0) throw new Error('消息时间或编号无效');
    this.open().prepare(`INSERT OR IGNORE INTO messages
      (id,ts,room,type,direction,sender,recipient,text,private) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(message.id, message.ts, message.room, message.type, message.direction,
        message.sender, message.recipient, message.text, message.private ? 1 : 0);
  }

  progress(key: string): number {
    return Number(this.open().prepare('SELECT seq FROM progress WHERE key=?').get(key)?.seq ?? 0);
  }

  advance(key: string, seq: number): void {
    this.open().prepare(`INSERT INTO progress(key,seq) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET seq=MAX(progress.seq,excluded.seq)`).run(key, seq);
  }

  query(input: HistoryQuery = {}, hidePrivate = false) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('查询条件无效');
    const clauses: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [key, op] of [['from', '>='], ['until', '<']] as const) {
      if (input[key] === undefined) continue;
      if (!Number.isSafeInteger(input[key]) || input[key]! < 0) throw new Error('查询时间无效');
      clauses.push(`ts ${op} ?`); values.push(input[key]!);
    }
    if (input.from !== undefined && input.until !== undefined && input.from >= input.until) throw new Error('结束时间须晚于开始时间');
    if (input.room !== undefined) {
      if (typeof input.room !== 'string') throw new Error('客厅无效');
      clauses.push('room=?'); values.push(input.room);
    }
    if (input.direction !== undefined) {
      if (!['sent', 'received'].includes(input.direction)) throw new Error('收发方向无效');
      clauses.push('direction=?'); values.push(input.direction);
    }
    if (input.before !== undefined) {
      const cursor = input.before;
      if (!cursor || !Number.isSafeInteger(cursor.ts) || typeof cursor.id !== 'string') throw new Error('翻页位置无效');
      clauses.push('(ts < ? OR (ts = ? AND id < ?))'); values.push(cursor.ts, cursor.ts, cursor.id);
    }
    if (hidePrivate) clauses.push('private=0');
    const limit = Math.max(1, Math.min(200, Math.trunc(Number(input.limit)) || 100));
    const rows = this.open().prepare(`SELECT * FROM messages
      ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY ts DESC,id DESC LIMIT ?`)
      .all(...values, limit + 1);
    const messages = rows.slice(0, limit).map(row => ({ ...row, private: Boolean(row.private) })) as unknown as HistoryMessage[];
    const last = messages.at(-1);
    return { messages, next: rows.length > limit && last ? { ts: last.ts, id: last.id } : null };
  }

  info() {
    const db = this.open();
    return {
      ...db.prepare('SELECT COUNT(*) AS count,MIN(ts) AS first,MAX(ts) AS last FROM messages').get(),
      rooms: db.prepare('SELECT DISTINCT room FROM messages ORDER BY room').all().map(row => row.room),
    };
  }

  close(): void { this.db?.close(); this.db = undefined; }
}
