import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { PARLOR } from '../src/definition.ts';
import { ParlorClient } from '../src/room/client.ts';
import type { Announcement } from '../src/room/support-db.ts';
import { FakeHost } from './helpers/fake-host.ts';

let dir: string;
let world: ReturnType<typeof PARLOR.create> | undefined;
let news: Announcement[];
beforeEach(() => {
  vi.useFakeTimers(); dir = mkdtempSync(join(tmpdir(), 'parlor-world-support-'));
  news = [{ id: 'notice-1', text: '维护结束，欢迎回来', created_at: Date.now() }];
  vi.spyOn(ParlorClient.prototype, 'initializeIdentity').mockResolvedValue(true);
  vi.spyOn(ParlorClient.prototype, 'snapshot').mockResolvedValue({ id: 'hall', latest: 1, now: Date.now(), at: '',
    seat: { id: 'mine', name: '阿岚', kind: 'pet', tier: 'full', joinedAt: Date.now() }, seats: [], events: [], maxSeats: 400 });
  vi.spyOn(ParlorClient.prototype, 'stream').mockImplementation(async (_t, _s, _cb, signal) => {
    await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
  });
});
afterEach(async () => { await world?.stop(); world = undefined; vi.restoreAllMocks(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });
const start = async (off = false) => {
  const ctx = fakeWorldContext(PARLOR, { scratchDir: dir });
  ctx.cfg.serverUrl = 'http://127.0.0.1:8790'; ctx.cfg.room = 'hall'; if (off) ctx.cfg.wakeTier = 'off';
  ctx.secret = name => name === 'PARLOR_SEAT_TOKEN' ? 'seat' : 'inv';
  world = PARLOR.create(ctx); const host = new FakeHost(); await world.start(host); await vi.advanceTimersByTimeAsync(0); return host;
};
describe('Coo 反馈与公告', () => {
  it('新公告投递一次；重复轮询与重启不重复，恢复后新公告可以补收', async () => {
    const support = vi.spyOn(ParlorClient.prototype, 'support').mockImplementation(async () => ({ announcements: news }));
    const host = await start();
    expect(host.events.filter(e => e.type === 'parlor.announcement')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.events.filter(e => e.type === 'parlor.announcement')).toHaveLength(1);
    support.mockRejectedValueOnce(new Error('fetch failed'));
    news.unshift({ id: 'notice-2', text: '新公告', created_at: Date.now() });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.events.filter(e => e.type === 'parlor.announcement')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.events.filter(e => e.type === 'parlor.announcement')).toHaveLength(2);
    await world!.stop();
    const restarted = await start();
    expect(restarted.events.filter(e => e.type === 'parlor.announcement')).toHaveLength(0);
  });

  it('off 不主动投递；仍可以主动查公告与提交反馈', async () => {
    const support = vi.spyOn(ParlorClient.prototype, 'support').mockImplementation(async (_token, action, body) => body
      ? { feedback: { id: 'f-1', coo_id: 'mine', name: '阿岚', text: body.text, created_at: Date.now(), reply: '', status: 'open' } }
      : action === 'announcements' ? { announcements: news } : { feedback: [] });
    const host = await start(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(host.events.some(e => e.type === 'parlor.announcement')).toBe(false);
    expect(support).not.toHaveBeenCalled();
    const call = (name: string, args: Record<string, unknown>) => world!.tools().find(tool => tool.name === name)!.handler(args, {} as never);
    expect(await call('parlor_announcements', {})).toContain('维护结束');
    expect(await call('parlor_feedback', { text: '断线问题', requestId: 'retry-me' })).toContain('不代表运营者已读');
    expect(support).toHaveBeenLastCalledWith('seat', 'feedback', { text: '断线问题', requestId: 'retry-me' });
  });
});
