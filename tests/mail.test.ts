import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailStore } from '../src/room/mail.ts';

const A = 'coo-aaaaaaaa';
const B = 'coo-bbbbbbbb';

const letter = (to: string, text: string, kind: 'whisper' | 'gift' | 'promise' | 'ledger' = 'whisper') => ({
  room: 'lobby',
  to,
  kind,
  fromName: '阿岚',
  text,
});

describe('信箱', () => {
  it('按收件人分开：别人读不到你的信，未读数也分开算', () => {
    const store = new MailStore({ now: () => 1000 });
    store.append(letter(A, '在吗'));
    store.append(letter(B, '给你的', 'gift'));

    expect(store.unreadCount(A, 'lobby')).toBe(1);
    expect(store.unreadCount(B, 'lobby')).toBe(1);
    expect(store.unreadCount(A, 'other')).toBe(0);
    expect(store.list(B, 'lobby').items[0]).toMatchObject({ kind: 'gift', text: '给你的' });
  });

  it('最旧的未读先给；peek 不推进游标，读完才标已读', () => {
    const store = new MailStore({ now: () => 1000 });
    store.append(letter(A, '第一封'));
    store.append(letter(A, '第二封'));
    store.append(letter(A, '第三封'));

    const peek = store.list(A, 'lobby', 2, false);
    expect(peek).toMatchObject({ unread: 3, remaining: 1, marked: false });
    expect(peek.items.map((item) => item.text)).toEqual(['第一封', '第二封']);
    expect(store.unreadCount(A, 'lobby')).toBe(3);

    const read = store.list(A, 'lobby', 2, true);
    expect(read.marked).toBe(true);
    expect(store.unreadCount(A, 'lobby')).toBe(1);
    expect(store.list(A, 'lobby', 10).items.map((item) => item.text)).toEqual(['第三封']);
    expect(store.unreadCount(A, 'lobby')).toBe(0);
    expect(store.list(A, 'lobby').items).toHaveLength(0);
  });

  it('信里不带收件人的 cooId；最近几封按新到旧给家长页看', () => {
    const store = new MailStore({ now: () => 1000 });
    store.append(letter(A, '早'));
    store.append(letter(A, '晚'));
    const [item] = store.list(A, 'lobby', 1, false).items;
    expect(item).not.toHaveProperty('to');
    expect(item).not.toHaveProperty('room');
    expect(store.recent(A, 'lobby', 2).map((entry) => entry.text)).toEqual(['晚', '早']);
    expect(store.recent(B, 'lobby', 2)).toHaveLength(0);
  });

  it('超过上限丢最旧的，编号继续往前走', () => {
    const store = new MailStore({ now: () => 1000, limit: 2 });
    store.append(letter(A, '第一封'));
    store.append(letter(A, '第二封'));
    store.append(letter(A, '第三封'));
    expect(store.count()).toBe(2);
    const page = store.list(A, 'lobby', 10, false);
    expect(page.items.map((item) => item.text)).toEqual(['第二封', '第三封']);
  });

  it('落盘后重启：信与已读游标都还在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parlor-mail-'));
    try {
      const file = join(dir, 'mail.json');
      const first = MailStore.load({ file, now: () => 1000 });
      first.append(letter(A, '重启前'));
      first.list(A, 'lobby', 10, true);
      first.append(letter(A, '重启后还在的'));

      const second = MailStore.load({ file, now: () => 2000 });
      expect(second.count()).toBe(2);
      expect(second.unreadCount(A, 'lobby')).toBe(1);
      expect(second.list(A, 'lobby').items.map((item) => item.text)).toEqual(['重启后还在的']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
