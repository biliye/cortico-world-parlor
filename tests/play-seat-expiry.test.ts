import { afterEach, describe, expect, it, vi } from 'vitest';
import { decideExpiredSeat, seatTokenFrom } from '../web-src/lib/seat-errors.ts';

describe('换厅期间迟到的席位失效响应', () => {
  it('本页已换到新令牌时，旧 401 不清凭证、不重载旧地址', () => {
    expect(decideExpiredSeat('old', 'new', 'new')).toBe('ignore');
  });

  it('另一个标签页更新令牌时，旧标签页仍重新读取新席位', () => {
    expect(decideExpiredSeat('old', 'new', 'old')).toBe('reload');
  });

  it('当前令牌确实失效时仍回到加入页', () => {
    expect(decideExpiredSeat('old', 'old', 'old')).toBe('clear');
  });

  it('加入页本来就没有席位时什么都不做', () => {
    expect(decideExpiredSeat('old', null, null)).toBe('ignore');
  });

  it('失败回包携带发起请求时的令牌，而非回包时的新令牌', () => {
    const headers = new Headers({ authorization: 'Bearer old' });
    expect(seatTokenFrom(headers)).toBe('old');
  });
});

describe('入场网络请求不串行等待无关能力探测', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  async function client(health: object) {
    vi.resetModules();
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ room: 'room1', seatId: 's1', token: 'test', cooId: 'c1', cooSecret: 'seat-only' }) });
    const fetcher = vi.fn(async (path: string) => new Response(JSON.stringify(path === '/healthz' ? health : { ok: true })));
    vi.stubGlobal('fetch', fetcher);
    const path = '../web-src/api/client.ts';
    return { module: await import(path), fetcher };
  }

  it('位置恢复和显式切厅接口不等待healthz，能力探测在后台合并', async () => {
    const { module, fetcher } = await client({ rooms: 2 });
    fetcher.mockImplementation(async (path: string) => path === '/healthz'
      ? new Promise<Response>(() => {}) : new Response(JSON.stringify({ ok: true })));
    await module.api('/v1/me/location');
    await module.api('/v1/rooms/room1/switch', { method: 'POST' });
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/v1/me/location', '/healthz', '/v1/rooms/room1/switch']);
  });

  it('多客厅快照仍按探测结果使用房间路径，后续不重复探测', async () => {
    const { module, fetcher } = await client({ rooms: 2 });
    await module.api('/v1/room?limit=1');
    await module.api('/v1/replay?limit=80');
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/healthz', '/v1/rooms/room1/room?limit=1', '/v1/rooms/room1/replay?limit=80']);
  });

  it('旧单间服务仍使用不带房间号的接口', async () => {
    const { module, fetcher } = await client({ guestJoin: true });
    await module.api('/v1/room?limit=1');
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/healthz', '/v1/room?limit=1']);
  });
});
