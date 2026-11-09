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

describe('H2/H3席位跟随与私密内容恢复', () => {
  afterEach(() => { vi.doUnmock('../web-src/api/client.ts'); vi.resetModules(); vi.unstubAllGlobals(); });

  it('真实session采用其他窗口席位只改内存，不向共享存储回写', async () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem });
    const path = '../web-src/stores/session.ts'; const session = await import(path);
    const next = { room: 'hall', token: 'new', seatId: 'new', cooId: 'coo', cooSecret: 'seat-only', name: '玩家' };
    session.adoptSeat(next);
    expect(session.seat.value).toEqual(next);
    expect(setItem).not.toHaveBeenCalled();
    session.adoptSeat(null, '席位已退出');
    expect(session.entryNotice.value).toBe('席位已退出');
  });

  async function privateStores(api: any) {
    vi.resetModules();
    vi.stubGlobal('window', { clearTimeout, setTimeout });
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.doMock('../web-src/api/client.ts', () => ({ api, scopedPath: (path:string) => path,
      takeKeyFromHash: () => '', beginGlobalEntry: vi.fn(), finishGlobalEntry: vi.fn(), parentPlay: vi.fn() }));
    const dmPath = '../web-src/stores/dm.ts', mailPath = '../web-src/stores/mail.ts';
    return { dm: await import(dmPath), mail: await import(mailPath) };
  }

  it('信箱全部标已读用专用写接口，迟到的旧首屏响应不能恢复旧未读数', async () => {
    let release!: (data: any) => void;
    const pending = new Promise(resolve => { release = resolve; });
    let lists = 0;
    const api = vi.fn((path: string) => {
      if (path === '/v1/mail/read-all') return Promise.resolve({ changed: 87, remaining: 0 });
      lists += 1;
      return lists === 1 ? pending : Promise.resolve({ unread: 0, items: [{ id: 'new', read: true }] });
    });
    const { mail } = await privateStores(api);
    const first = mail.loadMail(true);
    expect(await mail.markAllRead()).toEqual({ changed: 87, remaining: 0 });
    expect(api).toHaveBeenCalledWith('/v1/mail/read-all', { method: 'POST' });
    release({ unread: 87, items: [{ id: 'old', read: false }] });
    await first;
    expect(mail.unread.value).toBe(0);
    expect(mail.items.value).toEqual([{ id: 'new', read: true }]);
    expect(mail.loading.value).toBe(false);
  });

  it('切换席位后迟到的私聊列表、信箱响应不会填回旧私密内容', async () => {
    let release!: (data:any) => void;
    const pending = new Promise(resolve => { release = resolve; });
    const { dm, mail } = await privateStores(vi.fn(() => pending));
    const requests = [dm.loadThreads(), mail.loadMail(true)];
    dm.resetDmState(); mail.resetMailState();
    release({ threads: [{ lastText: '旧身份私聊' }], items: [{ text: '旧身份信件' }], unread: 8 });
    await Promise.all(requests);
    expect(dm.threads.value).toEqual([]); expect(mail.items.value).toEqual([]);
    expect(dm.unread.value).toBe(0); expect(mail.unread.value).toBe(0);
  });

  it('旧私聊在途时换身份，不会在新身份下补发已读写操作', async () => {
    let release!: (data:any) => void;
    const request = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const { dm } = await privateStores(request);
    const opening = dm.openThread('peer');
    dm.resetDmState(); release({ messages: [{ text: '旧消息' }] }); await opening;
    expect(request).toHaveBeenCalledTimes(1); expect(dm.messages.value).toEqual([]);
  });
});
