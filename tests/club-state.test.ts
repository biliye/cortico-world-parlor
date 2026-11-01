import { describe, expect, it } from 'vitest';
// @ts-expect-error Browser ESM is intentionally shipped without Node declarations.
import { createClubState, conversationKey, readRoute, routeUrl } from '../src/web/club-state.js';

describe('会馆界面状态与服务端快照隔离', () => {
  it('不同身份、客厅和桌的草稿隔离，切换与重新装载仍可恢复', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) };
    const first = createClubState(storage);
    const keys = [conversationKey('a', 'hall', 'room'), conversationKey('a', 'r1', 'room'),
      conversationKey('a', 'r1', 'table', 't1'), conversationKey('a', 'r1', 'table', 't2'), conversationKey('b', 'r1', 'table', 't1')];
    keys.forEach((key: string, index: number) => first.saveDraft(key, `草稿${index}`));
    first.setChatOpen(false); first.setMobileChatOpen(true); first.toggleFavorite('r1');
    const restored = createClubState(storage);
    keys.forEach((key: string, index: number) => expect(restored.draft(key)).toBe(`草稿${index}`));
    expect(restored.chatOpen).toBe(false); expect(restored.mobileChatOpen).toBe(true); expect(restored.isFavorite('r1')).toBe(true);
    restored.saveDraft(keys[2], ''); expect(restored.draft(keys[2])).toBe('');
    expect(restored.draft(keys[3])).toBe('草稿3');
  });

  it('存储损坏或被禁用时保留内存中的交互', () => {
    for (const bad of ['{', 'null', '7']) {
      const state = createClubState({ getItem: () => bad, setItem: () => { throw new Error('QuotaExceededError'); } });
      state.saveDraft('key', '一段话'); state.setChatOpen(false);
      expect(state.draft('key')).toBe('一段话'); expect(state.chatOpen).toBe(false);
    }
  });

  it('客厅邀请不携带身份或桌号，牌桌路由可以恢复且特殊字符正确编码', () => {
    const room = 'r-茶 & 夜';
    expect(readRoute(new URL(routeUrl(room, 'table', 't & 1'), 'http://localhost').search)).toEqual({ room, view: 'table', table: 't & 1' });
    expect(routeUrl(room, 'lobby', 't & 1')).not.toMatch(/table|token|secret|key/);
    expect(readRoute('?room=hall&view=unknown')).toEqual({ room: 'hall', view: 'lobby', table: '' });
  });
});
