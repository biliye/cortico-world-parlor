/** 客厅网页客户端：家长自己的席位，和 Coo 同桌玩。
 *  布局是三维（我的席位 / 牌桌 / 聊天），牌桌与聊天都接真实快照与 SSE；
 *  牌桌 tab 只是过滤，发送仍是房间公开的 parlor_say。 */
import {
  el, clear, icon, initialOf, fmtClock, fmtDateTime, fmtLeft, clockSpan, btn, playerClass,
  isNearBottom, readable, GAME_LABELS, STATUS_LABELS, KIND_LABELS,
} from './common.js';
import { mountDice } from './games/dice.js';
import { mountDdz } from './games/ddz.js';
import { mountMonopoly } from './games/monopoly.js';

const STORE_KEY = 'parlor-play-v1';
const app = document.getElementById('app');
const toastBox = document.getElementById('toast');

const RULES = {
  dice: '每人两颗暗骰，轮到你可以重掷一颗，或停牌；合计最高者赢。45 秒不动作会自动停牌。',
  ddz: '三人一桌，空位由脚本陪练补；牌型与计分由服务器判。叫地主 30 秒、出牌 60 秒，超时由服务器代打。',
  monopoly: '24 格外圈棋盘，买地、升级、道具与托管都在中间面板；回合超时自动托管。',
};

const state = {
  cfg: readStore(),
  snap: null,
  offset: 0,
  latest: 0,
  seen: new Set(),
  log: [],
  stream: null,
  reconnect: null,
  refreshTimer: null,
  mounted: null,
  shell: false,
  busy: false,
  view: 'lobby',
  tab: 'table',
  unread: { room: 0, table: 0 },
  mail: null,
  mailLoading: false,
  sheet: null,
  timerKey: '',
  timerTotal: 0,
};
const ui = {};
let toastTimer = 0;
let mailTimer = 0;

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
    state.view = hasLiveTable() ? 'table' : 'lobby';
    state.tab = hasLiveTable() ? 'table' : 'room';
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

function hasLiveTable() {
  const table = state.snap && state.snap.table;
  return !!table && (table.status === 'bidding' || table.status === 'playing');
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

async function actAndGo(body, view = 'table') {
  try {
    await act(body);
    if (view) setView(view);
  } catch {
    /* 错误已经弹过 */
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
  source.onopen = () => {
    setConn('on');
    // 连上之后补一次快照：online 与信箱未读只有在 SSE 连接建立后才准。
    scheduleRefresh();
  };
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
  if (state.tab === 'mail'
    && (type === 'parlor.whisper' || type === 'parlor.ledger' || type === 'parlor.table.turn')) {
    loadMail(true);
  }
}

async function seedLog() {
  if (!ui.logRoom) return;
  try {
    const page = await api('/v1/replay?limit=80');
    for (const event of (page.events || [])) pushLog(event, true);
    ui.logRoom.scrollTop = ui.logRoom.scrollHeight;
    ui.logTable.scrollTop = ui.logTable.scrollHeight;
  } catch {
    /* 回放拿不到不影响开局 */
  }
}

/* —— 事件分栏与渲染 —— */

function tableSeatIds() {
  const ids = new Set();
  const table = state.snap && state.snap.table;
  for (const seat of ((table && table.seats) || [])) {
    if (seat && typeof seat.id === 'string') ids.add(seat.id);
  }
  return ids;
}

function isTableBucket(event) {
  const type = event.type || '';
  if (type.startsWith('parlor.table.') || type.startsWith('parlor.monopoly.')) return true;
  if (type === 'parlor.say' && event.from !== 'system') return tableSeatIds().has(event.from);
  return false;
}

function pushLog(event, seed = false) {
  if (typeof event.seq === 'number') {
    if (state.seen.has(event.seq)) return;
    state.seen.add(event.seq);
    if (state.seen.size > 4000) {
      const keep = [...state.seen].sort((a, b) => b - a).slice(0, 2000);
      state.seen = new Set(keep);
    }
  }
  state.log.push(event);
  if (state.log.length > 400) state.log.splice(0, state.log.length - 300);

  const tableBucket = isTableBucket(event);
  const roomNode = lineOf(event, false);
  const tableNode = tableBucket ? lineOf(event, true) : null;
  if (!roomNode) return;

  const roomBottom = isNearBottom(ui.logRoom);
  ui.logRoom.append(roomNode);
  while (ui.logRoom.children.length > 300) ui.logRoom.firstElementChild.remove();
  if (!seed && roomBottom) ui.logRoom.scrollTop = ui.logRoom.scrollHeight;

  if (tableNode) {
    const tableBottom = isNearBottom(ui.logTable);
    ui.logTable.append(tableNode);
    while (ui.logTable.children.length > 300) ui.logTable.firstElementChild.remove();
    if (!seed && tableBottom) ui.logTable.scrollTop = ui.logTable.scrollHeight;
  }

  if (!seed) {
    if (state.tab !== 'room') state.unread.room += 1;
    if (tableBucket && state.tab !== 'table') state.unread.table += 1;
    renderChatBadges();
  }
}

function lineOf(event, tableBucket) {
  const type = event.type || '';
  if (type === 'parlor.table.turn' || type === 'parlor.digest') return null;
  const time = el('time', '', fmtClock(event.ts).slice(0, 5));
  if (event.from === 'system') {
    const node = el('div', 'system-line');
    const tag = type.startsWith('parlor.table.') ? '牌桌'
      : type.startsWith('parlor.monopoly.') ? '大富翁'
        : type === 'parlor.ledger' ? '账本' : '';
    if (tag) node.append(el('span', 'tag tag-table', tag));
    node.append(el('span', '', readable(event.text || '')), time);
    return node;
  }
  const snap = state.snap;
  const seat = snap ? snap.seats.find((entry) => entry.id === event.from) : null;
  const index = snap ? snap.seats.findIndex((entry) => entry.id === event.from) : -1;
  const name = (event.data && typeof event.data.name === 'string' ? event.data.name : '')
    || (seat ? seat.name : '')
    || event.from;
  const whisper = type === 'parlor.whisper';
  const node = el('article', 'msg' + (tableBucket ? ' is-table' : '') + (whisper ? ' is-whisper' : ''));
  node.append(avatarNode(event.from, 'avatar-sm'));
  const body = el('div', 'msg-body');
  const meta = el('div', 'msg-meta');
  meta.append(el('span', 'msg-name', name));
  meta.append(el('span', 'tag ' + (whisper ? 'tag-whisper' : tableBucket ? 'tag-table' : 'tag-room'),
    whisper ? '私聊' : tableBucket ? '牌桌' : '客厅'));
  meta.append(time);
  body.append(meta);
  body.append(el('p', '', (whisper ? '（只有你们看得见）' : '') + readable(event.text || '')));
  node.append(body);
  return node;
}

function avatarNode(id, size = 'avatar-sm', options = {}) {
  const snap = state.snap;
  const tableSeats = (snap && snap.table && snap.table.seats) || [];
  const seat = (snap && snap.seats.find((entry) => entry.id === id))
    || tableSeats.find((entry) => entry.id === id)
    || null;
  const index = snap ? snap.seats.findIndex((entry) => entry.id === id) : -1;
  const name = seat ? seat.name : (options.name || id || '？');
  const colorIndex = index >= 0 ? index : (options.index || 0);
  const cls = ['avatar', size, seat && seat.kind === 'pet' ? 'avatar-coo' : playerClass(colorIndex)]
    .filter(Boolean).join(' ');
  const node = el('span', cls, initialOf(name));
  if (seat && seat.kind === 'pet') {
    const badge = el('span', 'avatar-badge');
    badge.append(icon('spark'));
    node.append(badge);
  }
  if (options.online !== false && snap && Array.isArray(snap.online) && snap.online.includes(id)) {
    node.append(el('span', 'status-dot online'));
  }
  return node;
}

/* —— 页面骨架 —— */

function buildShell() {
  clear(app);
  state.shell = true;

  const top = el('header', 'topbar');
  const brand = brandNode();
  const roomPill = el('div', 'room-pill');
  const pillDot = el('span', 'live-dot');
  const pillText = el('span', 'room-pill-main');
  const pillSub = el('span', 'room-pill-sub');
  roomPill.append(pillDot, pillText, el('span', 'room-sep', '·'), pillSub);

  const viewSwitch = el('div', 'view-switch');
  viewSwitch.setAttribute('role', 'tablist');
  viewSwitch.setAttribute('aria-label', '切换大厅与牌桌');
  const topLobby = viewButton('大厅', 'lobby');
  const topTable = viewButton('牌桌', 'table');
  viewSwitch.append(topLobby, topTable);

  const topRight = el('div', 'top-right');
  const conn = el('span', 'conn');
  const connText = el('span', 'conn-text', '连接中…');
  conn.append(el('span', 'dot'), connText);

  const mailBtn = el('button', 'ghost-btn mail-btn');
  mailBtn.type = 'button';
  mailBtn.append(icon('mail'), document.createTextNode('信箱'));
  const mailBadge = el('span', 'badge', '0');
  mailBadge.hidden = true;
  mailBtn.append(mailBadge);
  mailBtn.addEventListener('click', () => openMailTab());

  const leaveBtn = btn('换席位', () => {
    if (!confirm('换席位会清掉这台浏览器里的令牌；旧席位会留在房间里。要继续吗？')) return;
    if (state.stream) state.stream.close();
    clearStore();
    location.reload();
  }, { ghost: true, small: true });
  leaveBtn.classList.add('leave-btn');

  const topMe = el('div', 'top-me');
  const topAvatar = el('span', 'top-avatar-host');
  const topMeText = el('span', 'top-me-text');
  const topName = el('span', 'top-me-name');
  const topSub = el('span', 'top-me-sub');
  topMeText.append(topName, topSub);
  const chips = el('span', 'chips');
  chips.append(icon('coin'));
  const chipsText = el('span', '', '0');
  chips.append(chipsText);
  topMe.append(topAvatar, topMeText, chips);

  const menuBtn = el('button', 'icon-btn menu-btn');
  menuBtn.type = 'button';
  menuBtn.setAttribute('aria-label', '打开我的席位');
  menuBtn.append(icon('menu'));
  menuBtn.addEventListener('click', () => openSheet('me'));

  topRight.append(conn, mailBtn, leaveBtn, topMe, menuBtn);
  top.append(brand, roomPill, viewSwitch, topRight);

  const banner = el('div', 'banner');
  banner.hidden = true;
  const bannerText = el('span', 'banner-text');
  const bannerGo = btn('去牌桌', () => setView('table'), { small: true });
  banner.append(bannerText, bannerGo);

  const layout = el('main', 'layout');
  layout.id = 'main';

  /* 左栏：我的席位 / 账本 / 牌桌 */
  const leftRail = el('aside', 'left-rail');
  leftRail.setAttribute('aria-label', '我的席位与账本');
  leftRail.append(sheetGrip());
  const leftHead = el('div', 'sheet-head');
  leftHead.append(el('span', 'eyebrow', '我的'), sheetClose());
  leftRail.append(leftHead);

  const seatCard = el('section', 'panel seat-card');
  const seatTop = el('div', 'seat-card-top');
  const seatAvatar = el('span', 'seat-avatar-host');
  const seatCopy = el('div', 'seat-card-copy');
  const seatName = el('h2', 'seat-card-name');
  const seatSub = el('p', 'seat-card-sub');
  seatCopy.append(el('span', 'eyebrow', '我的席位'), seatName, seatSub);
  seatTop.append(seatAvatar, seatCopy);
  const stats = el('div', 'seat-stats');
  const statChips = statCell('筹码');
  const statWins = statCell('今晚');
  const statGames = statCell('局数');
  stats.append(statChips.box, statWins.box, statGames.box);
  const progress = el('div', 'seat-progress');
  const progressHead = el('div', 'seat-progress-head');
  const progressLeft = el('span', '', '还没有战绩');
  const progressRight = el('span', 'muted', '0 局');
  progressHead.append(progressLeft, progressRight);
  const progressBar = el('div', 'bar');
  const progressFill = el('i');
  progressBar.append(progressFill);
  progress.append(progressHead, progressBar);
  seatCard.append(seatTop, stats, progress);
  leftRail.append(seatCard);

  const ledgerCard = el('section', 'panel ledger-card');
  const ledgerHead = el('div', 'panel-head');
  ledgerHead.append(el('h2', '', '账本'), el('span', 'muted', '最近'));
  const ledgerTotal = el('div', 'ledger-total');
  const ledgerNet = el('strong', '', '0');
  ledgerTotal.append(ledgerNet, el('span', '', '今晚的小收获 · 枚'));
  const split = el('div', 'ledger-split');
  split.setAttribute('aria-label', '按游戏分项');
  const ledgerList = el('ul', 'ledger-list');
  ledgerCard.append(ledgerHead, ledgerTotal, split, ledgerList);
  leftRail.append(ledgerCard);

  const tablesCard = el('section', 'panel tables-card');
  const tablesHead = el('div', 'panel-head');
  const tablesAll = el('button', 'link', '换桌');
  tablesAll.type = 'button';
  tablesAll.addEventListener('click', () => setView('lobby'));
  tablesHead.append(el('h2', '', '牌桌'), tablesAll);
  const tableList = el('ul', 'table-list');
  tablesCard.append(tablesHead, tableList);
  leftRail.append(tablesCard);

  /* 中间：牌桌 / 大厅 */
  const center = el('section', 'center');
  center.setAttribute('aria-label', '牌桌与大厅');
  const mobileSwitch = el('div', 'mobile-view-switch');
  mobileSwitch.setAttribute('role', 'tablist');
  mobileSwitch.setAttribute('aria-label', '切换大厅与牌桌');
  const mobLobby = viewButton('大厅', 'lobby');
  const mobTable = viewButton('牌桌', 'table');
  mobileSwitch.append(mobLobby, mobTable);

  const viewTable = el('div', 'view view-table');
  const tableHead = el('div', 'table-head-host');
  const mobileTicker = el('div', 'mobile-ticker');
  const game = el('div', 'game');
  const ticker = el('div', 'ticker');
  viewTable.append(tableHead, mobileTicker, game, ticker);

  const viewLobby = el('div', 'view view-lobby');
  const lobbyHead = el('div', 'lobby-head');
  const lobbyCopy = el('div');
  const lobbyEyebrow = el('span', 'eyebrow');
  const lobbyTitle = el('h1', '', '灯还亮着。');
  const lobbySub = el('p');
  lobbyCopy.append(lobbyEyebrow, lobbyTitle, lobbySub);
  lobbyHead.append(lobbyCopy);
  const gameGrid = el('div', 'game-grid');
  const members = el('section', 'panel members');
  const membersHead = el('div', 'panel-head');
  const membersTitle = el('h2', '', '房间里的人');
  const membersCount = el('span', 'muted');
  membersHead.append(membersTitle, membersCount);
  const memberRow = el('div', 'member-row');
  members.append(membersHead, memberRow);
  viewLobby.append(lobbyHead, gameGrid, members);
  center.append(mobileSwitch, viewTable, viewLobby);

  /* 右栏：聊天 / 牌桌信息 */
  const rightRail = el('aside', 'right-rail');
  rightRail.setAttribute('aria-label', '聊天与牌桌信息');
  const chatPanel = el('section', 'panel chat-panel');
  chatPanel.id = 'chatPanel';
  chatPanel.append(sheetGrip());
  const chatHead = el('div', 'chat-head');
  const chatCopy = el('div');
  chatCopy.append(el('span', 'eyebrow', '客厅 · 牌桌'), el('h2', '', '聊天'));
  const chatActions = el('div', 'chat-head-actions');
  const backRoom = el('button', 'link', '切回客厅');
  backRoom.type = 'button';
  backRoom.addEventListener('click', () => setTab('room'));
  const markRead = btn('都看过了', () => markMailRead(), { ghost: true, small: true });
  markRead.hidden = true;
  chatActions.append(markRead, backRoom, sheetClose());
  chatHead.append(chatCopy, chatActions);

  const chatTabs = el('div', 'chat-tabs');
  chatTabs.setAttribute('role', 'tablist');
  chatTabs.setAttribute('aria-label', '聊天频道');
  const tabRoom = chatTab('room', '客厅', 'users');
  const tabTable = chatTab('table', '牌桌', 'dice');
  const tabMail = chatTab('mail', '信箱', 'mail');
  chatTabs.append(tabRoom.btn, tabTable.btn, tabMail.btn);

  const chatBody = el('div', 'chat-body');
  const logRoom = el('div', 'chat-log');
  logRoom.dataset.chatPanel = 'room';
  const logTable = el('div', 'chat-log');
  logTable.dataset.chatPanel = 'table';
  logTable.hidden = true;
  const mailList = el('div', 'mail-list');
  mailList.dataset.chatPanel = 'mail';
  mailList.hidden = true;
  chatBody.append(logRoom, logTable, mailList);

  const composer = el('div', 'composer');
  const scope = el('div', 'composer-scope');
  scope.append(el('span', 'scope-dot'));
  const scopeText = el('span');
  scope.append(scopeText, icon('lock', 'scope-lock'));
  const composerRow = el('div', 'composer-row');
  const sayInput = el('input');
  sayInput.type = 'text';
  sayInput.maxLength = 400;
  sayInput.autocomplete = 'off';
  sayInput.setAttribute('aria-label', '在客厅说话');
  sayInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendSay();
    }
  });
  const sendBtn = el('button', 'send-btn');
  sendBtn.type = 'button';
  sendBtn.setAttribute('aria-label', '发送');
  sendBtn.append(icon('send'));
  sendBtn.addEventListener('click', () => sendSay());
  composerRow.append(sayInput, sendBtn);
  composer.append(scope, composerRow);

  const mailNote = el('div', 'mail-note');
  mailNote.hidden = true;
  mailNote.append(icon('lock'), document.createTextNode('信箱只读；回信请切到客厅或牌桌。'));
  chatPanel.append(chatHead, chatTabs, chatBody, composer, mailNote);

  const info = el('section', 'panel table-info');
  const infoHead = el('div', 'panel-head');
  infoHead.append(el('h2', '', '牌桌信息'));
  const infoGrid = el('dl', 'info-grid');
  const infoGame = infoCell(infoGrid, '游戏');
  const infoStake = infoCell(infoGrid, '每局');
  const infoStatus = infoCell(infoGrid, '状态');
  const infoTurn = infoCell(infoGrid, '轮到');
  const ruleNote = el('p', 'rule-note');
  const infoFoot = el('div', 'table-info-foot');
  const infoClock = el('span');
  infoFoot.append(el('span', 'live-dot'), infoClock);
  info.append(infoHead, infoGrid, ruleNote, infoFoot);
  rightRail.append(chatPanel, info);

  /* 手机底栏与抽屉背景 */
  const nav = el('nav', 'mobile-nav');
  nav.setAttribute('aria-label', '主导航');
  const navTable = navButton('table', '牌桌', 'dice');
  const navChat = navButton('chat', '聊天', 'chat');
  const navMail = navButton('mail', '信箱', 'mail');
  const navMe = navButton('me', '我', 'user');
  nav.append(navTable.btn, navChat.btn, navMail.btn, navMe.btn);

  const backdrop = el('div', 'sheet-backdrop');
  backdrop.hidden = true;
  backdrop.addEventListener('click', () => closeSheet());

  app.append(top, banner, layout, nav, backdrop);
  layout.append(leftRail, center, rightRail);

  Object.assign(ui, {
    top, conn, connText, mailBtn, mailBadge, banner, bannerText, bannerGo,
    roomPillText: pillText, roomPillSub: pillSub,
    viewButtons: [topLobby, topTable, mobLobby, mobTable],
    topAvatar, topName, topSub, chipsText,
    leftRail, seatAvatar, seatName, seatSub,
    statChips, statWins, statGames, progressLeft, progressRight, progressFill,
    ledgerNet, split, ledgerList, tableList,
    viewTable, viewLobby, tableHead, mobileTicker, game, ticker,
    lobbyEyebrow, lobbyTitle, lobbySub, gameGrid, membersCount, memberRow,
    chatPanel, markRead, backRoom, tabRoom, tabTable, tabMail,
    logRoom, logTable, mailList, composer, scopeText, sayInput, sendBtn, mailNote,
    infoGame, infoStake, infoStatus, infoTurn, ruleNote, infoClock,
    navTable, navChat, navMail, navMe, backdrop,
  });
  syncViewButtons();
  syncSheet();
}

function brandNode() {
  const brand = el('div', 'brand');
  const mark = el('span', 'brand-mark');
  mark.append(icon('lamp'));
  const text = el('span', 'brand-text');
  text.append(el('span', 'brand-name', '客厅'), el('span', 'brand-sub', 'LIVING ROOM · 一起玩'));
  brand.append(mark, text);
  return brand;
}

function sheetGrip() {
  const grip = el('div', 'sheet-grip');
  grip.setAttribute('aria-hidden', 'true');
  return grip;
}

function sheetClose() {
  const close = el('button', 'icon-btn sheet-close');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭');
  close.append(icon('close'));
  close.addEventListener('click', () => closeSheet());
  return close;
}

function statCell(label) {
  const box = el('div');
  box.append(el('span', '', label));
  const value = el('strong', '', '0');
  box.append(value);
  return { box, value };
}

function infoCell(grid, label) {
  const row = el('div');
  row.append(el('dt', '', label));
  const dd = el('dd', '', '—');
  row.append(dd);
  grid.append(row);
  return dd;
}

function viewButton(label, view) {
  const node = el('button', 'view-btn', label);
  node.type = 'button';
  node.dataset.view = view;
  node.setAttribute('role', 'tab');
  node.addEventListener('click', () => setView(view));
  return node;
}

function chatTab(tab, label, iconName) {
  const node = el('button', 'chat-tab');
  node.type = 'button';
  node.dataset.chatTab = tab;
  node.setAttribute('role', 'tab');
  node.append(icon(iconName), document.createTextNode(label));
  const badge = el('span', 'tab-count', '0');
  badge.hidden = true;
  node.append(badge);
  node.addEventListener('click', () => setTab(tab));
  return { btn: node, badge };
}

function navButton(kind, label, iconName) {
  const node = el('button', 'nav-btn');
  node.type = 'button';
  node.dataset.nav = kind;
  node.append(icon(iconName), el('span', '', label));
  const badge = el('i', 'nav-badge', '0');
  badge.hidden = true;
  node.append(badge);
  node.addEventListener('click', () => {
    if (kind === 'table') {
      closeSheet();
      setView('table');
      return;
    }
    if (kind === 'chat') {
      openSheet('chat');
      setTab(hasLiveTable() ? 'table' : 'room');
      return;
    }
    if (kind === 'mail') {
      openSheet('chat');
      setTab('mail');
      return;
    }
    openSheet('me');
  });
  return { btn: node, badge };
}

/* —— 总渲染 —— */

function render() {
  if (!state.shell || !state.snap) return;
  renderTopbar();
  renderSeatCard();
  renderLedger();
  renderTablesRail();
  renderBanner();
  renderChat();
  renderTableInfo();
  renderCenter();
  syncNav();
  document.title = (state.snap.tablePrivate && state.snap.tablePrivate.yourTurn ? '轮到你 · 客厅' : '客厅 · 一起玩');
}

function renderTopbar() {
  const snap = state.snap;
  const seated = snap.seats.filter((seat) => seat.kind !== 'observer').length;
  const pets = snap.seats.filter((seat) => seat.kind === 'pet');
  const coos = pets.filter((seat) => (snap.online || []).includes(seat.id)).length;
  ui.roomPillText.textContent = seated + ' 人在座';
  ui.roomPillSub.textContent = pets.length === 0
    ? '还没有 Coo'
    : coos > 0 ? coos + ' 位 Coo 在线' : pets.length + ' 位 Coo 离线';
  ui.topAvatar.replaceChildren(avatarNode(snap.seat.id, 'avatar', { online: false }));
  ui.topName.textContent = snap.seat.name;
  const online = (snap.online || []).includes(snap.seat.id);
  ui.topSub.textContent = (KIND_LABELS[snap.seat.kind] || snap.seat.kind) + ' · ' + (online ? '在线' : '离线');
  ui.chipsText.textContent = snap.ledger && snap.ledger.chips !== undefined ? String(snap.ledger.chips) : '0';
}

function renderSeatCard() {
  const snap = state.snap;
  const ledger = snap.ledger;
  ui.seatAvatar.replaceChildren(avatarNode(snap.seat.id, 'avatar-lg'));
  clear(ui.seatName);
  ui.seatName.append(document.createTextNode(snap.seat.name), el('span', 'tag tag-you', '你'));
  const online = (snap.online || []).includes(snap.seat.id);
  ui.seatSub.textContent = (KIND_LABELS[snap.seat.kind] || snap.seat.kind) + ' · ' + (online ? '在线' : '离线');
  const games = ledger ? ledger.games : 0;
  const wins = ledger ? ledger.wins : 0;
  const losses = ledger ? ledger.losses : 0;
  const draws = ledger ? ledger.draws : 0;
  ui.statChips.value.textContent = String(ledger ? ledger.chips : 0);
  ui.statWins.value.textContent = wins + ' 胜';
  ui.statGames.value.textContent = String(games);
  ui.progressLeft.textContent = games > 0
    ? '今晚 ' + [wins + ' 胜', losses + ' 负', draws ? draws + ' 平' : ''].filter(Boolean).join(' ')
    : '还没有战绩';
  ui.progressRight.textContent = games + ' 局';
  ui.progressFill.style.setProperty('width', (games > 0 ? (wins / games) * 100 : 0) + '%');
}

function renderLedger() {
  const ledger = state.snap.ledger;
  clear(ui.split);
  clear(ui.ledgerList);
  if (!ledger) {
    ui.ledgerNet.textContent = '0';
    ui.ledgerNet.classList.remove('neg');
    ui.split.append(el('p', 'muted', '还没有账本。'));
    return;
  }
  const dayStart = startOfToday();
  const net = (ledger.recent || [])
    .filter((entry) => entry.kind !== 'grant' && entry.ts >= dayStart && typeof entry.chips === 'number')
    .reduce((sum, entry) => sum + entry.chips, 0);
  ui.ledgerNet.textContent = (net > 0 ? '+' : net < 0 ? '-' : '') + Math.abs(net);
  ui.ledgerNet.classList.toggle('neg', net < 0);

  const byGame = (ledger.byGame || []).slice(0, 4);
  const max = byGame.reduce((top, row) => Math.max(top, row.games), 1);
  if (!byGame.length) {
    ui.split.append(el('p', 'muted', '还没有战绩。'));
  }
  for (const row of byGame) {
    const line = el('div', 'split-row');
    const name = el('span', 'split-name');
    name.append(el('i', 'dot ' + dotClass(row.game)), el('span', '', row.label || GAME_LABELS[row.game] || row.game));
    const bar = el('span', 'split-bar');
    const fill = el('i');
    fill.style.setProperty('width', Math.round((row.games / max) * 100) + '%');
    bar.append(fill);
    line.append(name, bar, el('span', 'split-val', row.games + ' 局'));
    ui.split.append(line);
  }

  const recent = (ledger.recent || []).slice(0, 3);
  if (!recent.length) {
    ui.ledgerList.append(el('li', '', '还没有账本条目。'));
  }
  for (const entry of recent) {
    const li = el('li');
    li.append(el('span', 'ledger-time', fmtClock(entry.ts).slice(0, 5)));
    li.append(el('span', 'ledger-line', readable(entry.text || '')));
    if (typeof entry.chips === 'number' && entry.chips !== 0) {
      li.append(el('b', entry.chips > 0 ? 'good' : 'bad', (entry.chips > 0 ? '+' : '') + entry.chips));
    }
    ui.ledgerList.append(li);
  }
}

function renderTablesRail() {
  const snap = state.snap;
  const table = snap.table;
  const signup = snap.monopoly && snap.monopoly.signup;
  clear(ui.tableList);
  for (const game of ['dice', 'ddz', 'monopoly']) {
    const row = el('li');
    const button = el('button', 'table-row');
    button.type = 'button';
    const mine = table && table.game === game && table.status !== 'ended';
    if (mine) button.classList.add('is-active');
    const iconBox = el('span', 'table-icon');
    iconBox.append(icon(game === 'dice' ? 'dice' : game === 'ddz' ? 'cards' : 'board'));
    const copy = el('span', 'table-copy');
    copy.append(el('strong', '', GAME_LABELS[game]));
    const small = el('small');
    let stateText = '';
    if (mine) {
      small.append(el('span', 'live-dot'));
      small.append(document.createTextNode((STATUS_LABELS[table.status] || table.status) + ' · ' + (table.seats || []).length + ' 人'));
      stateText = '在桌上';
    } else if (game === 'monopoly' && signup) {
      small.append(el('span', 'live-dot'));
      small.append(document.createTextNode('报名中 · ' + signup.seats.length + '/' + signup.size));
      stateText = '去牌桌';
    } else if (table && table.status !== 'ended') {
      small.append(document.createTextNode('另一桌进行中'));
      stateText = '看那桌';
    } else {
      small.append(document.createTextNode('可开桌'));
      stateText = game === 'monopoly' ? '去报名' : '去开桌';
    }
    copy.append(small);
    const stateEl = el('span', 'table-state' + (mine || stateText === '去牌桌' ? '' : ' muted'), stateText);
    button.append(iconBox, copy, stateEl);
    button.addEventListener('click', () => {
      if (mine || stateText === '去牌桌' || (table && table.status !== 'ended')) setView('table');
      else setView('lobby');
    });
    row.append(button);
    ui.tableList.append(row);
  }
}

function renderBanner() {
  const snap = state.snap;
  const priv = snap.tablePrivate;
  const yourTurn = !!(priv && priv.yourTurn === true);
  ui.banner.hidden = !yourTurn || state.view === 'table';
  if (ui.banner.hidden) return;
  clear(ui.bannerText);
  const gameName = snap.table ? tableTitle(snap.table) : '';
  ui.bannerText.append(document.createTextNode('轮到你' + (gameName ? ' · ' + gameName : '')));
  const deadline = (priv && priv.deadline) || (snap.table && snap.table.deadline);
  if (deadline) {
    ui.bannerText.append(document.createTextNode(' '));
    ui.bannerText.append(clockSpan(deadline, 'clock'));
  }
}

/* —— 中间：牌桌 / 大厅 —— */

function renderCenter() {
  ui.viewTable.hidden = state.view !== 'table';
  ui.viewLobby.hidden = state.view !== 'lobby';
  if (state.view === 'table') {
    renderTableHead();
    renderGame();
  } else {
    ui.tableHead.hidden = true;
    renderLobby();
  }
}

function tableTitle(table) {
  const label = table.label || GAME_LABELS[table.game] || table.game;
  return table.game === 'dice' ? '骰子桌' : label;
}

function namesMap() {  const names = new Map((state.snap.seats || []).map((seat) => [seat.id, seat.name]));
  for (const seat of ((state.snap.table && state.snap.table.seats) || [])) {
    if (!names.has(seat.id)) names.set(seat.id, seat.name);
  }
  return names;
}

function renderTableHead() {
  const host = ui.tableHead;
  clear(host);
  const table = state.snap.table;
  const active = !!table && (table.status === 'bidding' || table.status === 'playing');
  host.hidden = !active;
  if (!active) {
    ui.timer = null;
    ui.timerText = null;
    return;
  }
  const head = el('div', 'table-head');
  const left = el('div', 'game-id');
  const iconBox = el('span', 'game-icon');
  iconBox.append(icon(table.game === 'dice' ? 'dice' : table.game === 'ddz' ? 'cards' : 'board'));
  const copy = el('div');
  copy.append(el('h1', '', tableTitle(table)));
  const parts = [];
  parts.push(STATUS_LABELS[table.status] || table.status);
  const seatCount = (table.seats || []).length;
  if (seatCount) parts.push(seatCount + ' 人');
  if (table.stake) parts.push('每局 ' + table.stake);
  if (table.game === 'monopoly' && table.round) parts.push('第 ' + table.round + '/' + (table.rounds || 12) + ' 轮');
  if (table.game === 'ddz' && table.multiplier) parts.push('倍数 x' + table.multiplier);
  copy.append(el('p', '', parts.join(' · ')));
  left.append(iconBox, copy);

  const priv = state.snap.tablePrivate;
  const myTurn = !!(priv && priv.yourTurn === true);
  const names = namesMap();
  const turnBox = el('div', 'turn-box');
  const turnCopy = el('div', 'turn-copy');
  turnCopy.append(el('span', 'turn-kicker', myTurn ? '轮到你' : '轮到'));
  turnCopy.append(el('span', 'turn-name', myTurn ? state.snap.seat.name : (table.turn ? names.get(table.turn) || '？' : '—')));
  turnBox.append(turnCopy);

  const deadline = table.deadline || (priv && priv.deadline) || 0;
  const timer = el('div', 'timer');
  const timerText = el('span', '', '—');
  timer.append(timerText);
  if (deadline) {
    // 一回合有多长，服务器没有单独给；第一次见到这个截止时刻时按剩余秒数记总长。
    // 骰子约 45 秒、斗地主 30/60 秒、大富翁 5/30 分钟，都能落在同一个环上。
    const key = table.game + ':' + deadline;
    if (state.timerKey !== key) {
      state.timerKey = key;
      state.timerTotal = Math.max(10, Math.ceil((deadline - serverNow()) / 1000));
    }
    timer.dataset.deadline = String(deadline);
    timer.dataset.total = String(state.timerTotal);
  } else {
    timer.classList.add('is-off');
  }
  turnBox.append(timer);
  head.append(left, turnBox);
  host.append(head);
  ui.timer = timer;
  ui.timerText = timerText;
  updateTimer();
}

function renderGame() {
  const table = state.snap.table;
  const active = !!table && (table.status === 'bidding' || table.status === 'playing');
  if (!active) {
    disposeGame();
    renderTableIdle();
    renderTicker();
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
    const ctx = {
      me: state.snap.seat,
      act,
      toast: showToast,
      serverNow,
      showLobby: () => setView('lobby'),
    };
    state.mounted = { game: table.game, instance: factory(root, ctx) };
  }
  state.mounted.instance.update(makeView());
  renderTicker();
}

function makeView() {
  const snap = state.snap;
  const names = namesMap();
  const classes = new Map();
  (snap.seats || []).forEach((seat, index) => classes.set(seat.id, playerClass(index)));
  ((snap.table && snap.table.seats) || []).forEach((seat, index) => {
    if (!classes.has(seat.id)) classes.set(seat.id, playerClass(index));
  });
  return {
    table: snap.table,
    priv: snap.tablePrivate,
    me: snap.seat,
    seats: snap.seats,
    names,
    classes,
    online: snap.online || [],
    now: serverNow(),
    recent: state.log
      .filter((event) => event.type !== 'parlor.table.turn'
        && (String(event.type || '').startsWith('parlor.table.') || String(event.type || '').startsWith('parlor.monopoly.')))
      .slice(-4),
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

function renderTicker() {
  const table = state.snap.table;
  const active = !!table && (table.status === 'bidding' || table.status === 'playing');
  clear(ui.ticker);
  clear(ui.mobileTicker);
  if (!active) {
    ui.ticker.hidden = true;
    ui.mobileTicker.hidden = true;
    return;
  }
  const recent = state.log
    .filter((event) => event.type !== 'parlor.table.turn' && event.type !== 'parlor.digest'
      && (String(event.type || '').startsWith('parlor.table.')
        || String(event.type || '').startsWith('parlor.monopoly.')))
    .slice(-3)
    .reverse();
  ui.ticker.hidden = false;
  ui.mobileTicker.hidden = false;
  const label = el('span', 'ticker-label');
  label.append(icon('clock'), document.createTextNode('牌桌动态'));
  const items = el('div', 'ticker-items');
  for (const event of recent) items.append(el('span', '', readable(event.text || '')));
  if (!recent.length) items.append(el('span', '', '还没有动作。'));
  ui.ticker.append(label, items);
  ui.mobileTicker.append(el('span', 'live-dot'), el('span', '', recent[0] ? readable(recent[0].text || '') : '还没有动作。'));
}

function renderTableIdle() {
  clear(ui.game);
  const snap = state.snap;
  const signup = snap.monopoly && snap.monopoly.signup;
  const fault = snap.monopoly && snap.monopoly.fault;
  const table = snap.table;
  const panel = el('section', 'panel wait-card');
  if (fault) panel.append(el('p', 'warn', '大富翁故障：' + fault));
  if (!signup && !table) {
    panel.append(el('h2', '', '灯还亮着。'));
    panel.append(el('p', 'muted', '现在没有牌桌。开一张，或者等她开。'));
    panel.append(openButtons());
  }
  if (signup) {
    panel.append(signupCard(signup, { tableActive: !!(table && table.status !== 'ended') }));
    if (!table) {
      panel.append(el('p', 'dim', '等报名的时候也可以先打别的：'));
      panel.append(openButtons({ monopoly: false }));
    }
  }
  if (table) panel.append(openTableCard(table, { allowMonopoly: !signup }));
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
    actions.append(btn('报名', () => actAndGo({ type: 'monopoly', action: 'join' }), { primary: true }));
  } else if (!host) {
    actions.append(btn('退出报名', () => actAndGo({ type: 'monopoly', action: 'leave' })));
  }
  if (host) {
    const canStart = signup.seats.length >= 2 && signup.missing === 0 && !options.tableActive;
    actions.append(btn('开局', () => actAndGo({ type: 'monopoly', action: 'start' }), {
      primary: true,
      disabled: !canStart,
      title: options.tableActive ? '现在还有一张没结束的桌子' : canStart ? '' : '至少两个真人报名，空位最多补 2 个脚本',
    }));
    actions.append(btn('取消报名', () => actAndGo({ type: 'monopoly', action: 'cancel' }), { danger: true }));
  }
  if (actions.children.length) box.append(actions);
  else box.append(el('p', 'muted', '等发起人开局。'));
  return box;
}

function openTableCard(table, options = {}) {
  const me = state.snap.seat;
  const names = namesMap();
  const box = el('div', 'open-table');
  box.append(el('h3', '', tableTitle(table) + ' · ' + (STATUS_LABELS[table.status] || table.status)));
  if (table.status === 'ended') {
    box.append(el('p', 'muted', readable(table.text || '这局结束了。')));
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
    actions.append(btn('坐下', () => actAndGo({ type: 'table_join' }), { primary: true }));
  } else if (host) {
    const count = (table.seats || []).length;
    const enough = table.game === 'ddz' || count >= 2;
    actions.append(btn('开始', () => actAndGo({ type: 'table_start' }), {
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
  row.append(btn('开骰子桌', () => actAndGo({ type: 'table_open', game: 'dice' })));
  row.append(btn('开斗地主桌', () => actAndGo({ type: 'table_open', game: 'ddz' })));
  box.append(row);

  if (options.monopoly === false) return box;
  const mono = el('div', 'actions');
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
  mono.append(size, pace, btn('开大富翁报名', () => actAndGo({
    type: 'monopoly',
    action: 'open',
    size: Number(size.value),
    pace: pace.value,
  })));
  box.append(mono);
  box.append(el('p', 'dim', '大富翁至少要两个真人报名；空位最多补 2 个脚本。'));
  return box;
}

function renderLobby() {
  const snap = state.snap;
  const table = snap.table;
  const signup = snap.monopoly && snap.monopoly.signup;
  const seated = snap.seats.filter((seat) => seat.kind !== 'observer').length;
  const tables = (table && table.status !== 'ended' ? 1 : 0) + (signup ? 1 : 0);
  ui.lobbyEyebrow.textContent = '今晚 · ' + fmtClock(serverNow()).slice(0, 5) + ' · 服务器时间';
  ui.lobbyTitle.textContent = tables > 0 ? '灯还亮着。' : '客厅还没开桌。';
  ui.lobbySub.textContent = tables > 0
    ? tables + ' 张桌，' + seated + ' 个人。想玩哪一桌？'
    : seated + ' 个人在客厅。想开一桌吗？';

  clear(ui.gameGrid);
  const current = table && table.status !== 'ended' ? table.game : null;
  const lead = current || (signup ? 'monopoly' : null);
  const games = ['dice', 'ddz', 'monopoly'];
  if (lead) games.sort((left, right) => (left === lead ? -1 : right === lead ? 1 : 0));
  for (const game of games) ui.gameGrid.append(lobbyCard(game));
  renderMembers();
}

function lobbyCard(game) {
  const snap = state.snap;
  const table = snap.table;
  const signup = snap.monopoly && snap.monopoly.signup;
  const mine = table && table.game === game && table.status !== 'ended';
  const ended = table && table.game === game && table.status === 'ended';
  const card = el('article', 'game-card' + (mine ? ' game-card-live' : ''));
  const art = el('div', 'game-card-art art-' + (game === 'dice' ? 'dice' : game === 'ddz' ? 'cards' : 'board'));
  art.append(gameArt(game));
  const body = el('div', 'game-card-body');
  const kicker = el('div', 'game-card-kicker');
  let pill;
  let statusText;
  if (mine) {
    statusText = STATUS_LABELS[table.status] || table.status;
    pill = el('span', 'status-pill live');
    pill.append(el('span', 'live-dot'), document.createTextNode(statusText));
  } else if (game === 'monopoly' && signup) {
    statusText = '报名中';
    pill = el('span', 'status-pill warm', statusText);
  } else if (ended) {
    statusText = '已结束';
    pill = el('span', 'status-pill quiet', statusText);
  } else if (table && table.status !== 'ended') {
    statusText = '另一桌进行中';
    pill = el('span', 'status-pill quiet', statusText);
  } else {
    statusText = '可开桌';
    pill = el('span', 'status-pill quiet', statusText);
  }
  kicker.append(pill);
  if (mine) kicker.append(el('span', 'muted', (table.seats || []).length + ' 人'));
  body.append(kicker);
  body.append(el('h2', '', GAME_LABELS[game]));
  let sub;
  if (game === 'dice') sub = '每人两颗暗骰，重掷或停牌，合计最高者赢。';
  else if (game === 'ddz') sub = '三个人也能打，空位由脚本陪练补。';
  else sub = signup
    ? signup.seats.length + '/' + signup.size + ' 人已报名，还差 ' + signup.missing + ' 个真人。'
    : '24 格外圈棋盘，买地、升级、补道具。';
  body.append(el('p', '', sub));

  const foot = el('div', 'game-card-foot');
  if (mine) {
    const avatars = el('div', 'mini-avatars');
    for (const seat of (table.seats || []).slice(0, 4)) avatars.append(avatarNode(seat.id, 'avatar-xs', { online: false }));
    foot.append(avatars);
    const go = btn('看牌桌', () => setView('table'), { primary: true, small: true });
    go.append(icon('arrow'));
    foot.append(go);
  } else if (game === 'monopoly' && signup) {
    foot.append(el('span', 'muted', signup.host + ' 发起'));
    foot.append(btn('去牌桌', () => setView('table'), { small: true }));
  } else if (ended) {
    foot.append(el('span', 'muted', '结果还留着'));
    foot.append(btn('看结果', () => setView('table'), { small: true }));
  } else if (table && table.status !== 'ended') {
    foot.append(el('span', 'muted', '先打完那桌'));
    foot.append(btn('看那桌', () => setView('table'), { small: true }));
  } else if (game === 'monopoly') {
    const form = el('div', 'row');
    const size = el('select');
    size.setAttribute('aria-label', '大富翁人数');
    for (const value of [4, 6]) {
      const option = el('option', '', value + ' 人');
      option.value = String(value);
      size.append(option);
    }
    const pace = el('select');
    pace.setAttribute('aria-label', '大富翁节奏');
    for (const [value, label] of [['standard', '30 分钟/回合'], ['quick', '试玩 5 分钟/回合']]) {
      const option = el('option', '', label);
      option.value = value;
      pace.append(option);
    }
    form.append(size, pace);
    foot.append(form);
    foot.append(btn('开报名', () => actAndGo({
      type: 'monopoly',
      action: 'open',
      size: Number(size.value),
      pace: pace.value,
    }), { small: true }));
  } else {
    foot.append(el('span', 'muted', game === 'dice' ? '两个人就能开' : '不够人时脚本补位'));
    foot.append(btn('开一桌', () => actAndGo({ type: 'table_open', game }), { small: true }));
  }
  body.append(foot);
  card.append(art, body);
  return card;
}

function gameArt(game) {
  if (game === 'dice') {
    const table = el('div', 'mini-table');
    table.append(el('span', 'mini-seat mini-seat-a'), el('span', 'mini-seat mini-seat-b'), el('span', 'mini-seat mini-seat-c'));
    const dice = el('div', 'mini-dice');
    for (const face of [5, 3, 6]) {
      const die = el('i');
      die.dataset.face = String(face);
      dice.append(die);
    }
    const chips = el('div', 'mini-chips');
    chips.append(el('i'), el('i'), el('i'));
    table.append(dice, chips);
    return table;
  }
  if (game === 'ddz') {
    const wrap = document.createDocumentFragment();
    wrap.append(el('div', 'mini-card mini-card-back'));
    const face = el('div', 'mini-card mini-card-face');
    face.append(el('span', 'suit red', '♥'), el('b', '', 'A'));
    wrap.append(face);
    const second = el('div', 'mini-card mini-card-face second');
    second.append(el('span', 'suit black', '♠'), el('b', '', 'K'));
    wrap.append(second);
    return wrap;
  }
  const board = el('div', 'mini-board');
  for (const cls of ['p-a', 'p-b', 'p-c', 'p-d', 'p-e', 'p-f', 'p-g', 'p-h']) {
    board.append(el('i', 'prop ' + cls));
  }
  board.append(el('span', 'board-pawn'));
  return board;
}

function renderMembers() {
  const snap = state.snap;
  const online = snap.online || [];
  const tableIds = tableSeatIds();
  clear(ui.memberRow);
  const active = snap.seats.filter((seat) => seat.kind !== 'observer');
  const coos = active.filter((seat) => seat.kind === 'pet');
  ui.membersCount.textContent = active.length + ' 人在座' + (coos.length ? ' · ' + coos.length + ' 位 Coo' : '');
  for (const seat of snap.seats) {
    const chip = el('span', 'member-chip');
    chip.append(avatarNode(seat.id, 'avatar-xs'));
    const copy = el('span');
    const name = el('strong', '', seat.name + (seat.id === snap.seat.id ? '（你）' : ''));
    const small = el('small');
    const isOnline = online.includes(seat.id);
    if (isOnline) small.append(el('span', 'live-dot'));
    small.append(document.createTextNode(
      (isOnline ? '在线' : '离线') + (tableIds.has(seat.id) ? ' · 在牌桌' : '')
      + (seat.kind === 'observer' ? ' · 观看' : ''),
    ));
    copy.append(name, small);
    chip.append(copy);
    if (seat.kind === 'pet') chip.append(el('span', 'tag tag-coo', 'Coo'));
    if (seat.id === snap.seat.id) chip.append(el('span', 'tag tag-you', '你'));
    ui.memberRow.append(chip);
  }
}

/* —— 聊天 —— */

function renderChat() {
  renderChatBadges();
  syncChatTabs();
  const tab = state.tab;
  ui.composer.hidden = tab === 'mail';
  ui.mailNote.hidden = tab !== 'mail';
  ui.markRead.hidden = tab !== 'mail' || ((state.snap && state.snap.mailUnread) || 0) <= 0;
  if (tab === 'room') {
    ui.scopeText.textContent = '发到客厅 · 房间里的人都看得见';
    ui.sayInput.placeholder = '在客厅说点什么…';
  } else if (tab === 'table') {
    ui.scopeText.textContent = '牌桌 tab 只是过滤 · 发送仍到客厅，客厅也看得见；真私聊在 0.12.0';
    ui.sayInput.placeholder = '在客厅说点什么…（牌桌 tab 只过滤）';
  }
}

function syncChatTabs() {
  for (const [key, tab] of [['room', ui.tabRoom], ['table', ui.tabTable], ['mail', ui.tabMail]]) {
    const active = state.tab === key;
    tab.btn.classList.toggle('is-active', active);
    tab.btn.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  ui.logRoom.hidden = state.tab !== 'room';
  ui.logTable.hidden = state.tab !== 'table';
  ui.mailList.hidden = state.tab !== 'mail';
}

function renderChatBadges() {
  const mailUnread = (state.snap && state.snap.mailUnread) || 0;
  const counts = {
    room: state.unread.room,
    table: state.unread.table,
    mail: mailUnread,
  };
  ui.tabRoom.badge.textContent = String(counts.room);
  ui.tabRoom.badge.hidden = counts.room <= 0;
  ui.tabTable.badge.textContent = String(counts.table);
  ui.tabTable.badge.hidden = counts.table <= 0;
  ui.tabMail.badge.textContent = String(counts.mail);
  ui.tabMail.badge.hidden = counts.mail <= 0;
  const chatCount = counts.room + counts.table;
  ui.navChat.badge.textContent = String(chatCount);
  ui.navChat.badge.hidden = chatCount <= 0;
  ui.navMail.badge.textContent = String(counts.mail);
  ui.navMail.badge.hidden = counts.mail <= 0;
  if (ui.mailBadge) {
    ui.mailBadge.textContent = String(counts.mail);
    ui.mailBadge.hidden = counts.mail <= 0;
  }
}

function setTab(tab) {
  state.tab = tab;
  state.unread[tab] = 0;
  syncChatTabs();
  renderChat();
  if (tab === 'room') ui.logRoom.scrollTop = ui.logRoom.scrollHeight;
  if (tab === 'table') ui.logTable.scrollTop = ui.logTable.scrollHeight;
  if (tab === 'mail') loadMail();
  syncNav();
}

function setView(view) {
  state.view = view;
  syncViewButtons();
  closeSheet();
  render();
}

function syncViewButtons() {
  for (const node of (ui.viewButtons || [])) {
    const active = node.dataset.view === state.view;
    node.classList.toggle('is-active', active);
    node.setAttribute('aria-selected', active ? 'true' : 'false');
  }
}

function syncNav() {
  let active = null;
  if (state.sheet === 'me') active = 'me';
  else if (state.sheet === 'chat') active = state.tab === 'mail' ? 'mail' : 'chat';
  else if (state.view === 'table') active = 'table';
  for (const [key, node] of [['table', ui.navTable], ['chat', ui.navChat], ['mail', ui.navMail], ['me', ui.navMe]]) {
    node.btn.classList.toggle('is-active', key === active);
  }
}

async function loadMail(force = false) {
  if (state.mailLoading) return;
  if (state.mail && !force && Date.now() - state.mail.at < 15000) return;
  state.mailLoading = true;
  renderMail();
  try {
    // recent=1 是只读的最近几封（含已读），信箱 tab 用它；peek=1 只取未读，会把读过的信藏起来。
    const page = await api('/v1/mail?recent=1&limit=12');
    state.mail = { items: page.items || [], unread: page.unread || 0, at: Date.now() };
    state.mail.error = null;
  } catch (error) {
    state.mail = { items: [], unread: 0, at: Date.now(), error: error.message || '取不到信箱' };
  } finally {
    state.mailLoading = false;
    renderMail();
  }
}

function renderMail() {
  clear(ui.mailList);
  const mail = state.mail;
  if (!mail) {
    ui.mailList.append(el('p', 'chat-empty', '正在取信箱…'));
    return;
  }
  if (mail.error) {
    ui.mailList.append(el('p', 'chat-empty bad', mail.error));
    return;
  }
  if (!mail.items.length) {
    ui.mailList.append(el('p', 'chat-empty', '信箱是空的。'));
    return;
  }
  mail.items.forEach((item, index) => {
    // MailView 不带逐封已读位；peek 返回的是最近的几封，未读数以内的算未读。
    const unread = index < mail.unread;
    const node = el('article', 'mail-item' + (unread ? ' is-unread' : ''));
    node.append(el('span', 'mail-seal' + (item.fromName === '系统' ? ' is-system' : '')));
    const copy = el('div', 'mail-copy');
    const meta = el('div', 'mail-meta');
    meta.append(el('strong', '', item.fromName || '系统'), el('time', '', fmtClock(item.ts).slice(0, 5)));
    copy.append(meta, el('p', '', readable(item.text || '')), el('span', 'mail-sub', '只有你能看'));
    node.append(copy);
    if (unread) node.append(el('span', 'unread-dot'));
    ui.mailList.append(node);
  });
  if (mail.unread > mail.items.length) {
    ui.mailList.append(el('p', 'chat-empty', '还有 ' + (mail.unread - mail.items.length) + ' 封未读。'));
  }
}

async function markMailRead() {
  try {
    await api('/v1/mail?limit=50');
    await refreshSnapshot();
    state.mail = null;
    await loadMail(true);
    render();
    showToast('信箱标成已读了');
  } catch (error) {
    showToast(error.message, 'bad');
  }
}

function openMailTab() {
  if (window.matchMedia('(max-width: 820px)').matches) openSheet('chat');
  setTab('mail');
  if (!window.matchMedia('(max-width: 820px)').matches) {
    ui.chatPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

/* —— 抽屉 —— */

function openSheet(which) {
  state.sheet = which;
  syncSheet();
  if (which === 'chat' && state.tab === 'mail') loadMail();
}

function closeSheet() {
  state.sheet = null;
  syncSheet();
}

function syncSheet() {
  if (!ui.backdrop) return;
  const open = !!state.sheet;
  ui.leftRail.classList.toggle('is-open', state.sheet === 'me');
  ui.chatPanel.classList.toggle('is-open', state.sheet === 'chat');
  ui.backdrop.hidden = !open;
  if (open) requestAnimationFrame(() => ui.backdrop.classList.add('is-show'));
  else ui.backdrop.classList.remove('is-show');
  document.body.classList.toggle('sheet-open', open);
  syncNav();
}

/* —— 说话 / 小工具 —— */

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

function startOfToday() {
  const shifted = new Date(serverNow() + 8 * 3600 * 1000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 8 * 3600 * 1000;
}

function dotClass(game) {
  if (game === 'ddz') return 'dot-cards';
  if (game === 'monopoly') return 'dot-board';
  return 'dot-dice';
}

function renderTableInfo() {
  const snap = state.snap;
  const table = snap.table;
  const signup = snap.monopoly && snap.monopoly.signup;
  const names = namesMap();
  ui.infoGame.textContent = table ? (table.label || GAME_LABELS[table.game] || table.game) : (signup ? '大富翁（报名）' : '—');
  ui.infoStake.textContent = table ? (table.stake ? table.stake + ' 枚' : '不押') : '—';
  ui.infoStatus.textContent = table
    ? (STATUS_LABELS[table.status] || table.status)
    : (signup ? '报名中' : '空闲');
  ui.infoTurn.textContent = table && table.turn ? (names.get(table.turn) || '？') : '—';
  ui.ruleNote.textContent = table
    ? (RULES[table.game] || '')
    : (signup ? '大富翁正在报名；人数够了由发起人开局。' : '现在没有牌桌。开一张，或者等她开。');
  ui.infoClock.textContent = '服务器时刻 ' + fmtClock(serverNow()).slice(0, 5) + '（UTC+8）';
}

/* —— 加入 / 离线 —— */

function renderJoin(message = '') {
  state.shell = false;
  disposeGame();
  clear(app);
  const join = el('div', 'join');
  const panel = el('section', 'panel');
  panel.append(brandNode());
  panel.append(el('h1', '', '客厅 · 下场玩'));
  panel.append(el('p', 'sub', '用自己的席位和 Coo 同桌。你的战绩、筹码和信箱是单独的一份，不会记到她头上。'));

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
  panel.append(nameField, inviteField, error, submit, note);
  join.append(panel);
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
      state.log = [];
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
  const join = el('div', 'join');
  const panel = el('section', 'panel');
  panel.append(brandNode());
  panel.append(el('h1', '', '连不上客厅'));
  panel.append(el('p', 'sub', message || '网络没有通。'));
  const actions = el('div', 'actions');
  actions.append(btn('重试', () => boot(), { primary: true }));
  actions.append(btn('换一个席位', () => {
    clearStore();
    location.reload();
  }, { ghost: true }));
  panel.append(actions);
  join.append(panel);
  app.append(join);
}

/* —— 时钟 —— */

function updateTimer() {
  const node = ui.timer;
  if (!node || !ui.timerText) return;
  const deadline = Number(node.dataset.deadline || 0);
  if (!deadline) return;
  const total = Number(node.dataset.total || 60) || 60;
  const left = Math.max(0, Math.ceil((deadline - serverNow()) / 1000));
  ui.timerText.textContent = String(Math.floor(left / 60)).padStart(2, '0') + ':' + String(left % 60).padStart(2, '0');
  const p = Math.max(0, Math.min(100, (left / total) * 100));
  node.style.setProperty('--p', String(p));
  node.classList.toggle('is-off', left <= 0);
}

setInterval(() => {
  const now = serverNow();
  for (const node of document.querySelectorAll('[data-deadline]')) {
    if (node.classList.contains('timer')) continue;
    const deadline = Number(node.dataset.deadline);
    if (!deadline) {
      node.textContent = '';
      continue;
    }
    const left = fmtLeft(deadline, now);
    node.textContent = left === '已截止' ? '已截止（服务器托管中）' : '还剩 ' + left;
  }
  updateTimer();
}, 500);

setInterval(() => {
  if (ui.infoClock && state.snap) renderTableInfo();
}, 30000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleRefresh();
});
window.addEventListener('focus', () => scheduleRefresh());
