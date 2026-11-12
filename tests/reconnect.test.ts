import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { PARLOR } from '../src/definition.ts';
import { ParlorClient, ParlorHttpError } from '../src/room/client.ts';
import { FakeHost } from './helpers/fake-host.ts';

let world: ReturnType<typeof PARLOR.create> | undefined;
let dir: string;
beforeEach(() => { vi.useFakeTimers(); dir = mkdtempSync(join(tmpdir(), 'parlor-reconnect-')); });
afterEach(async () => {
  await world?.stop(); world = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});
const start = async (host = new FakeHost(), { name = '阿岚', room = 'lobby' } = {}) => {
  const ctx = fakeWorldContext(PARLOR, { scratchDir: dir });
  ctx.cfg.serverUrl = 'http://127.0.0.1:8790'; ctx.cfg.room = 'lobby';
  ctx.cfg.seatName = '阿岚';
  ctx.secret = name => name === 'PARLOR_SEAT_TOKEN' ? 'seat' : 'inv';
  vi.spyOn(ParlorClient.prototype, 'initializeIdentity').mockResolvedValue(true);
  vi.spyOn(ParlorClient.prototype, 'location').mockResolvedValue({ room, seat: null });
  vi.spyOn(ParlorClient.prototype, 'rename').mockResolvedValue({ name });
  vi.spyOn(ParlorClient.prototype, 'support').mockResolvedValue({ announcements: [] });
  vi.spyOn(ParlorClient.prototype, 'snapshot').mockResolvedValue({ id: room, latest: 12, now: Date.now(), at: '',
    seat: { id: 'mine', name, kind: 'pet', tier: 'full', joinedAt: Date.now() }, seats: [], events: [], maxSeats: 30 });
  world = PARLOR.create(ctx); await world.start(host); return host;
};

describe('断线恢复', () => {
  it('远端实际席位名走外部事件，环境前缀只用本机席位名和有效的客厅编号', async () => {
    vi.spyOn(ParlorClient.prototype, 'stream').mockResolvedValue(undefined);
    const name = '服务端传来的席位名';
    const host = await start(new FakeHost(), { name, room: '服务端传来的客厅文字' });
    expect(host.events.find(event => event.type === 'parlor.started')).toMatchObject({
      origin: 'external',
      text: expect.stringContaining(name),
    });
    expect(await world!.envPromptVars()).toMatchObject({
      'parlor.room': '请查询当前客厅',
      'parlor.seat': '阿岚',
    });
  });

  it('持续 fetch failed 会持续退避；故障只提示一次，恢复后补游标并能再次收消息', async () => {
    let attempt = 0;
    const stream = vi.spyOn(ParlorClient.prototype, 'stream').mockImplementation(async (_token, since, receive, signal, _room, opened) => {
      if (++attempt === 1) throw new ParlorHttpError(502, '远端故障详情');
      if (attempt <= 8) throw new TypeError('fetch failed');
      expect(since).toBe(12); opened?.();
      receive({ seq: 13, ts: Date.now(), type: 'parlor.say', from: 'friend', scope: { kind: 'room' },
        mentions: ['mine'], text: '@阿岚 回来了', data: { name: '小满' } });
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
    });
    const host = await start();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(stream).toHaveBeenCalledTimes(9);
    expect(host.events.filter(e => e.type === 'parlor.link' && e.text.includes('断了'))).toEqual([
      expect.objectContaining({ origin: 'external', text: expect.stringContaining('远端故障详情') }),
    ]);
    expect(host.events.filter(e => e.type === 'parlor.link' && e.text.includes('已恢复'))).toEqual([
      expect.objectContaining({ origin: 'internal' }),
    ]);
    expect(host.events.some(e => e.type === 'parlor.message' && e.text.includes('回来了'))).toBe(true);
  });

  it('断线通知写入失败也不停止重试；停用会立即取消退避', async () => {
    const stream = vi.spyOn(ParlorClient.prototype, 'stream').mockRejectedValue(new TypeError('fetch failed'));
    const host = new FakeHost();
    const original = host.pushEvent.bind(host);
    vi.spyOn(host, 'pushEvent').mockImplementation(async (event, opts) => {
      if (event.type === 'parlor.link') throw new Error('host unavailable');
      return original(event, opts);
    });
    await start(host); await vi.advanceTimersByTimeAsync(65_000);
    expect(stream.mock.calls.length).toBeGreaterThan(5);
    await world!.stop();
    const attempts = stream.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(stream).toHaveBeenCalledTimes(attempts);
  });

  it('45 秒没收到响应头时结束订阅，即使 fetch 在中止后仍挂起', async () => {
    let aborted = false;
    let failure: unknown;
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise(() => {
      init.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    })));
    void new ParlorClient('http://127.0.0.1:8790').stream('t', 0, () => {}).catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(aborted).toBe(true);
    expect(failure).toMatchObject({ message: expect.stringContaining('45 秒') });
  });

  it('主动中止时结束挂起的订阅并释放迟到的响应', async () => {
    let respond!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { respond = resolve; }));
    vi.stubGlobal('fetch', fetch);
    const abort = new AbortController();
    const onOpen = vi.fn();
    const onEvent = vi.fn();
    let failure: unknown;
    void new ParlorClient('http://127.0.0.1:8790').stream('t', 0, onEvent, abort.signal, 'lobby', onOpen)
      .catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();
    const reason = new Error('切换客厅');
    abort.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(failure).toBe(reason);

    const cancel = vi.fn();
    respond(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('半开流超时；收到 SSE 心跳会延后超时；停用会取消流', async () => {
    let writer: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal('fetch', vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) { writer = controller; },
        cancel,
      });
      return new Response(body, { status: 200 });
    }));
    let failure: unknown;
    const abort = new AbortController();
    const client = new ParlorClient('http://127.0.0.1:8790');
    void client.stream('t', 0, () => {}, abort.signal).catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(30_000);
    writer!.enqueue(new TextEncoder().encode(': ping\n\n'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(failure).toMatchObject({ message: expect.stringContaining('45 秒') });
    expect(cancel).toHaveBeenCalledTimes(1);

    void client.stream('t', 0, () => {}, abort.signal).catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(failure).toBe(abort.signal.reason);
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
