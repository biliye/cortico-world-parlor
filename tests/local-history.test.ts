import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHistory, type HistoryMessage } from '../src/local-history.ts';

let dir: string;
let store: LocalHistory;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'parlor-local-history-'));
  store = new LocalHistory(dir, 'https://example.invalid', 'child');
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
const message = (id: string, ts = 1, extra: Partial<HistoryMessage> = {}): HistoryMessage => ({
  id, ts, room: 'lobby', type: 'parlor.say', direction: 'received', sender: '朋友', recipient: '孩子', text: `消息${id}`, ...extra,
});

describe('孩子本机持久消息档案', () => {
  it('保存超过 7 天的记录，重开去重；不同服务器和孩子相互隔离', () => {
    store.append(message('old', Date.now() - 30 * 86400_000));
    store.advance('mail', 10); store.advance('mail', 2);
    store.close();
    store = new LocalHistory(dir, 'https://example.invalid', 'child');
    store.append(message('old', Date.now(), { text: '重复推送不能改写原记录' }));
    expect(store.query().messages).toHaveLength(1);
    expect(store.query().messages[0].text).toBe('消息old');
    expect(store.progress('mail')).toBe(10);
    const otherChild = new LocalHistory(dir, 'https://example.invalid', 'other');
    const otherServer = new LocalHistory(dir, 'https://other.invalid', 'child');
    try {
      expect(otherChild.query().messages).toEqual([]);
      expect(otherServer.query().messages).toEqual([]);
    } finally { otherChild.close(); otherServer.close(); }
  });

  it('同毫秒 250 条按稳定游标翻页，新消息插入不造成重复或漏页', () => {
    for (let i = 0; i < 250; i++) store.append(message(`id-${String(i).padStart(3, '0')}`, 100));
    const first = store.query({ limit: 100 });
    store.append(message('new', 101));
    const second = store.query({ limit: 100, before: first.next! });
    const third = store.query({ limit: 100, before: second.next! });
    const ids = [...first.messages, ...second.messages, ...third.messages].map(item => item.id);
    expect(ids).toHaveLength(250); expect(new Set(ids).size).toBe(250);
    expect(third.next).toBeNull(); expect(ids).not.toContain('new');
  });

  it('按时间半开区间、客厅、方向筛选，局中私密记录仍受隐藏约束', () => {
    store.append(message('start', 100, { direction: 'sent' }));
    store.append(message('secret', 101, { direction: 'sent', private: true }));
    store.append(message('other-room', 102, { room: 'hall' }));
    store.append(message('end', 200));
    const query = { from: 100, until: 200, room: 'lobby', direction: 'sent' as const };
    expect(store.query(query).messages.map(item => item.id)).toEqual(['secret', 'start']);
    expect(store.query(query, true).messages.map(item => item.id)).toEqual(['start']);
    expect(() => store.query({ from: 200, until: 100 })).toThrow('结束时间');
    expect(() => store.query({ from: NaN })).toThrow('查询时间');
    expect(() => store.query({ before: { ts: 1, id: null as unknown as string } })).toThrow('翻页位置');
    expect(() => store.query({ room: "' OR 1=1 --" })).not.toThrow();
    expect(store.query({ room: "' OR 1=1 --" }).messages).toEqual([]);
  });

  it('进出过滤使用旧档案已有的事件类型，并在分页前生效', () => {
    store.append(message('joined', 104, { type: 'parlor.joined' }));
    store.append(message('private', 103, { private: true }));
    store.append(message('newer', 102, { room: 'hall' }));
    store.append(message('left', 101, { type: 'parlor.left' }));
    store.append(message('older', 100, { text: '我刚进了客厅' }));
    expect(store.query().messages.map(item => item.id)).toEqual(['joined', 'private', 'newer', 'left', 'older']);
    const query = { hidePresence: true, limit: 1 };
    const first = store.query(query, true);
    expect(first.messages.map(item => item.id)).toEqual(['newer']);
    expect(first.next).toEqual({ ts: 102, id: 'newer' });
    const second = store.query({ ...query, before: first.next! }, true);
    expect(second.messages.map(item => item.id)).toEqual(['older']);
    expect(second.next).toBeNull();
  });
});
