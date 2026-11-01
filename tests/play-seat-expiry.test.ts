import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../src/web/play.js', import.meta.url), 'utf8');
const browserFunction = (name: string, globals: Record<string, unknown>) => {
  const code = source.match(new RegExp(`async function ${name}\\([^]*?\\n\\}`))?.[0];
  if (!code) throw new Error(`Missing browser function: ${name}`);
  return runInNewContext(`(${code})`, globals);
};

function expiry(storedToken: string, currentToken: string) {
  const reload = vi.fn(), clearStore = vi.fn(), renderJoin = vi.fn();
  const state = { cfg: { token: currentToken }, stream: null };
  const handle = browserFunction('handleExpiredSeat', {
    readStore: () => ({ token: storedToken }), state,
    location: { reload }, clearStore, renderJoin,
    loadEntryPolicy: async () => {}, hasParentSession: async () => false,
  });
  return { handle, reload, clearStore, renderJoin };
}

describe('换厅期间迟到的席位失效响应', () => {
  it('本页已换到新令牌时，旧 401 不清凭证、不重载旧地址', async () => {
    const x = expiry('new', 'new');
    await x.handle('old');
    expect(x.clearStore).not.toHaveBeenCalled();
    expect(x.reload).not.toHaveBeenCalled();
  });

  it('另一个标签页更新令牌时，旧标签页仍重新读取新席位', async () => {
    const x = expiry('new', 'old');
    await x.handle('old');
    expect(x.reload).toHaveBeenCalledOnce();
    expect(x.clearStore).not.toHaveBeenCalled();
  });

  it('当前令牌确实失效时仍回到加入页', async () => {
    const x = expiry('old', 'old');
    await x.handle('old');
    expect(x.clearStore).toHaveBeenCalledOnce();
    expect(x.renderJoin).toHaveBeenCalledWith('这个席位的令牌已经失效，请重新加入。');
  });

  it('失败回包携带发起请求时的令牌，而非回包时的新令牌', async () => {
    const state = { cfg: { token: 'old', cooSecret: 'seat-only' } };
    const api = browserFunction('api', {
      state, Headers, roomPath: (path: string) => path, timeoutSignal: () => ({}),
      fetch: async () => {
        state.cfg.token = 'new';
        return { ok: false, status: 401, json: async () => ({ error: 'expired' }) };
      },
    });
    await expect(api('/v1/room')).rejects.toMatchObject({ status: 401, seatToken: 'old' });
  });
});
