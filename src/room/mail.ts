/**
 * 信箱：给可能不在线的席位留一份持久的私信、礼物与账本通知。
 *
 * 事件流会滚动（房间只留最近 500 条），信箱不滚；每个收件人一个已读游标，
 * 读的时候按「最旧的未读先给」出，读完游标往前走。
 * 这里只存收件人能看到的那一段文字，不存 cooId 列表或令牌别的秘密。
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type MailKind = 'whisper' | 'gift' | 'promise' | 'ledger';

export interface MailItem {
  id: string;
  /** 全局递增，用来做已读游标。 */
  seq: number;
  ts: number;
  room: string;
  /** 收件人 cooId。 */
  to: string;
  kind: MailKind;
  /** 具体动作（gift / promise / accept / decline / settle / default / refill…）。 */
  action?: string;
  fromName: string;
  text: string;
  entryId?: string;
  /** 幂等键：同一条通知只留一封。 */
  key?: string;
}

/** 给 World / 家长页的信；不带收件人 cooId。 */
export interface MailView {
  id: string;
  seq: number;
  ts: number;
  kind: MailKind;
  action?: string;
  fromName: string;
  text: string;
  entryId?: string;
}

export interface MailPage {
  /** 收件箱里还有多少封未读（含这次读走后剩下的）。 */
  unread: number;
  /** 这次没取走、还留着下次读的未读。 */
  remaining: number;
  items: MailView[];
  /** 这次有没有把游标往前推。 */
  marked: boolean;
}

export interface MailStoreOptions {
  file?: string;
  now?: () => number;
  limit?: number;
}

interface MailState {
  version: 1;
  seq: number;
  read: Record<string, number>;
  items: MailItem[];
}

const DEFAULT_LIMIT = 400;
const KINDS: readonly MailKind[] = ['whisper', 'gift', 'promise', 'ledger'];

const isItem = (value: unknown): value is MailItem => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<MailItem>;
  return typeof item.id === 'string'
    && typeof item.seq === 'number'
    && typeof item.ts === 'number'
    && typeof item.room === 'string'
    && typeof item.to === 'string'
    && typeof item.fromName === 'string'
    && typeof item.text === 'string'
    && KINDS.includes(item.kind as MailKind);
};

const view = (item: MailItem): MailView => ({
  id: item.id,
  seq: item.seq,
  ts: item.ts,
  kind: item.kind,
  ...(item.action ? { action: item.action } : {}),
  fromName: item.fromName,
  text: item.text,
  ...(item.entryId ? { entryId: item.entryId } : {}),
});

export class MailStore {
  private items: MailItem[] = [];
  private readonly read = new Map<string, number>();
  private seq = 0;
  private readonly file?: string;
  private readonly now: () => number;
  private readonly limit: number;

  constructor(options: MailStoreOptions = {}) {
    this.file = options.file;
    this.now = options.now ?? Date.now;
    this.limit = options.limit ?? DEFAULT_LIMIT;
  }

  static load(options: MailStoreOptions = {}): MailStore {
    const store = new MailStore(options);
    if (!options.file || !existsSync(options.file)) return store;
    try {
      const raw = JSON.parse(readFileSync(options.file, 'utf8')) as Partial<MailState>;
      if (raw.version !== 1) return store;
      if (Array.isArray(raw.items)) {
        store.items = raw.items.filter(isItem).slice(-store.limit);
      }
      store.seq = Math.max(Number(raw.seq) || 0, ...store.items.map((item) => item.seq), 0);
      if (raw.read && typeof raw.read === 'object') {
        for (const [cooId, cursor] of Object.entries(raw.read)) {
          const value = Number(cursor);
          if (typeof cooId === 'string' && Number.isFinite(value) && value > 0) store.read.set(cooId, value);
        }
      }
    } catch { /* 坏文件从空信箱开始，不阻断房间 */ }
    return store;
  }

  append(input: Omit<MailItem, 'id' | 'seq' | 'ts'>): MailItem {
    const item: MailItem = { id: randomUUID(), seq: ++this.seq, ts: this.now(), ...input };
    this.items.push(item);
    if (this.items.length > this.limit) {
      this.items.splice(0, this.items.length - this.limit);
    }
    this.save();
    return item;
  }

  /** 幂等写：同一个 key 已经投过就返回旧的那封。 */
  appendOnce(key: string, input: Omit<MailItem, 'id' | 'seq' | 'ts'>): MailItem {
    const existing = this.items.find((item) => item.key === key);
    if (existing) return existing;
    return this.append({ ...input, key });
  }

  unreadCount(cooId: string, room: string): number {
    const cursor = this.read.get(cooId) ?? 0;
    return this.items.filter((item) => item.to === cooId && item.room === room && item.seq > cursor).length;
  }

  /** 读最旧的未读；markRead=false 时只看不推进游标。 */
  list(cooId: string, room: string, limit = 10, markRead = true): MailPage {
    const cursor = this.read.get(cooId) ?? 0;
    const unread = this.items
      .filter((item) => item.to === cooId && item.room === room && item.seq > cursor)
      .sort((left, right) => left.seq - right.seq);
    const count = Math.max(1, Math.min(50, Math.trunc(limit)));
    const picked = unread.slice(0, count);
    if (markRead && picked.length > 0) {
      this.read.set(cooId, picked[picked.length - 1].seq);
      this.save();
    }
    return {
      unread: unread.length,
      remaining: Math.max(0, unread.length - picked.length),
      items: picked.map(view),
      marked: markRead && picked.length > 0,
    };
  }

  /** 只读最近几封（含已读），给家长页看，不动游标。 */
  recent(cooId: string, room: string, limit = 3): MailView[] {
    return this.items
      .filter((item) => item.to === cooId && item.room === room)
      .slice(-Math.max(1, limit))
      .reverse()
      .map(view);
  }

  count(): number {
    return this.items.length;
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const state: MailState = {
        version: 1,
        seq: this.seq,
        read: Object.fromEntries(this.read),
        items: this.items,
      };
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.file);
      chmodSync(this.file, 0o600);
    } catch { /* 信箱写不进去不阻断房间 */ }
  }
}
