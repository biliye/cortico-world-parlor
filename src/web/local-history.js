/** 经 Coo 控制台原有的面板读取本机档案，不连接客厅服务器。 */
import { mountStoryArchive } from './story-script';
const $ = id => document.getElementById(id);
const zone = 8 * 3600_000;
const time = ts => new Date(ts + zone).toISOString().slice(0, 19).replace('T', ' ');
let active = null;
let next = null;
let busy = false;
let shown = 0;
const knownRooms = new Set();

async function api(method, arg) {
  const url = new URL(method, location.href);
  if (arg) url.searchParams.set('args', JSON.stringify([arg]));
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `读取失败（${response.status}）`);
  return result;
}

function filters() {
  const from = Date.parse($('from').value + '+08:00');
  const until = Date.parse($('until').value + '+08:00');
  if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from) throw new Error('请选择有效的起止时间，结束时间须晚于开始时间。');
  return { from, until, ...($('room').value ? { room: $('room').value } : {}),
    ...($('direction').value ? { direction: $('direction').value } : {}),
    ...($('presence').value === 'hide' ? { hidePresence: true } : {}) };
}

function status(message, error = false) {
  $('status').textContent = message;
  $('status').className = error ? 'error' : '';
}

function lock(value) {
  busy = value;
  for (const input of document.querySelectorAll('input,select,button')) input.disabled = value;
}

function append(messages) {
  for (const item of messages) {
    const row = document.createElement('article');
    const header = document.createElement('header');
    const when = document.createElement('time'); when.textContent = time(item.ts);
    const who = document.createElement('span');
    who.textContent = `${item.direction === 'sent' ? '发出' : '收到'} · ${item.sender} → ${item.recipient}`;
    if (item.direction === 'sent') who.className = 'sent';
    const room = document.createElement('span'); room.textContent = `${item.room} · ${item.type}`;
    const text = document.createElement('p'); text.textContent = item.text;
    header.append(when, who, room); row.append(header, text); $('messages').append(row);
  }
}

async function refreshInfo() {
  try {
    const info = await api('info');
    $('info').textContent = `${info.name || '孩子'} · 档案总计 ${info.count} 条${info.first !== null ? ` · ${time(info.first)} 至 ${time(info.last)}` : ''}${info.syncing ? ' · 正在补收历史' : ''}${info.privateHidden ? ' · 私密牌桌记录已隐藏' : ''}`;
    for (const room of info.rooms) {
      if (knownRooms.has(room)) continue;
      const option = document.createElement('option'); option.value = room; option.textContent = room; $('room').append(option);
      knownRooms.add(room);
    }
    if (info.error) status(info.error, true);
  } catch (error) { $('info').textContent = `档案总览暂不可用（${error.message}）`; }
}

async function load(more = false) {
  if (busy) return;
  lock(true);
  try {
    const query = more ? active : filters();
    const page = await api('query', { ...query, ...(more && next ? { before: next } : {}) });
    if (!more) { $('messages').replaceChildren(); shown = 0; active = query; }
    append(page.messages); shown += page.messages.length; next = page.next;
    $('more').hidden = !next;
    status(shown ? `本次筛选已显示 ${shown} 条，按消息时间从新到旧排列。` : '当前筛选条件下没有消息。');
    if (!more) await refreshInfo();
  } catch (error) { status(error.message, true); }
  finally { lock(false); }
}

async function exportRange() {
  if (busy) return;
  lock(true);
  try {
    const query = filters();
    const chunks = [];
    let cursor = null;
    let count = 0;
    do {
      const page = await api('query', { ...query, limit: 200, ...(cursor ? { before: cursor } : {}) });
      chunks.push(...page.messages.map(item => JSON.stringify(item) + '\n'));
      count += page.messages.length; cursor = page.next;
      status(`正在导出 ${count} 条…`);
    } while (cursor);
    const url = URL.createObjectURL(new Blob(chunks, { type: 'application/x-ndjson;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'parlor-history-' + $('from').value.slice(0, 10) + '.jsonl';
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
    status(`已导出 ${count} 条消息。`);
  } catch (error) { status(error.message, true); }
  finally { lock(false); }
}

$('filters').addEventListener('submit', event => { event.preventDefault(); void load(); });
$('more').addEventListener('click', () => { void load(true); });
$('export').addEventListener('click', () => { void exportRange(); });

async function boot() {
  const today = time(Date.now()).slice(0, 10);
  $('from').value = today + 'T00:00';
  $('until').value = time(Date.parse(today + 'T00:00:00+08:00') + 24 * 3600_000).slice(0, 16).replace(' ', 'T');
  await load();
}
void boot();
mountStoryArchive($('stories'), {
  time,
  list: before => api('stories', before ? { before } : {}),
  detail: id => api('stories', { id }),
});
