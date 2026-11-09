import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 家长入场：`#key=` 一进页面就从地址栏抹掉（不进历史、不会被复制外发），
 * 但钥匙必须留在内存里。旧页在断网后还能用同一把钥匙重试；Vue 换过来时漏了这一步——
 * 第一次请求没到服务器，第二次就没有钥匙可用，只能让用户回扩展面板重新点一次。
 */

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  parentPlay: vi.fn(),
  takeKeyFromHash: vi.fn(),
  beginGlobalEntry: vi.fn(),
  finishGlobalEntry: vi.fn(),
}));

vi.mock('../web-src/api/client.ts', () => ({
  api: mocks.api,
  scopedPath: (path: string) => path,
  takeKeyFromHash: mocks.takeKeyFromHash,
  beginGlobalEntry: mocks.beginGlobalEntry,
  finishGlobalEntry: mocks.finishGlobalEntry,
  parentPlay: mocks.parentPlay,
}));

vi.mock('../web-src/stores/chat.ts', () => ({ noteChatEvent: vi.fn(), resetChatState: vi.fn() }));
vi.mock('../web-src/stores/dm.ts', () => ({ noteWhisper: vi.fn(), resetDmState: vi.fn() }));
vi.mock('../web-src/stores/mail.ts', () => ({ resetMailState: vi.fn() }));
vi.mock('../web-src/stores/ui.ts', () => ({ showToast: vi.fn() }));
vi.mock('../web-src/stores/session.ts', async () => {
  const { ref } = await import('vue');
  return {
    seat: ref(null), saveSeat: vi.fn(), clearSeat: vi.fn(), readStoredSeat: vi.fn(),
    adoptSeat: vi.fn(), STORE_KEY: 'parlor-play-v1',
  };
});
vi.mock('../web-src/stores/view.ts', async () => {
  const { ref } = await import('vue');
  return { watchTableId: ref(''), backToRoom: vi.fn(), enterTable: vi.fn(), readView: vi.fn() };
});

class Stream {
  onopen?: () => void;
  onmessage?: (message: { data: string }) => void;
  onerror?: () => void;
  constructor(readonly url: string) {}
  close() {}
}

let store: any;
let session: any;

beforeEach(async () => {
  vi.resetModules();
  for (const mock of Object.values(mocks)) mock.mockReset();
  vi.stubGlobal('location', { pathname: '/play', search: '', hash: '', reload: vi.fn(), assign: vi.fn() });
  vi.stubGlobal('history', { state: null, replaceState: vi.fn(), pushState: vi.fn() });
  vi.stubGlobal('performance', { getEntriesByType: () => [] });
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  vi.stubGlobal('EventSource', Stream);
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  // 计算式 import 让 Node 侧 tsconfig 不把整套 DOM 源码纳入服务端类型检查。
  const sessionPath = '../web-src/stores/session.ts';
  const storePath = '../web-src/stores/parlor.ts';
  session = await import(sessionPath);
  store = await import(storePath);
  session.seat.value = null;
  session.readStoredSeat.mockImplementation(() => session.seat.value);
});

describe('家长钥匙的重试', () => {
  it('第一次请求断网后，第二次仍然带着同一把钥匙去换席位', async () => {
    mocks.takeKeyFromHash.mockReturnValueOnce('key-1').mockReturnValue('');
    mocks.parentPlay.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(store.boot()).rejects.toThrow('fetch failed');
    expect(mocks.parentPlay).toHaveBeenCalledTimes(1);
    expect(mocks.parentPlay).toHaveBeenLastCalledWith('key-1');

    // 地址栏已经抹掉了，靠页内副本再试一次——这就是旧页有、Vue 漏掉的那一步。
    mocks.parentPlay.mockResolvedValueOnce({ globalEntry: 'https://identity.test/authorize', room: 'hall' });
    await expect(store.boot()).resolves.toBe(false);
    expect(mocks.parentPlay).toHaveBeenCalledTimes(2);
    expect(mocks.parentPlay).toHaveBeenLastCalledWith('key-1');
    expect(mocks.beginGlobalEntry).toHaveBeenCalledTimes(1);
  });

  it('换到席位之后清掉内存副本，不会拿旧钥匙再换一次', async () => {
    mocks.takeKeyFromHash.mockReturnValueOnce('key-2').mockReturnValue('');
    mocks.parentPlay.mockImplementationOnce(async () => {
      const next = { room: 'room1', seatId: 's1', name: '爸爸', token: 't1', cooId: 'c1', cooSecret: 'x' };
      session.seat.value = next;
      return { room: 'room1', seat: { id: 's1', name: '爸爸' }, token: 't1', identity: { cooId: 'c1', cooSecret: 'x' } };
    });
    mocks.api.mockImplementation(async (path: string) => {
      if (path.startsWith('/v1/me/location')) return { room: 'room1', seat: { id: 's1', name: '爸爸' } };
      if (path.startsWith('/v1/room')) return { id: 'room1', now: Date.now(), latest: 0, seats: [], online: [] };
      return { events: [] };
    });

    await expect(store.boot()).resolves.toBe(true);
    expect(mocks.parentPlay).toHaveBeenCalledTimes(1);

    await expect(store.boot()).resolves.toBe(true);
    expect(mocks.parentPlay).toHaveBeenCalledTimes(1);
  });

  it('改用邀请码入场后，不会拿失败过的钥匙再换一次身份', async () => {
    mocks.takeKeyFromHash.mockReturnValueOnce('key-3').mockReturnValue('');
    mocks.parentPlay.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(store.boot()).rejects.toThrow('fetch failed');
    expect(mocks.parentPlay).toHaveBeenCalledTimes(1);

    // 换一条路入场：席位由邀请码流程写进来，钥匙该退场了。
    session.seat.value = { room: 'room1', seatId: 's9', name: '客人', token: 't9', cooId: 'c9', cooSecret: 'y' };
    mocks.api.mockImplementation(async (path: string) => {
      if (path.startsWith('/v1/me/location')) return { room: 'room1', seat: { id: 's9', name: '客人' } };
      if (path.startsWith('/v1/room')) return { id: 'room1', now: Date.now(), latest: 0, seats: [], online: [] };
      return { events: [] };
    });

    await expect(store.boot()).resolves.toBe(true);
    expect(mocks.parentPlay).toHaveBeenCalledTimes(1);
  });
});
