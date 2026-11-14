import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { sourceFunction } from './helpers/game-component.ts';

class TestNode {
  children: TestNode[] = [];
  className = '';
  textContent = '';
  get firstChild() { return this.children[0]; }
  append(...nodes: TestNode[]) { this.children.push(...nodes); }
  removeChild(node: TestNode) { this.children.splice(this.children.indexOf(node), 1); }
  addEventListener() {}
}

const mount = (responses: unknown[] = []) => {
  const nodes = new Map<string, TestNode>();
  const fetch = vi.fn();
  for (const body of responses) fetch.mockResolvedValueOnce(Response.json(body));
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
    .replace('void boot();', '');
  const renderer = runInNewContext(source + '\nrender = captureRender; ({ renderMail, renderLog, loadView })', {
    document, fetch, setTimeout, clearTimeout: vi.fn(), URLSearchParams, captureRender: render,
  }) as { renderMail(view: unknown): void; renderLog(view: unknown): void; loadView(): Promise<boolean> };
  return { ...renderer, nodes, document, fetch, render, setTimeout };
};

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
