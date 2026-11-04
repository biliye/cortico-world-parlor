import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// 实际构建产物在无浏览器全局的模块加载阶段也必须可导入。
const built = readFileSync(new URL('../dist/webui.js', import.meta.url), 'utf8');
const bundle = runInNewContext(built.replace(/export\s*\{\s*(\w+) as default\s*\};?\s*$/, '$1;'), { URL, Blob }) as {
  panels: { history: { mount(ctx: unknown): Promise<void> } };
};

class Element {
  textContent = ''; className = ''; name = ''; type = ''; hidden = false; disabled = false;
  private explicitValue?: string;
  href = ''; download = ''; required = false;
  children: Element[] = [];
  attrs: Record<string, string> = {};
  listeners = new Map<string, { fn: (event: { preventDefault(): void }) => void; signal?: AbortSignal }>();
  ownerDocument = { createElement: (tag: string) => new Element(tag) };
  constructor(readonly tag = 'div') {}
  get value(): string {
    return this.explicitValue ?? (this.tag === 'option' ? this.textContent : this.tag === 'select' ? this.children[0]?.value ?? '' : '');
  }
  set value(value: string) { this.explicitValue = value; }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  addEventListener(type: string, fn: (event: { preventDefault(): void }) => void, opts: { signal?: AbortSignal }) {
    this.listeners.set(type, { fn, signal: opts.signal });
  }
  fire(type: string) { const handler = this.listeners.get(type); if (!handler?.signal?.aborted) handler?.fn({ preventDefault() {} }); }
  click() { this.fire('click'); }
  remove() {}
  all(): Element[] { return [this, ...this.children.flatMap(node => node.all())]; }
}
function setup() {
  const root = new Element();
  const controller = new AbortController();
  const owned: Array<{ dispose(): void }> = [];
  const responses: unknown[] = [];
  const info = { name: '孩子', count: 2, first: 1, last: 2, rooms: ['hall'], syncing: false, privateHidden: true };
  const invoke = vi.fn(async (method: string, _args?: unknown[]): Promise<unknown> => {
    if (method === 'info') return info;
    const result = responses.shift() ?? { messages: [], next: null };
    if (result instanceof Error) throw result;
    return result;
  });
  const timeout = vi.fn();
  const ctx = { root, signal: controller.signal, invoke, timeout, own: (value: { dispose(): void }) => { owned.push(value); return value; } };
  const find = (test: (node: Element) => boolean) => root.all().find(test)!;
  return { root, controller, invoke, responses, info, timeout,
    mount: () => bundle.panels.history.mount(ctx),
    input: (name: string) => find(node => node.name === name),
    button: (text: string) => find(node => node.tag === 'button' && node.textContent === text),
    status: () => find(node => node.attrs.role === 'status'),
    form: () => find(node => node.tag === 'form'),
    messages: () => find(node => node.attrs['aria-label'] === '消息记录'),
    dispose: () => { controller.abort(); for (const value of owned) value.dispose(); },
  };
}
const item = { id: 'a', ts: 1, room: 'hall', type: 'parlor.say', direction: 'sent', sender: '孩子', recipient: '客厅', text: '<img onerror=bad()>\n你好' };
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
afterEach(() => vi.restoreAllMocks());

describe('控制台本地消息档案正式面板', () => {
  it('按宿主 mount(ctx) 挂载，经本面板接口读档案，正文只作文本', async () => {
    const ui = setup(); ui.responses.push({ messages: [item], next: null });
    await ui.mount();
    expect(ui.invoke.mock.calls[0][0]).toBe('query');
    expect(ui.invoke.mock.calls[0][1]?.[0]).not.toHaveProperty('room');
    expect(ui.invoke.mock.calls[1]).toEqual(['info']);
    expect(ui.messages().children[0].children[1].textContent).toBe(item.text);
    expect(ui.root.all().some(node => node.tag === 'img')).toBe(false);
    expect(ui.root.all().some(node => node.textContent.includes('私密牌桌记录已隐藏'))).toBe(true);
    ui.dispose();
  });

  it('新查询刷新档案总计和客厅选项，同时保留当前筛选', async () => {
    const ui = setup(); await ui.mount();
    const summary = ui.root.all().find(node => node.className === 'parlor-history-info')!;
    expect(summary.textContent).toContain('档案总计 2 条');
    ui.input('room').value = 'hall';
    ui.info.count = 9;
    ui.info.rooms.push('other');
    ui.responses.push({ messages: [item], next: null });
    ui.form().fire('submit'); await tick();
    expect(summary.textContent).toContain('档案总计 9 条');
    expect(ui.status().textContent).toContain('本次筛选已显示 1 条');
    expect(ui.input('room').value).toBe('hall');
    expect(ui.input('room').children.map(option => option.value)).toEqual(['', 'hall', 'other']);
    ui.dispose();
  });

  it('北京时间半开区间、客厅与收发筛选正确，翻页保留原条件，失败可重试', async () => {
    const ui = setup(); await ui.mount();
    ui.input('from').value = '2026-11-02T00:00'; ui.input('until').value = '2026-11-03T00:00';
    ui.input('room').value = 'hall'; ui.input('direction').value = 'sent';
    ui.input('presence').value = 'hide';
    const cursor = { ts: 1, id: 'a' };
    ui.responses.push({ messages: [item], next: cursor }); ui.form().fire('submit'); await tick();
    const query = { from: Date.parse('2026-11-01T16:00:00Z'), until: Date.parse('2026-11-02T16:00:00Z'), room: 'hall', direction: 'sent', hidePresence: true };
    expect(ui.invoke.mock.calls.at(-2)).toEqual(['query', [query]]);
    ui.input('room').value = 'another';
    ui.input('presence').value = '';
    ui.responses.push(new Error('暂时读不到')); ui.button('更早的消息').click(); await tick();
    expect(ui.status().textContent).toBe('暂时读不到');
    expect(ui.button('更早的消息').disabled).toBe(false);
    ui.responses.push({ messages: [], next: null }); ui.button('更早的消息').click(); await tick();
    expect(ui.invoke.mock.calls.at(-1)).toEqual(['query', [{ ...query, before: cursor }]]);
    expect(ui.messages().children).toHaveLength(1);
    expect(ui.button('更早的消息').hidden).toBe(true);
    ui.dispose();
  });

  it('无效日期不调用接口，失败后控件可操作', async () => {
    const ui = setup(); await ui.mount(); const count = ui.invoke.mock.calls.length;
    ui.input('until').value = '2020-01-01T00:00'; ui.form().fire('submit'); await tick();
    expect(ui.invoke).toHaveBeenCalledTimes(count);
    expect(ui.status().textContent).toContain('结束时间须晚于');
    expect(ui.input('from').disabled).toBe(false);
    ui.dispose();
  });

  it('导出遍历所有分页，保留 Unicode 和换行，卸载释放下载资源', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:history');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const ui = setup(); await ui.mount();
    ui.input('presence').value = 'hide';
    ui.responses.push({ messages: [item], next: { ts: 1, id: 'a' } }, { messages: [{ ...item, id: 'b' }], next: null });
    ui.button('导出当前范围').click(); await tick();
    expect(ui.status().textContent).toBe('已导出 2 条消息。');
    const body = await (create.mock.calls[0][0] as Blob).text();
    expect(body.trim().split('\n').map(line => JSON.parse(line).text)).toEqual([item.text, item.text]);
    expect(ui.invoke.mock.calls.at(-2)?.[1]).toEqual([expect.objectContaining({ hidePresence: true, limit: 200 })]);
    expect(ui.invoke.mock.calls.at(-1)?.[1]).toEqual([expect.objectContaining({ hidePresence: true, limit: 200, before: { ts: 1, id: 'a' } })]);
    ui.dispose(); expect(revoke).toHaveBeenCalledWith('blob:history');
  });

  it('卸载时未完成的查询不能继续渲染或发起导出下一页', async () => {
    const ui = setup(); await ui.mount();
    let finish!: (value: unknown) => void;
    ui.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    ui.button('导出当前范围').click(); const before = ui.invoke.mock.calls.length;
    ui.dispose(); finish({ messages: [item], next: { ts: 1, id: 'a' } }); await tick();
    expect(ui.invoke).toHaveBeenCalledTimes(before);
    expect(ui.messages().children).toEqual([]);
    expect(ui.timeout).not.toHaveBeenCalled();
  });
});
