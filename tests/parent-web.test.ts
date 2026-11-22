import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { sourceFunction } from './helpers/game-component.ts';

class TestNode {
  children: TestNode[] = [];
  listeners = new Map<string, (event?: unknown) => unknown>();
  className = '';
  textContent = '';
  value = '';
  hidden = false;
  disabled = false;
  open = false;
  attrs = new Map<string, string>();
  get firstChild() { return this.children[0]; }
  append(...nodes: TestNode[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: TestNode[]) { this.children = [...nodes]; }
  removeChild(node: TestNode) { this.children.splice(this.children.indexOf(node), 1); }
  addEventListener(type: string, listener: (event?: unknown) => unknown) { this.listeners.set(type, listener); }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
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
  const renderer = runInNewContext(source + `
    mountGuestInvites = () => {};
    render = captureRender;
    ({ renderMail, renderLog, loadView, playAsParent, showView, saveCredentials, saveRename, loadHistory })
  `, {
    document, fetch, setTimeout, clearTimeout: vi.fn(), URLSearchParams, captureRender: render, beginGlobalEntry, confirm: () => true,
    mountStoryArchive: vi.fn(),
    location: { origin: 'https://parlor.test' },
  }) as { renderMail(view: unknown): void; renderLog(view: unknown): void; loadView(): Promise<boolean>;
    playAsParent(button: { disabled: boolean }): Promise<void>;
    showView(account: { displayName: string }): void;
    saveCredentials(): Promise<void>; saveRename(): Promise<void>; loadHistory(more?: boolean): Promise<void> };
  return { ...renderer, nodes, document, fetch, render, setTimeout, beginGlobalEntry };
};

const deferredResponse = () => {
  let resolve!: (response: Response) => void;
  const response = new Promise<Response>(done => { resolve = done; });
  return { response, resolve };
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

it('家长页隐藏没有活跃席位时的退厅按钮', () => {
  const html = readFileSync(new URL('../src/web/parent.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/web/parent.css', import.meta.url), 'utf8');
  expect(html).toMatch(/<button id="leave-child-seat"[^>]*\bboard-btn\b[^>]*\bhidden\b/);
  expect(css).toMatch(/\.board-btn\[hidden\]\s*\{\s*display:\s*none;/);
});

it('顶栏只留一个账户入口，「回到茶室」挨着「回会馆首页」', () => {
  const html = readFileSync(new URL('../src/web/parent.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/web/parent.css', import.meta.url), 'utf8');
  // 原来的「下场玩」挪到会馆首页旁边，并改名。
  expect(html).not.toContain('下场玩');
  expect(html).toMatch(/<div class="hud-links">\s*<a class="hud-home" href="\/">← 回会馆首页<\/a>\s*<button id="back-to-tea"[^>]*>回到茶室<\/button>/);
  // 账户是右上角唯一的入口，四个分区都在同一个弹窗里。
  expect(html).toMatch(/<dialog id="account-dialog"/);
  for (const [tab, label] of [['account', '账户'], ['rename', '改名字'], ['credentials', '多端登录'], ['history', '账户历史战绩']] as const) {
    expect(html).toMatch(new RegExp(`<button id="tab-${tab}"[^>]*>[^<]*(<svg[\\s\\S]*?</svg>)?${label}</button>`));
    expect(html).toContain(`id="pane-${tab}"`);
  }
  // 多端登录要用户把密码输两次。
  expect(html).toMatch(/<input id="cred-password" type="password"/);
  expect(html).toMatch(/<input id="cred-confirm" type="password"/);
  expect(html).toContain('再输一次密码');
  // 分区切换靠 hidden，作者样式会盖掉它，必须显式写一条。
  expect(css).toMatch(/\.sheet-pane\[hidden\]\s*\{\s*display:\s*none;/);
  // 红字提示用现成的 .warn（--red），不另造一套颜色。
  expect(css).toMatch(/--red:\s*#/);
  expect(html).toMatch(/<p id="cred-error" class="warn" role="alert"><\/p>/);
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

describe('家长账户弹窗', () => {
  const mountAccount = (responses: unknown[] = []) => {
    const page = mount(responses);
    page.showView({ displayName: '小满' });
    return page;
  };

  const fill = (nodes: Map<string, TestNode>, password: string, confirm: string, login = 'xiaoman') => {
    nodes.get('cred-login')!.value = login;
    nodes.get('cred-password')!.value = password;
    nodes.get('cred-confirm')!.value = confirm;
  };

  it('两次密码不一致时不发请求，只把红字写在面板里', async () => {
    const { saveCredentials, nodes, fetch } = mountAccount();
    fill(nodes, 'twelve-chars-ok', 'twelve-chars-oK');
    await saveCredentials();
    expect(nodes.get('cred-error')!.textContent).toBe('两次输入的密码不一致，请重新确认。');
    expect(fetch).not.toHaveBeenCalled();
    expect(nodes.get('cred-save')!.disabled).toBe(false);
  });

  it('密码不足 12 个字符、没填登录名时同样拦在前端', async () => {
    const { saveCredentials, nodes, fetch } = mountAccount();
    fill(nodes, 'short', 'short');
    await saveCredentials();
    expect(nodes.get('cred-error')!.textContent).toBe('密码至少 12 个字符。');
    fill(nodes, 'twelve-chars-ok', 'twelve-chars-ok', '  ');
    await saveCredentials();
    expect(nodes.get('cred-error')!.textContent).toBe('先填登录名。');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('两个密码一边输一边比：对不上就先提示，改对了提示消失', () => {
    const { nodes } = mount();
    const password = nodes.get('cred-password')!;
    const confirm = nodes.get('cred-confirm')!;
    password.value = 'twelve-chars-ok';
    confirm.value = 'twelve-chars-oK';
    confirm.listeners.get('input')!();
    expect(nodes.get('cred-error')!.textContent).toBe('两次输入的密码不一致');
    confirm.value = 'twelve-chars-ok';
    confirm.listeners.get('input')!();
    expect(nodes.get('cred-error')!.textContent).toBe('');
  });

  it('两次一致才把登录名和密码提交给服务端', async () => {
    const { saveCredentials, nodes, fetch } = mountAccount([{ loginName: 'xiaoman' }]);
    fill(nodes, 'twelve-chars-ok', 'twelve-chars-ok', '  xiaoman ');
    await saveCredentials();
    expect(fetch.mock.calls[0]?.[0]).toBe('/v1/web/credentials');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ loginName: 'xiaoman', password: 'twelve-chars-ok' }),
    });
    expect(nodes.get('cred-error')!.textContent).toBe('');
    expect(nodes.get('cred-password')!.value).toBe('');
    expect(nodes.get('cred-confirm')!.value).toBe('');
  });

  it('战绩面板用服务端给的玩法名和自己的局数', async () => {
    const { loadHistory, nodes, fetch } = mount([{
      player: true, ledger: { games: 2, wins: 1, losses: 1, draws: 0 },
      games: [{ id: 'ddz', label: '斗地主' }],
      items: [{ id: 'a', ts: 0, roomName: '客厅', kind: 'game', game: 'ddz', gameLabel: '斗地主', result: 'win', text: '地主胜' }],
      next: null,
    }]);
    nodes.get('history-kind')!.value = 'games';
    await loadHistory();
    expect(fetch.mock.calls[0]?.[0]).toContain('/v1/parent/history?kind=games');
    expect(nodes.get('history-summary')!.textContent).toBe('共 2 局 · 1 胜 1 负 0 平');
    expect(nodes.get('history-list')!.children).toHaveLength(1);
    expect(nodes.get('history-list')!.children[0]!.className).toBe('history-row is-win');
    expect(nodes.get('history-game')!.children.map(option => option.textContent)).toContain('斗地主');
    expect(nodes.get('history-empty')!.hidden).toBe(true);
    expect(nodes.get('history-more')!.hidden).toBe(true);
  });

  it('还没下过场的人看到的是空账与一句怎么开始', async () => {
    const { loadHistory, nodes } = mount([{ player: false, ledger: null, games: [], items: [], next: null }]);
    await loadHistory();
    expect(nodes.get('history-summary')!.textContent).toContain('回到茶室');
    expect(nodes.get('history-empty')!.hidden).toBe(false);
  });

  it('退出时清空多端登录的三个输入框，不留给下一个账号', async () => {
    const { nodes } = mount([{ ok: true }]);
    fill(nodes, 'twelve-chars-ok', 'twelve-chars-ok', 'alice');
    await nodes.get('account-logout')!.listeners.get('click')!();
    expect(nodes.get('cred-login')!.value).toBe('');
    expect(nodes.get('cred-password')!.value).toBe('');
    expect(nodes.get('cred-confirm')!.value).toBe('');
    expect(nodes.get('cred-error')!.textContent).toBe('');
  });

  it.each([200, 409])('上一个会话的保存响应（%i）不影响新账号正在保存的表单', async (status) => {
    const { nodes, fetch, showView, saveCredentials } = mountAccount();
    const previous = deferredResponse();
    fetch.mockReturnValueOnce(previous.response);
    fill(nodes, 'first-password', 'first-password', 'first-login');
    const firstSave = saveCredentials();

    fetch.mockResolvedValueOnce(Response.json({ ok: true }));
    await nodes.get('account-logout')!.listeners.get('click')!();
    showView({ displayName: '新家长' });

    const current = deferredResponse();
    fetch.mockReturnValueOnce(current.response);
    fill(nodes, 'second-password', 'second-password', 'second-login');
    const secondSave = saveCredentials();
    expect(fetch).toHaveBeenCalledTimes(3);

    previous.resolve(Response.json({ loginName: 'first-login', error: '旧会话的提示' }, { status }));
    await firstSave;
    expect(nodes.get('fact-login')!.textContent).toBe('正在读取…');
    expect(nodes.get('cred-error')!.textContent).toBe('');
    expect(nodes.get('cred-password')!.value).toBe('second-password');
    expect(nodes.get('cred-confirm')!.value).toBe('second-password');
    expect(nodes.get('cred-save')!.disabled).toBe(true);

    current.resolve(Response.json({ loginName: 'second-login' }));
    await secondSave;
    expect(nodes.get('fact-login')!.textContent).toBe('second-login');
    expect(nodes.get('cred-save')!.disabled).toBe(false);
  });

  it('切换账号后忽略上一个会话的改名响应', async () => {
    const { nodes, fetch, showView, saveRename } = mountAccount();
    const previous = deferredResponse();
    fetch.mockReturnValueOnce(previous.response);
    nodes.get('rename-input')!.value = '旧账号的新名字';
    const pending = saveRename();

    showView({ displayName: '新家长' });
    expect(nodes.get('rename-save')!.disabled).toBe(false);
    previous.resolve(Response.json({ account: { displayName: '旧账号的新名字' } }));
    await pending;

    expect(nodes.get('fact-name')!.textContent).toBe('新家长');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('翻页沿用生成游标的那次筛选：改了玩法但没查询，也不把新条件混进来', async () => {
    const page = { player: true, ledger: { games: 1, wins: 1, losses: 0, draws: 0 }, games: [], items: [] };
    const { loadHistory, nodes, fetch } = mount([{ ...page, next: 900 }, { ...page, next: null }]);
    nodes.get('history-kind')!.value = 'games';
    nodes.get('history-game')!.value = 'ddz';
    await loadHistory();
    expect(fetch.mock.calls[0]?.[0]).toContain('game=ddz');

    // 只改表单、不点查询：翻页仍然按斗地主的条件走。
    nodes.get('history-game')!.value = 'gomoku';
    await loadHistory(true);
    const next = fetch.mock.calls[1]?.[0] as string;
    expect(next).toContain('game=ddz');
    expect(next).toContain('before=900');
    expect(next).not.toContain('gomoku');

    // 重新查询后才换成新条件，且旧游标不带过去。
    await loadHistory();
    const fresh = fetch.mock.calls[2]?.[0] as string;
    expect(fresh).toContain('game=gomoku');
    expect(fresh).not.toContain('before=');
  });

  it('重新查询时隐藏旧翻页入口，翻页过程中也不会重复请求', async () => {
    const page = { player: true, ledger: null, games: [], items: [] };
    const { loadHistory, nodes, fetch } = mount([{ ...page, next: 900 }]);
    nodes.get('history-kind')!.value = 'games';
    nodes.get('history-game')!.value = 'ddz';
    await loadHistory();
    const more = nodes.get('history-more')!;
    expect(more.hidden).toBe(false);

    const refresh = deferredResponse();
    fetch.mockReturnValueOnce(refresh.response);
    nodes.get('history-game')!.value = 'gomoku';
    const refreshing = loadHistory();
    expect(more.hidden).toBe(true);
    await loadHistory(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    refresh.resolve(Response.json({ ...page, next: 700 }));
    await refreshing;
    expect(more.hidden).toBe(false);

    const next = deferredResponse();
    fetch.mockReturnValueOnce(next.response);
    const paging = loadHistory(true);
    expect(more.disabled).toBe(true);
    await loadHistory(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2]?.[0]).toContain('game=gomoku&before=700');
    next.resolve(Response.json({ ...page, next: null }));
    await paging;
    expect(more.hidden).toBe(true);
    expect(more.disabled).toBe(false);
  });

  it('点遮罩关窗，点盒子里面的东西不关', () => {
    const { nodes } = mount();
    const dialog = nodes.get('account-dialog')!;
    dialog.open = true;
    dialog.listeners.get('click')!({ target: dialog });
    expect(dialog.open).toBe(false);

    dialog.open = true;
    dialog.listeners.get('click')!({ target: nodes.get('account-close')! });
    expect(dialog.open).toBe(true);
  });
});
