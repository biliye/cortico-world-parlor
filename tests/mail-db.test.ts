import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDb, type Db } from '../src/room/db.ts';
import { MailDb, type MailInput } from '../src/room/mail-db.ts';
import type { MailKind } from '../src/room/mail.ts';

const A = 'coo-aaaaaaaa';
const B = 'coo-bbbbbbbb';

let db: Db;
let mail: MailDb;

const seed = (database: Db): void => {
  const coo = database.prepare(
    'INSERT OR IGNORE INTO coos(id, kind, display_name, created_at) VALUES (?, ?, ?, ?)',
  );
  coo.run(A, 'pet', '阿岚', 1);
  coo.run(B, 'pet', '小满', 1);
  const room = database.prepare(
    `INSERT OR IGNORE INTO rooms(id, kind, name, owner_coo_id, visibility, capacity, epoch, seq, created_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 1)`,
  );
  for (const id of ['lobby', 'a', 'b']) room.run(id, 'room', id, A, 'unlisted', 8, `epoch-${id}`);
};

const letter = (to: string, text: string, kind: MailKind = 'whisper', room = 'lobby'): MailInput => ({
  room,
  to,
  kind,
  fromName: '阿岚',
  text,
});

beforeEach(() => {
  db = openDb();
  migrate(db);
  seed(db);
  mail = new MailDb(db, { now: () => 1000 });
});

afterEach(() => {
  db.close();
});

describe('SQLite 全局信箱', () => {
  it('投递后视图带 room/read，不带收件人 cooId', () => {
    const item = mail.append(letter(A, '在吗'));
    expect(item).toMatchObject({ room: 'lobby', kind: 'whisper', read: false, seq: 1 });
    expect(item).not.toHaveProperty('to');

    const row = db.prepare('SELECT coo_id, room_id, read_at FROM mail WHERE id = ?').get(item.id) as {
      coo_id: string;
      room_id: string;
      read_at: number | null;
    };
    expect(row).toEqual({ coo_id: A, room_id: 'lobby', read_at: null });

    const page = mail.list(A, 'lobby', 10, false);
    expect(page.items[0]).not.toHaveProperty('to');
    expect(page.items[0]).toMatchObject({ room: 'lobby', read: false });
    expect(page.unreadByRoom).toEqual({ lobby: 1 });
  });

  it('逐封已读：readOne 只标这一封，重复与别人的信都不动', () => {
    const first = mail.append(letter(A, '第一封'));
    const second = mail.append(letter(A, '第二封'));
    expect(second.seq).toBeGreaterThan(first.seq);

    expect(mail.readOne(A, first.seq)).toBe(true);
    expect(mail.readOne(A, first.seq)).toBe(false);
    expect(mail.readOne(B, first.seq)).toBe(false);
    expect(mail.unreadCount(A, 'lobby')).toBe(1);
    expect(mail.list(A, 'lobby', 10, false).items.map((item) => item.text)).toEqual(['第二封']);
    const row = db.prepare('SELECT read_at FROM mail WHERE seq = ?').get(first.seq) as { read_at: number | null };
    expect(row.read_at).toBe(1000);
  });

  it('跨客厅：先读 B 不会吞掉 A 更早的未读', () => {
    mail.append(letter(A, 'A 的早信', 'whisper', 'a'));
    mail.append(letter(A, 'B 的晚信', 'whisper', 'b'));

    const page = mail.list(A, 'b', 10, true);
    expect(page.items.map((item) => item.text)).toEqual(['B 的晚信']);
    expect(page.unreadByRoom).toEqual({ a: 1 });

    expect(mail.unreadCount(A, 'b')).toBe(0);
    expect(mail.unreadCount(A, 'a')).toBe(1);
    expect(mail.unreadCount(A)).toBe(1);
    expect(mail.list(A, 'a', 10, false).items.map((item) => item.text)).toEqual(['A 的早信']);
    expect(mail.unreadPage(A, 'a').items.map((item) => item.text)).toEqual(['A 的早信']);
  });

  it('按房筛选：未读、最近几封与全库计数互不串房', () => {
    mail.append(letter(A, '厅里的'));
    mail.append(letter(A, 'A 厅的', 'gift', 'a'));
    mail.append(letter(A, 'B 厅的', 'promise', 'b'));
    mail.append(letter(B, '给 B 的'));

    expect(mail.unreadCount(A)).toBe(3);
    expect(mail.unreadCount(A, 'lobby')).toBe(1);
    expect(mail.unreadByRoom(A)).toEqual({ a: 1, b: 1, lobby: 1 });
    expect(mail.unreadByRoom(B)).toEqual({ lobby: 1 });

    expect(mail.recent(A, 'a', 3).map((item) => item.text)).toEqual(['A 厅的']);
    expect(mail.recent(A, 'lobby', 1).map((item) => item.text)).toEqual(['厅里的']);
    expect(mail.recent(A, 'lobby', 1)[0].kind).toBe('whisper');

    expect(mail.list(A, 'a', 10, false).items.map((item) => item.text)).toEqual(['A 厅的']);
    expect(mail.list(A, undefined, 10, false).items.map((item) => item.text))
      .toEqual(['厅里的', 'A 厅的', 'B 厅的']);
    expect(mail.count()).toBe(4);
  });

  it('peek 不标记：list(markRead=false) 与 unreadPage 都不改 read_at', () => {
    mail.append(letter(A, '第一封'));
    mail.append(letter(A, '第二封'));
    mail.append(letter(A, '第三封'));

    const peek = mail.list(A, 'lobby', 2, false);
    expect(peek).toMatchObject({ unread: 3, remaining: 1, marked: false });
    expect(peek.items.map((item) => item.text)).toEqual(['第一封', '第二封']);
    expect(mail.unreadCount(A, 'lobby')).toBe(3);

    const page1 = mail.unreadPage(A, 'lobby', 2);
    expect(page1).toMatchObject({ unread: 3, remaining: 1, marked: false });
    expect(page1.items.map((item) => item.text)).toEqual(['第一封', '第二封']);
    expect(page1.nextAfter).toBe(page1.items[1].seq);

    const page2 = mail.unreadPage(A, 'lobby', 2, page1.nextAfter ?? 0);
    expect(page2).toMatchObject({ unread: 1, remaining: 0, marked: false, nextAfter: null });
    expect(page2.items.map((item) => item.text)).toEqual(['第三封']);
    expect(mail.unreadCount(A, 'lobby')).toBe(3);

    const read = mail.list(A, 'lobby', 2, true);
    expect(read.marked).toBe(true);
    expect(mail.unreadCount(A, 'lobby')).toBe(1);
  });

  it('appendOnce：同 key 幂等，不同 key 才新增', () => {
    const first = mail.appendOnce('gift:1', letter(A, '礼物', 'gift'));
    const again = mail.appendOnce('gift:1', letter(A, '重复的礼物', 'gift'));
    expect(again).toEqual(first);
    expect(mail.count()).toBe(1);

    const other = mail.appendOnce('gift:2', letter(A, '第二份礼物', 'gift'));
    expect(other.seq).toBeGreaterThan(first.seq);
    expect(mail.count()).toBe(2);
    expect(mail.unreadCount(A)).toBe(2);

    const raw = db.prepare('SELECT COUNT(*) AS n FROM mail WHERE key = ?').get('gift:1') as { n: number };
    expect(raw.n).toBe(1);
  });

  it('重启后：信、seq 与逐封已读都还在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parlor-mail-db-'));
    const file = join(dir, 'parlor.db');
    let first: Db | undefined;
    let second: Db | undefined;
    try {
      first = openDb(file);
      migrate(first);
      seed(first);
      const store = new MailDb(first, { now: () => 1000 });
      const readItem = store.append(letter(A, '重启前读过的'));
      store.append(letter(A, '重启前没读的'));
      expect(store.readOne(A, readItem.seq)).toBe(true);
      first.close();
      first = undefined;

      second = openDb(file);
      migrate(second);
      const reopened = new MailDb(second, { now: () => 2000 });
      expect(reopened.count()).toBe(2);
      expect(reopened.unreadCount(A, 'lobby')).toBe(1);
      expect(reopened.list(A, 'lobby', 10, false).items.map((item) => item.text))
        .toEqual(['重启前没读的']);
      expect(reopened.recent(A, 'lobby', 2).map((item) => item.read)).toEqual([false, true]);
    } finally {
      first?.close();
      second?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('旧 JSON 的全局游标迁移成逐封 read_at，重复导入不 duplicate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parlor-mail-db-'));
    try {
      const file = join(dir, 'mail.json');
      writeFileSync(file, JSON.stringify({
        version: 1,
        seq: 4,
        read: { [A]: 1 },
        items: [
          { id: 'm1', seq: 1, ts: 1, room: 'lobby', to: A, kind: 'whisper', fromName: '阿岚', text: '旧已读' },
          { id: 'm2', seq: 2, ts: 2, room: 'lobby', to: A, kind: 'whisper', fromName: '阿岚', text: '旧未读' },
          { id: 'm3', seq: 3, ts: 3, room: 'gone', to: A, kind: 'gift', fromName: '小满', text: '找不到客厅' },
          { id: 'm4', seq: 4, ts: 4, room: 'lobby', to: A, kind: 'ledger', fromName: '小满', text: '账本链接丢了', entryId: 'entry-missing' },
        ],
      }), 'utf8');

      expect(mail.importLegacy(file)).toEqual({ imported: 3, skipped: 1 });
      expect(mail.count()).toBe(3);
      expect(mail.unreadCount(A, 'lobby')).toBe(2);
      const unread = mail.list(A, 'lobby', 10, false).items;
      expect(unread.map((item) => item.text)).toEqual(['旧未读', '账本链接丢了']);
      expect(unread[0].seq).toBe(2);
      expect(unread[1]).not.toHaveProperty('entryId');

      expect(mail.importLegacy(file)).toEqual({ imported: 0, skipped: 4 });
      expect(mail.count()).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
