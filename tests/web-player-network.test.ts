import { afterEach, describe, expect, it, vi } from 'vitest';

// 浏览器模块由网页 tsconfig 检查，节点测试只在运行时加载。
const webPlayerModule = '../web-src/api/web-player.ts';
const { uncertainWebResult, webPlayerRequest } = await import(webPlayerModule);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('网页登录网络层', () => {
  it.each([401, 409, 429, 503])('保留 HTTP %i 状态和错误正文', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: '会馆提示' }, { status })));
    const failure = await webPlayerRequest('play', {}).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status, message: '会馆提示' });
    expect(uncertainWebResult(failure)).toBe(status >= 500);
  });

  it('超时中断请求并把结果交给调用方核对，网络层只发一次', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const fetch = vi.fn((_path: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetch);
    const pending = webPlayerRequest('redeem', { code: 'fixture' }).catch((error: unknown) => error);
    controller.abort();
    const error = await pending;
    expect(error).toMatchObject({ status: 0, message: expect.stringContaining('超时') });
    expect(uncertainWebResult(error)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('失败后可读取新会话，状态请求绕过浏览器缓存', async () => {
    const player = { guest: true, name: '测试游客', seated: true, expiresAt: 1000 };
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(Response.json(player));
    vi.stubGlobal('fetch', fetch);
    const failure = await webPlayerRequest('play', { takeover: true }).catch((error: unknown) => error);
    expect(uncertainWebResult(failure)).toBe(true);
    expect(await webPlayerRequest('me')).toEqual(player);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/v1/web/play', '/v1/web/me']);
    expect(fetch.mock.calls[1][1]).toMatchObject({ cache: 'no-store' });
  });
});
