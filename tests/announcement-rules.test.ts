import { describe, expect, it } from 'vitest';
import { pickAnnouncement, rememberDismissed, excerpt } from '../src/web/announcement-rules.js';

describe('首屏公告横幅的规则', () => {
  const older = { id: 'a1', text: '旧的公告', created_at: '2026-11-01 10:00:00' };
  const newer = { id: 'a2', text: '新的公告', created_at: '2026-11-01 12:00:00' };

  it('没有公告就不弹', () => {
    expect(pickAnnouncement([], [])).toBeNull();
    expect(pickAnnouncement(null, ['a1'])).toBeNull();
  });

  it('挑最新的一条；点掉过的不再挑', () => {
    expect(pickAnnouncement([older, newer], [])?.id).toBe('a2');
    expect(pickAnnouncement([older, newer], ['a2'])?.id).toBe('a1');
    expect(pickAnnouncement([older, newer], ['a1', 'a2'])).toBeNull();
  });

  it('没有时间戳就按服务器给的顺序（新的在前）', () => {
    expect(pickAnnouncement([{ id: 'b1', text: '第一条' }, { id: 'b2', text: '第二条' }], [])?.id).toBe('b1');
  });

  it('缺 id 的条目跳过', () => {
    expect(pickAnnouncement([{ text: '没有编号' }, { id: 'c1', text: '有编号' }], [])?.id).toBe('c1');
  });

  it('点过的 id 记在本地，重复点不会越积越多', () => {
    expect(rememberDismissed([], 'a1')).toEqual(['a1']);
    expect(rememberDismissed(['a1'], 'a1')).toEqual(['a1']);
    expect(rememberDismissed(['a1'], 'a2')).toEqual(['a1', 'a2']);
    expect(rememberDismissed(['a1', 'a2'], 'a3', 2)).toEqual(['a2', 'a3']);
    expect(rememberDismissed(['a1', 3, null], 'a2')).toEqual(['a1', 'a2']);
    expect(rememberDismissed(null, 'a1')).toEqual(['a1']);
  });

  it('横幅只有一行：压掉换行、太长截断', () => {
    expect(excerpt('  周末  会馆  维护\n第二天恢复 ')).toBe('周末 会馆 维护 第二天恢复');
    expect(excerpt('一'.repeat(60)).length).toBe(47);
    expect(excerpt('一'.repeat(60)).endsWith('…')).toBe(true);
    expect(excerpt('')).toBe('');
    expect(excerpt(undefined)).toBe('');
  });
});
