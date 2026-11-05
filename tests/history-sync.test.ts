import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { PARLOR } from '../src/definition.ts';
import type { ParlorConfigSection } from '../src/config.ts';
import { LocalHistory } from '../src/local-history.ts';
import { ParlorClient, ParlorHttpError } from '../src/room/client.ts';
import { historySyncEvent, type HistorySyncEvent } from '../src/room/history-sync.ts';
import type { RoomEvent } from '../src/room/protocol.ts';
import { FakeHost } from './helpers/fake-host.ts';

const event = (seq: number): HistorySyncEvent => ({ seq, ts: seq, type: 'parlor.say', from: 'friend', text: `消息${seq}` });
let dir: string;
let world: ReturnType<typeof PARLOR.create> | undefined;
let ctx: ReturnType<typeof fakeWorldContext<ParlorConfigSection>>;
let source: Record<string, HistorySyncEvent[]>;
let receive: (event: RoomEvent) => void;

const idle = async () => {
  for (let i = 0; i < 100; i++) {
    const info = await world!.webUi!().invoke!('history', 'info', []) as { syncing: boolean };
    if (!info.syncing) return;
  }
  throw new Error('补档未完成');
};
const start = async () => { world = PARLOR.create(ctx); await world.start(new FakeHost()); await idle(); };
const tick = async () => { await vi.advanceTimersByTimeAsync(60_000); await idle(); };
const info = async () => world!.webUi!().invoke!('history', 'info', []) as Promise<{ count: number; error: string }>;

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), 'parlor-history-sync-'));
  ctx = fakeWorldContext(PARLOR, { scratchDir: dir });
  ctx.cfg.serverUrl = 'http://127.0.0.1:8790'; ctx.cfg.room = 'lobby'; ctx.cfg.seatName = '孩子';
  ctx.secret = key => ({ PARLOR_SEAT_TOKEN: 'seat-token', PARLOR_INVITE_CODE: 'inv' }[key] ?? '');
  vi.spyOn(ParlorClient.prototype, 'initializeIdentity').mockResolvedValue(true);
  vi.spyOn(ParlorClient.prototype, 'snapshot').mockResolvedValue({
    id: 'lobby', seat: { id: 'mine', name: '孩子', kind: 'pet', tier: 'full', joinedAt: 1 },
    seats: [], latest: 0, now: Date.now(), at: '', events: [], maxSeats: 30,
  });
  vi.spyOn(ParlorClient.prototype, 'stream').mockImplementation(async (_token, _since, callback, signal, _room, onOpen) => {
    receive = callback; onOpen?.();
    await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener('abort', () => resolve(), { once: true }); });
  });
  vi.spyOn(ParlorClient.prototype, 'messageHistory').mockResolvedValue({ items: [], seats: [{ id: 'old-mine', room: 'other' }] });
  vi.spyOn(ParlorClient.prototype, 'support').mockResolvedValue({ announcements: [] });
  source = { lobby: [], other: [] };
  vi.spyOn(ParlorClient.prototype, 'historySync').mockImplementation(async (room, after = 0, limit = 200) => {
    const remaining = source[room].filter(item => item.seq > after);
    return { events: remaining.slice(0, limit), more: remaining.length > limit };
  });
});

afterEach(async () => {
  await world?.stop(); world = undefined;
  vi.restoreAllMocks(); vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('本机档案增量补档', () => {
  it('首次跨页补齐；每厅独立游标，空轮询与重启不重下已有正文，实时消息去重', async () => {
    source.lobby = Array.from({ length: 205 }, (_, i) => event(i + 1)); source.other = [event(7)];
    await start();
    expect((await info()).count).toBe(206);
    expect(vi.mocked(ParlorClient.prototype.historySync).mock.calls).toEqual([['lobby', 0], ['lobby', 200], ['other', 0]]);
    vi.mocked(ParlorClient.prototype.historySync).mockClear();
    await tick();
    expect(vi.mocked(ParlorClient.prototype.historySync).mock.calls).toEqual([['lobby', 205], ['other', 7]]);
    source.lobby.push(event(206), event(207));
    receive({ ...event(207), scope: { kind: 'room' } });
    await tick();
    expect((await info()).count).toBe(208);
    await world!.stop(); vi.mocked(ParlorClient.prototype.historySync).mockClear(); await start();
    expect(vi.mocked(ParlorClient.prototype.historySync).mock.calls).toEqual([['lobby', 207], ['other', 7]]);
    expect((await info()).count).toBe(208);
  });

  it('第二页网络失败后从已落盘的第一页末尾续传，不跳过缺口', async () => {
    const sync = vi.mocked(ParlorClient.prototype.historySync);
    sync.mockResolvedValueOnce({ events: Array.from({ length: 200 }, (_, i) => event(i + 1)), more: true })
      .mockRejectedValueOnce(new ParlorHttpError(503, '稍后重试'));
    await start();
    expect((await info()).count).toBe(200); expect((await info()).error).toContain('稍后重试');
    source.lobby = [event(201), event(202)]; sync.mockClear(); await tick();
    expect(sync.mock.calls[0]).toEqual(['lobby', 200]);
    expect((await info()).count).toBe(202); expect((await info()).error).toBe('');
  });

  it('一页内写盘失败不推进该页游标，重试不会重复或漏消息', async () => {
    source.lobby = [event(1), event(2), event(3)];
    const append = LocalHistory.prototype.append;
    let fail = true;
    vi.spyOn(LocalHistory.prototype, 'append').mockImplementation(function (this: LocalHistory, message) {
      if (message.id === 'event:lobby:2' && fail) { fail = false; throw new Error('磁盘暂时不可写'); }
      return append.call(this, message);
    });
    await start();
    expect((await info()).count).toBe(1);
    vi.mocked(ParlorClient.prototype.historySync).mockClear(); await tick();
    expect(vi.mocked(ParlorClient.prototype.historySync).mock.calls[0]).toEqual(['lobby', 0]);
    expect((await info()).count).toBe(3);
  });

  it('旧网关404后兼容回放；暂时性500不切回高流量回放', async () => {
    const sync = vi.mocked(ParlorClient.prototype.historySync).mockRejectedValueOnce(new ParlorHttpError(500, '暂时故障'));
    const replay = vi.spyOn(ParlorClient.prototype, 'replayAsIdentity').mockResolvedValue({
      room: 'lobby', latest: 0, now: 1, at: '', retentionDays: 7, events: [], older: false,
    });
    await start(); expect(replay).not.toHaveBeenCalled();
    sync.mockRejectedValueOnce(new ParlorHttpError(404, '没有这个接口')); await tick();
    expect(replay).toHaveBeenCalledTimes(2);
    sync.mockClear(); await tick();
    expect(sync).not.toHaveBeenCalled(); expect(replay).toHaveBeenCalledTimes(4);
  });

  it('分页不前进时失败退出，不无限循环', async () => {
    vi.mocked(ParlorClient.prototype.historySync).mockResolvedValueOnce({ events: [], more: true });
    await start(); expect((await info()).error).toContain('分页没有前进');
  });

  it('轻量事件保留收发与私聊去重字段，剔除游戏数据；正文大小不随手牌副本增长', () => {
    const original = { ...event(1), data: {
      actorSeatId: 'old-mine', actorName: '我', name: '名称', to: '朋友',
      mail: { seq: 77, ts: 10, room: 'other', unused: '无关' },
      table: { speeches: '长篇发言'.repeat(20_000) }, cards: ['A'],
    } };
    const compact = historySyncEvent(original);
    expect(compact.data).toEqual({ actorSeatId: 'old-mine', actorName: '我', name: '名称', to: '朋友', mail: { seq: 77, ts: 10, room: 'other' } });
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(400);
    expect(Buffer.byteLength(JSON.stringify(original))).toBeGreaterThan(200_000);
  });
});
