/** 家长只读页：用 ownerKey 换 HttpOnly 会话，然后按孩子当前席位的可见范围看。 */

const ui = {
  account: document.getElementById('account'),
  gate: document.getElementById('gate'),
  gateForm: document.getElementById('gate-form'),
  gateKey: document.getElementById('key'),
  gateError: document.getElementById('gate-error'),
  view: document.getElementById('view'),
  roomName: document.getElementById('room-name'),
  roomSeat: document.getElementById('room-seat'),
  roomLive: document.getElementById('room-live'),
  people: document.getElementById('room-people'),
  tableStatus: document.getElementById('table-status'),
  tableText: document.getElementById('table-text'),
  tablePrivate: document.getElementById('table-private'),
  chips: document.getElementById('chips'),
  ledgerLine: document.getElementById('ledger-line'),
  ledgerRoom: document.getElementById('ledger-room'),
  latest: document.getElementById('latest'),
  log: document.getElementById('log'),
  mailUnread: document.getElementById('mail-unread'),
  mail: document.getElementById('mail'),
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
  ui.account.replaceChildren();
  ui.gateError.textContent = message;
  ui.gateKey.focus();
}

function showView(account) {
  ui.gate.hidden = true;
  ui.view.hidden = false;
  clear(ui.account);
  ui.account.append(el('span', '', account.displayName || '家长'));
  const logout = el('button', 'link', '退出');
  logout.type = 'button';
  logout.addEventListener('click', async () => {
    try { await api('/v1/parent/logout', { method: 'POST' }); } catch { /* 已经失效 */ }
    showGate('已经退出。');
  });
  ui.account.append(logout);
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
  ui.roomName.textContent = room ? (room.kind === 'hall' ? '大厅' : room.name) : '不在任何客厅';
  ui.roomSeat.textContent = seat ? `席位 ${seat.name}` : '孩子现在没有活跃席位。';
  ui.roomLive.textContent = room ? `${(view.events || []).length} 条可见` : '—';
  ui.latest.textContent = view.at ? `服务器 ${clock(view.now)}` : '';

  const seats = [];
  if (seat) seats.push(seat);
  clear(ui.people);
  if (seat) {
    const line = el('li', 'person');
    line.append(el('span', 'avatar', Array.from(String(seat.name || '？'))[0] || '？'));
    line.append(el('span', '', `${seat.name}（${KIND[seat.kind] || seat.kind}）`));
    ui.people.append(line);
  }

  const table = view.table;
  ui.tableStatus.textContent = table ? (table.label || table.game || '牌桌') : '空闲';
  ui.tableText.textContent = table ? (table.text || '') : '现在没有桌子。';
  if (view.tablePrivate && view.tablePrivate.text) {
    ui.tablePrivate.hidden = false;
    ui.tablePrivate.textContent = view.tablePrivate.text;
  } else {
    ui.tablePrivate.hidden = true;
    ui.tablePrivate.textContent = '';
  }

  const ledger = view.ledger;
  ui.chips.textContent = ledger && ledger.chips !== undefined ? `${ledger.chips} 枚` : '—';
  ui.ledgerLine.textContent = ledger && ledger.games > 0
    ? `共 ${ledger.games} 局，${ledger.wins} 胜 ${ledger.losses} 负 ${ledger.draws} 平。`
    : '还没有战绩。';
  clear(ui.ledgerRoom);
  for (const entry of view.ledgerRoom || []) {
    const item = el('li', '', entry.text);
    item.append(el('span', 'when', clock(entry.ts)));
    ui.ledgerRoom.append(item);
  }

  renderLog(view);
  renderMail(view);
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
  ui.mailUnread.textContent = view.mailUnread ? `${view.mailUnread} 封未读` : '';
  clear(ui.mail);
  if (items.length === 0) {
    ui.mail.append(el('li', 'empty', '信箱是空的。'));
    return;
  }
  for (const item of items) {
    const row = el('li');
    row.append(el('span', 'when', clock(item.ts)));
    row.append(el('span', 'from', item.fromName || '系统'));
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

void boot();
