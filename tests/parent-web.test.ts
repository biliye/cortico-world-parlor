import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { sourceFunction } from './helpers/game-component.ts';

class TestNode {
  children: TestNode[] = [];
  listeners = new Map<string, () => Promise<void>>();
  className = '';
  textContent = '';
  get firstChild() { return this.children[0]; }
  append(...nodes: TestNode[]) { this.children.push(...nodes); }
  removeChild(node: TestNode) { this.children.splice(this.children.indexOf(node), 1); }
  addEventListener(type: string, listener: () => Promise<void>) { this.listeners.set(type, listener); }
}

const mount = (responses: unknown[] = []) => {
  const nodes = new Map<string, TestNode>();
  const fetch = vi.fn();
  for (const body of responses) fetch.mockResolvedValueOnce(Response.json(body));
  const beginGlobalEntry = vi.fn();
  const setTimeout = vi.fn();
  const render = vi.fn();
  const document = {
    hidden: false,
    getElementById(id: string) {
      if (!nodes.has(id)) nodes.set(id, new TestNode());
      return nodes.get(id);
    },
    createElement: () => new TestNode(),
    addEventListener: vi.fn(),
  };
  const source = readFileSync(new URL('../src/web/parent.js', import.meta.url), 'utf8')
    .replace("import { mountStoryArchive } from './story-archive.js';", '')
    .replace("import { beginGlobalEntry } from './identity-entry.js';", '')
    .replace('void boot();', '');
  const renderer = runInNewContext(source + '\nrender = captureRender; ({ renderMail, renderLog, loadView, playAsParent })', {
    document, fetch, setTimeout, clearTimeout: vi.fn(), URLSearchParams, captureRender: render, beginGlobalEntry, confirm: () => true,
    location: { origin: 'https://parlor.test' },
  }) as { renderMail(view: unknown): void; renderLog(view: unknown): void; loadView(): Promise<boolean>;
    playAsParent(button: { disabled: boolean }): Promise<void> };
  return { ...renderer, nodes, document, fetch, render, setTimeout, beginGlobalEntry };
};

it('家长页从统一身份服务返回游玩页后自动领席位', async () => {
  const { playAsParent, beginGlobalEntry } = mount([{ globalEntry: 'https://identity.test', room: 'lobby' }]);
  await playAsParent({ disabled: false });
  expect(beginGlobalEntry).toHaveBeenCalledWith('https://identity.test', { room: 'lobby', parent: true }, 'https://parlor.test/play');
});

it('家长退厅提交页面上确认的席位，成功后刷新位置', async () => {
  const { loadView, nodes, fetch, render } = mount([
    { room: { id: 'hall' }, seat: { id: 'seat-from-view' } },
    { ok: true, left: true },
    { room: null, seat: null },
  ]);
  await loadView();
  await nodes.get('leave-child-seat')!.listeners.get('click')!();
  expect(fetch.mock.calls[1]?.[0]).toBe('/v1/parent/leave');
  expect(JSON.parse(fetch.mock.calls[1]?.[1].body)).toEqual({ seatId: 'seat-from-view' });
  expect(render).toHaveBeenLastCalledWith({ room: null, seat: null });
});

it('反馈页遇到失效席位时可以凭家长会话提交', async () => {
  class SupportNode extends TestNode {
    disabled = false;
    value = '';
    replaceChildren(...nodes: TestNode[]) { this.children = nodes; }
    removeAttribute() {}
  }
  const nodes = new Map<string, SupportNode>();
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new SupportNode());
    return nodes.get(id)!;
  };
  const fetch = vi.fn(async (path: string, init: RequestInit) => {
    if (path === '/v1/support/feedback?as=parent') {
      return Response.json({ feedback: init.method === 'POST' ? { id: 'saved' } : [] });
    }
    if (path === '/v1/support/announcements?as=parent') return Response.json({ announcements: [] });
    return Response.json({ error: '席位令牌已失效' }, { status: 401 });
  });
  const script = readFileSync(new URL('../src/web/support.js', import.meta.url), 'utf8')
    .replace('void refresh().catch(error => status(error.message));', '');
  const { refresh } = runInNewContext(script + '\n({ refresh })', {
    document: { getElementById: get, createElement: () => new SupportNode() }, fetch, location: { search: '' },
    URLSearchParams, AbortSignal, setInterval: vi.fn(), crypto: { randomUUID: () => 'sample-request' },
    localStorage: { getItem: () => '{"token":"old-token"}', setItem: vi.fn() },
  }) as { refresh(): Promise<void> };
  await refresh();
  expect(fetch.mock.calls.map(([path]) => path)).toEqual([
    '/v1/support/feedback', '/v1/support/feedback?as=web', '/v1/support/feedback?as=parent', '/v1/support/announcements?as=parent',
  ]);
  const button = get('feedback-submit');
  expect(button.disabled).toBe(false);
  get('feedback-text').value = '网页发来的反馈';
  const submit = get('feedback-form').listeners.get('submit') as unknown as (event: object) => void;
  submit({ preventDefault: vi.fn(), submitter: button });
  await vi.waitFor(() => expect(get('status').textContent).toContain('反馈已保存'));
  expect(fetch.mock.calls[4]).toMatchObject([
    '/v1/support/feedback?as=parent',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '网页发来的反馈', requestId: 'sample-request' }) },
  ]);
});
describe('家长页消息渲染', () => {
  it('合并版本响应、清空已失效的私牌与历史，并在后台降频', async () => {
    const versions = { state: 's1', events: 'e1', mail: 'm1' };
    const state = { room: { id: 'lobby' }, tablePrivate: { text: '暗牌' }, watchTableId: 'old-table' };
    const events = [{ seq: 2, text: '历史' }];
    const mail = [{ text: '来信' }];
    const { loadView, document, fetch, render, setTimeout } = mount([
      { now: 1, versions, state, events, mail },
      { now: 2, versions },
      { now: 3, versions: { ...versions, state: 's2', events: 'e2' }, state: { room: null, tablePrivate: null }, events: [] },
    ]);
    const first = loadView();
    expect(loadView()).toBe(first);
    await first;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 3000);
    document.hidden = true;
    await loadView();
    expect(fetch.mock.lastCall?.[0]).toContain('stateVersion=s1&eventsVersion=e1&mailVersion=m1');
    expect(render).toHaveBeenLastCalledWith({ ...state, now: 2, at: true, events, mail });
    expect(setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 30000);
    await loadView();
    expect(render).toHaveBeenLastCalledWith({ room: null, tablePrivate: null, now: 3, at: true, events: [], mail });
  });

  it('来信和孩子回复各标方向；正文当纯文本，刷新不堆重复记录', () => {
    const { renderMail, nodes } = mount();
    const view = { mailUnread: 1, mail: [
      { ts: 1, fromMe: true, toName: '阿岚', toHandle: 'alan', text: '<script>回复</script>', kind: 'whisper' },
      { ts: 0, fromName: '阿岚', fromHandle: 'alan', text: '在吗', kind: 'whisper', read: false },
    ] };
    renderMail(view);
    const rows = nodes.get('mail')!.children;
    expect(rows[0].children[1].textContent).toBe('孩子 → 阿岚 #alan');
    expect(rows[0].children[2].textContent).toBe('<script>回复</script>');
    expect(rows[0].children[2].children).toHaveLength(0);
    expect(rows[1].children[1].textContent).toBe('阿岚 #alan → 孩子 · 未读');
    expect(nodes.get('mail-unread')!.textContent).toBe('孩子未读 1 封');
    renderMail(view);
    expect(nodes.get('mail')!.children).toHaveLength(2);
    renderMail({ mail: [] });
    expect(nodes.get('mail')!.children[0].textContent).toBe('信箱是空的。');
  });

  it('孩子自己的公开发言与桌聊仍显示，私牌行动不画进聊天', () => {
    const { renderLog, nodes } = mount();
    renderLog({ room: { id: 'hall' }, events: [
      { seq: 1, ts: 1, type: 'parlor.say', from: 'child', data: { name: '小满' }, text: '公开回复' },
      { seq: 2, ts: 2, type: 'parlor.table.say', from: 'child', data: { name: '小满' }, text: '桌聊回复' },
      { seq: 3, ts: 3, type: 'parlor.table.turn', from: 'system', text: '暗牌' },
    ] });
    expect(nodes.get('log')!.children.map(row => row.children[2].textContent)).toEqual(['公开回复', '桌聊回复']);
  });
});

it('家长观战遇到暂停桌时停止轮询，暂时故障仍会重试', async () => {
  const setTimeout = vi.fn();
  const live = { value: { table: { label: '飞行棋' } } };
  const status = { value: '' };
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 409 }));
  const refresh = sourceFunction('web-src/views/ParentWatchView.vue', 'refresh', {
    props: { tableId: 't1' }, controller: new AbortController(),
    window: { setTimeout }, timer: undefined, fetch, live, status,
  });

  await refresh();
  expect(status.value).toBe('暂时无法更新牌桌，正在重试。');
  expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 2500);
  setTimeout.mockClear();

  await refresh();
  expect(live.value).toBeNull();
  expect(status.value).toBe('这张牌桌已暂停，暂时无法观看。');
  expect(setTimeout).not.toHaveBeenCalled();
});
