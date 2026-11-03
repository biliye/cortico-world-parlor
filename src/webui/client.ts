import type { WebUiClientBundle, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { HistoryMessage, HistoryQuery } from '../local-history.ts';
import './history.css';

interface HistoryPage { messages: HistoryMessage[]; next: HistoryQuery['before'] | null }
interface HistoryInfo {
  name?: string; count: number; first: number | null; last: number | null;
  rooms: string[]; syncing: boolean; privateHidden: boolean; error?: string;
}
const zone = 8 * 3600_000;
const time = (ts: number) => new Date(ts + zone).toISOString().slice(0, 19).replace('T', ' ');

async function mountHistory(ctx: WebUiPanelContext): Promise<void> {
  const doc = ctx.root.ownerDocument;
  function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = ''): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.textContent = text;
    return node;
  }
  const panel = el('section'); panel.className = 'parlor-history-panel';
  const form = el('form');
  const from = el('input'); from.type = 'datetime-local'; from.required = true; from.name = 'from';
  const until = el('input'); until.type = 'datetime-local'; until.required = true; until.name = 'until';
  const room = el('select'); room.name = 'room'; room.append(el('option', '全部客厅'));
  const direction = el('select'); direction.name = 'direction';
  for (const [value, text] of [['', '全部'], ['received', '孩子收到'], ['sent', '孩子发出']]) {
    const option = el('option', text); option.value = value; direction.append(option);
  }
  for (const [text, input] of [
    ['开始（北京时间）', from], ['结束（不含此时刻）', until], ['客厅', room], ['收发', direction],
  ] as const) {
    const label = el('label', text); label.append(input); form.append(label);
  }
  const submit = el('button', '查询'); submit.type = 'submit';
  const download = el('button', '导出当前范围'); download.type = 'button';
  const actions = el('div'); actions.className = 'parlor-history-actions'; actions.append(submit, download);
  form.append(actions);
  const info = el('p'); info.className = 'parlor-history-info';
  const status = el('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const messages = el('section'); messages.setAttribute('aria-label', '消息记录');
  const more = el('button', '更早的消息'); more.type = 'button'; more.hidden = true;
  panel.append(el('h2', '本地消息档案'),
    el('p', '消息保存在孩子运行 Coo 的电脑上，不随客厅服务器的 7 天回放清理。网页关闭后扩展仍会记录；已经丢失的旧消息无法补回。'),
    el('p', '“收到”表示孩子有权接收，不代表模型逐条读过。局中或未连接时，私密牌桌通知暂不展示；连接后确认已结束可回看。'),
    form, info, status, messages, more);
  ctx.root.append(panel);
  const controls = [from, until, room, direction, submit, download, more];
  const objectUrls = new Set<string>();
  ctx.own({ dispose() { for (const url of objectUrls) URL.revokeObjectURL(url); objectUrls.clear(); } });
  let active: HistoryQuery | null = null;
  let next: HistoryPage['next'] = null;
  let busy = false;
  let shown = 0;
  const alive = () => !ctx.signal.aborted;
  function lock(value: boolean) { busy = value; for (const control of controls) control.disabled = value; }
  function note(message: string, error = false) {
    status.textContent = message; status.className = error ? 'parlor-history-error' : '';
  }
  function filters(): HistoryQuery {
    const start = Date.parse(from.value + '+08:00');
    const end = Date.parse(until.value + '+08:00');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new Error('请选择有效的起止时间，结束时间须晚于开始时间。');
    }
    return { from: start, until: end, ...(room.value ? { room: room.value } : {}),
      ...(direction.value ? { direction: direction.value as HistoryQuery['direction'] } : {}) };
  }
  function append(items: HistoryMessage[]) {
    for (const item of items) {
      const row = el('article');
      const header = el('header');
      const who = el('span', `${item.direction === 'sent' ? '发出' : '收到'} · ${item.sender} → ${item.recipient}`);
      header.append(el('time', time(item.ts)), who, el('span', `${item.room} · ${item.type}`));
      row.append(header, el('p', item.text)); messages.append(row);
    }
  }
  async function load(older = false) {
    if (busy || !alive()) return;
    lock(true);
    try {
      const query = older && active ? active : filters();
      const page = await ctx.invoke<HistoryPage>('query', [{ ...query, ...(older && next ? { before: next } : {}) }]);
      if (!alive()) return;
      if (!older) { messages.replaceChildren(); shown = 0; active = query; }
      append(page.messages); shown += page.messages.length; next = page.next; more.hidden = !next;
      note(shown ? `已显示 ${shown} 条，按消息时间从新到旧排列。` : '这个时间范围没有已保存的消息。');
    } catch (error) { if (alive()) note(String((error as Error).message || error), true); }
    finally { if (alive()) lock(false); }
  }
  async function exportRange() {
    if (busy || !alive()) return;
    lock(true);
    try {
      const query = filters();
      const chunks: string[] = [];
      let cursor: HistoryPage['next'] = null;
      let count = 0;
      do {
        const page: HistoryPage = await ctx.invoke('query', [{ ...query, limit: 200, ...(cursor ? { before: cursor } : {}) }]);
        if (!alive()) return;
        chunks.push(...page.messages.map(item => JSON.stringify(item) + '\n'));
        count += page.messages.length; cursor = page.next; note(`正在导出 ${count} 条…`);
      } while (cursor);
      const url = URL.createObjectURL(new Blob(chunks, { type: 'application/x-ndjson;charset=utf-8' }));
      objectUrls.add(url);
      const link = el('a'); link.href = url; link.download = `parlor-history-${from.value.slice(0, 10)}.jsonl`;
      panel.append(link); link.click(); link.remove();
      ctx.timeout(() => { URL.revokeObjectURL(url); objectUrls.delete(url); }, 30_000);
      note(`已导出 ${count} 条消息。`);
    } catch (error) { if (alive()) note(String((error as Error).message || error), true); }
    finally { if (alive()) lock(false); }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void load(); }, { signal: ctx.signal });
  more.addEventListener('click', () => { void load(true); }, { signal: ctx.signal });
  download.addEventListener('click', () => { void exportRange(); }, { signal: ctx.signal });
  const today = time(Date.now()).slice(0, 10);
  from.value = today + 'T00:00';
  until.value = time(Date.parse(today + 'T00:00:00+08:00') + 86400_000).slice(0, 16).replace(' ', 'T');
  lock(true);
  let history: HistoryInfo;
  try {
    history = await ctx.invoke<HistoryInfo>('info');
    if (!alive()) return;
    info.textContent = `${history.name || '孩子'} · 已存 ${history.count} 条${history.first !== null ? ` · ${time(history.first)} 至 ${time(history.last!)}` : ''}${history.syncing ? ' · 正在补收历史' : ''}${history.privateHidden ? ' · 私密牌桌记录已隐藏' : ''}`;
    for (const name of history.rooms) { const option = el('option', name); option.value = name; room.append(option); }
  } catch (error) { if (alive()) note(String((error as Error).message || error), true); return; }
  finally { if (alive()) lock(false); }
  await load();
  if (alive() && history.error) note(history.error, true);
}

export default { panels: { history: { mount: mountHistory } } } satisfies WebUiClientBundle;
