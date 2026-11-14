/** 家长只读页：用 ownerKey 换 HttpOnly 会话，然后按孩子当前席位的可见范围看。 */
import { mountStoryArchive } from './story-archive.js';

const ui = {
  account: document.getElementById('account'),
  gate: document.getElementById('gate'),
  gateForm: document.getElementById('gate-form'),
  gateKey: document.getElementById('key'),
  gateError: document.getElementById('gate-error'),
  view: document.getElementById('view'),
  liveDot: document.getElementById('live-dot'),
  consoleClock: document.getElementById('clock'),
  roomName: document.getElementById('room-name'),
  roomSeat: document.getElementById('room-seat'),
  roomLive: document.getElementById('room-live'),
  statMsgs: document.getElementById('stat-msgs'),
  statWins: document.getElementById('stat-wins'),
  statUnread: document.getElementById('stat-unread'),
  statGames: document.getElementById('stat-games'),
  people: document.getElementById('room-people'),
  tableStatus: document.getElementById('table-status'),
  tableWatchEntry: document.getElementById('table-watch-entry'),
  tableWatch: document.getElementById('table-watch'),
  tableText: document.getElementById('table-text'),
  tablePrivate: document.getElementById('table-private'),
  privateNote: document.getElementById('private-note'),
  recordTag: document.getElementById('record-tag'),
  ledgerLine: document.getElementById('ledger-line'),
  ledgerRoom: document.getElementById('ledger-room'),
  meter: document.getElementById('meter'),
  meterLegend: document.getElementById('meter-legend'),
  alerts: document.getElementById('alerts'),
  alertCount: document.getElementById('alert-count'),
  latest: document.getElementById('latest'),
  log: document.getElementById('log'),
  mailUnread: document.getElementById('mail-unread'),
  mail: document.getElementById('mail'),
  refresh: document.getElementById('refresh'),
  stories: document.getElementById('parent-stories'),
  toast: document.getElementById('toast'),
};

let timer = 0;
let lastSignature = '';
let toastTimer = 0;

const el = (tag, cls = '', text = '') => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== '') node.textContent = text;
  return node;
};

const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
};

const clock = (ts) => new Date(ts + 8 * 3600 * 1000).toISOString().slice(11, 16);

const toast = (text) => {
  ui.toast.textContent = text;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 4200);
};

const api = async (path, init = {}) => {
  const response = await fetch(path, { ...init, credentials: 'same-origin' });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const error = new Error((body && body.error) || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return body;
};

const KIND = { pet: 'Coo', human: '人', observer: '观看' };

function showGate(message = '') {
  clearTimeout(timer);
  ui.gate.hidden = false;
  ui.view.hidden = true;
  ui.stories.replaceChildren();
  ui.account.replaceChildren();
  ui.gateError.textContent = message;
  ui.gateKey.focus();
}

function showView(account) {
  ui.gate.hidden = true;
  ui.view.hidden = false;
  ui.stories.replaceChildren();
  const stories = el('div');
  ui.stories.append(stories);
  mountStoryArchive(stories, {
    time: ts => new Date(ts + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' '),
    list: cursor => api('/v1/parent/story' + (cursor
      ? '?' + new URLSearchParams({ cursorAt: String(cursor.endedAt), cursorId: cursor.id }) : '')),
    detail: id => api('/v1/parent/story?id=' + encodeURIComponent(id)),
    active: () => stories.isConnected && !ui.view.hidden,
  });
  clear(ui.account);
  const who = el('span', 'who', account.displayName || '家长');
  ui.account.append(who);
  const play = el('button', 'board-btn primary small', '下场玩');
  play.type = 'button';
  play.title = '以家长身份进客厅；和孩子的账本分开';
  play.addEventListener('click', () => { void playAsParent(play); });
  ui.account.append(play);
  const rename = el('button', 'board-btn ghost small', '改名字');
  rename.type = 'button';
  rename.addEventListener('click', () => openRename(account, who));
  ui.account.append(rename);
  const logout = el('button', 'board-btn ghost small', '退出');
  logout.type = 'button';
  logout.addEventListener('click', async () => {
    try { await api('/v1/parent/logout', { method: 'POST' }); } catch { /* 已经失效 */ }
    showGate('已经退出。');
  });
  ui.account.append(logout);
}

/** 改名字：账户显示名、玩家身份名、当前席位名一起改（服务器一个接口）。 */
function openRename(account, who) {
  const open = document.getElementById('rename-box');
  if (open) {
    open.remove();
    return;
  }
  const box = el('form', 'rename');
  box.id = 'rename-box';
  const input = el('input');
  input.value = account.displayName || '';
  input.maxLength = 24;
  input.placeholder = '比如：塞斯普瑞家的家长';
  input.setAttribute('aria-label', '新名字');
  const save = el('button', 'board-btn primary small', '保存');
  save.type = 'submit';
  const cancel = el('button', 'board-btn ghost small', '取消');
  cancel.type = 'button';
  cancel.addEventListener('click', () => box.remove());
  box.append(input, save, cancel);
  box.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const result = await api('/v1/parent/rename', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: input.value }),
      });
      account.displayName = result.account.displayName;
      who.textContent = account.displayName;
      box.remove();
      toast('名字改好了');
      await loadView();
    } catch (error) {
      toast(error.message || '改不了名字');
    } finally {
      save.disabled = false;
    }
  });
  ui.account.parentElement.after(box);
  input.focus();
  input.select();
}

/** 家长下场：借家长会话领一个 human 席位，把席位令牌写进 localStorage，再去 /play。 */
async function playAsParent(button) {
  button.disabled = true;
  try {
    const result = await api('/v1/parent/play', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    localStorage.setItem('parlor-play-v1', JSON.stringify({
      room: result.room,
      seatId: result.seat.id,
      name: result.seat.name,
      token: result.token,
      cooId: result.identity.cooId,
      cooSecret: result.identity.cooSecret,
    }));
    location.href = '/play?room=' + encodeURIComponent(result.room);
  } catch (error) {
    toast(error.message || '现在下不了场');
  } finally {
    button.disabled = false;
  }
}

async function openWithKey(key) {
  ui.gateError.textContent = '';
  const button = ui.gateForm.querySelector('button');
  button.disabled = true;
  try {
    const result = await api('/v1/parent/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    showView(result.account);
    await loadView();
  } catch (error) {
    showGate(error.message || '打不开这个家长链接');
  } finally {
    button.disabled = false;
  }
}

async function boot() {
  const hash = location.hash.replace(/^#/, '');
  if (hash.startsWith('key=')) {
    const key = decodeURIComponent(hash.slice(4));
    history.replaceState(null, '', location.pathname);
    await openWithKey(key);
    return;
  }
  try {
    const me = await api('/v1/parent/me');
    showView(me.account);
    await loadView();
  } catch (error) {
    showGate(error.status === 401 ? '' : (error.message || '连不上客厅'));
  }
}

async function loadView() {
  clearTimeout(timer);
  try {
    const view = await api('/v1/parent/view?limit=80');
    render(view);
    timer = setTimeout(loadView, 3000);
  } catch (error) {
    if (error.status === 401) {
      showGate('家长会话已经失效，请重新打开家长链接。');
      return;
    }
    toast(error.message || '刷新失败');
    timer = setTimeout(loadView, 5000);
  }
}

function render(view) {
  const seat = view.seat;
  const room = view.room;
  const ledger = view.ledger;
  const events = view.events || [];

  ui.consoleClock.textContent = clock(view.now);
  ui.liveDot.className = seat ? 'live-dot is-live' : 'live-dot is-off';

  ui.roomName.textContent = room ? (room.kind === 'hall' ? '大厅' : room.name) : '不在任何客厅';
  ui.roomSeat.textContent = seat
    ? `席位 ${seat.name}${seat.handle ? ` #${seat.handle}` : ''} · ${KIND[seat.kind] || seat.kind}`
    : '孩子现在没有活跃席位。';
  ui.roomLive.textContent = room ? `${events.length} 条可见` : '不在客厅';
  ui.latest.textContent = view.at ? `服务器 ${clock(view.now)}` : '';

  ui.statMsgs.textContent = String(events.length);
  ui.statWins.textContent = ledger && ledger.wins !== undefined ? String(ledger.wins) : '—';
  ui.statUnread.textContent = String(view.mailUnread || 0);
  ui.statGames.textContent = ledger && ledger.games ? String(ledger.games) : '0';

  renderTable(view);
  renderPeople(view);
  renderAlerts(view);
  renderLedger(view);
  renderLog(view);
  renderMail(view);
}

function renderTable(view) {
  const table = view.table;
  ui.tableStatus.textContent = table ? (table.label || table.game || '牌桌') : '空闲';
  ui.tableText.textContent = table ? (table.text || '') : '现在没有桌子。';
  if (ui.tableWatchEntry && ui.tableWatch) {
    ui.tableWatchEntry.hidden = !view.watchTableId;
    if (view.watchTableId) ui.tableWatch.href = '/play?' + new URLSearchParams({ parentWatch: view.watchTableId });
    else ui.tableWatch.removeAttribute('href');
  }

  const priv = view.tablePrivate && view.tablePrivate.text ? view.tablePrivate.text : '';
  if (priv) {
    ui.tablePrivate.hidden = false;
    ui.tablePrivate.textContent = priv;
    ui.privateNote.hidden = false;
    ui.privateNote.textContent = '这是孩子现在的私牌，只有他自己和你能看到。';
  } else if (view.ownerPrivateHidden) {
    ui.tablePrivate.hidden = true;
    ui.tablePrivate.textContent = '';
    ui.privateNote.hidden = false;
    ui.privateNote.textContent = '这张桌子上还有别的人，按隐私规则，孩子的暗牌不在这里显示。';
  } else {
    ui.tablePrivate.hidden = true;
    ui.tablePrivate.textContent = '';
    ui.privateNote.hidden = true;
    ui.privateNote.textContent = '';
  }
}

/** 最近说过话的人：家长一眼看出孩子正跟谁待在一个客厅。 */
function renderPeople(view) {
  const events = view.events || [];
  const seen = new Set();
  const list = [];
  for (let i = events.length - 1; i >= 0 && list.length < 6; i -= 1) {
    const event = events[i];
    const raw = event.data && typeof event.data.name === 'string' ? event.data.name : '';
    const name = raw || (event.from === 'system' ? '系统' : String(event.from || ''));
    if (!name || seen.has(name)) continue;
    seen.add(name);
    list.push({ name, system: !raw && event.from === 'system' });
  }

  clear(ui.people);
  if (list.length === 0) {
    ui.people.append(el('li', 'people-empty', '还没有人说话'));
    return;
  }
  for (const person of list) {
    const item = el('li', person.system ? 'person is-system' : 'person');
    item.append(el('span', 'avatar', Array.from(person.name)[0] || '？'));
    item.append(el('span', '', person.name));
    ui.people.append(item);
  }
}

/** 要注意：没有需要处理的事就明说“一切正常”，不要留一片空白让人猜。 */
function renderAlerts(view) {
  const items = [];
  if (!view.seat) {
    items.push({ tone: 'off', mark: '·', title: '孩子现在不在客厅', note: '他打开客厅之后，这一页会自动跟上。' });
  }
  if (view.seat && view.ownerPrivateHidden) {
    items.push({
      tone: 'warn',
      mark: '!',
      title: '私牌已隐藏',
      note: '这张桌子上还有别的人，孩子的暗牌不会显示在这一页。',
    });
  }
  const unread = view.mailUnread || 0;
  if (unread > 0) {
    items.push({
      tone: 'info',
      mark: 'i',
      title: `有 ${unread} 封未读来信`,
      note: '来信会一直留着；看这一页不会把信标成已读。',
    });
  }
  if (items.length === 0) {
    items.push({ tone: 'ok', mark: '✓', title: '一切正常', note: '没有要你处理的事，孩子在自己玩。' });
  }

  const needsAttention = items.filter((item) => item.tone === 'warn' || item.tone === 'info').length;
  ui.alertCount.textContent = String(needsAttention);
  ui.alertCount.className = needsAttention === 0 ? 'badge is-zero' : 'badge';

  clear(ui.alerts);
  for (const item of items) {
    const row = el('li', `alert ${item.tone}`);
    const mark = el('span', 'mark', item.mark);
    mark.setAttribute('aria-hidden', 'true');
    const body = el('span');
    body.append(el('strong', '', item.title));
    body.append(el('em', '', item.note));
    row.append(mark, body);
    ui.alerts.append(row);
  }
}

function renderLedger(view) {
  const ledger = view.ledger;
  ui.recordTag.textContent = ledger && ledger.games ? `${ledger.wins} 胜 / ${ledger.games} 局` : '—';
  ui.ledgerLine.textContent = ledger && ledger.games > 0
    ? `共 ${ledger.games} 局，${ledger.wins} 胜 ${ledger.losses} 负 ${ledger.draws} 平。`
    : '还没有战绩。';

  const games = ledger && ledger.games > 0 ? ledger.games : 0;
  if (games === 0) {
    ui.meter.hidden = true;
    ui.meterLegend.hidden = true;
    ui.meter.replaceChildren();
  } else {
    // 20 格代表这孩子打过的全部局数，按最大余数分配，最后几格留给没结算的。
    const cells = 20;
    const parts = [
      { key: 'g-win', value: ledger.wins || 0 },
      { key: 'g-draw', value: ledger.draws || 0 },
      { key: 'g-loss', value: ledger.losses || 0 },
    ];
    let used = 0;
    const counts = parts.map((part) => {
      const exact = (part.value * cells) / games;
      const base = Math.floor(exact);
      used += base;
      return { ...part, base, rest: exact - base };
    });
    let left = Math.max(0, cells - used);
    for (const entry of [...counts].sort((a, b) => b.rest - a.rest)) {
      if (left <= 0) break;
      entry.base += 1;
      left -= 1;
    }
    const frag = [];
    for (const entry of counts) {
      for (let i = 0; i < entry.base; i += 1) frag.push(el('i', entry.key));
    }
    ui.meter.replaceChildren(...frag);
    ui.meter.hidden = false;
    ui.meterLegend.hidden = false;
    clear(ui.meterLegend);
    const legend = [
      { cls: 'k k-win', text: `胜 ${ledger.wins || 0}` },
      { cls: 'k k-draw', text: `平 ${ledger.draws || 0}` },
      { cls: 'k k-loss', text: `负 ${ledger.losses || 0}` },
    ];
    for (const item of legend) {
      const wrap = el('span', 'legend');
      wrap.append(el('span', item.cls), el('span', 'legend-text', item.text));
      ui.meterLegend.append(wrap);
    }
  }

  clear(ui.ledgerRoom);
  for (const entry of view.ledgerRoom || []) {
    const item = el('li');
    item.append(el('span', 'when', clock(entry.ts)));
    item.append(el('span', 'ledger-text', entry.text));
    ui.ledgerRoom.append(item);
  }
}

function renderLog(view) {
  const events = view.events || [];
  const signature = `${view.room ? view.room.id : ''}:${events.map((event) => event.seq).join(',')}`;
  if (signature === lastSignature) return;
  lastSignature = signature;
  clear(ui.log);
  if (events.length === 0) {
    ui.log.append(el('p', 'empty', '孩子现在看不到新消息。'));
    return;
  }
  for (const event of events.slice(-60)) {
    if ((event.type === 'parlor.joined' || event.type === 'parlor.left') && event.data?.presenceWeb === false) continue;
    if (String(event.type).startsWith('parlor.table.') && event.type !== 'parlor.table.say') continue;
    const row = el('div', 'row');
    row.append(el('span', 'when', clock(event.ts)));
    const name = event.data && typeof event.data.name === 'string' ? event.data.name : (event.from === 'system' ? '系统' : event.from);
    row.append(el('span', 'who', name));
    row.append(el('span', 'text', event.text));
    ui.log.append(row);
  }
  ui.log.scrollTop = ui.log.scrollHeight;
}

function renderMail(view) {
  const items = view.mail || [];
  ui.mailUnread.textContent = `孩子未读 ${view.mailUnread || 0} 封`;
  clear(ui.mail);
  if (items.length === 0) {
    ui.mail.append(el('li', 'empty', '信箱是空的。'));
    return;
  }
  for (const item of items) {
    const row = el('li');
    row.append(el('span', 'when', clock(item.ts)));
    const from = item.fromMe
      ? `孩子 → ${item.toName || '对方'}${item.toHandle ? ` #${item.toHandle}` : ''}`
      : `${item.fromName || '系统'}${item.fromHandle ? ` #${item.fromHandle}` : ''}${item.kind === 'whisper' ? ' → 孩子' : ''}`;
    row.append(el('span', 'from', from + (item.read === false ? ' · 未读' : '')));
    row.append(el('span', 'text', item.text));
    ui.mail.append(row);
  }
}

ui.gateForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const key = ui.gateKey.value.trim();
  if (!key) {
    ui.gateError.textContent = '先贴家长钥匙。';
    return;
  }
  void openWithKey(key);
});

ui.refresh?.addEventListener('click', async () => {
  ui.refresh.disabled = true;
  try {
    await loadView();
    toast('已经是最新的了');
  } finally {
    ui.refresh.disabled = false;
  }
});

void boot();
