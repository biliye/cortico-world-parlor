/** 客厅网页客户端：家长自己的席位，和 Coo 同桌玩。 */
import {
  el, clear, fmtClock, fmtDateTime, fmtLeft, clockSpan, btn, playerClass,
  isNearBottom, GAME_LABELS, STATUS_LABELS, KIND_LABELS, TIER_LABELS,
} from './common.js';
import { mountDice } from './games/dice.js';
import { mountDdz } from './games/ddz.js';
import { mountMonopoly } from './games/monopoly.js';

const STORE_KEY = 'parlor-play-v1';
const app = document.getElementById('app');
const toastBox = document.getElementById('toast');

const state = {
  cfg: readStore(),
  snap: null,
  offset: 0,
  latest: 0,
  seen: new Set(),
  stream: null,
  reconnect: null,
  refreshTimer: null,
  mounted: null,
  shell: false,
  busy: false,
  mailOpen: false,
};
const ui = {};
let toastTimer = 0;

boot();

/* —— 起步 —— */

async function boot() {
  if (!state.cfg) {
    renderJoin();
    return;
  }
  try {
    await refreshSnapshot();
    state.latest = state.snap.latest;
    buildShell();
    render();
    await seedLog();
    await refreshSnapshot();
    render();
    connect();
  } catch (error) {
    if (error && error.status === 401) {
      clearStore();
      renderJoin('这个席位的令牌已经失效，请重新加入。');
      return;
    }
    renderOffline(error && error.message ? error.message : String(error));
  }
}

function readStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!raw || !raw.token || !raw.seatId || !raw.cooId || !raw.cooSecret) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeStore(cfg) {
  state.cfg = cfg;
  localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
}

function clearStore() {
  state.cfg = null;
  localStorage.removeItem(STORE_KEY);
}

function serverNow() {
  return Date.now() + state.offset;
}

/* —— 网络 —— */

async function api(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (state.cfg) {
    headers.set('authorization', 'Bearer ' + state.cfg.token);
    headers.set('x-parlor-coo', state.cfg.cooId);
    headers.set('x-parlor-coo-secret', state.cfg.cooSecret);
  }
  const response = await fetch(path, { ...init, headers });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = new Error((body && body.error) || ('请求失败（' + response.status + '）'));
    error.status = response.status;
    throw error;
  }
  return body;
}

async function refreshSnapshot() {
  const snapshot = await api('/v1/room?limit=1');
  state.snap = snapshot;
  state.offset = snapshot.now - Date.now();
}

function scheduleRefresh() {
  if (state.refreshTimer) return;
  state.refreshTimer = setTimeout(async () => {
    state.refreshTimer = null;
    try {
      await refreshSnapshot();
      render();
    } catch (error) {
      if (error && error.status === 401) {
        clearStore();
        renderJoin('这个席位的令牌已经失效，请重新加入。');
      }
    }
  }, 120);
}

async function act(body) {
  if (state.busy) return null;
  state.busy = true;
  try {
    const receipt = await api('/v1/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await refreshSnapshot();
    render();
    return receipt;
  } catch (error) {
    showToast(error.message || '动作没成功', 'bad');
    throw error;
  } finally {
    state.busy = false;
  }
}

/* —— 实时推送 —— */

function connect() {
  if (!state.cfg) return;
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
  clearTimeout(state.reconnect);
  setConn('connecting');
  const source = new EventSource('/v1/stream?since=' + state.latest + '&token=' + encodeURIComponent(state.cfg.token));
  state.stream = source;
  source.onopen = () => setConn('on');
  source.onmessage = (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    handleEvent(event);
  };
  source.onerror = () => {
    setConn('off');
    source.close();
    if (state.stream === source) state.stream = null;
    state.reconnect = setTimeout(connect, 3000);
  };
}

function setConn(mode) {
  if (!ui.conn) return;
  ui.conn.className = 'conn ' + (mode === 'on' ? 'on' : mode === 'off' ? 'off' : '');
  ui.connText.textContent = mode === 'on' ? '已连接' : mode === 'off' ? '重连中…' : '连接中…';
}

function handleEvent(event) {
  if (typeof event.seq !== 'number') return;
  state.latest = Math.max(state.latest, event.seq);
  pushLog(event);
  const type = event.type || '';
  if (type === 'parlor.say') return;
  if (type.startsWith('parlor.table.') || type.startsWith('parlor.monopoly.')
    || type === 'parlor.joined' || type === 'parlor.left'
    || type === 'parlor.ledger' || type === 'parlor.whisper') {
    scheduleRefresh();
  }
}

async function seedLog() {
  if (!ui.chat) return;
  try {
    const page = await api('/v1/replay?limit=80');
    for (const event of (page.events || [])) pushLog(event, true);
    ui.chat.scrollTop = ui.chat.scrollHeight;
  } catch {
    /* 回放拿不到不影响开局 */
  }
}

function pushLog(event, seed = false) {
  if (!ui.chat) return;
  if (typeof event.seq === 'number') {
    if (state.seen.has(event.seq)) return;
    state.seen.add(event.seq);
    if (state.seen.size > 4000) {
      const keep = [...state.seen].sort((a, b) => b - a).slice(0, 2000);
      state.seen = new Set(keep);
    }
  }
  const node = lineOf(event);
  if (!node) return;
  const atBottom = isNearBottom(ui.chat);
  ui.chat.append(node);
  while (ui.chat.children.length > 300) ui.chat.firstElementChild.remove();
  if (!seed && atBottom) ui.chat.scrollTop = ui.chat.scrollHeight;
}

function lineOf(event) {
  const type = event.type || '';
  if (type === 'parlor.table.turn' || type === 'parlor.digest') return null;
  const system = event.from === 'system';
  const node = el('div', 'line' + (system ? ' system' : '') + (type === 'parlor.whisper' ? ' whisper' : ''));
  if (system) {
    const tag = type.startsWith('parlor.table.') ? '牌桌'
      : type.startsWith('parlor.monopoly.') ? '大富翁'
        : type === 'parlor.ledger' ? '账本' : '';
    if (tag) node.append(el('span', 'tag', tag));
    node.append(document.createTextNode(event.text || ''));
    return node;
  }
  const snap = state.snap;
  const index = snap ? snap.seats.findIndex((seat) => seat.id === event.from) : -1;
  const seat = snap ? snap.seats.find((entry) => entry.id === event.from) : null;
  const who = el('span', 'who ' + (index >= 0 ? playerClass(index) : ''));
  const name = (event.data && typeof event.data.name === 'string' ? event.data.name : '')
    || (seat ? seat.name : event.from)
    || '？';
  who.textContent = name + '：';
  const text = (type === 'parlor.whisper' ? '（私聊）' : '') + (event.text || '');
  node.append(who, el('span', 'text', text));
  return node;
}

/* —— 页面骨架 —— */

function buildShell() {
  clear(app);
  state.shell = true;

  const top = el('header', 'topbar');
  const brand = el('div', 'brand');
  brand.append(el('span', 'mark', '客'), document.createTextNode('客厅'), el('span', 'room', state.snap.id));
  const me = el('div', 'me');
  const myName = el('span', 'myname', state.snap.seat.name);
  const chips = el('span', 'chips');
  me.append(myName, chips);

  const tools = el('div', 'tools');
  const conn = el('span', 'conn');
  const connText = el('span', '', '连接中…');
  conn.append(el('span', 'dot'), connText);
  const mailBtn = btn('信箱', () => openMail(), { ghost: true });
  const mailBadge = el('span', 'badge', '0');
  mailBadge.hidden = true;
  mailBtn.append(mailBadge);
  const leaveBtn = btn('换席位', () => {
    if (!confirm('换席位会清掉这台浏览器里的令牌；旧席位会留在房间里。要继续吗？')) return;
    if (state.stream) state.stream.close();
    clearStore();
    location.reload();
  }, { ghost: true, small: true });
  tools.append(conn, mailBtn, leaveBtn);
  top.append(brand, me, tools);

  const banner = el('div', 'banner');
  banner.hidden = true;
  const bannerText = el('span', 'banner-text');
  banner.append(bannerText);

  const layout = el('main', 'layout');
  const gameCol = el('section', 'game-col');
  const game = el('div', 'game');
  gameCol.append(game);
  const side = el('aside', 'side');

  const seatsCard = el('section', 'card');
  const seatsTitle = el('h2', '', '席位');
  const seatCount = el('span', 'dim');
  seatsTitle.append(document.createTextNode(' '), seatCount);
  const seats = el('div', 'seats');
  seatsCard.append(seatsTitle, seats);

  const chatCard = el('section', 'card chat');
  chatCard.append(el('h2', '', '房间'));
  const chat = el('div', 'chat-log');
  const chatForm = el('div', 'chat-form');
  const sayInput = el('input');
  sayInput.placeholder = '说点什么…';
  sayInput.maxLength = 400;
  sayInput.setAttribute('aria-label', '在房间里说话');
  const sendBtn = btn('说', () => sendSay(), { primary: true });
  sayInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendSay();
    }
  });
  chatForm.append(sayInput, sendBtn);
  chatCard.append(chat, chatForm);

  side.append(seatsCard, chatCard);
  layout.append(gameCol, side);
  app.append(top, banner, layout);

  Object.assign(ui, {
    top, conn, connText, mailBtn, mailBadge, banner, bannerText,
    game, seats, seatCount, chat, sayInput, sendBtn, chips, myName,
  });
}

function render() {
  if (!state.shell || !state.snap) return;
  const snap = state.snap;
  ui.myName.textContent = snap.seat.name;
  ui.chips.textContent = snap.ledger && snap.ledger.chips !== undefined ? snap.ledger.chips + ' 枚筹码' : '';
  ui.seatCount.textContent = '· ' + snap.seats.filter((seat) => seat.kind !== 'observer').length + '/' + snap.maxSeats;
  renderSeats();
  renderMailBadge();
  renderBanner();
  renderGame();
}

function renderSeats() {
  clear(ui.seats);
  const snap = state.snap;
  snap.seats.forEach((seat) => {
    const row = el('div', 'seat' + (seat.id === snap.seat.id ? ' self' : ''));
    const dot = el('span', 'dot' + (snap.online && snap.online.includes(seat.id) ? ' on' : ''));
    row.append(dot, el('span', 'name', seat.name));
    if (seat.kind === 'pet') {
      row.append(el('span', 'kind', (KIND_LABELS[seat.kind] || seat.kind) + ' · ' + (TIER_LABELS[seat.tier] || seat.tier)));
    } else {
      row.append(el('span', 'kind', KIND_LABELS[seat.kind] || seat.kind));
    }
    if (seat.id === snap.seat.id) row.append(el('span', 'me-tag', '你'));
    ui.seats.append(row);
  });
}

function renderMailBadge() {
  const unread = state.snap.mailUnread || 0;
  ui.mailBadge.textContent = String(unread);
  ui.mailBadge.hidden = unread <= 0;
}

function renderBanner() {
  const snap = state.snap;
  const priv = snap.tablePrivate;
  const yourTurn = !!(priv && priv.yourTurn === true);
  ui.banner.hidden = !yourTurn;
  document.title = yourTurn ? '轮到你 · 客厅' : '客厅';
  if (!yourTurn) return;
  clear(ui.bannerText);
  const gameName = snap.table ? (GAME_LABELS[snap.table.game] || '') : '';
  ui.bannerText.append(document.createTextNode('轮到你' + (gameName ? ' · ' + gameName : '')));
  if (priv.deadline) {
    ui.bannerText.append(document.createTextNode(' '), clockSpan(priv.deadline));
  }
}

/* —— 牌桌 / 大厅 —— */

function renderGame() {
  const table = state.snap.table;
  const active = table && (table.status === 'bidding' || table.status === 'playing');
  if (!active) {
    disposeGame();
    renderLobby();
    return;
  }
  if (!state.mounted || state.mounted.game !== table.game) {
    disposeGame();
    const root = el('div', 'game-root');
    ui.game.append(root);
    const factory = { dice: mountDice, ddz: mountDdz, monopoly: mountMonopoly }[table.game];
    if (!factory) {
      root.append(el('p', 'muted', '这个游戏还没有网页桌面。'));
      state.mounted = { game: table.game, instance: { update() {}, destroy() {} } };
      return;
    }
    const ctx = { me: state.snap.seat, act, toast: showToast, serverNow };
    state.mounted = { game: table.game, instance: factory(root, ctx) };
  }
  state.mounted.instance.update(makeView());
}

function makeView() {
  const snap = state.snap;
  const names = new Map((snap.seats || []).map((seat) => [seat.id, seat.name]));
  // 脚本陪练不是房间席位，但桌上的名字要能显示出来。
  for (const seat of ((snap.table && snap.table.seats) || [])) {
    if (!names.has(seat.id)) names.set(seat.id, seat.name);
  }
  return {
    table: snap.table,
    priv: snap.tablePrivate,
    me: snap.seat,
    seats: snap.seats,
    names,
    online: snap.online || [],
    now: serverNow(),
  };
}

function disposeGame() {
  if (state.mounted) {
    try {
      state.mounted.instance.destroy?.();
    } catch {
      /* 渲染器自己清干净 */
    }
    state.mounted = null;
  }
  if (ui.game) clear(ui.game);
}

function renderLobby() {
  const snap = state.snap;
  const signup = snap.monopoly && snap.monopoly.signup;
  const fault = snap.monopoly && snap.monopoly.fault;
  const table = snap.table;
  clear(ui.game);

  const panel = el('section', 'panel');
  panel.append(el('h2', '', '牌桌'));
  if (fault) panel.append(el('p', 'warn', '大富翁故障：' + fault));

  if (signup) {
    panel.append(signupCard(signup, { tableActive: !!(table && table.status !== 'ended') }));
    if (!table) {
      panel.append(el('p', 'dim', '等报名的时候也可以先打别的：'));
      panel.append(openButtons({ monopoly: false }));
    }
  }
  if (table) panel.append(openTableCard(table, { allowMonopoly: !signup }));
  if (!signup && !table) {
    panel.append(el('p', 'muted', '现在没有牌桌。开一张，或者等她开。'));
    panel.append(openButtons());
  }
  ui.game.append(panel);
}

function signupCard(signup, options = {}) {
  const me = state.snap.seat;
  const box = el('div', 'signup');
  box.append(el('h3', '', '大富翁报名'));
  box.append(el('p', 'muted', '发起人：' + signup.host + '；已报名：' + (signup.seats.join('、') || '无')));
  box.append(el('p', 'muted',
    (signup.pace === 'quick' ? '试玩 5 分钟/回合' : '标准 30 分钟/回合')
    + '；' + signup.seats.length + '/' + signup.size + ' 人；'
    + (signup.missing > 0 ? '还差 ' + signup.missing + ' 个真人（脚本最多补 2 个）' : '人数够了，可以开局')
    + '；报名截止 ' + fmtDateTime(signup.deadlineAt)));
  const inSignup = signup.seats.includes(me.name);
  const host = signup.host === me.name;
  const actions = el('div', 'actions');
  if (!inSignup) {
    actions.append(btn('报名', () => act({ type: 'monopoly', action: 'join' }), { primary: true }));
  } else if (!host) {
    actions.append(btn('退出报名', () => act({ type: 'monopoly', action: 'leave' })));
  }
  if (host) {
    const canStart = signup.seats.length >= 2 && signup.missing === 0 && !options.tableActive;
    actions.append(btn('开局', () => act({ type: 'monopoly', action: 'start' }), {
      primary: true,
      disabled: !canStart,
      title: options.tableActive ? '现在还有一张没结束的桌子' : canStart ? '' : '至少两个真人报名，空位最多补 2 个脚本',
    }));
    actions.append(btn('取消报名', () => act({ type: 'monopoly', action: 'cancel' }), { danger: true }));
  }
  if (actions.children.length) box.append(actions);
  else box.append(el('p', 'muted', '等发起人开局。'));
  return box;
}

function openTableCard(table, options = {}) {
  const me = state.snap.seat;
  const names = new Map(state.snap.seats.map((seat) => [seat.id, seat.name]));
  const box = el('div', 'open-table');
  box.append(el('h3', '', (GAME_LABELS[table.game] || table.game) + ' · ' + (STATUS_LABELS[table.status] || table.status)));
  if (table.status === 'ended') {
    box.append(el('p', 'muted', table.text || '这局结束了。'));
    if (table.game === 'monopoly' && table.ended && Array.isArray(table.ended.ranking)) {
      const ranking = el('div', 'ranking');
      table.ended.ranking.forEach((row, index) => {
        const line = el('div', 'rank');
        line.append(el('span', 'place', '#' + (index + 1)));
        line.append(el('span', 'who', names.get(row.seatId) || row.seatId));
        line.append(el('span', 'detail', '现金 ' + row.cash + ' + 地产 ' + row.propertyValue + ' = ' + row.assets));
        ranking.append(line);
      });
      box.append(ranking);
    }
    box.append(openButtons({ monopoly: options.allowMonopoly !== false }));
    return box;
  }
  box.append(el('p', 'muted', '桌上：' + (table.seats || []).map((seat) => names.get(seat.id) || seat.name).join('、')));
  const seated = (table.seats || []).some((seat) => seat.id === me.id);
  const host = table.host === me.id;
  const actions = el('div', 'actions');
  if (!seated) {
    actions.append(btn('坐下', () => act({ type: 'table_join' }), { primary: true }));
  } else if (host) {
    const count = (table.seats || []).length;
    const enough = table.game === 'ddz' || count >= 2;
    actions.append(btn('开始', () => act({ type: 'table_start' }), {
      primary: true,
      disabled: !enough,
      title: enough ? '' : '骰子桌至少两个人',
    }));
  } else {
    box.append(el('p', 'muted', '等 ' + (names.get(table.host) || '发起人') + ' 开局。'));
  }
  if (actions.children.length) box.append(actions);
  return box;
}

function openButtons(options = {}) {
  const box = el('div', 'open-buttons');
  const row = el('div', 'actions');
  row.append(btn('开骰子桌', () => act({ type: 'table_open', game: 'dice' })));
  row.append(btn('开斗地主桌', () => act({ type: 'table_open', game: 'ddz' })));
  box.append(row);

  if (options.monopoly === false) return box;
  const mono = el('div', 'row');
  const size = el('select');
  size.setAttribute('aria-label', '大富翁人数');
  for (const value of [4, 6]) {
    const option = el('option', '', value + ' 人');
    option.value = String(value);
    size.append(option);
  }
  const pace = el('select');
  pace.setAttribute('aria-label', '大富翁节奏');
  for (const [value, label] of [['standard', '标准 30 分钟/回合'], ['quick', '试玩 5 分钟/回合']]) {
    const option = el('option', '', label);
    option.value = value;
    pace.append(option);
  }
  mono.append(size, pace, btn('开大富翁报名', () => act({
    type: 'monopoly',
    action: 'open',
    size: Number(size.value),
    pace: pace.value,
  })));
  box.append(mono);
  box.append(el('p', 'dim', '大富翁至少要两个真人报名；空位最多补 2 个脚本。'));
  return box;
}

/* —— 信箱 —— */

async function openMail() {
  if (state.mailOpen) return;
  state.mailOpen = true;
  const overlay = el('div', 'mail-overlay');
  const card = el('section', 'card mail-card');
  const head = el('div', 'mail-head');
  head.append(el('h2', '', '信箱'));
  const close = btn('关闭', () => {
    state.mailOpen = false;
    overlay.remove();
  }, { ghost: true, small: true });
  head.append(close);
  card.append(head);
  const list = el('div');
  card.append(list);
  const actions = el('div', 'actions');
  const mark = btn('全部标为已读', async () => {
    try {
      await api('/v1/mail?limit=50');
      await refreshSnapshot();
      render();
      close.click();
      showToast('信箱标成已读了');
    } catch (error) {
      showToast(error.message, 'bad');
    }
  }, { small: true });
  actions.append(mark);
  card.append(actions);
  overlay.append(card);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close.click();
  });
  app.append(overlay);
  try {
    const page = await api('/v1/mail?peek=1&limit=10');
    if (!page.items || page.items.length === 0) list.append(el('p', 'muted', '信箱是空的。'));
    for (const item of (page.items || [])) {
      const row = el('div', 'mail-item');
      row.append(el('div', 'meta', (item.fromName || '系统') + ' · ' + fmtClock(item.ts)));
      row.append(document.createTextNode(item.text));
      list.append(row);
    }
    if (page.unread > (page.items || []).length) {
      list.append(el('p', 'dim', '还有 ' + (page.unread - page.items.length) + ' 封未读。'));
    }
  } catch (error) {
    list.append(el('p', 'warn', error.message));
  }
}

/* —— 加入 / 离线 —— */

function renderJoin(message = '') {
  state.shell = false;
  disposeGame();
  clear(app);
  const join = el('div', 'join');
  const card = el('section', 'card');
  card.append(el('h1', '', '客厅 · 下场玩'));
  card.append(el('p', 'sub', '用自己的席位和 Coo 同桌。你的战绩、筹码和信箱是单独的一份，不会记到她头上。'));

  const nameField = el('div', 'field');
  nameField.append(el('label', '', '你的名字'));
  const nameInput = el('input');
  nameInput.placeholder = '比如：爸爸';
  nameInput.maxLength = 24;
  nameInput.autocomplete = 'nickname';
  nameField.append(nameInput);

  const inviteField = el('div', 'field');
  inviteField.append(el('label', '', '邀请码'));
  const inviteInput = el('input');
  inviteInput.type = 'password';
  inviteInput.placeholder = '部署里 PARLOR_INVITE_CODE 那一行';
  inviteInput.autocomplete = 'off';
  inviteField.append(inviteInput);

  const error = el('p', 'warn error', message);
  const submit = btn('加入客厅', () => submitJoin(), { primary: true });
  const note = el('p', 'note', '邀请码只用来进这个房间，不会存进网址；席位令牌存在这台浏览器里。');
  card.append(nameField, inviteField, error, submit, note);
  join.append(card);
  app.append(join);
  nameInput.focus();

  async function submitJoin() {
    const name = nameInput.value.trim();
    const invite = inviteInput.value.trim();
    error.textContent = '';
    if (!name) {
      error.textContent = '先起一个名字。';
      return;
    }
    if (!invite) {
      error.textContent = '邀请码没填。';
      return;
    }
    submit.disabled = true;
    try {
      const response = await fetch('/v1/player/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-parlor-invite': invite },
        body: JSON.stringify({ name }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || '加入失败');
      writeStore({
        room: body.room,
        seatId: body.seat.id,
        name: body.seat.name,
        token: body.token,
        cooId: body.identity.cooId,
        cooSecret: body.identity.cooSecret,
      });
      state.latest = 0;
      state.seen = new Set();
      await boot();
    } catch (joinError) {
      error.textContent = joinError.message || '加入失败';
    } finally {
      submit.disabled = false;
    }
  }
}

function renderOffline(message) {
  state.shell = false;
  disposeGame();
  clear(app);
  const box = el('div', 'join');
  const card = el('section', 'card');
  card.append(el('h1', '', '连不上客厅'));
  card.append(el('p', 'sub', message || '网络没有通。'));
  const actions = el('div', 'actions');
  actions.append(btn('重试', () => boot(), { primary: true }));
  actions.append(btn('换一个席位', () => {
    clearStore();
    location.reload();
  }, { ghost: true }));
  card.append(actions);
  box.append(card);
  app.append(box);
}

/* —— 聊天 —— */

async function sendSay() {
  const text = ui.sayInput.value.trim();
  if (!text) return;
  ui.sayInput.value = '';
  try {
    await act({ type: 'say', text });
  } catch {
    ui.sayInput.value = text;
  }
}

/* —— 小东西 —— */

function showToast(message, kind = '') {
  if (!message) return;
  toastBox.textContent = message;
  toastBox.className = 'toast show' + (kind ? ' ' + kind : '');
  toastBox.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastBox.hidden = true;
  }, 4200);
}

setInterval(() => {
  const now = serverNow();
  for (const node of document.querySelectorAll('[data-deadline]')) {
    const deadline = Number(node.dataset.deadline);
    if (!deadline) {
      node.textContent = '';
      continue;
    }
    const left = fmtLeft(deadline, now);
    node.textContent = left === '已截止' ? '已截止（服务器托管中）' : '还剩 ' + left;
  }
}, 500);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleRefresh();
});
window.addEventListener('focus', () => scheduleRefresh());
