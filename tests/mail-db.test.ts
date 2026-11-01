import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Db } from '../src/room/db.ts';
import { MailDb, type MailInput } from '../src/room/mail-db.ts';
import type { MailKind } from '../src/room/mail.ts';
import { closeTestDb, openTestDb } from './helpers/test-db.ts';

const A = 'coo-aaaaaaaa';
const B = 'coo-bbbbbbbb';

let db: Db;
let mail: MailDb;

const seed = async (database: Db): Promise<void> => {
  const coo = database.prepare(
    'INSERT INTO coos(id, kind, display_name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
  );
  await coo.run(A, 'pet', '阿岚', 1);
  await coo.run(B, 'pet', '小满', 1);
  const room = database.prepare(
    `INSERT INTO rooms(id, kind, name, owner_coo_id, visibility, capacity, epoch, seq, created_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 1) ON CONFLICT DO NOTHING`,
  );
  for (const id of ['lobby', 'a', 'b']) await room.run(id, 'room', id, A, 'unlisted', 8, `epoch-${id}`);
};

const letter = (to: string, text: string, kind: MailKind = 'whisper', room = 'lobby'): MailInput => ({
  room,
  to,
  kind,
  fromName: '阿岚',
  text,
});

beforeEach(async () => {
  db = await openTestDb();
  await seed(db);
  mail = new MailDb(db, { now: () => 1000 });
});

afterEach(async () => {
  await closeTestDb(db);
});

describe('SQLite 全局信箱', () => {
  it('投递后视图带 room/read，不带收件人 cooId', async () => {
    const item = await mail.append(letter(A, '在吗'));
    expect(item).toMatchObject({ room: 'lobby', kind: 'whisper', read: false, seq: 1 });
    expect(item).not.toHaveProperty('to');

    const row = await db.prepare('SELECT coo_id, room_id, read_at FROM mail WHERE id = ?').get(item.id) as {
      coo_id: string;
      room_id: string;
      read_at: number | null;
    };
    expect(row).toEqual({ coo_id: A, room_id: 'lobby', read_at: null });

    const page = await mail.list(A, 'lobby', 10, false);
    expect(page.items[0]).not.toHaveProperty('to');
    expect(page.items[0]).toMatchObject({ room: 'lobby', read: false });
    expect(page.unreadByRoom).toEqual({ lobby: 1 });
  });

  it('逐封已读：readOne 只标这一封，重复与别人的信都不动', async () => {
    const first = await mail.append(letter(A, '第一封'));
    const second = await mail.append(letter(A, '第二封'));
    expect(second.seq).toBeGreaterThan(first.seq);

    expect(await mail.readOne(A, first.seq)).toBe(true);
    expect(await mail.readOne(A, first.seq)).toBe(false);
    expect(await mail.readOne(B, first.seq)).toBe(false);
    expect(await mail.unreadCount(A, 'lobby')).toBe(1);
    expect((await mail.list(A, 'lobby', 10, false)).items.map((item) => item.text)).toEqual(['第二封']);
    const row = await db.prepare('SELECT read_at FROM mail WHERE seq = ?').get(first.seq) as { read_at: number | null };
    expect(row.read_at).toBe(1000);
  });

  it('跨客厅：先读 B 不会吞掉 A 更早的未读', async () => {
    await mail.append(letter(A, 'A 的早信', 'whisper', 'a'));
    await mail.append(letter(A, 'B 的晚信', 'whisper', 'b'));

    const page = await mail.list(A, 'b', 10, true);
    expect(page.items.map((item) => item.text)).toEqual(['B 的晚信']);
    expect(page.unreadByRoom).toEqual({ a: 1 });

    expect(await mail.unreadCount(A, 'b')).toBe(0);
    expect(await mail.unreadCount(A, 'a')).toBe(1);
    expect(await mail.unreadCount(A)).toBe(1);
    expect((await mail.list(A, 'a', 10, false)).items.map((item) => item.text)).toEqual(['A 的早信']);
    expect((await mail.unreadPage(A, 'a')).items.map((item) => item.text)).toEqual(['A 的早信']);
  });

  it('按房筛选：未读、最近几封与全库计数互不串房', async () => {
    await mail.append(letter(A, '厅里的'));
    await mail.append(letter(A, 'A 厅的', 'gift', 'a'));
    await mail.append(letter(A, 'B 厅的', 'promise', 'b'));
    await mail.append(letter(B, '给 B 的'));

    expect(await mail.unreadCount(A)).toBe(3);
    expect(await mail.unreadCount(A, 'lobby')).toBe(1);
    expect(await mail.unreadByRoom(A)).toEqual({ a: 1, b: 1, lobby: 1 });
    expect(await mail.unreadByRoom(B)).toEqual({ lobby: 1 });

    expect((await mail.recent(A, 'a', 3)).map((item) => item.text)).toEqual(['A 厅的']);
    expect((await mail.recent(A, 'lobby', 1)).map((item) => item.text)).toEqual(['厅里的']);
    expect((await mail.recent(A, 'lobby', 1))[0].kind).toBe('whisper');

    expect((await mail.list(A, 'a', 10, false)).items.map((item) => item.text)).toEqual(['A 厅的']);
    expect((await mail.list(A, undefined, 10, false)).items.map((item) => item.text))
      .toEqual(['厅里的', 'A 厅的', 'B 厅的']);
    expect(await mail.count()).toBe(4);
  });

  it('peek 不标记：list(markRead=false) 与 unreadPage 都不改 read_at', async () => {
    await mail.append(letter(A, '第一封'));
    await mail.append(letter(A, '第二封'));
    await mail.append(letter(A, '第三封'));

    const peek = await mail.list(A, 'lobby', 2, false);
    expect(peek).toMatchObject({ unread: 3, remaining: 1, marked: false });
    expect(peek.items.map((item) => item.text)).toEqual(['第一封', '第二封']);
    expect(await mail.unreadCount(A, 'lobby')).toBe(3);

    const page1 = await mail.unreadPage(A, 'lobby', 2);
    expect(page1).toMatchObject({ unread: 3, remaining: 1, marked: false });
    expect(page1.items.map((item) => item.text)).toEqual(['第一封', '第二封']);
    expect(page1.nextAfter).toBe(page1.items[1].seq);

    const page2 = await mail.unreadPage(A, 'lobby', 2, page1.nextAfter ?? 0);
    expect(page2).toMatchObject({ unread: 1, remaining: 0, marked: false, nextAfter: null });
    expect(page2.items.map((item) => item.text)).toEqual(['第三封']);
    expect(await mail.unreadCount(A, 'lobby')).toBe(3);

    const read = await mail.list(A, 'lobby', 2, true);
    expect(read.marked).toBe(true);
    expect(await mail.unreadCount(A, 'lobby')).toBe(1);
  });

  it('appendOnce：同 key 幂等，不同 key 才新增', async () => {
    const first = await mail.appendOnce('gift:1', letter(A, '礼物', 'gift'));
    const again = await mail.appendOnce('gift:1', letter(A, '重复的礼物', 'gift'));
    expect(again).toEqual(first);
    expect(await mail.count()).toBe(1);

    const other = await mail.appendOnce('gift:2', letter(A, '第二份礼物', 'gift'));
    expect(other.seq).toBeGreaterThan(first.seq);
    expect(await mail.count()).toBe(2);
    expect(await mail.unreadCount(A)).toBe(2);

    const raw = await db.prepare('SELECT COUNT(*) AS n FROM mail WHERE key = ?').get('gift:1') as { n: number };
    expect(raw.n).toBe(1);
  });

  it('重启后：信、seq 与逐封已读都还在', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parlor-mail-db-'));
    const file = join(dir, 'parlor.db');
    let first: Db | undefined;
    let second: Db | undefined;
    try {
      first = await openTestDb(file);
      await seed(first);
      const store = new MailDb(first, { now: () => 1000 });
      const readItem = await store.append(letter(A, '重启前读过的'));
      await store.append(letter(A, '重启前没读的'));
      expect(await store.readOne(A, readItem.seq)).toBe(true);
      await closeTestDb(first);
      first = undefined;

      second = await openTestDb(file);
      const reopened = new MailDb(second, { now: () => 2000 });
      expect(await reopened.count()).toBe(2);
      expect(await reopened.unreadCount(A, 'lobby')).toBe(1);
      expect((await reopened.list(A, 'lobby', 10, false)).items.map((item) => item.text))
        .toEqual(['重启前没读的']);
      expect((await reopened.recent(A, 'lobby', 2)).map((item) => item.read)).toEqual([false, true]);
    } finally {
      if (first) await closeTestDb(first);
      if (second) await closeTestDb(second);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('旧 JSON 的全局游标迁移成逐封 read_at，重复导入不 duplicate', async () => {
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

      expect(await mail.importLegacy(file)).toEqual({ imported: 3, skipped: 1 });
      expect(await mail.count()).toBe(3);
      expect(await mail.unreadCount(A, 'lobby')).toBe(2);
      const unread = (await mail.list(A, 'lobby', 10, false)).items;
      expect(unread.map((item) => item.text)).toEqual(['旧未读', '账本链接丢了']);
      expect(unread[0].seq).toBe(2);
      expect(unread[1]).not.toHaveProperty('entryId');

      expect(await mail.importLegacy(file)).toEqual({ imported: 0, skipped: 4 });
      expect(await mail.count()).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
