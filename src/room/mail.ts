/**
 * 信箱：给可能不在线的席位留一份持久的私信、礼物与账本通知。
 *
 * 事件流会滚动（房间只留最近 500 条），信箱不滚。
 * 已读按“每一封”记，不按一个 cooId 一个游标：多客厅时先读 B 厅不能把 A 厅更早的
 * 未读一起吞掉。`room` 只作为来源/筛选，不再参与已读位置。
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type MailKind = 'whisper' | 'gift' | 'promise' | 'ledger' | 'invite';

export interface MailItem {
  id: string;
  /** 全局递增，只用来排序/定位；已读不再靠它。 */
  seq: number;
  ts: number;
  room: string;
  /** 收件人 cooId。 */
  to: string;
  /** 发件人 cooId；私聊才有，系统信为 null。 */
  fromCooId?: string;
  kind: MailKind;
  /** 具体动作（gift / promise / accept / decline / settle / default / refill…）。 */
  action?: string;
  fromName: string;
  text: string;
  entryId?: string;
  /** 幂等键：同一条通知只留一封。 */
  key?: string;
  /** 逐封已读；老文件没有这一位时按旧游标迁移。 */
  read?: boolean;
}

/** 给 World / 家长页的信；不带收件人 cooId。 */
export interface MailView {
  id: string;
  seq: number;
  ts: number;
  room: string;
  /** 私聊来信时有：对方 cooId（网页用它打开会话）。 */
  fromCooId?: string;
  kind: MailKind;
  action?: string;
  fromName: string;
  text: string;
  entryId?: string;
  read: boolean;
}

export interface MailPage {
  /** 这次读取前，查询范围里有多少封未读。 */
  unread: number;
  /** 这次没取走、还留着下次读的未读。 */
  remaining: number;
  items: MailView[];
  /** 这次有没有把信标成已读。 */
  marked: boolean;
  /** 当前这个 cooId 每个客厅各有多少未读（读完之后的状态）。 */
  unreadByRoom: Record<string, number>;
}

export interface MailStoreOptions {
  file?: string;
  now?: () => number;
  limit?: number;
}

interface MailState {
  version: 1;
  seq: number;
  /** 老文件的全局游标；只用于迁移，新写入不再产生。 */
  read?: Record<string, number>;
  items: MailItem[];
}

/** 长局通知要的是「确认落盘」；写不进去必须让调用方知道。 */
export class MailWriteError extends Error {
  constructor(message = '信箱写盘失败') {
    super(message);
    this.name = 'MailWriteError';
  }
}

const DEFAULT_LIMIT = 400;
const KINDS: readonly MailKind[] = ['whisper', 'gift', 'promise', 'ledger', 'invite'];

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
  room: item.room,
  kind: item.kind,
  ...(item.action ? { action: item.action } : {}),
  fromName: item.fromName,
  text: item.text,
  ...(item.entryId ? { entryId: item.entryId } : {}),
  read: item.read === true,
});

export class MailStore {
  private items: MailItem[] = [];
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
      const cursors: Record<string, number> = {};
      if (raw.read && typeof raw.read === 'object') {
        for (const [cooId, cursor] of Object.entries(raw.read)) {
          const value = Number(cursor);
          if (typeof cooId === 'string' && Number.isFinite(value) && value > 0) cursors[cooId] = value;
        }
      }
      if (Array.isArray(raw.items)) {
        store.items = raw.items.filter(isItem).slice(-store.limit).map((item) => ({
          ...item,
          // 老文件只有全局游标：按旧行为把它当成已读；新文件逐封记。
          read: typeof item.read === 'boolean' ? item.read : (cursors[item.to] ?? 0) >= item.seq,
        }));
      }
      store.seq = Math.max(Number(raw.seq) || 0, ...store.items.map((item) => item.seq), 0);
    } catch { /* 坏文件从空信箱开始，不阻断房间 */ }
    return store;
  }

  append(input: Omit<MailItem, 'id' | 'seq' | 'ts' | 'read'>): MailItem {
    const item: MailItem = { id: randomUUID(), seq: ++this.seq, ts: this.now(), ...input, read: false };
    this.items.push(item);
    if (this.items.length > this.limit) {
      this.items.splice(0, this.items.length - this.limit);
    }
    this.save();
    return item;
  }

  /**
   * 幂等写：同一个 key 已经投过就返回旧的那封。
   * 写盘失败会回滚并抛 `MailWriteError`，不假装已经留底。
   */
  appendOnce(key: string, input: Omit<MailItem, 'id' | 'seq' | 'ts' | 'read'>): MailItem {
    const existing = this.items.find((item) => item.key === key);
    if (existing) return existing;
    const before = this.seq;
    const item: MailItem = { id: randomUUID(), seq: ++this.seq, ts: this.now(), ...input, key, read: false };
    this.items.push(item);
    if (!this.save()) {
      this.items.pop();
      this.seq = before;
      throw new MailWriteError(`信箱写盘失败，key=${key} 没有确认`);
    }
    if (this.items.length > this.limit) {
      this.items.splice(0, this.items.length - this.limit);
    }
    return item;
  }

  /** 未读数；给了 room 就只算那个客厅，不给算全部。 */
  unreadCount(cooId: string, room?: string): number {
    return this.items.filter((item) => (
      item.to === cooId
      && item.read !== true
      && (room === undefined || item.room === room)
    )).length;
  }

  /** 每个客厅各多少未读；用于全局信箱列表。 */
  unreadByRoom(cooId: string): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const item of this.items) {
      if (item.to !== cooId || item.read === true) continue;
      counts[item.room] = (counts[item.room] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * 读最旧的未读；markRead=false 时只看不标记。
   * 给了 room 就只读那个客厅；不给读全部，回执带每厅未读。
   */
  list(cooId: string, room?: string, limit = 10, markRead = true): MailPage {
    const unread = this.items
      .filter((item) => (
        item.to === cooId
        && item.read !== true
        && (room === undefined || item.room === room)
      ))
      .sort((left, right) => left.seq - right.seq);
    const count = Math.max(1, Math.min(50, Math.trunc(limit)));
    const picked = unread.slice(0, count);
    if (markRead && picked.length > 0) {
      for (const item of picked) item.read = true;
      this.save();
    }
    return {
      unread: unread.length,
      remaining: Math.max(0, unread.length - picked.length),
      items: picked.map(view),
      marked: markRead && picked.length > 0,
      unreadByRoom: this.unreadByRoom(cooId),
    };
  }

  /** 只标记一封；用于「读这一封」的入口。 */
  readOne(cooId: string, seq: number): boolean {
    const item = this.items.find((entry) => entry.to === cooId && entry.seq === seq);
    if (!item || item.read === true) return false;
    item.read = true;
    this.save();
    return true;
  }

  /** 只读最近几封（含已读），给家长页看，不动已读状态。 */
  recent(cooId: string, room?: string, limit = 3): MailView[] {
    return this.items
      .filter((item) => item.to === cooId && (room === undefined || item.room === room))
      .slice(-Math.max(1, limit))
      .reverse()
      .map(view);
  }

  count(): number {
    return this.items.length;
  }

  private save(): boolean {
    if (!this.file) return true;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const state: MailState = {
        version: 1,
        seq: this.seq,
        items: this.items,
      };
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.file);
      chmodSync(this.file, 0o600);
      return true;
    } catch {
      return false;
    }
  }
}
