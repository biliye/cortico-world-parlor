import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

class Node {
  value = ''; textContent = ''; className = ''; hidden = false; disabled = false;
  children: Node[] = [];
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; }
  addEventListener() {}
  click() {}
}
const mount = () => {
  const nodes = new Map(['filters','from','until','room','direction','presence','messages','more','status','info','export'].map(id => [id, new Node()]));
  const queries: any[] = [];
  const pages: any[] = [];
  const downloads: string[][] = [];
  const info = { count: 2, first: 1, last: 2, rooms: ['hall'] };
  const source = readFileSync(new URL('../src/web/local-history.js', import.meta.url), 'utf8').replace('void boot();', '');
  const UI = runInNewContext(source + '\n({ load, exportRange, filters })', {
    document: { getElementById: (id: string) => nodes.get(id), createElement: () => new Node(), querySelectorAll: () => [...nodes.values()] },
    location: { href: 'http://localhost/api/webui/providers/world%3Aparlor/panels/history/page' },
    URL: class extends URL { static createObjectURL() { return 'blob:test'; } static revokeObjectURL() {} },
    Blob: class { constructor(chunks: string[]) { downloads.push(chunks); } },
    setTimeout() {},
    fetch: async (url: URL) => {
      if (url.pathname.endsWith('/info')) return { ok: true, json: async () => info };
      queries.push(JSON.parse(url.searchParams.get('args')!)[0]);
      const next = pages.shift();
      if (next instanceof Error) throw next;
      return { ok: true, json: async () => next };
    },
  }) as { load(more?: boolean): Promise<void>; exportRange(): Promise<void>; filters(): unknown };
  nodes.get('from')!.value = '2026-11-02T00:00'; nodes.get('until')!.value = '2026-11-03T00:00';
  return { ...UI, nodes, queries, pages, downloads, info };
};

describe('本地档案真实网页脚本', () => {
  it('再次查询后更新档案总计，同时保留当前客厅选项', async () => {
    const ui = mount();
    ui.pages.push({ messages: [], next: null });
    await ui.load();
    expect(ui.nodes.get('info')!.textContent).toContain('档案总计 2 条');
    ui.nodes.get('room')!.value = 'hall';
    ui.info.count = 9;
    ui.info.rooms.push('other');
    ui.pages.push({ messages: [], next: null });
    await ui.load();
    expect(ui.nodes.get('info')!.textContent).toContain('档案总计 9 条');
    expect(ui.nodes.get('room')!.value).toBe('hall');
    expect(ui.nodes.get('room')!.children.map(option => option.value)).toEqual(['hall', 'other']);
  });

  it('北京时间筛选、翻页保留条件，错误可重试，消息正文按纯文本渲染', async () => {
    const ui = mount(); ui.nodes.get('room')!.value = 'hall'; ui.nodes.get('direction')!.value = 'sent';
    ui.nodes.get('presence')!.value = 'hide';
    ui.pages.push({ messages: [{ id: 'a', ts: 1, room: 'hall', type: 'parlor.say', direction: 'sent', sender: '孩子', recipient: '客厅', text: '<img onerror=bad()>' }], next: { ts: 1, id: 'a' } });
    await ui.load();
    expect(ui.queries[0]).toMatchObject({ from: Date.parse('2026-11-01T16:00:00Z'), until: Date.parse('2026-11-02T16:00:00Z'), room: 'hall', direction: 'sent', hidePresence: true });
    expect(ui.nodes.get('messages')!.children[0].children[1].textContent).toBe('<img onerror=bad()>');
    ui.nodes.get('presence')!.value = '';
    ui.pages.push(new Error('暂时读不到'));
    await ui.load(true);
    expect(ui.nodes.get('status')!.textContent).toBe('暂时读不到');
    expect(ui.nodes.get('more')!.disabled).toBe(false);
    ui.pages.push({ messages: [], next: null }); await ui.load(true);
    expect(ui.queries.at(-1)).toMatchObject({ hidePresence: true, before: { ts: 1, id: 'a' } });
    expect(ui.nodes.get('messages')!.children).toHaveLength(1);
    expect(ui.nodes.get('more')!.hidden).toBe(true);
  });

  it('导出会取完所有分页而非当前屏幕，保留 Unicode 与换行', async () => {
    const ui = mount();
    ui.nodes.get('presence')!.value = 'hide';
    const items = Array.from({ length: 200 }, (_, i) => ({ id: String(i), ts: i, text: '孩子\n回复' }));
    ui.pages.push({ messages: items, next: { ts: 1, id: '199' } }, { messages: [{ id: 'old', text: '最后一条' }], next: null });
    await ui.exportRange();
    expect(ui.queries).toHaveLength(2);
    expect(ui.queries.map(query => query.hidePresence)).toEqual([true, true]);
    expect(ui.queries[1].before).toEqual({ ts: 1, id: '199' });
    expect(ui.downloads[0]).toHaveLength(201);
    expect(JSON.parse(ui.downloads[0][0]).text).toBe('孩子\n回复');
    expect(ui.nodes.get('status')!.textContent).toBe('已导出 201 条消息。');
  });

  it('错误时间范围不会发请求，筛选框恢复可操作', async () => {
    const ui = mount(); ui.nodes.get('until')!.value = '2026-11-01T00:00';
    await ui.load();
    expect(ui.queries).toEqual([]);
    expect(ui.nodes.get('status')!.textContent).toContain('结束时间须晚于');
    expect(ui.nodes.get('from')!.disabled).toBe(false);
  });
});
