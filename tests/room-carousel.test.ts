import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Browser ESM is intentionally shipped without Node declarations.
import { createRoomCarousel } from '../src/web/room-carousel.js';

afterEach(() => { vi.useRealTimers(); });
const room = (id: string, seats: number, archived = false) => ({ id, seats, archived, name: id });

describe('热门客厅轮播', () => {
  it('严格大于10人：10人、非数字人数与已归档的客厅不进入推荐', () => {
    const model = createRoomCarousel(() => {});
    model.setRooms([room('ten', 10), room('eleven', 11), room('full', 30), room('closed', 20, true), room('unknown', NaN)]);
    expect(model.snapshot().rooms.map((entry: { id: string }) => entry.id)).toEqual(['eleven', 'full']);
    model.dispose();
  });

  it('每6秒自动轮换并循环；悬停/聚焦、手动暂停、离开大厅都停止计时', () => {
    vi.useFakeTimers();
    const model = createRoomCarousel(() => {});
    model.setRooms([room('a', 11), room('b', 15)]); model.setActive(true);
    vi.advanceTimersByTime(5999); expect(model.snapshot().current.id).toBe('a');
    vi.advanceTimersByTime(1); expect(model.snapshot().current.id).toBe('b');
    model.setBlocked(true); vi.advanceTimersByTime(12000); expect(model.snapshot().current.id).toBe('b');
    model.setBlocked(false); vi.advanceTimersByTime(6000); expect(model.snapshot().current.id).toBe('a');
    model.setPaused(true); vi.advanceTimersByTime(12000); expect(model.snapshot().current.id).toBe('a');
    model.move(1); expect(model.snapshot().current.id).toBe('b');
    model.setPaused(false); model.setActive(false); vi.advanceTimersByTime(12000); expect(model.snapshot().current.id).toBe('b');
    model.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  it('目录刷新保留当前客厅；跌到10人时移除；零个/一个不启动自动轮换', () => {
    vi.useFakeTimers();
    const model = createRoomCarousel(() => {});
    model.setRooms([room('a', 11), room('b', 15)]); model.select(1);
    model.setRooms([room('b', 16), room('a', 12)]); expect(model.snapshot().current.id).toBe('b');
    model.setActive(true); model.setRooms([room('b', 10), room('a', 12)]);
    expect(model.snapshot().current.id).toBe('a'); expect(vi.getTimerCount()).toBe(0);
    model.setRooms([room('a', 9)]); expect(model.snapshot().current).toBeNull(); expect(vi.getTimerCount()).toBe(0);
    model.dispose();
  });
});
