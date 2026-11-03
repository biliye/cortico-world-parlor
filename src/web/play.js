/** 客厅网页客户端：家长自己的席位，和 Coo 同桌玩。
 *  导航为大厅 / 客厅 / 牌桌三层，牌桌与聊天接真实快照和 SSE；
 *  牌桌 tab 发的是桌内私聊（只有同桌看得见），客厅 tab 才是全房间公开。 */
import {
  el, clear, icon, initialOf, fmtClock, fmtDateTime, fmtLeft, clockSpan, btn, playerClass,
  isNearBottom, readable, GAME_LABELS, STATUS_LABELS, KIND_LABELS,
} from './common.js';
import { ENABLED_GAMES, GAMES, gameOf, gameLabel, gameIcon, heroGame } from './games/registry.js?v=0.36.1';
import { createClubState, conversationKey, readRoute, routeUrl } from './club-state.js';
import { createRoomCarousel } from './room-carousel.js';
import { supportLink } from './support-link.js?v=0.36.1';
import { mountAnnouncementBanner } from './announcement-banner.js?v=0.36.1';
import { startAnnouncementWatch } from './announcements.js?v=0.36.1';

const club = createClubState({
  getItem: key => sessionStorage.getItem(key),
  setItem: (key, value) => sessionStorage.setItem(key, value),
});
let draftScope = '';
let hallSection = 'all';
let hallFilter = 'all';
let hallQuery = '';
let roomSwitching = false;
let tableChatScope = '';
let crumbSignature = '';
let sheetFocus = null;

const STORE_KEY = 'parlor-play-v1';
const app = document.getElementById('app');
const toastBox = document.getElementById('toast');

const RULES = {
  dice: '每人两颗暗骰，轮到你可以重掷一颗，或停牌；合计最高者赢。45 秒不动作会自动停牌。',
  ddz: '三人一桌，空位由脚本陪练补；牌型与计分由服务器判。叫地主 30 秒、出牌 60 秒，超时由服务器代打。',
  monopoly: '24 格外圈棋盘，买地、升级、道具与托管都在中间面板；回合超时自动托管。',
};

/** 可开游戏由 games/registry.js 的 enabled 决定。 */

/** 普通客厅固定 30 人；大厅容量由服务器单独管理。 */
const ROOM_CAPACITY = 30;

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
  /** 牌桌增量：一个在途、后续合并成一次；syncEpoch 挡住比回执更旧的响应。 */
  tableTimer: null,
  tableBusy: false,
  tableQueued: false,
  syncEpoch: 0,
  /** 回执已经覆盖到的房间游标：自己动作的回显事件不用再补一次增量。 */
  appliedSeq: 0,
  ledgerTimer: null,
  ledgerBusy: false,
  ledgerQueued: false,
  mounted: null,
  shell: false,
  busy: false,
  view: 'lobby',
  tab: 'table',
  /** 正在看的那张桌（snap.tables 里的 id）；空串 = 我的桌 / 唯一那张。 */
  watchTableId: '',
  unread: { room: 0, table: 0 },
  mail: null,
  mailLoading: false,
  sheet: null,
  hallData: null,
  hallLoading: false,
  /** 服务端是否开放「用户名 + 邀请码」入口；默认按开处理，boot 时问 /healthz。 */
  guestJoin: true,
  globalIdentity: null,
  /** 从 #key= 取到的钥匙；换席位失败时留着给「重试」用，成功就清掉。 */
  entryKey: '',
  dm: { open: false, peer: null, threads: [], people: [], messages: [], unread: 0, q: '', timer: 0, drag: null },
  timerKey: '',
  timerTotal: 0,
};
const ui = {};
const featuredCarousel = createRoomCarousel(renderFeaturedRoom, { paused: window.matchMedia('(prefers-reduced-motion: reduce)').matches });
let toastTimer = 0;
let mailTimer = 0;

/** 首屏的进度：页面还是那张占位卡时换一句话；界面画出来以后这层就没了。 */
const bootClock = { started: Date.now(), base: '正在打开客厅…', timer: 0 };

function note(text) {
  if (text) bootClock.base = text;
  paintNote();
}

function paintNote() {
  const box = document.getElementById('boot-note');
  if (!box) {
    if (bootClock.timer) clearInterval(bootClock.timer);
    bootClock.timer = 0;
    return;
  }
  const secs = Math.floor((Date.now() - bootClock.started) / 1000);
  const slow = secs >= 6 ? ' 网络看起来有点慢，还在等服务器回话。' : '';
  box.textContent = `${bootClock.base}（已等 ${secs} 秒）${slow}`;
}

function startBootClock() {
  bootClock.started = Date.now();
  if (!bootClock.timer) bootClock.timer = setInterval(paintNote, 1000);
  paintNote();
}

function bootFailureText(error) {
  if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return '服务器 25 秒没有回话。网络可能断了，或者客厅那边没起来；点重试再试一次。';
  }
  return error && error.message ? error.message : String(error);
}

boot();   // 牌面图改成第一次画牌时才拉，见 common.js 的 probeCardArt

// 在已经打开的页面地址栏里粘一条新的「我下场玩」链接：hash 变了但页面不会重载，
// 这里主动换一次钥匙，换好再整页重来，免得旧席位的日志和牌桌还挂着。
window.addEventListener('hashchange', async () => {
  const key = takeKeyFromHash();
  if (!key) return;
  if (await tryParentEntry(key, { hadSeat: true })) location.reload();
});

/* —— 起步 —— */

/** 访客入口开没开：/healthz 的 guestJoin；老服务器没这个字段就按开处理。 */
async function loadEntryPolicy() {
  try {
    const response = await fetch('/healthz');
    if (!response.ok) return;
    const body = await response.json();
    if (body && body.guestJoin === false) state.guestJoin = false;
    state.globalIdentity = body.globalIdentity || null;
  } catch { /* 连不上就保持默认；提交时服务器也会拒 */ }
}

async function boot() {
  if (await followLocation()) return;
  startBootClock();
  const identityArgs = new URLSearchParams(location.hash.slice(1));
  if (identityArgs.has('identity')) {
    history.replaceState(null, '', location.pathname + location.search);
    try {
      const pending = JSON.parse(sessionStorage.getItem('parlor-identity-pending') || 'null');
      if (!pending || pending.state !== identityArgs.get('state')) throw new Error('身份连接已失效，请重新加入');
      const body = await api('/v1/global/player/join', { method: 'POST', headers: { 'x-parlor-identity': identityArgs.get('identity') },
        body: JSON.stringify({ invite: pending.invite, room: pending.room || 'hall', parent: pending.parent === true }) });
      sessionStorage.removeItem('parlor-identity-pending');
      writeStore({ room: body.room, seatId: body.seat.id, name: body.seat.name, token: body.token,
        cooId: body.identity.cooId, cooSecret: body.identity.cooSecret });
    } catch (error) { renderOffline(bootFailureText(error)); return; }
  }
  // 带钥匙的「我下场玩」链接：钥匙只用来换会话，换完立刻从地址栏抹掉。
  // 钥匙是明确点开的意图，比这台设备存着的旧席位优先——旧席位可能是另一个家长身份，
  // 也可能早就失效了；先换钥匙，再谈旧席位。
  const key = takeKeyFromHash() || state.entryKey;
  if (key) {
    state.entryKey = key;
    note('正在用链接里的钥匙换席位…');
    if (await tryParentEntry(key, { hadSeat: !!state.cfg })) {
      state.entryKey = '';
    } else if (!state.cfg) {
      // 没有旧席位可退：留在离线页，重试会再用这把钥匙试一次。
      renderOffline('这个链接里的钥匙没换成席位。可能链接过期了，也可能网络没通——回扩展面板重新点一次「我下场玩」，或者点下面的重试。');
      return;
    }
    // 换不到但旧席位还在：继续用旧席位，上面已经提示了原因。
  } else if (!state.cfg && await hasParentSession()) {
    await tryParentEntry('');
  }
  if (!state.cfg) {
    await loadEntryPolicy();
    renderJoin();
    return;
  }
  try {
    note('正在读取客厅状态…');
    await refreshSnapshot();
    state.latest = state.snap.latest;
    const route = readRoute(location.search);
    if (route.room && route.room !== currentRoom()) {
      if (await goRoom(route.room, { replace: true })) return;
    }
    state.watchTableId = route.table;
    normalizeWatch();
    state.view = inHall() ? 'hall' : route.view;
    state.tab = state.view === 'table' && activePrivate() ? 'table' : 'room';
    buildShell();
    writeRoute(true);
    render();
    // 回放补历史；它之后不再补一次快照——SSE 从第一份快照的游标接上，中间漏的会补发。
    await seedLog();
    if (state.view === 'hall') void loadHall(true);
    connect();
    void loadDmThreads();
  } catch (error) {
    if (error && error.status === 401) {
      await handleExpiredSeat(error.seatToken || (state.cfg ? state.cfg.token : ''));
      return;
    }
    renderOffline(bootFailureText(error));
  }
}

/** 从 #key=… 取一次性钥匙；取到就从地址栏抹掉（不进历史，也不会被复制外发）。 */
function takeKeyFromHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return '';
  const key = (new URLSearchParams(raw).get('key') || '').trim();
  if (key) history.replaceState(null, '', location.pathname + location.search);
  return key;
}

async function hasParentSession() {
  try {
    return (await fetch('/v1/parent/me', timeoutSignal())).ok;
  } catch {
    return false;
  }
}

/**
 * 家长入场：钥匙或这台浏览器已有的家长会话，都直接以家长身份下场。
 * 带钥匙时不管这台设备有没有旧席位都先换钥匙——钥匙是点链接的人刚做的选择。
 * 换好以后旧席位的界面状态要清掉，免得还挂着上一个身份的日志与牌桌。
 */
async function tryParentEntry(key = '', options = {}) {
  const before = state.cfg && state.cfg.name;
  try {
    // 带钥匙时一次做完「换会话 + 领席位」：跨境链路上每多一个来回就是两三秒。
    const played = await fetch('/v1/parent/play', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(key ? { key } : {}), ...(options.room ? { room: options.room } : {}) }),
      ...timeoutSignal(),
    });
    const body = await played.json().catch(() => ({}));
    if (!played.ok) throw new Error(body.error || (key ? '这个家长链接不对，或已经失效了' : '现在下不了场'));
    if (body.globalEntry) { beginGlobalEntry(body.globalEntry, { room: body.room, parent: true }); return true; }
    if (options.hadSeat) {
      state.latest = 0;
      state.appliedSeq = 0;
      state.seen = new Set();
      state.log = [];
      state.snap = null;
      state.watchTableId = '';
    }
    writeStore({
      room: body.room,
      seatId: body.seat.id,
      name: body.seat.name,
      token: body.token,
      cooId: body.identity.cooId,
      cooSecret: body.identity.cooSecret,
    });
    if (options.hadSeat && before && before !== body.seat.name) {
      showToast(`这台设备原来在「${before}」的席位上，已经换成「${body.seat.name}」。`);
    }
    return true;
  } catch (error) {
    showToast(bootFailureText(error), 'bad');
    return false;
  }
}

/**
 * 席位令牌失效（401）要分两种：
 * - 存着的令牌就是刚失败的那一个：真的失效了，清掉、回加入页；
 * - 存着的已经换了（另一个标签页换过客厅/换过席位）：这个标签页只是旧了，
 *   重新读一次就好——不能把别的标签页刚写进去的新令牌一起删掉，否则看起来像「被登出」。
 */
async function handleExpiredSeat(token) {
  const stored = readStore();
  if (stored && token && stored.token !== token) {
    // 本页刚换好席位，迟到的旧请求不能清掉新令牌，也不用重载旧地址。
    if (state.cfg && state.cfg.token === stored.token) return;
    location.reload();
    return;
  }
  // 本来就在加入页（没有席位）：这不是「令牌失效」，重画会把正在填的名字冲掉。
  if (!stored && !state.cfg) return;
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
  clearStore();
  await loadEntryPolicy();
  if (await hasParentSession()) {
    renderJoin('这台设备上的席位已经失效（可能被另一台设备顶掉了）。点下面的「以家长身份下场」重新进来。');
  } else {
    renderJoin('这个席位的令牌已经失效，请重新加入。');
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

/** 当前客厅；旧存档没有这一格时回落到默认客厅的 /v1/... 别名。 */
function currentRoom() {
  return (state.cfg && state.cfg.room) || '';
}

function inHall() {
  return (state.snap && state.snap.id === 'hall') || currentRoom() === 'hall';
}

/** 单客厅接口改走 /v1/rooms/:id/...；信箱顺带取全局（跨厅邀请在里面）。 */
function roomPath(path) {
  const room = currentRoom();
  if (!room) return path;
  const [base, query] = path.split('?');
  const match = /^\/v1\/(room|table|action|mail|replay|history|stream)$/.exec(base);
  if (!match) return path;
  let q = query || '';
  if (match[1] === 'mail' && !/(^|&)all=/.test(q)) q = q ? q + '&all=1' : 'all=1';
  return '/v1/rooms/' + encodeURIComponent(room) + '/' + match[1] + (q ? '?' + q : '');
}

function hasLiveTable() {
  const table = state.snap && state.snap.table;
  return !!table && (table.status === 'bidding' || table.status === 'playing');
}

/** 一张桌（或一份私视图）的 id：新服务器 id 与 tableId 都给，老数据可能都没有。 */
function tableIdOf(table) {
  if (!table) return '';
  if (typeof table.tableId === 'string' && table.tableId) return table.tableId;
  if (typeof table.id === 'string' && table.id) return table.id;
  return '';
}

/** 快照里的桌列表；老服务器没有 tables 时退回单桌快照。 */
function tableList() {
  const snap = state.snap;
  if (!snap) return [];
  if (Array.isArray(snap.tables) && snap.tables.length) return snap.tables;
  return snap.table ? [snap.table] : [];
}

/** watchTableId 指向的那张桌；桌子没了就是 null。 */
function watchedTable() {
  if (!state.watchTableId) return null;
  return tableList().find((table) => tableIdOf(table) === state.watchTableId) || null;
}

/** 现在该画的那张桌：看着的那张，否则服务器给的「我的桌 / 唯一那张」。 */
function activeTable() {
  return watchedTable() || (state.snap && state.snap.table) || null;
}

/** 我的桌：服务器只在我坐在桌上时给 tablePrivate。 */
function myTable() {
  const snap = state.snap;
  const priv = snap && snap.tablePrivate;
  if (!priv) return null;
  const id = tableIdOf(priv);
  if (id) {
    const found = tableList().find((table) => tableIdOf(table) === id);
    if (found) return found;
  }
  return snap.table || null;
}

function myTableId() {
  return tableIdOf(myTable()) || tableIdOf(state.snap && state.snap.tablePrivate);
}

/** 只有看着自己那张桌时才带私视图；看别人的桌子就当旁观者。 */
function activePrivate() {
  const snap = state.snap;
  const priv = snap && snap.tablePrivate;
  if (!priv) return null;
  const table = activeTable();
  if (!table) return null;
  const privId = tableIdOf(priv);
  const mine = privId
    ? tableIdOf(table) === privId
    : tableIdOf(table) === tableIdOf(snap.table);
  return mine ? priv : null;
}

/** 点回自己的桌：watchTableId 清空 = 跟随服务器的「我的桌」。 */
function watchMine() {
  state.watchTableId = '';
}

/** 看过的那张桌从快照里消失（被收掉、超出「最近结束」保留）就回默认桌。 */
function normalizeWatch() {
  if (!state.watchTableId) return;
  if (!tableList().some((table) => tableIdOf(table) === state.watchTableId)) {
    state.watchTableId = '';
  }
}

/**
 * 现在能不能「只对同桌说」：我的桌子还在（没散）而且我就坐在这桌上。
 * 不在桌上时输入框是停用的——宁可让人切到客厅，也不把以为是私密的话发成全房间可见。
 * 看别的桌不改变这一点：桌上的话永远发回我自己的那张桌。
 */
function tableChatOpen() {
  const table = myTable();
  if (!table || table.status === 'ended') return false;
  if (tableIdOf(activeTable()) !== tableIdOf(table)) return false;
  if (table.game === 'werewolf' && table.status !== 'open') return false;
  const me = state.snap.seat && state.snap.seat.id;
  return (table.seats || []).some((seat) => seat && seat.id === me);
}

/* —— 网络 —— */

/** 普通接口 25 秒没回话就当超时；首屏卡住时能自己走到「重试」，而不是一直转。 */
function timeoutSignal(existing) {
  if (existing) return { signal: existing };
  if (typeof AbortSignal === 'undefined' || !AbortSignal.timeout) return {};
  return { signal: AbortSignal.timeout(25_000) };
}

async function api(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (state.cfg) {
    headers.set('authorization', 'Bearer ' + state.cfg.token);
    if (state.cfg.cooSecret !== 'seat-only') {
      headers.set('x-parlor-coo', state.cfg.cooId);
      headers.set('x-parlor-coo-secret', state.cfg.cooSecret);
    }
  }
  const response = await fetch(roomPath(path), { ...init, headers, ...timeoutSignal(init.signal) });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = new Error((body && body.error) || ('请求失败（' + response.status + '）'));
    error.status = response.status;
    error.seatToken = (headers.get('authorization') || '').replace(/^Bearer /, '');
    throw error;
  }
  return body;
}

async function refreshSnapshot() {
  const snapshot = await api('/v1/room?limit=1');
  state.snap = snapshot;
  state.offset = snapshot.now - Date.now();
  normalizeWatch();
}

function scheduleRefresh(delay = 120) {
  // 加入页还没有席位：没有可刷的东西，而未带令牌的刷新会 401、把整块表单重画掉。
  if (!state.cfg) return;
  if (state.refreshTimer) return;
  state.refreshTimer = setTimeout(async () => {
    state.refreshTimer = null;
    try {
      await refreshSnapshot();
      render();
    } catch (error) {
      if (error && error.status === 401) {
        void handleExpiredSeat(error.seatToken || (state.cfg ? state.cfg.token : ''));
      }
    }
  }, delay);
}

/**
 * 大厅的「谁在线」用一份单独的目录数据。它比整份快照还贵（还带客厅列表），
 * 所以加入/离开的高峰期只允许 1.2 秒刷一次：300 个人同时点链接时，
 * 不能让每个浏览器对每条 joined 都打一次 /v1/hall。
 */
function scheduleHallRefresh() {
  if (!state.cfg || state.hallTimer) return;
  state.hallTimer = setTimeout(() => {
    state.hallTimer = null;
    void loadHall(true);
  }, 1200);
}

/* —— 牌桌增量：自己的回执直接用，别人的事件只补当前桌 —— */

/**
 * 迟到的桌视图不能盖掉更新的一版：同一张桌按 revision 比，不同桌各管各的。
 * 表与私视图都带 revision；老服务器没有就按「可以替换」处理。
 */
function newerTable(incoming, current) {
  if (!incoming) return false;
  if (!current) return true;
  const nextId = tableIdOf(incoming);
  const haveId = tableIdOf(current);
  if (nextId && haveId && nextId !== haveId) return true;
  const next = typeof incoming.revision === 'number' ? incoming.revision : 0;
  const have = typeof current.revision === 'number' ? current.revision : 0;
  return next >= have;
}

/** 桌列表里换掉同一张桌（没有就补上）；别的行不碰。 */
function patchTableEntry(table) {
  const snap = state.snap;
  if (!snap || !table) return;
  const id = tableIdOf(table);
  if (!id) {
    snap.table = table;
    return;
  }
  if (!Array.isArray(snap.tables)) snap.tables = [];
  const index = snap.tables.findIndex((entry) => tableIdOf(entry) === id);
  if (index < 0) snap.tables.push(table);
  else if (newerTable(table, snap.tables[index])) snap.tables[index] = table;
}

/**
 * 把一份增量贴进本地快照：tables 是服务器给的整份桌列表（只在内存里算，不查库），
 * table 是「我的桌」，tablePrivate 是「我的私视图」。返回动没动，动过才重画。
 */
function applyTablePatch(patch) {
  const snap = state.snap;
  if (!snap || !patch) return false;
  let touched = false;
  if (Array.isArray(patch.tables)) {
    snap.tables = patch.tables;
    touched = true;
  }
  if ('table' in patch) {
    const next = patch.table || null;
    if (!next) {
      // 服务器说「你的桌没了」才清；in-flight 的旧响应由 syncEpoch 提前挡掉。
      if (snap.table) {
        snap.table = null;
        touched = true;
      }
    } else if (newerTable(next, snap.table)) {
      snap.table = next;
      touched = true;
    }
    if (next) patchTableEntry(next);
  }
  if ('tablePrivate' in patch) {
    const next = patch.tablePrivate || null;
    if (next ? newerTable(next, snap.tablePrivate) : true) {
      if (snap.tablePrivate !== next) touched = true;
      snap.tablePrivate = next;
    }
  }
  if (touched) normalizeWatch();
  return touched;
}

/** 只重画跟着牌桌变的那几块；聊天记录、席位名单与信箱不归它管。 */
function renderTableParts() {
  if (!state.shell || !state.snap) return;
  renderTopbar();
  renderSeatCard();
  renderLedger();
  renderTablesRail();
  renderBanner();
  renderChat();
  renderTableInfo();
  if (state.view === 'table') {
    renderTableHead();
    renderGame();
  }
  if (state.view === 'lobby') renderLobby();
  renderClubNav();
  document.title = (state.snap.tablePrivate && state.snap.tablePrivate.yourTurn ? '轮到你 · 鲸语会馆' : '鲸语会馆 · 一起玩');
}

/** 一个在途、后续请求合并成一次；期间有回执落地就丢掉这份旧的。 */
async function refreshTable() {
  if (!state.cfg || !state.snap) return;
  // 自己的动作：事件常常比 POST 的回执先到（SSE 是另一条连接）。回执落地后
  // 本地状态已经覆盖到最新游标，这一趟就不用跑了。
  if (state.appliedSeq > 0 && state.appliedSeq >= state.latest) return;
  if (state.tableBusy) {
    state.tableQueued = true;
    return;
  }
  state.tableBusy = true;
  try {
    const epoch = state.syncEpoch;
    const slice = await api('/v1/table');
    if (epoch !== state.syncEpoch) return;
    if (applyTablePatch(slice)) renderTableParts();
  } catch (error) {
    if (error && error.status === 401) {
      void handleExpiredSeat(error.seatToken || (state.cfg ? state.cfg.token : ''));
      return;
    }
    // 老服务器没有桌接口、或网络抖了一下：退回整份快照重新同步。
    scheduleRefresh(0);
  } finally {
    state.tableBusy = false;
    if (state.tableQueued) {
      state.tableQueued = false;
      scheduleTableRefresh(0);
    }
  }
}

function scheduleTableRefresh(delay = 120) {
  if (!state.cfg) return;
  if (state.tableTimer) return;
  state.tableTimer = setTimeout(() => {
    state.tableTimer = null;
    void refreshTable();
  }, delay);
}

/** 筹码只在开局押注、结算、礼物这几处变；单独取一次账本，不拖整份快照。 */
async function refreshLedger() {
  if (!state.cfg || !state.snap) return;
  if (state.ledgerBusy) {
    state.ledgerQueued = true;
    return;
  }
  state.ledgerBusy = true;
  try {
    const body = await api('/v1/me/ledger');
    if (body && body.ledger) {
      state.snap.ledger = body.ledger;
      renderTopbar();
      renderSeatCard();
      renderLedger();
    }
  } catch { /* 拿不到就等下一次整份快照 */ } finally {
    state.ledgerBusy = false;
    if (state.ledgerQueued) {
      state.ledgerQueued = false;
      scheduleLedgerRefresh(0);
    }
  }
}

function scheduleLedgerRefresh(delay = 200) {
  if (!state.cfg) return;
  if (state.ledgerTimer) return;
  state.ledgerTimer = setTimeout(() => {
    state.ledgerTimer = null;
    void refreshLedger();
  }, delay);
}

/** 账本变化才动筹码的地方：牌局结算、作废退款。 */
function touchesLedger(type) {
  return type === 'parlor.table.end' || type === 'parlor.table.cancel';
}

/** 服务器按 requestId 去重的动作：网络掉线时可以原样重发一次。 */
const IDEMPOTENT_ACTIONS = new Set([
  'table_open', 'table_join', 'table_leave', 'table_start', 'table_action', 'ddz_action', 'werewolf_action', 'monopoly',
]);

/** 幂等键：优先 crypto.randomUUID；老浏览器退回 getRandomValues 拼一个 v4。 */
function newRequestId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* 有些环境下 randomUUID 不可调用 */ }
  const bytes = new Uint8Array(16);
  let filled = false;
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(bytes);
      filled = true;
    }
  } catch { /* 下面用 Math.random 兜底 */ }
  if (!filled) {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-'
    + hex.slice(16, 20) + '-' + hex.slice(20);
}

/**
 * 牌桌动作只写「做什么」；「对哪张桌、基于哪一版」在这里补。
 * 游戏渲染器不传桌号：动作永远打回我自己那张桌（看别人的桌时也一样）。
 */
function withTableFields(body) {
  if (!body || typeof body !== 'object') return body;
  const out = { ...body };
  const type = typeof out.type === 'string' ? out.type : '';
  if (type === 'table_open') return out;
  if (type === 'table_join') {
    if (!out.table) {
      const target = activeTable();
      if (target) out.table = tableIdOf(target);
    }
    return out;
  }
  if (!type.startsWith('table_') && type !== 'ddz_action' && type !== 'werewolf_action') return out;
  const mine = myTableId();
  if (mine && !out.table) out.table = mine;
  if (type === 'table_action' || type === 'ddz_action') {
    const revision = state.snap && state.snap.tablePrivate && state.snap.tablePrivate.revision;
    if (typeof revision === 'number' && out.revision === undefined) out.revision = revision;
  }
  return out;
}

/** 网络没送到（fetch 抛 TypeError）；HTTP 错误是服务器已经答了，不算。 */
function isNetworkError(error) {
  return !!error && (error instanceof TypeError || error.name === 'TypeError');
}

async function act(body) {
  if (state.busy) {
    showToast('上一操作正在处理，这次尚未发送，请稍后重试。', 'bad');
    return null;
  }
  state.busy = true;
  try {
    const payload = withTableFields(body) || {};
    const retryable = IDEMPOTENT_ACTIONS.has(payload.type);
    if (retryable) payload.requestId = newRequestId();
    const send = () => api('/v1/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let receipt;
    try {
      receipt = await send();
    } catch (error) {
      // 只重发「可能没到服务器」的那一次；重发用同一个 requestId，服务器会去重。
      if (!retryable || !isNetworkError(error)) throw error;
      receipt = await send();
    }
    if ((payload.type === 'table_open' || payload.type === 'table_join')
      && receipt && typeof receipt.tableId === 'string' && receipt.tableId) {
      state.watchTableId = receipt.tableId;
    }
    // 回执里已经带了桌、私视图（有的还带整份桌列表）：直接贴上去重画，不再拉整份快照。
    // 旧服务器没有这些字段，就还按原来的路：拉一份快照。
    if (receipt && ('table' in receipt || 'tablePrivate' in receipt || Array.isArray(receipt.tables))) {
      state.syncEpoch += 1;
      if (typeof receipt.seq === 'number') state.appliedSeq = Math.max(state.appliedSeq, receipt.seq);
      applyTablePatch(receipt);
      renderTableParts();
      // 开局押注会立刻扣筹码：账本单独补一次，别为它拉整份快照。
      if (payload.type === 'table_start') scheduleLedgerRefresh(0);
    } else {
      await refreshSnapshot();
      render();
    }
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

/** 结算页的「再开一桌」：开一张新桌，回到等人的牌桌视图。 */
function openNewTable(game = heroGame()) {
  act({ type: 'table_open', game })
    .then(() => setView('table'))
    .catch(() => {});
}

/* —— 实时推送 —— */

let reconnectFailures = 0;
async function followLocation() {
  if (!state.cfg) return false;
  const old = state.cfg;
  try {
    const res = await fetch('/v1/me/location', { headers: { authorization:'Bearer ' + old.token }, signal:AbortSignal.timeout(15000) });
    if (!res.ok) return false;
    const current = await res.json();
    if (!current.room || !current.seat || state.cfg !== old || (current.room === old.room && current.seat.id === old.seatId)) return false;
    state.cfg = { ...old, room:current.room, seatId:current.seat.id, name:current.seat.name };
    localStorage.setItem(STORE_KEY, JSON.stringify(state.cfg));
    location.replace('/play?legacy=1&room=' + encodeURIComponent(current.room));
    return true;
  } catch { return false; }
}
function connect() {
  if (!state.cfg) return;
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
  clearTimeout(state.reconnect);
  setConn('connecting');
  const source = new EventSource(roomPath('/v1/stream?cap=seat-location-v1&since=' + state.latest + '&token=' + encodeURIComponent(state.cfg.token)));
  state.stream = source;
  source.onopen = () => {
    reconnectFailures = 0;
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
    // 服务端收回席位后及时检查状态，进入重新入场流程。
    const delay = Math.min(30000, 3000 * 2 ** Math.min(reconnectFailures++, 4)) + Math.floor(Math.random()*1500);
    state.reconnect = setTimeout(() => { void followLocation().then(moved => { if (!moved) connect(); }); }, delay);
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
  if (type === 'parlor.say' || type === 'parlor.table.say') return;
  const seatChange = type === 'parlor.joined' || type === 'parlor.left';
  // 结算/作废会改筹码；账本单独取，不跟牌桌增量绑在一起。
  if (touchesLedger(type)) scheduleLedgerRefresh();
  if (type.startsWith('parlor.table.') || type.startsWith('parlor.monopoly.')) {
    // 桌事件只补当前桌：别人的出牌、超时代打、开局与结算都走这条。
    // 自己的动作已经用回执重画过（回执的 seq 覆盖到这儿），别再多跑一趟网络。
    if (event.seq > state.appliedSeq) scheduleTableRefresh();
  } else if (type === 'parlor.ledger' || type === 'parlor.whisper') {
    // 收礼/承诺/私聊要动信箱未读，这些还在整份快照里。
    scheduleRefresh();
  } else if (seatChange && (state.view === 'lobby' || state.view === 'hall')) {
    // 人名单在客厅页与大厅页显示；大厅那份还要拿快照的 online 筛掉离线，进出都要跟着刷。
    // 1 秒的防抖把「几百人同时进来」放大成的事件流压成每个浏览器每秒一次。
    scheduleRefresh(1000);
  }
  if (state.view === 'hall' && seatChange) scheduleHallRefresh();
  if (state.tab === 'mail'
    && (type === 'parlor.whisper' || type === 'parlor.ledger' || type === 'parlor.table.turn')) {
    loadMail(true);
  }
  if (type === 'parlor.whisper') dmRefreshSoon();
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

/** 「在牌桌」标记：把客厅里所有还没结束的桌子的座位并起来。 */
function tableSeatIds() {
  const ids = new Set();
  for (const table of tableList()) {
    if (table.status === 'ended') continue;
    for (const seat of (table.seats || [])) {
      if (seat && typeof seat.id === 'string') ids.add(seat.id);
    }
  }
  return ids;
}

/**
 * 牌桌栏只放桌内私聊。客厅的公开发言哪怕出自桌上的席位，也只在客厅栏——
 * 两栏内容不重复，想看客厅就切回去（他 2026-10-29 中午提的）。
 */
function isTableBucket(event) {
  return (event.type || '') === 'parlor.table.say';
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
  const tableNode = tableBucket && eventMatchesChatTable(event) ? lineOf(event, true) : null;
  // 桌上说的话只进牌桌栏：客厅那栏看不见它，所以 roomNode 是 null。
  if (!roomNode && !tableNode) return;

  if (roomNode) {
    const roomBottom = isNearBottom(ui.logRoom);
    ui.logRoom.append(roomNode);
    while (ui.logRoom.children.length > 300) ui.logRoom.firstElementChild.remove();
    if (!seed && roomBottom) ui.logRoom.scrollTop = ui.logRoom.scrollHeight;
  }

  if (tableNode) {
    const tableBottom = isNearBottom(ui.logTable);
    const empty = ui.logTable.querySelector('.chat-empty');
    if (empty) empty.remove();
    ui.logTable.append(tableNode);
    while (ui.logTable.children.length > 300) ui.logTable.firstElementChild.remove();
    if (!seed && tableBottom) ui.logTable.scrollTop = ui.logTable.scrollHeight;
  }

  if (!seed) {
    // 角标只数「聊天」类事件；牌桌的每一次出牌/托管都算未读会把 99+ 堆在底栏，反而没人看。
    const type = event.type || '';
    const conversational = type === 'parlor.say' || type === 'parlor.whisper'
      || type === 'parlor.table.say'
      || type === 'parlor.joined' || type === 'parlor.left' || type === 'parlor.ledger';
    if (conversational) {
      // 桌内发言不会出现在客厅栏里，自然也不算客厅的未读。
      if (type !== 'parlor.table.say' && !chatVisible('room')) state.unread.room += 1;
      if (tableBucket && !chatVisible('table')) state.unread.table += 1;
      renderChatBadges();
    }
  }
}

/**
 * 「现在真的看得见这一栏吗」。桌面上聊天常驻，切到哪个 tab 就算看着哪个；
 * 手机上聊天是一个抽屉，抽屉没拉开时哪怕 tab 停在客厅，新消息也得算未读。
 */
function chatVisible(tab) {
  if (state.tab !== tab) return false;
  if (window.matchMedia('(min-width: 1101px)').matches) return club.chatOpen;
  return state.sheet === 'chat';
}

function lineOf(event, tableBucket) {
  const type = event.type || '';
  // 私聊只进浮窗：它不是房间聊天，别混进大厅/客厅的聊天栏，也不该给聊天栏记未读。
  if (type === 'parlor.whisper') return null;
  if (type === 'parlor.table.turn' || type === 'parlor.digest') return null;
  // 出牌/过牌/开桌/开始/结算这些动作不进聊天栏：牌桌本身已经画出来了，
  // 聊天栏只留人说的话（含桌内私聊），免得一局斗地主把聊天刷满。
  if (type.startsWith('parlor.table.') && type !== 'parlor.table.say') return null;
  if (type.startsWith('parlor.monopoly.')) return null;
  // 桌内发言只属于牌桌栏；桌子散了它也不该混进客厅。
  if (type === 'parlor.table.say' && !tableBucket) return null;
  const time = el('time', '', fmtClock(event.ts).slice(0, 5));
  if (event.from === 'system') {
    const node = el('div', 'system-line');
    const tag = type.startsWith('parlor.table.') ? '牌桌'
      : type.startsWith('parlor.monopoly.') ? '大富翁'
        : type === 'parlor.ledger' ? '账本' : '';
    if (tag) node.append(el('span', 'tag tag-table', tag));
    // 服务器的事件文案是按「客厅」写的；人在大厅时显示成大厅（只换进/离开这两个说法，
    // 不去动「去「默认客厅」」这种真正的客厅名字）。
    let text = event.text || '';
    if (inHall()) text = text.replace(/进了客厅/g, '进了大厅').replace(/离开了客厅/g, '离开了大厅');
    node.append(el('span', '', readable(text)), time);
    return node;
  }
  const snap = state.snap;
  const seat = snap ? snap.seats.find((entry) => entry.id === event.from) : null;
  const index = snap ? snap.seats.findIndex((entry) => entry.id === event.from) : -1;
  const name = (event.data && typeof event.data.name === 'string' ? event.data.name : '')
    || (seat ? seat.name : '')
    || event.from;
  const tableTalk = type === 'parlor.table.say';
  const node = el('article', 'msg' + (tableBucket ? ' is-table' : ''));
  node.append(avatarNode(event.from, 'avatar-sm'));
  const body = el('div', 'msg-body');
  const meta = el('div', 'msg-meta');
  meta.append(el('span', 'msg-name', name));
  meta.append(el('span', 'tag ' + (tableBucket ? 'tag-table' : 'tag-room'),
    tableTalk ? '牌桌私聊' : tableBucket ? '牌桌' : inHall() ? '大厅' : '客厅'));
  meta.append(time);
  body.append(meta);
  body.append(el('p', '', (tableTalk ? '（只有同桌看得见）' : '') + readable(event.text || '')));
  node.append(body);
  return node;
}

function avatarNode(id, size = 'avatar-sm', options = {}) {
  const snap = state.snap;
  const tableSeats = tableList().flatMap((table) => table.seats || []);
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
  featuredCarousel.setActive(false);
  clear(app);
  state.shell = true;
  crumbSignature = '';
  tableChatScope = '';
  draftScope = '';
  try {
    const filter = sessionStorage.getItem('parlor-hall-filter');
    if (['all', 'mine', 'favorites'].includes(filter)) hallSection = filter;
    sessionStorage.removeItem('parlor-hall-filter');
  } catch {}

  const top = el('header', 'topbar');
  const brand = brandNode();
  const breadcrumb = el('nav', 'club-breadcrumb');
  breadcrumb.setAttribute('aria-label', '当前位置');
  const roomPill = el('button', 'room-pill');
  roomPill.type = 'button';
  roomPill.title = '换客厅';
  roomPill.addEventListener('click', () => { void openRooms(); });
  const pillDot = el('span', 'live-dot');
  const pillText = el('span', 'room-pill-main');
  const pillSub = el('span', 'room-pill-sub');
  roomPill.append(pillDot, pillText, el('span', 'room-sep', '·'), pillSub);

  const viewSwitch = el('div', 'view-switch');
  viewSwitch.setAttribute('role', 'tablist');
  viewSwitch.setAttribute('aria-label', '切换大厅、客厅与牌桌');
  const topHall = viewButton('大厅', 'hall');
  const topRoom = viewButton('客厅', 'lobby');
  const topTable = viewButton('牌桌', 'table');
  viewSwitch.append(topHall, topRoom, topTable);

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

  const dmBtn = el('button', 'ghost-btn dm-btn');
  dmBtn.type = 'button';
  dmBtn.title = '私聊：找人说话，离线也能收到';
  dmBtn.append(icon('chat'), document.createTextNode('私聊'));
  const dmBadge = el('span', 'badge', '0');
  dmBadge.hidden = true;
  dmBtn.append(dmBadge);
  dmBtn.addEventListener('click', () => toggleDm());

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

  const chatToggle = btn('聊天', () => toggleChat(), { ghost: true, small: true });
  chatToggle.classList.add('chat-toggle');
  chatToggle.setAttribute('aria-controls', 'chatPanel');
  topRight.append(conn, mailBtn, dmBtn, leaveBtn, topMe, themePicker(), chatToggle, menuBtn);
  top.append(brand, breadcrumb, roomPill, viewSwitch, topRight);

  const banner = el('div', 'banner');
  banner.hidden = true;
  const bannerText = el('span', 'banner-text');
  const bannerGo = btn('去牌桌', () => {
    watchMine();
    setView('table');
  }, { small: true });
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
  const clubNav = el('nav', 'club-nav');
  clubNav.setAttribute('aria-label', '会馆导航');
  for (const [filter, label, symbol] of [['all', '发现客厅', 'lamp'], ['mine', '我的客厅', 'users'], ['favorites', '收藏的地方', 'spark']]) {
    const button = btn(label, () => selectHallSection(filter), { ghost: true });
    button.prepend(icon(symbol));
    button.dataset.section = filter;
    clubNav.append(button);
  }
  leftRail.append(clubNav);

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
  leftRail.append(supportLink(() => state.cfg?.token));
  const parentLink = el('a', 'ghost-btn', '家长页');
  parentLink.href = '/parent';
  parentLink.target = '_blank';
  parentLink.rel = 'noopener';
  leftRail.append(parentLink);

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
  const tableListNode = el('ul', 'table-list');
  tablesCard.append(tablesHead, tableListNode);
  leftRail.append(tablesCard);

  const roomCard = el('section', 'panel room-card');
  const roomHead = el('div', 'panel-head');
  const roomTitle = el('h2', '', '客厅');
  const roomSwitch = el('button', 'link', '换');
  roomSwitch.type = 'button';
  roomSwitch.addEventListener('click', () => { void openRooms(); });
  roomHead.append(roomTitle, roomSwitch);
  const roomNote = el('p', 'room-note muted', '');
  const roomManage = btn('成员管理', () => { void openAccess(); }, { ghost: true, small: true });
  roomManage.title = '房主：管成员、发邀请、改可见性';
  const roomLeave = btn('离开客厅', () => { void goRoom('hall'); }, { ghost: true, small: true });
  roomLeave.title = '回到大厅（牌局进行中时会被拦住）';
  const roomActions = el('div', 'room-actions');
  roomActions.append(roomManage, roomLeave);
  roomCard.append(roomHead, roomNote, roomActions);
  leftRail.append(roomCard);

  /* 中间：牌桌 / 客厅 / 大厅 */
  const center = el('section', 'center');
  center.setAttribute('aria-label', '牌桌、客厅与大厅');

  const viewTable = el('div', 'view view-table');
  const tableNavigation = el('div', 'club-page-nav');
  tableNavigation.append(btn('← 返回客厅', () => { setView('lobby'); setTab('room'); }, { ghost: true, small: true }),
    btn('邀请朋友', () => inviteToRoom(), { ghost: true, small: true }));
  const tableHead = el('div', 'table-head-host');
  const mobileTicker = el('div', 'mobile-ticker');
  const game = el('div', 'game');
  const ticker = el('div', 'ticker');
  viewTable.append(tableNavigation, tableHead, mobileTicker, game, ticker);

  const viewLobby = el('div', 'view view-lobby');
  const lobbyHead = el('div', 'lobby-head');
  const roomNavigation = el('div', 'club-page-nav');
  roomNavigation.append(btn('← 返回大厅', () => setView('hall'), { ghost: true, small: true }),
    btn('邀请来客厅', () => inviteToRoom(), { ghost: true, small: true }));
  const lobbyCopy = el('div');
  const lobbyEyebrow = el('span', 'eyebrow');
  const lobbyTitle = el('h1', '', '灯还亮着。');
  const lobbySub = el('p');
  lobbyCopy.append(lobbyEyebrow, lobbyTitle, lobbySub);
  // 保留侧栏原入口；主区域另建按钮，不能移动同一个 DOM 节点。
  const lobbyManage = btn('成员管理', () => { void openAccess(); }, { ghost: true, small: true });
  lobbyManage.title = roomManage.title;
  lobbyHead.append(lobbyCopy, lobbyManage);
  const gameGrid = el('div', 'game-grid');
  // 玩法说明由 registry 里的 guide 生成（见 renderGuides）；这里只留壳。
  const guide = el('section', 'panel ddz-guide');
  const lobbyNotice = el('div', 'lobby-notice');
  const members = el('section', 'panel members');
  const membersHead = el('div', 'panel-head');
  const membersTitle = el('h2', '', '房间里的人');
  const membersCount = el('span', 'muted');
  membersHead.append(membersTitle, membersCount);
  const memberRow = el('div', 'member-row');
  members.append(membersHead, memberRow);
  const roomWelcome = el('section', 'club-welcome');
  roomWelcome.append(el('span', 'eyebrow', 'MAKE YOURSELF AT HOME'),
    el('h2', '', '先聊两句，再挑一张桌。'),
    el('p', '', '同一个客厅，不同的好时光。想玩就入座，想聊就坐一会儿。'), clubScene('ddz'));
  const roomTables = el('div', 'club-table-grid');
  const tableSectionHead = el('div', 'club-section-head');
  tableSectionHead.append(el('h2', '', '挑张桌，坐下来'), el('span', 'muted', '斗地主 3 席 · 狼人杀 9 席'));
  const stay = el('div', 'club-stay');
  stay.append(el('strong', '', '✳  不玩游戏，也欢迎留下来。'), el('p', '', '打开聊天，和这个客厅里的朋友说两句。'));
  viewLobby.append(roomNavigation, lobbyHead, roomWelcome, members, tableSectionHead, roomTables, gameGrid, lobbyNotice, stay, guide);

  /* 中间：大厅（会话世界）——谁在大厅、有哪些客厅、开一间 */
  const viewHall = el('div', 'view view-hall');
  const hallHead = el('div', 'hall-head');
  const hallEyebrow = el('span', 'eyebrow', 'A LITTLE PLAY, A LITTLE COMPANY.');
  const hallTitle = el('h1', '', '今晚，来一局。');
  const hallDescription = el('p', 'muted', '找个舒服的位置，和朋友、Coo 一起把时间慢下来。');
  hallHead.append(
    hallEyebrow, hallTitle, hallDescription,
  );
  const createShortcut = btn('＋ 开一间客厅', () => {
    hallCreate.scrollIntoView({ behavior: 'smooth', block: 'center' }); hallCreateName.focus({ preventScroll: true });
  }, { ghost: true });
  hallHead.append(createShortcut);
  const hallHero = el('section', 'club-hero');
  hallHero.setAttribute('aria-label', '热门客厅推荐');
  hallHero.setAttribute('aria-roledescription', '轮播');
  let heroHovered = false, heroFocused = false;
  const blockHero = () => featuredCarousel.setBlocked(heroHovered || heroFocused);
  hallHero.addEventListener('mouseenter', () => { heroHovered = true; blockHero(); });
  hallHero.addEventListener('mouseleave', () => { heroHovered = false; blockHero(); });
  hallHero.addEventListener('focusin', () => { heroFocused = true; blockHero(); });
  hallHero.addEventListener('focusout', event => { heroFocused = hallHero.contains(event.relatedTarget); blockHero(); });
  const hallPeople = el('section', 'panel hall-people');
  const hallPeopleHead = el('div', 'panel-head');
  const hallPeopleCount = el('span', 'muted');
  hallPeopleHead.append(el('h2', '', '大厅里'), hallPeopleCount);
  const hallPeopleRow = el('div', 'member-row');
  hallPeople.append(hallPeopleHead, hallPeopleRow,
    el('p', 'muted hall-note', '在别的客厅里的人不在这里显示；离线的不显示。'));
  const hallRooms = el('section', 'panel hall-rooms');
  const hallRoomsHead = el('div', 'panel-head');
  const hallRefresh = el('button', 'link', '刷新');
  hallRefresh.type = 'button';
  hallRefresh.addEventListener('click', () => { void loadHall(true); });
  const hallRoomsTitle = el('h2', '', '客厅');
  hallRoomsHead.append(hallRoomsTitle, hallRefresh);
  const discovery = el('div', 'club-discovery');
  const search = el('input', 'club-search');
  search.type = 'search'; search.placeholder = '搜索客厅名字、话题…'; search.setAttribute('aria-label', '搜索客厅');
  search.addEventListener('input', () => { hallQuery = search.value; renderHall(); });
  const filters = el('div', 'club-filters');
  filters.setAttribute('aria-label', '筛选客厅');
  for (const [value, label] of [['all', '全部'], ['ddz', '斗地主'], ['werewolf', '狼人杀']]) {
    const button = btn(label, () => { hallFilter = value; renderHall(); }, { ghost: true, small: true });
    button.dataset.filter = value; filters.append(button);
  }
  discovery.append(search, filters);
  const hallRoomsList = el('div', 'rooms-list hall-rooms-list');
  const hallRoomsNote = el('p', 'muted hall-note', '公开客厅谁都能进；不公开的要先被邀请。');
  hallRooms.append(hallRoomsHead, discovery, hallRoomsList, hallRoomsNote);
  const hallCreate = el('section', 'panel hall-create');
  const hallCreateName = el('input');
  hallCreateName.type = 'text';
  hallCreateName.maxLength = 32;
  hallCreateName.placeholder = '客厅名字（2–32 个字）';
  hallCreateName.setAttribute('aria-label', '新客厅名字');
  const hallCreateVis = el('select');
  hallCreateVis.setAttribute('aria-label', '客厅可见性');
  for (const [value, label] of [['public', '公开'], ['unlisted', '不公开'], ['private', '私密']]) {
    const option = el('option', '', label);
    option.value = value;
    hallCreateVis.append(option);
  }
  const hallCreateCap = el('span', 'muted', '固定 30 人');
  const hallCreateBtn = btn('开一间', () => { void createHallRoom(); }, { primary: true, small: true });
  const hallCreateRow = el('div', 'hall-create-row');
  hallCreateRow.append(hallCreateName, hallCreateVis, hallCreateCap, hallCreateBtn);
  hallCreate.append(el('h2', '', '开一间新的'), hallCreateRow,
    el('p', 'muted hall-note', '公开的客厅会出现在别人的目录里；不公开的只有成员看得到。'));
  viewHall.append(hallHead, hallHero, hallRooms, hallPeople, hallCreate);
  center.append(viewTable, viewLobby, viewHall);
  // 运营公告横幅：首屏（大厅、客厅）才有，牌桌上不占地方；没有新公告时不渲染出来。
  mountAnnouncementBanner(viewLobby);
  const hallAnnouncement = mountAnnouncementBanner(viewHall);
  startAnnouncementWatch(() => state.cfg && state.cfg.token);

  /* 右栏：聊天 / 牌桌信息 */
  const rightRail = el('aside', 'right-rail');
  rightRail.setAttribute('aria-label', '聊天与牌桌信息');
  const chatPanel = el('section', 'panel chat-panel');
  chatPanel.id = 'chatPanel';
  chatPanel.append(sheetGrip());
  const chatHead = el('div', 'chat-head');
  const chatCopy = el('div');
  const chatEyebrow = el('span', 'eyebrow', '客厅 · 牌桌');
  chatCopy.append(chatEyebrow, el('h2', '', '有话慢慢聊'));
  const chatActions = el('div', 'chat-head-actions');
  const backRoom = el('button', 'link', '切回客厅');
  backRoom.type = 'button';
  backRoom.title = '只切聊天栏的频道，不换客厅';
  backRoom.addEventListener('click', () => setTab('room'));
  const markRead = btn('都看过了', () => markMailRead(), { ghost: true, small: true });
  markRead.hidden = true;
  const collapseChat = btn('收起', () => toggleChat(false), { ghost: true, small: true });
  collapseChat.setAttribute('aria-label', '收起聊天');
  chatActions.append(markRead, backRoom, collapseChat);
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
  logTable.append(el('div', 'chat-empty', '牌桌上还没人说话。客厅的聊天在「客厅」那一栏。'));
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
  sayInput.addEventListener('input', () => club.saveDraft(draftScope, sayInput.value));
  sayInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      // 中文输入法里回车是确认候选词，不该顺手把半句话发出去。确认那一下有的浏览器
      // isComposing 已是 false，只剩 keyCode 229，所以两个记号都看。
      if (event.isComposing || event.keyCode === 229) return;
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
  const navHall = navButton('hall', '大厅', 'lamp');
  const navRoom = navButton('room', '客厅', 'users');
  const navTable = navButton('table', '牌桌', 'dice');
  const navChat = navButton('chat', '聊天', 'chat');
  nav.append(navHall.btn, navRoom.btn, navTable.btn, navChat.btn);

  const backdrop = el('div', 'sheet-backdrop');
  backdrop.hidden = true;
  backdrop.addEventListener('click', () => closeSheet());

  app.append(top, banner, layout, nav, backdrop);
  layout.append(leftRail, center, rightRail);

  Object.assign(ui, {
    top, conn, connText, mailBtn, mailBadge, dmBtn, dmBadge, banner, bannerText, bannerGo, chatToggle,
    layout, clubNav, hallHero, roomTables, breadcrumb,
    hallHead, hallEyebrow, hallTitle, hallDescription, createShortcut, hallPeople, hallCreate, hallAnnouncement,
    hallRoomsTitle, hallRoomsNote, hallSearch: search,
    roomPillText: pillText, roomPillSub: pillSub,
    viewButtons: [topHall, topRoom, topTable],
    topAvatar, topName, topSub, chipsText,
    leftRail, seatAvatar, seatName, seatSub,
    statChips, statWins, statGames, progressLeft, progressRight, progressFill,
    ledgerNet, split, ledgerList, tableList: tableListNode, roomTitle, roomNote, roomManage, roomLeave,
    tablesCard, roomCard, chatEyebrow,
    viewTable, viewLobby, viewHall, tableHead, mobileTicker, game, ticker,
    lobbyEyebrow, lobbyTitle, lobbySub, gameGrid, guide, lobbyNotice, membersCount, memberRow,
    hallPeopleCount, hallPeopleRow, hallRoomsList, hallCreateName, hallCreateVis, hallCreateCap, hallCreateBtn,
    chatPanel, markRead, backRoom, tabRoom, tabTable, tabMail,
    logRoom, logTable, mailList, composer, scopeText, sayInput, sendBtn, mailNote,
    infoGame, infoStake, infoStatus, infoTurn, ruleNote, infoClock,
    navHall, navRoom, navTable, navChat, backdrop,
  });
  ui.featured = null;
  featuredCarousel.setBlocked(false);
  syncViewButtons();
  state.sheet = !window.matchMedia('(min-width: 1101px)').matches && club.mobileChatOpen ? 'chat' : null;
  syncSheet();
  if (window.matchMedia('(min-width: 1101px)').matches) syncChatCollapse();
}

function brandNode() {
  const brand = el('div', 'brand');
  const mark = el('span', 'brand-mark');
  mark.append(icon('whale'));
  const text = el('span', 'brand-text');
  text.append(el('span', 'brand-name', '鲸语'), el('span', 'brand-sub', 'PARLOR CLUB'));
  brand.append(mark, text);
  return brand;
}

/** 外观选单：深色 / 浅色 / 奶油。切换只换颜色，桌子里的牌、草稿和焦点都不动。 */
const THEME_LABELS = [['dark', '深色'], ['light', '浅色'], ['cream', '奶油']];

function themePicker() {
  const wrap = el('label', 'theme-picker');
  wrap.append(icon('sun'));
  const select = document.createElement('select');
  select.setAttribute('aria-label', '外观');
  for (const [value, label] of THEME_LABELS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  select.value = (window.parlorTheme && window.parlorTheme.value) || 'dark';
  select.addEventListener('change', () => window.parlorTheme?.set(select.value));
  wrap.append(select);
  return wrap;
}

function syncThemePickers() {
  const value = (window.parlorTheme && window.parlorTheme.value) || 'dark';
  document.querySelectorAll('.theme-picker select').forEach((select) => { select.value = value; });
}

document.addEventListener('parlor:themechange', syncThemePickers);

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
  const labelNode = el('span', 'chat-tab-label', label);
  node.append(icon(iconName), labelNode);
  const badge = el('span', 'tab-count', '0');
  badge.hidden = true;
  node.append(badge);
  node.addEventListener('click', () => setTab(tab));
  return { btn: node, badge, labelNode };
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
    if (kind === 'hall') {
      closeSheet();
      setView('hall');
      return;
    }
    if (kind === 'room') {
      closeSheet();
      setView('lobby');
      return;
    }
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
  renderClubNav();
  syncFeaturedRotation();
  document.title = (state.snap.tablePrivate && state.snap.tablePrivate.yourTurn ? '轮到你 · 鲸语会馆' : '鲸语会馆 · 一起玩');
}

function renderTopbar() {
  const snap = state.snap;
  const seated = snap.seats.filter((seat) => seat.kind !== 'observer').length;
  const pets = snap.seats.filter((seat) => seat.kind === 'pet');
  const coos = pets.filter((seat) => (snap.online || []).includes(seat.id)).length;
  const hall = inHall();
  ui.roomPillText.textContent = snap.name || (hall ? '大厅' : '客厅');
  ui.roomPillSub.textContent = seated + ' 人在座'
    + (pets.length === 0 ? ' · 还没有 Coo' : coos > 0 ? ` · ${coos} 位 Coo 在线` : ` · ${pets.length} 位 Coo 离线`);
  ui.roomTitle.textContent = hall ? '大厅' : '客厅';
  ui.roomNote.textContent = hall
    ? '大厅是入口；挑一间客厅进去坐坐。'
    : '用「换」去大厅或别的客厅；串门会释放这里的席位。';
  for (const node of ui.viewButtons) {
    const view = node.dataset.view;
    if (view === 'table' || view === 'lobby') node.hidden = hall;
  }
  ui.roomLeave.hidden = hall;
  ui.roomManage.hidden = hall;
  // 大厅里没有客厅/牌桌这两张卡，留着只会让人点进空页面。
  ui.tablesCard.hidden = hall;
  ui.roomCard.hidden = hall;
  if (hall && state.view !== 'hall') {
    // 人在大厅就没有客厅/牌桌可看；快照说了算。
    state.view = 'hall';
    syncViewButtons();
  }
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
  ui.seatSub.textContent = (KIND_LABELS[snap.seat.kind] || snap.seat.kind)
    + ' · ' + (online ? '在线' : '离线')
    + (snap.seat.handle ? ' · #' + snap.seat.handle : '');
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

/**
 * 牌桌栏列的是真实的桌（没结束的在前，最近结束的在后），不再按游戏造行。
 * 点一行只是「看那张桌」，不换桌、不离开自己那桌；「开一桌」固定在底部。
 */
function renderTablesRail() {
  const snap = state.snap;
  const signup = snap.monopoly && snap.monopoly.signup;
  const tables = tableList();
  const names = namesMap();
  const mineId = myTableId();
  const yourTurn = !!(snap.tablePrivate && snap.tablePrivate.yourTurn);
  const currentId = tableIdOf(activeTable());
  clear(ui.tableList);
  // 未结束的在前、最近结束的在后（服务器的顺序也这样，这里再兜一层）。
  const ordered = [
    ...tables.filter((table) => table.status !== 'ended'),
    ...tables.filter((table) => table.status === 'ended'),
  ];
  for (const table of ordered) {
    const id = tableIdOf(table);
    const row = el('li');
    const button = el('button', 'table-row');
    button.type = 'button';
    if (id && id === currentId) button.classList.add('is-active');
    const iconBox = el('span', 'table-icon');
    iconBox.append(icon(gameIcon(table.game)));
    const copy = el('span', 'table-copy');
    copy.append(el('strong', '', table.label || gameLabel(table.game)));
    const small = el('small');
    if (table.status !== 'ended') small.append(el('span', 'live-dot'));
    const bits = [
      STATUS_LABELS[table.status] || table.status,
      (table.seats || []).length + ' 人',
    ];
    const hostName = table.host ? names.get(table.host) : '';
    if (hostName) bits.push('房主 ' + hostName);
    if (!ENABLED_GAMES.includes(table.game)) bits.push('已收起');
    small.append(document.createTextNode(bits.join(' · ')));
    copy.append(small);
    const isMine = !!id && id === mineId;
    const stateText = isMine && yourTurn ? '轮到你'
      : isMine ? '我的'
        : table.status === 'ended' ? '看结果'
          : table.status === 'open' ? '可加入' : '观战';
    const stateEl = el('span', 'table-state' + (isMine || table.status === 'ended' ? '' : ' muted'), stateText);
    button.append(iconBox, copy, stateEl);
    button.addEventListener('click', () => {
      state.watchTableId = id;
      setView('table');
    });
    row.append(button);
    ui.tableList.append(row);
  }
  if (!tables.length) ui.tableList.append(el('li', 'rail-note', '还没有牌桌。开一桌吧。'));

  const openRow = el('li', 'table-row-open');
  const mine = myTable();
  const blocked = !!(mine && mine.status !== 'ended');
  openRow.append(btn('开' + gameLabel(heroGame()) + '桌', () => {
    actAndGo({ type: 'table_open', game: heroGame() }, 'table');
  }, {
    primary: true,
    small: true,
    disabled: blocked,
    title: blocked ? '先把自己那张桌打完或收掉' : '',
  }));
  ui.tableList.append(openRow);

  let note = '';
  if (signup) note = '大富翁已收起 · 报名 ' + signup.seats.length + '/' + signup.size;
  else if (tables.some((table) => table.status !== 'ended' && !ENABLED_GAMES.includes(table.game))) {
    const legacy = tables.find((table) => table.status !== 'ended' && !ENABLED_GAMES.includes(table.game));
    note = gameLabel(legacy.game) + ' 已收起，先把这局打完';
  } else {
    const hidden = Object.keys(GAMES).filter((id) => !GAMES[id].enabled);
    note = hidden.length ? hidden.map((id) => gameLabel(id)).join(' / ') + ' 已收起' : '';
  }
  if (note) ui.tableList.append(el('li', 'rail-note', note));
}

function renderBanner() {
  const snap = state.snap;
  // 「轮到你」只看我自己的桌；正在看别人的桌时也要提醒。
  const priv = snap.tablePrivate;
  const yourTurn = !!(priv && priv.yourTurn === true);
  const mine = myTable();
  const watchingMine = !state.watchTableId
    || (!!mine && tableIdOf(mine) === state.watchTableId);
  ui.banner.hidden = !yourTurn || (state.view === 'table' && watchingMine);
  if (ui.banner.hidden) return;
  clear(ui.bannerText);
  const gameName = mine ? tableTitle(mine) : '';
  ui.bannerText.append(document.createTextNode('轮到你' + (gameName ? ' · ' + gameName : '')));
  const deadline = (priv && priv.deadline) || (mine && mine.deadline);
  if (deadline) {
    ui.bannerText.append(document.createTextNode(' '));
    ui.bannerText.append(clockSpan(deadline, 'clock'));
  }
}

/* —— 中间：牌桌 / 大厅 —— */

function renderCenter() {
  ui.viewTable.hidden = state.view !== 'table';
  ui.viewLobby.hidden = state.view !== 'lobby';
  ui.viewHall.hidden = state.view !== 'hall';
  if (state.view === 'table') {
    renderTableHead();
    renderGame();
  } else if (state.view === 'hall') {
    ui.tableHead.hidden = true;
    renderHall();
  } else {
    ui.tableHead.hidden = true;
    renderLobby();
  }
}

function tableTitle(table) {
  const label = table.label || gameLabel(table.game);
  return table.game === 'dice' ? '骰子桌' : label;
}

function namesMap() {
  const names = new Map((state.snap.seats || []).map((seat) => [seat.id, seat.name]));
  for (const table of tableList()) {
    for (const seat of (table.seats || [])) {
      if (seat && !names.has(seat.id)) names.set(seat.id, seat.name);
    }
  }
  return names;
}

function renderTableHead() {
  const host = ui.tableHead;
  clear(host);
  const table = activeTable();
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
  iconBox.append(icon(gameIcon(table.game)));
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

  const priv = activePrivate();
  const myTurn = !!(priv && priv.yourTurn === true);
  const names = namesMap();
  const turnBox = el('div', 'turn-box');
  const turnCopy = el('div', 'turn-copy');
  turnCopy.append(el('span', 'turn-kicker', myTurn ? '轮到你' : '轮到'));
  turnCopy.append(el('span', 'turn-name', myTurn ? state.snap.seat.name : (table.turn ? names.get(table.turn) || '？' : '—')));
  turnBox.append(turnCopy);

  const deadline = table.deadline || (priv && priv.deadline) || 0;
  const turnSeat = (table.seats || []).find((seat) => seat.id === table.turn);
  const botTurn = !!(turnSeat && turnSeat.bot) && !myTurn;
  const timer = el('div', 'timer');
  const timerText = el('span', '', '—');
  timer.append(timerText);
  if (deadline && !botTurn) {
    // 一回合有多长，服务器没有单独给；第一次见到这个截止时刻时按剩余秒数记总长。
    // 骰子约 45 秒、斗地主 30/60 秒、大富翁 5/30 分钟，都能落在同一个环上。
    const key = tableIdOf(table) + ':' + table.game + ':' + deadline;
    if (state.timerKey !== key) {
      state.timerKey = key;
      state.timerTotal = Math.max(10, Math.ceil((deadline - serverNow()) / 1000));
    }
    timer.dataset.deadline = String(deadline);
    timer.dataset.total = String(state.timerTotal);
  } else {
    timer.classList.add('is-off');
    if (botTurn) timerText.textContent = '脚本';
  }
  turnBox.append(timer);
  head.append(left, turnBox);
  host.append(head);
  ui.timer = timer;
  ui.timerText = timerText;
  updateTimer();
}

function renderGame() {
  const table = activeTable();
  const active = !!table && (table.status === 'bidding' || table.status === 'playing');
  // 有的游戏结束后还要留在桌面渲染器里（斗地主展示三家剩牌），由注册表的 endScreen 决定；
  // 其余游戏结束仍走通用结算卡。
  const def = table ? gameOf(table.game) : null;
  const endedWithScreen = !!table && table.status === 'ended' && !!def && def.endScreen;
  if (!active && !endedWithScreen) {
    disposeGame();
    renderTableIdle();
    renderTicker();
    return;
  }
  // 两张同游戏的桌各挂各的渲染器：桌号进 key，换桌就重建。
  const tableId = tableIdOf(table);
  const mountKey = table.game + ':' + tableId;
  if (!state.mounted || state.mounted.key !== mountKey) {
    disposeGame();
    const root = el('div', 'game-root');
    ui.game.append(root);
    const factory = def ? def.mount : null;
    if (!factory) {
      root.append(el('p', 'muted', '这个游戏还没有网页桌面。'));
      state.mounted = {
        key: mountKey, game: table.game, tableId, instance: { update() {}, destroy() {} },
      };
      return;
    }
    const ctx = {
      me: state.snap.seat,
      act,
      toast: showToast,
      serverNow,
      showLobby: () => setView('lobby'),
      openDdz: () => openNewTable('ddz'),
      openGame: (game) => openNewTable(game),
    };
    state.mounted = { key: mountKey, game: table.game, tableId, instance: factory(root, ctx) };
  }
  state.mounted.instance.update(makeView());
  renderTicker();
}

/** 事件是不是属于这张桌；老事件没有 tableId 时按「是」处理。 */
function onTable(event, tableId) {
  if (!tableId) return true;
  const id = event && event.data ? event.data.tableId : '';
  return !id || id === tableId;
}

function tableRecentEvents(tableId, limit, options = {}) {
  return state.log
    .filter((event) => event.type !== 'parlor.table.turn'
      && !(options.skipDigest && event.type === 'parlor.digest')
      && onTable(event, tableId)
      && (String(event.type || '').startsWith('parlor.table.')
        || String(event.type || '').startsWith('parlor.monopoly.')))
    .slice(-limit);
}

function makeView() {
  const snap = state.snap;
  const table = activeTable();
  const tableId = tableIdOf(table);
  const names = namesMap();
  const classes = new Map();
  (snap.seats || []).forEach((seat, index) => classes.set(seat.id, playerClass(index)));
  for (const entry of tableList()) {
    (entry.seats || []).forEach((seat, index) => {
      if (!classes.has(seat.id)) classes.set(seat.id, playerClass(index));
    });
  }
  const game = table ? table.game : 'ddz';
  // 结算事件也按桌号认：两张桌都打过时，别把另一桌的底牌摆到这桌上。
  const endEvent = [...state.log].reverse().find((event) => event.type === 'parlor.table.end'
    && event.data && event.data.game === game && Array.isArray(event.data.revealed)
    && onTable(event, tableId)) || null;
  return {
    table,
    priv: activePrivate(),
    me: snap.seat,
    seats: snap.seats,
    names,
    classes,
    online: snap.online || [],
    now: serverNow(),
    endEvent,
    recent: tableRecentEvents(tableId, 4),
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
  const table = activeTable();
  const active = !!table && (table.status === 'bidding' || table.status === 'playing');
  clear(ui.ticker);
  clear(ui.mobileTicker);
  if (!active) {
    ui.ticker.hidden = true;
    ui.mobileTicker.hidden = true;
    return;
  }
  const recent = tableRecentEvents(tableIdOf(table), 3, { skipDigest: true }).reverse();
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
  const table = activeTable();
  const panel = el('section', 'panel wait-card');
  if (fault) panel.append(el('p', 'warn', '大富翁故障：' + fault));
  if (table) {
    panel.append(openTableCard(table));
    if (!ENABLED_GAMES.includes(table.game)) {
      panel.append(el('p', 'dim',
        '这版只露出 ' + ENABLED_GAMES.map((id) => gameLabel(id)).join('、')
        + '；桌上这局还可以打完。'));
    }
    ui.game.append(panel);
    return;
  }
  if (signup) panel.append(signupNotice(signup));
  const hero = heroGame();
  const heroDef = gameOf(hero);
  panel.append(el('h2', '', '先来一局' + gameLabel(hero) + '。'));
  if (heroDef && heroDef.blurb) panel.append(el('p', 'muted', heroDef.blurb));
  panel.append(openButtons());
  ui.game.append(panel);
}

/** 大富翁先收起；已经挂着的报名表给一个收尾的口子。 */
function signupNotice(signup) {
  const me = state.snap.seat;
  const box = el('div', 'signup-notice');
  box.append(el('h3', '', '大富翁先收起了'));
  box.append(el('p', 'muted', '现在还挂着一份报名表：' + signup.seats.length + '/' + signup.size
    + ' 人；24 小时内没开局会自动过期。'));
  const actions = el('div', 'actions');
  if (signup.host === me.name) {
    actions.append(btn('取消报名', () => actAndGo({ type: 'monopoly', action: 'cancel' }, null), {
      danger: true,
      small: true,
    }));
  } else if (signup.seats.includes(me.name)) {
    actions.append(btn('退出报名', () => actAndGo({ type: 'monopoly', action: 'leave' }, null), { small: true }));
  }
  if (actions.children.length) box.append(actions);
  return box;
}

/** 大富翁的完整报名卡先留着，入口重新打开时再用。 */
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

function openTableCard(table) {
  const me = state.snap.seat;
  const names = namesMap();
  const hidden = !ENABLED_GAMES.includes(table.game);
  const box = el('div', 'open-table');
  box.append(el('h3', '', tableTitle(table) + ' · ' + (STATUS_LABELS[table.status] || table.status)
    + (hidden ? '（已收起）' : '')));
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
    box.append(openButtons());
    return box;
  }
  box.append(el('p', 'muted', '桌上：' + (table.seats || []).map((seat) => names.get(seat.id) || seat.name).join('、')));
  const def = gameOf(table.game);
  if (def && def.botFill) {
    box.append(el('p', 'dim', '空位由脚本陪练补；一个人也可以开始。'));
  }
  const seated = (table.seats || []).some((seat) => seat.id === me.id);
  const host = table.host === me.id;
  const actions = el('div', 'actions');
  if (!seated) {
    // 看的是哪张桌就坐哪张：多桌时必须把桌号带上。
    const target = tableIdOf(table);
    actions.append(btn('坐下', () => actAndGo({ type: 'table_join', ...(target ? { table: target } : {}) }), { primary: true }));
  } else if (host) {
    const count = (table.seats || []).length;
    const enough = count >= (def ? def.minPlayers : 2) || !!(def && def.botFill);
    actions.append(btn('开始', () => actAndGo({ type: 'table_start' }), {
      primary: true,
      disabled: !enough,
      title: enough ? '' : '人数不够',
    }));
  } else {
    box.append(el('p', 'muted', '等 ' + (names.get(table.host) || '发起人') + ' 开局。'));
  }
  if (seated) {
    actions.append(btn(host ? '收桌' : '退桌', () => actAndGo({ type: 'table_leave' }, 'lobby'), {
      ghost: true,
      small: true,
    }));
  }
  if (actions.children.length) box.append(actions);
  return box;
}

function openButtons() {
  const box = el('div', 'open-buttons');
  // 「能不能再开一桌」看的是我自己的桌：看别人的桌不算我在打。
  const mine = myTable();
  const blocked = !!(mine && mine.status !== 'ended');
  const hero = heroGame();
  const def = gameOf(hero);
  const row = el('div', 'actions');
  row.append(btn('开' + gameLabel(hero) + '桌', () => actAndGo({ type: 'table_open', game: hero }), {
    primary: true,
    disabled: blocked,
    title: blocked ? '先结束现在这桌' : '',
  }));
  box.append(row);
  if (def) box.append(el('p', 'dim', def.blurb));
  return box;
}

/* —— 大厅（会话世界） —— */

/**
 * 大厅的数据：谁在大厅（`/v1/hall` 的 seats）与有哪些客厅（目录）。
 * 只有人在大厅时才看这个页面；换客厅走 goRoom——那是服务器上的原子切换，
 * 牌局进行中会被服务器拦住（不是前端藏按钮）。
 */
async function loadHall(force = false) {
  if (!state.shell || state.hallLoading) return;
  if (!force && state.hallData && Date.now() - state.hallData.at < 8000) return;
  state.hallLoading = true;
  try {
    const [payload, directory] = await Promise.all([api('/v1/hall'), api('/v1/rooms?all=1')]);
    state.hallData = { hall: payload.hall, rooms: directory.rooms || [], at: Date.now(), error: null };
  } catch (error) {
    state.hallData = {
      ...(state.hallData || {}),
      at: Date.now(),
      error: error.message || String(error),
    };
  } finally {
    state.hallLoading = false;
    if (state.view === 'hall') renderHall();
  }
}

function selectHallSection(section) {
  hallSection = section;
  hallFilter = 'all';
  hallQuery = '';
  if (ui.hallSearch) ui.hallSearch.value = '';
  if (inHall()) {
    setView('hall');
    window.scrollTo({ top: 0 });
  } else {
    try { sessionStorage.setItem('parlor-hall-filter', section); } catch {}
    void goRoom('hall');
  }
}

function renderHallSection() {
  const discover = hallSection === 'all';
  const mine = hallSection === 'mine';
  ui.viewHall.classList.toggle('is-collection', !discover);
  ui.hallEyebrow.hidden = !discover;
  ui.hallTitle.textContent = discover ? '今晚，来一局。' : mine ? '我的客厅' : '收藏的地方';
  ui.hallDescription.textContent = discover ? '找个舒服的位置，和朋友、Coo 一起把时间慢下来。'
    : mine ? '你创建或加入的客厅，都在这里。' : '喜欢的客厅，随时回来坐坐。';
  ui.hallHero.hidden = !discover;
  ui.hallPeople.hidden = !discover;
  ui.hallCreate.hidden = !discover && !mine;
  ui.createShortcut.hidden = !discover && !mine;
  ui.hallRoomsNote.hidden = !discover;
  ui.hallSearch.placeholder = discover ? '搜索客厅名字、话题…' : mine ? '搜索我的客厅…' : '搜索收藏的客厅…';
  ui.hallSearch.setAttribute('aria-label', discover ? '搜索客厅' : mine ? '搜索我的客厅' : '搜索收藏的客厅');
  // 公告仍由同一订阅维护，只在发现页占据首屏；切换范围不标记已读。
  ui.hallAnnouncement.classList.toggle('collection-hidden', !discover);
  for (const button of ui.clubNav.querySelectorAll('[data-section]')) {
    const active = button.dataset.section === hallSection;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  for (const button of ui.viewHall.querySelectorAll('[data-filter]')) {
    const active = button.dataset.filter === hallFilter;
    button.classList.toggle('is-active', active); button.setAttribute('aria-pressed', String(active));
  }
  renderClubNav();
  syncFeaturedRotation();
}

function renderHall() {
  if (!ui.hallRoomsList) return;
  renderHallSection();
  const data = state.hallData;
  const hall = data && data.hall;
  clear(ui.hallPeopleRow);
  clear(ui.hallRoomsList);
  ui.hallRoomsTitle.textContent = hallSection === 'all' ? '客厅' : '客厅列表';
  if (data && data.error && !hall) {
    ui.hallPeopleCount.textContent = '';
    ui.hallRoomsList.append(el('p', 'warn', '取不到大厅：' + data.error));
    return;
  }
  if (!hall) {
    ui.hallPeopleCount.textContent = '';
    ui.hallRoomsList.append(el('p', 'muted', '正在加载客厅…'));
    return;
  }
  const seats = hall.seats || [];
  // 「大厅里」只显示在线的。看这一页的人必坐在大厅（inHall），网页快照的 online 恰好就是大厅那份；
  // 快照还没到（SSE 未连）时不筛，照旧全显示，免得闪一下空列表。掉线的人最多 20 秒后才消失。
  const online = state.snap && Array.isArray(state.snap.online) ? state.snap.online : null;
  const visible = online ? seats.filter((seat) => online.includes(seat.id)) : seats;
  ui.hallPeopleCount.textContent = visible.length + ' 人';
  if (!visible.length) ui.hallPeopleRow.append(el('p', 'muted', online ? '大厅里现在没有在线的人。' : '大厅里现在没人。'));
  for (const seat of visible) {
    const chip = hallSeatChip(seat);
    if (visible.filter(other => other.name.toLowerCase() === seat.name.toLowerCase()).length > 1) chip.classList.add('has-same-name');
    ui.hallPeopleRow.append(chip);
  }
  const allRooms = (data.rooms || []).filter((room) => !room.archived);
  const scopedRooms = allRooms.filter(room => hallSection === 'mine' ? room.mine
    : hallSection === 'favorites' ? club.isFavorite(room.id) : true);
  const query = hallQuery.trim().toLocaleLowerCase();
  const rooms = scopedRooms.filter(room => {
    if (query && !(room.name + ' ' + (room.topic || '')).toLocaleLowerCase().includes(query)) return false;
    if (hallFilter === 'ddz' || hallFilter === 'werewolf') return (room.games || []).includes(hallFilter);
    return true;
  });
  featuredCarousel.setRooms(allRooms);
  syncFeaturedRotation();
  if (hallSection !== 'all') ui.hallRoomsTitle.textContent = `${rooms.length} 间客厅`;
  if (!rooms.length) {
    const empty = el('div', 'club-empty');
    const filtered = !!query || hallFilter !== 'all';
    empty.append(el('p', '', filtered ? '没有找到符合条件的客厅，试试其他关键词或游戏。'
      : hallSection === 'mine' ? '你还没有创建或加入客厅，先去发现一间喜欢的吧。'
      : hallSection === 'favorites' ? '还没有收藏的客厅。在客厅卡片上点一下星标，下次就能在这里找到。'
      : '还没有客厅，开一间等朋友吧。'));
    if (filtered) empty.append(btn('清除筛选', () => {
      hallQuery = ''; hallFilter = 'all'; ui.hallSearch.value = ''; renderHall();
    }, { ghost: true, small: true }));
    else if (hallSection !== 'all') empty.append(btn('去发现客厅 ↗', () => selectHallSection('all'), { ghost: true, small: true }));
    ui.hallRoomsList.append(empty);
  }
  for (const room of rooms) ui.hallRoomsList.append(hallRoomRow(room));
  if (data.error) ui.hallRoomsList.append(el('p', 'warn', '刷新失败：' + data.error));
}

function syncFeaturedRotation() {
  featuredCarousel.setActive(state.shell && state.view === 'hall' && hallSection === 'all' && !document.hidden && !state.sheet);
}

function renderFeaturedRoom(model) {
  if (!ui.hallHero?.isConnected) return;
  if (!ui.featured) {
    const copy = el('div', 'club-hero-copy');
    const kicker = el('span', 'eyebrow'), title = el('h2'), description = el('p'), meta = el('p', 'club-hero-meta');
    const enter = btn('', () => {
      const room = featuredCarousel.snapshot().current;
      if (room) void goRoom(room.id);
      else if (state.hallData?.rooms?.length) ui.hallRoomsList.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else ui.hallCreateName.focus();
    }, { primary: true });
    copy.append(kicker, title, description, meta, enter);
    const controls = el('div', 'club-carousel-controls');
    const status = el('span', 'club-carousel-status');
    const previous = btn('←', () => featuredCarousel.move(-1), { ghost: true, small: true });
    previous.setAttribute('aria-label', '上一个热门客厅');
    const next = btn('→', () => featuredCarousel.move(1), { ghost: true, small: true });
    next.setAttribute('aria-label', '下一个热门客厅');
    const pause = btn('', () => featuredCarousel.setPaused(!featuredCarousel.snapshot().paused), { ghost: true, small: true });
    const dots = el('div', 'club-carousel-dots');
    dots.setAttribute('aria-label', '选择热门客厅');
    controls.append(status, previous, dots, next, pause);
    const art = clubScene('ddz', true);
    ui.hallHero.replaceChildren(copy, art, controls);
    ui.featured = { kicker, title, description, meta, enter, controls, status, pause, dots, art, dotKey: '' };
  }
  const nodes = ui.featured, room = model.current;
  nodes.kicker.textContent = room ? '热闹正在发生  /  PARLOR CLUB' : '留个位置，慢慢相聚  /  PARLOR CLUB';
  nodes.title.textContent = room ? room.name : '好朋友，也可以是新朋友。';
  nodes.description.textContent = room?.topic || '先在客厅聊聊天，再选一张喜欢的桌。人和 Coo，都有自己的座位。';
  nodes.meta.hidden = !room;
  nodes.meta.textContent = room ? `${room.seats} / ${room.capacity} 人在客厅 · ${room.tableCount ?? '—'} 张桌` : '';
  nodes.enter.textContent = room ? '走进这间客厅  ↗' : state.hallData?.rooms?.length ? '逛逛客厅  ↘' : '开一间客厅';
  nodes.controls.hidden = model.rooms.length < 2;
  nodes.status.textContent = `${model.index + 1} / ${model.rooms.length} · 每 6 秒轮换`;
  nodes.pause.textContent = model.paused ? '开始轮播' : '暂停轮播';
  nodes.pause.setAttribute('aria-label', model.paused ? '开始热门客厅自动轮播' : '暂停热门客厅自动轮播');
  const key = model.rooms.map(entry => entry.id).join('|');
  if (nodes.dotKey !== key) {
    nodes.dotKey = key; clear(nodes.dots);
    if (model.rooms.length <= 7) model.rooms.forEach((entry, index) => {
      const dot = el('button', 'club-carousel-dot'); dot.type = 'button';
      dot.setAttribute('aria-label', '推荐客厅：' + entry.name);
      dot.addEventListener('click', () => featuredCarousel.select(index)); nodes.dots.append(dot);
    });
  }
  [...nodes.dots.children].forEach((dot, index) => {
    dot.setAttribute('aria-current', index === model.index ? 'true' : 'false');
    dot.setAttribute('aria-label', '推荐客厅：' + model.rooms[index].name);
  });
  ui.hallHero.classList.toggle('has-carousel', model.rooms.length > 1);
}

function hallSeatChip(seat) {
  const chip = el('span', 'member-chip');
  chip.append(avatarNode(seat.id, 'avatar-xs', { name: seat.name, online: true }));
  const copy = el('span');
  const small = el('small', '', KIND_LABELS[seat.kind] || seat.kind);
  if (seat.handle) small.append(el('span', 'member-handle', ' · #' + seat.handle));
  copy.append(
    el('strong', '', seat.name + (state.snap && seat.id === state.snap.seat.id ? '（你）' : '')),
    small,
  );
  chip.append(copy);
  if (seat.kind === 'pet') chip.append(el('span', 'tag tag-coo', 'Coo'));
  return chip;
}

function hallRoomRow(room) {
  const row = el('article', 'club-room-card');
  const art = clubScene((room.games || []).includes('werewolf') ? 'werewolf' : 'ddz');
  const favorite = btn(club.isFavorite(room.id) ? '★' : '☆', () => {
    club.toggleFavorite(room.id); renderHall();
  }, { ghost: true, small: true });
  favorite.classList.add('club-favorite');
  favorite.setAttribute('aria-label', (club.isFavorite(room.id) ? '取消收藏 ' : '收藏 ') + room.name);
  favorite.setAttribute('aria-pressed', String(club.isFavorite(room.id)));
  const text = el('div', 'club-room-copy');
  const visibility = room.visibility === 'public' ? '公开'
    : room.visibility === 'unlisted' ? '不公开' : '私密';
  text.append(
    el('span', 'eyebrow', visibility + '客厅'),
    el('h3', '', room.name),
    el('p', '', room.topic || '牌可以慢慢打，话也可以慢慢聊。'),
  );
  const foot = el('div', 'club-room-foot');
  foot.append(el('span', '', `${room.seats} / ${room.capacity} 人 · ${room.tableCount ?? '—'} 桌`),
    btn('进客厅 ↗', () => void goRoom(room.id), { ghost: true, small: true }));
  text.append(foot); row.append(art, favorite, text);
  return row;
}

/** Pure CSS/SVG illustration; every displayed player/count comes from the server. */
function clubScene(game, large = false) {
  const scene = el('div', 'club-scene' + (game === 'werewolf' ? ' is-night' : '') + (large ? ' is-large' : ''));
  scene.setAttribute('aria-hidden', 'true');
  const felt = el('div', 'club-felt');
  if (game === 'werewolf') felt.append(el('span', 'club-moon', '☾'));
  else {
    for (const value of ['A♠', 'K♥', 'Q♣']) felt.append(el('span', 'club-playing-card', value));
  }
  scene.append(el('span', 'club-orbit', '✳'), felt, el('span', 'club-scene-label', 'GOOD COMPANY. GREAT HANDS.'));
  for (let index = 0; index < (game === 'werewolf' ? 5 : 3); index++) scene.append(el('i', 'club-chair chair-' + index));
  return scene;
}

async function createHallRoom() {
  const name = ui.hallCreateName.value.trim();
  if (name.length < 2) {
    showToast('客厅名字至少两个字', 'bad');
    return;
  }
  ui.hallCreateBtn.disabled = true;
  try {
    const created = await api('/v1/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        visibility: ui.hallCreateVis.value,
        capacity: ROOM_CAPACITY,
      }),
    });
    ui.hallCreateName.value = '';
    await goRoom(created.room.id);
  } catch (error) {
    showToast(error.message || '开不了这间客厅', 'bad');
  } finally {
    ui.hallCreateBtn.disabled = false;
  }
}

function renderLobby() {
  const snap = state.snap;
  const table = snap.table;
  const signup = snap.monopoly && snap.monopoly.signup;
  const seated = snap.seats.filter((seat) => seat.kind !== 'observer').length;
  const legacy = table && !ENABLED_GAMES.includes(table.game) && table.status !== 'ended' ? table : null;
  ui.lobbyEyebrow.textContent = '客厅 / ' + seated + ' / 30 人 · ' + tableList().filter(t => t.status !== 'ended').length + ' 张桌';
  ui.lobbyTitle.textContent = snap.name || '客厅';
  ui.lobbySub.textContent = snap.topic || '想玩就坐下来，想聊就留一会儿。';
  const tables = tableList().filter(table => table.status !== 'abandoned');
  const cardsKey = JSON.stringify([myTableId(), tables.map(table => [tableIdOf(table), table.status, table.label,
    (table.seats || []).map(seat => [seat.id, seat.name, seat.bot])])]);
  if (ui.roomTables.dataset.snapshot !== cardsKey) {
    ui.roomTables.dataset.snapshot = cardsKey;
    clear(ui.roomTables);
    for (const table of tables) ui.roomTables.append(clubTableCard(table));
    if (!tables.length) ui.roomTables.append(el('p', 'club-empty', '桌子还空着。选个游戏，开一桌等朋友。'));
    clear(ui.gameGrid);
    for (const game of ENABLED_GAMES) ui.gameGrid.append(lobbyCard(game));
  }
  if (!ui.guide.childElementCount) renderGuides();
  clear(ui.lobbyNotice);
  if (legacy) ui.lobbyNotice.append(legacyNotice(legacy));
  if (signup) ui.lobbyNotice.append(signupNotice(signup));
  renderMembers();
}

function clubTableCard(table) {
  const id = tableIdOf(table);
  const card = el('article', 'club-table-card' + (table.game === 'werewolf' ? ' is-night' : ''));
  const seats = table.seats || [];
  const capacity = table.game === 'werewolf' ? 9 : table.game === 'ddz' ? 3 : 4;
  const header = el('div', 'club-section-head');
  header.append(el('span', '', gameLabel(table.game)), el('span', 'muted', `${seats.length} / ${capacity} 席`));
  const scene = clubScene(table.game);
  const avatars = el('div', 'club-table-avatars');
  for (const seat of seats.slice(0, 9)) avatars.append(avatarNode(seat.id, 'avatar-sm', { name: seat.name }));
  scene.append(avatars);
  const copy = el('div', 'club-table-copy');
  copy.append(el('h3', '', table.label || gameLabel(table.game)), el('small', 'muted', '桌号 ' + id),
    el('p', '', (STATUS_LABELS[table.status] || table.status) + ' · ' + (seats.map(seat => seat.name).join('、') || '等待朋友入座')));
  const mine = seats.some(seat => seat.id === state.snap.seat.id);
  const open = table.status === 'open';
  const ended = table.status === 'ended';
  const actions = el('div', 'club-room-foot');
  const enter = () => { state.watchTableId = id; setView('table'); setTab(mine ? 'table' : 'room'); };
  if (open && !mine && !myTable()) {
    actions.append(btn('入座一起玩 ↗', () => actAndGo({ type: 'table_join', table: id }), { primary: true, small: true, disabled: seats.length >= capacity }));
  }
  actions.append(btn(mine ? '回到我的桌 ↗' : ended ? '查看结果 ↗' : '围观这桌 ↗', enter, { ghost: true, small: true }));
  copy.append(actions); card.append(header, scene, copy); return card;
}

/** 大厅底部的玩法说明：每张启用的桌子一段，文案在 games/registry.js 的 guide 里。 */
function renderGuides() {
  clear(ui.guide);
  for (const game of ENABLED_GAMES) {
    const def = gameOf(game);
    if (!def || !Array.isArray(def.guide) || !def.guide.length) continue;
    ui.guide.append(el('h2', '', def.label + ' · 怎么玩'));
    const list = el('ul', 'guide-list');
    for (const line of def.guide) list.append(el('li', '', line));
    ui.guide.append(list);
  }
  const hidden = Object.keys(GAMES).filter((id) => !GAMES[id].enabled);
  if (hidden.length) {
    ui.guide.append(el('p', 'guide-note',
      hidden.map((id) => gameLabel(id)).join(' / ') + ' 先收起来了；等主推的游戏打磨好再加回来。'));
  }
  ui.guide.hidden = !ui.guide.children.length;
}

function legacyNotice(table) {
  const box = el('div', 'legacy-notice');
  const copy = el('div');
  copy.append(el('strong', '', gameLabel(table.game) + ' 已收起'));
  copy.append(el('p', 'muted', '桌上还有一局没结束；先把这局打完，再回来开' + gameLabel(heroGame()) + '。'));
  box.append(copy, btn('去牌桌', () => setView('table'), { small: true }));
  return box;
}

function lobbyCard(game) {
  const def = gameOf(game);
  if (!def) return el('div');
  const mine = myTable();
  const occupied = !!mine && mine.status !== 'ended';
  const same = occupied && mine.game === game;
  const card = el('article', 'game-card game-card-live game-card-hero');
  const body = el('div', 'game-card-body');
  body.append(el('span', 'eyebrow', same ? '我的牌桌' : '开一张新桌'), el('h2', '', def.label), el('p', '', def.blurb));
  const foot = el('div', 'game-card-foot');
  foot.append(el('span', 'muted', def.foot));
  if (same) {
    foot.append(btn('回到我的桌', () => { watchMine(); setView('table'); }, { primary: true, small: true }));
    if (mine.status === 'open') foot.append(btn(mine.host === state.snap.seat.id ? '收桌' : '退桌',
      () => actAndGo({ type: 'table_leave' }, 'lobby'), { ghost: true, small: true }));
  } else {
    foot.append(btn('开一桌', () => actAndGo({ type: 'table_open', game }), {
      primary: true, small: true, disabled: occupied,
      title: occupied ? '先结束或离开自己的牌桌' : '',
    }));
  }
  body.append(foot); card.append(body); return card;
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
    if (snap.seats.filter(other => other.name.toLowerCase() === seat.name.toLowerCase()).length > 1) chip.classList.add('has-same-name');
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
    if (seat.handle) small.append(el('span', 'member-handle', ' · #' + seat.handle));
    copy.append(name, small);
    chip.append(copy);
    if (seat.kind === 'pet') chip.append(el('span', 'tag tag-coo', 'Coo'));
    if (seat.id === snap.seat.id) chip.append(el('span', 'tag tag-you', '你'));
    ui.memberRow.append(chip);
  }
}

/* —— 聊天 —— */

function renderChat() {
  syncConversation();
  renderChatBadges();
  syncChatTabs();
  const tab = state.tab;
  if (ui.chatEyebrow) ui.chatEyebrow.textContent = inHall() ? '大厅' : '客厅 · 牌桌';
  if (ui.tabRoom && ui.tabRoom.labelNode) {
    ui.tabRoom.labelNode.textContent = inHall() ? '大厅' : '客厅';
  }
  if (ui.backRoom) {
    // 这个按钮只是把聊天栏切到当前所在的频道，不是换客厅；已经在这一栏就不用显示。
    ui.backRoom.textContent = inHall() ? '切到大厅' : '切回客厅';
    ui.backRoom.hidden = tab === 'room';
  }
  ui.composer.hidden = tab === 'mail';
  ui.mailNote.hidden = tab !== 'mail';
  ui.markRead.hidden = tab !== 'mail' || ((state.snap && state.snap.mailUnread) || 0) <= 0;
  const canTableTalk = tableChatOpen();
  ui.sayInput.disabled = tab === 'table' && !canTableTalk;
  ui.sendBtn.disabled = ui.sayInput.disabled;
  if (tab === 'room') {
    ui.scopeText.textContent = inHall()
      ? '发到大厅 · 大厅里的人都看得见'
      : '发到客厅 · 房间里的人都看得见';
    ui.sayInput.placeholder = inHall() ? '在大厅说点什么…' : '在客厅说点什么…';
    ui.sayInput.title = '';
  } else if (tab === 'table') {
    if (canTableTalk) {
      const watching = activeTable();
      const mine = myTable();
      const elsewhere = !!watching && !!mine && tableIdOf(watching) !== tableIdOf(mine);
      if (elsewhere) {
        // 看着别人的桌时，牌桌聊天仍然发回我自己的那张桌，输入框里说明白。
        ui.scopeText.textContent = '只发到我的桌 · 你现在看的是另一桌';
        ui.sayInput.placeholder = '对同桌说点什么…（发到我的「' + tableTitle(mine) + '」）';
        ui.sayInput.title = '我的桌：' + tableIdOf(mine);
      } else {
        ui.scopeText.textContent = '只发到这一桌 · 客厅和不在桌上的人看不见';
        ui.sayInput.placeholder = '对同桌说点什么…';
        ui.sayInput.title = '';
      }
    } else {
      ui.scopeText.textContent = activeTable()?.game === 'werewolf' && activeTable()?.status !== 'open'
        ? '狼人杀进行中 · 发言和狼聊请使用游戏内面板'
        : '围观只读 · 聊天请切到「客厅」';
      ui.sayInput.placeholder = '当前桌聊不可用';
      ui.sayInput.title = '';
    }
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
  const chatCount = counts.room + counts.table + counts.mail;
  ui.navChat.badge.textContent = String(chatCount);
  ui.navChat.badge.hidden = chatCount <= 0;
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
  if (view === 'hall' && !inHall()) {
    // 大厅是服务器上的一个位置，不是本地一张页面：离开客厅要过服务器（牌局进行中会被拦住）。
    void goRoom('hall');
    return;
  }
  if ((view === 'lobby' || view === 'table') && inHall()) {
    showToast('先在大厅挑一间客厅进去。');
    return;
  }
  state.view = view;
  if (view === 'table') state.tab = activePrivate() ? 'table' : 'room';
  else if (state.tab !== 'mail') state.tab = 'room';
  writeRoute();
  syncViewButtons();
  if (state.sheet === 'me') closeSheet();
  if (view === 'hall') void loadHall();
  render();
}

function currentDraftKey() {
  return conversationKey(state.cfg?.cooId || state.cfg?.seatId, currentRoom(), state.tab, tableIdOf(activeTable()));
}

function eventMatchesChatTable(event) {
  const id = tableIdOf(activeTable());
  const eventId = event.data && event.data.tableId;
  return !!activePrivate() && (!eventId ? !id : eventId === id);
}

function syncConversation() {
  if (!ui.sayInput) return;
  const next = currentDraftKey();
  if (next !== draftScope) {
    if (draftScope) club.saveDraft(draftScope, ui.sayInput.value);
    draftScope = next;
    ui.sayInput.value = club.draft(next);
  }
  const tableScope = conversationKey(state.cfg?.cooId || state.cfg?.seatId, currentRoom(), 'table', tableIdOf(activeTable()))
    + ':' + !!activePrivate();
  if (tableScope !== tableChatScope) {
    tableChatScope = tableScope;
    clear(ui.logTable);
    for (const event of state.log) {
      if (isTableBucket(event) && eventMatchesChatTable(event)) {
        const node = lineOf(event, true); if (node) ui.logTable.append(node);
      }
    }
    if (!ui.logTable.children.length) ui.logTable.append(el('p', 'chat-empty', activePrivate() ? '同桌的话，留在这一桌。' : '围观不开放同桌聊天。'));
  }
  ui.sayInput.setAttribute('aria-label', state.tab === 'table' ? '发送到当前牌桌' : inHall() ? '发送到大厅' : '发送到当前客厅');
}

function syncChatCollapse() {
  if (!ui.layout) return;
  const desktop = window.matchMedia('(min-width: 1101px)').matches;
  ui.layout.classList.toggle('chat-collapsed', desktop && !club.chatOpen);
  const expanded = desktop ? club.chatOpen : state.sheet === 'chat';
  ui.chatToggle.setAttribute('aria-expanded', String(expanded));
  ui.chatToggle.setAttribute('aria-label', expanded ? '收起聊天侧栏' : '展开聊天侧栏');
  ui.chatToggle.replaceChildren(icon('chat'), el('span', 'chat-toggle-label', expanded ? '收起聊天' : '打开聊天'));
  window.dispatchEvent(new Event('resize'));
}

function toggleChat(force) {
  const desktop = window.matchMedia('(min-width: 1101px)').matches;
  const next = force ?? !(desktop ? club.chatOpen : state.sheet === 'chat');
  if (desktop) club.setChatOpen(next);
  else club.setMobileChatOpen(next);
  if (!desktop) { if (next) openSheet('chat'); else closeSheet(); }
  syncChatCollapse();
  if (next && (state.tab === 'room' || state.tab === 'table')) state.unread[state.tab] = 0;
  renderChatBadges();
}

function writeRoute(replace = false) {
  const url = routeUrl(currentRoom(), state.view, state.view === 'table' ? tableIdOf(activeTable()) : '');
  if (location.pathname + location.search === url && !replace) return;
  history[replace ? 'replaceState' : 'pushState']({ parlor: true }, '', url);
}

function renderClubNav() {
  if (!ui.breadcrumb) return;
  const signature = [currentRoom(), state.snap?.name, state.view, tableIdOf(activeTable()), hallSection].join('|');
  if (signature === crumbSignature) return;
  crumbSignature = signature;
  clear(ui.breadcrumb);
  ui.breadcrumb.append(btn('大厅', () => selectHallSection('all'), { ghost: true, small: true }));
  if (!inHall()) {
    ui.breadcrumb.append(el('span', '', '/'), btn(state.snap.name || '客厅', () => setView('lobby'), { ghost: true, small: true }));
    if (state.view === 'table') ui.breadcrumb.append(el('span', '', '/'), el('span', '', activeTable() ? tableTitle(activeTable()) : '牌桌'));
  } else ui.breadcrumb.append(el('span', '', '/ ' + (hallSection === 'mine' ? '我的客厅' : hallSection === 'favorites' ? '收藏的地方' : '发现客厅')));
}

async function inviteToRoom() {
  const url = location.origin + routeUrl(currentRoom(), 'lobby');
  try { await navigator.clipboard.writeText(url); showToast('客厅链接已复制；朋友进入后再选桌。私密厅仍需成员邀请。'); }
  catch { prompt('复制客厅链接（私密厅还需要成员邀请）', url); }
}

window.addEventListener('popstate', async () => {
  if (!state.shell || roomSwitching) return;
  const route = readRoute(location.search);
  if (route.room && route.room !== currentRoom()) {
    if (!await goRoom(route.room, { replace: true })) writeRoute(true);
    return;
  }
  state.watchTableId = route.table; normalizeWatch();
  state.view = inHall() ? 'hall' : route.view;
  state.tab = state.view === 'table' && activePrivate() ? 'table' : 'room';
  syncViewButtons(); render();
});
window.addEventListener('pagehide', () => { featuredCarousel.setActive(false); if (draftScope && ui.sayInput) club.saveDraft(draftScope, ui.sayInput.value); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
window.matchMedia('(min-width: 1101px)').addEventListener('change', () => { closeSheet({ preserveChat: true }); syncChatCollapse(); });

function syncViewButtons() {
  for (const node of (ui.viewButtons || [])) {
    const active = node.dataset.view === state.view;
    node.classList.toggle('is-active', active);
    node.setAttribute('aria-selected', active ? 'true' : 'false');
  }
}

function syncNav() {
  let active = null;
  if (state.sheet === 'chat') active = 'chat';
  else if (state.sheet === 'me') active = null;
  else if (state.view === 'hall') active = 'hall';
  else if (state.view === 'lobby') active = 'room';
  else if (state.view === 'table') active = 'table';
  for (const [key, node] of [
    ['hall', ui.navHall], ['room', ui.navRoom], ['table', ui.navTable], ['chat', ui.navChat],
  ]) {
    if (node) node.btn.classList.toggle('is-active', key === active);
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
    meta.append(el('strong', '', item.fromName || '系统'));
    if (item.fromHandle) meta.append(el('span', 'mail-handle', ' #' + item.fromHandle));
    meta.append(el('time', '', fmtClock(item.ts).slice(0, 5)));
    copy.append(meta, el('p', '', readable(item.text || '')), el('span', 'mail-sub', '只有你能看'));
    node.append(copy);
    if (unread) node.append(el('span', 'unread-dot'));
    if (item.kind === 'whisper' && item.fromCooId) {
      node.classList.add('is-dm');
      node.title = '点开私聊';
      node.addEventListener('click', () => openDm(item.fromCooId, item.fromName, item.fromHandle));
    }
    // 邀请：私密客厅的邀请要先「接受」才有权限，接受后直接过去；
    // 老式邀请（没有 invitationId）只带目的地，点「进去」走一次换房。
    if (item.kind === 'invite' && item.action === 'room_invite' && item.invitationId) {
      node.classList.add('is-invite');
      const actions = el('div', 'mail-actions');
      actions.append(
        btn('接受并进去', () => { void acceptRoomInvite(item); }, { primary: true, small: true }),
        btn('拒绝', () => { void declineRoomInvite(item); }, { ghost: true, small: true }),
      );
      copy.append(actions);
    } else if (item.kind === 'invite' && item.room) {
      node.classList.add('is-invite');
      if (currentRoom() === item.room) {
        copy.append(el('span', 'mail-sub', '你现在就在这儿'));
      } else {
        const go = el('button', 'ghost-btn mail-go', '进去');
        go.type = 'button';
        go.addEventListener('click', () => { void goRoom(item.room); });
        copy.append(go);
      }
    }
    ui.mailList.append(node);
  });
  if (mail.unread > mail.items.length) {
    ui.mailList.append(el('p', 'chat-empty', '还有 ' + (mail.unread - mail.items.length) + ' 封未读。'));
  }
}

/** 邀请处理失败的共同说法：403 不是你的，409 过期/处理过了。 */
function inviteErrorText(error) {
  const status = error && error.status;
  if (status === 403) return '这个邀请不是给你的';
  if (status === 409) return '这个邀请已经过期或处理过了';
  if (status === 404) return '这个邀请不存在或已经失效';
  return (error && error.message) || '处理不了这个邀请';
}

/** 接受私密客厅邀请：先拿到授权，再换到这个客厅。 */
async function acceptRoomInvite(item) {
  try {
    const result = await api('/v1/invitations/' + encodeURIComponent(item.invitationId) + '/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const room = (result && result.room) || item.room;
    if (!room) throw new Error('这封邀请没有目的地');
    state.mail = null;
    await loadMail(true);
    if (room === currentRoom()) {
      showToast('你现在就在这个客厅里。');
      return;
    }
    showToast('接受了，正在进这个客厅…');
    await goRoom(room);
  } catch (error) {
    showToast(inviteErrorText(error), 'bad');
    state.mail = null;
    await loadMail(true);
  }
}

async function declineRoomInvite(item) {
  try {
    await api('/v1/invitations/' + encodeURIComponent(item.invitationId) + '/decline', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    showToast('已经拒绝这个邀请');
  } catch (error) {
    showToast(inviteErrorText(error), 'bad');
  } finally {
    state.mail = null;
    await loadMail(true);
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
  if (which === 'chat' && window.matchMedia('(min-width: 1101px)').matches) {
    club.setChatOpen(true); syncChatCollapse();
    state.sheet = null; syncSheet(); return;
  }
  state.sheet = which;
  if (which === 'chat') club.setMobileChatOpen(true);
  sheetFocus = document.activeElement;
  syncSheet();
  requestAnimationFrame(() => {
    const panel = which === 'chat' ? ui.chatPanel : ui.leftRail;
    panel.querySelector('button:not(:disabled),input:not(:disabled)')?.focus({ preventScroll: true });
  });
  if (which === 'chat') {
    // 抽屉拉开了，当前频道就算看过了；信封里的未读另有它自己的标记。
    if (state.tab === 'room' || state.tab === 'table') state.unread[state.tab] = 0;
    renderChatBadges();
    if (state.tab === 'mail') loadMail();
  }
}

function closeSheet(options = {}) {
  const wasOpen = !!state.sheet;
  if (state.sheet === 'chat' && !options.preserveChat) club.setMobileChatOpen(false);
  state.sheet = null;
  syncSheet();
  if (wasOpen && sheetFocus?.isConnected) sheetFocus.focus({ preventScroll: true });
}

function syncSheet() {
  if (!ui.backdrop) return;
  const open = !!state.sheet;
  ui.leftRail.classList.toggle('is-open', state.sheet === 'me');
  ui.chatPanel.classList.toggle('is-open', state.sheet === 'chat');
  for (const [panel, active] of [[ui.leftRail, state.sheet === 'me'], [ui.chatPanel, state.sheet === 'chat']]) {
    if (active) { panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); }
    else { panel.removeAttribute('role'); panel.removeAttribute('aria-modal'); }
  }
  ui.backdrop.hidden = !open;
  if (open) requestAnimationFrame(() => ui.backdrop.classList.add('is-show'));
  else ui.backdrop.classList.remove('is-show');
  document.body.classList.toggle('sheet-open', open);
  if (ui.chatToggle && !window.matchMedia('(min-width: 1101px)').matches) {
    ui.chatToggle.setAttribute('aria-expanded', String(state.sheet === 'chat'));
    ui.chatToggle.setAttribute('aria-label', state.sheet === 'chat' ? '收起聊天侧栏' : '展开聊天侧栏');
    ui.chatToggle.replaceChildren(icon('chat'), el('span', 'chat-toggle-label', state.sheet === 'chat' ? '收起聊天' : '打开聊天'));
  }
  syncNav();
  syncFeaturedRotation();
}

document.addEventListener('keydown', event => {
  if (!state.sheet) return;
  if (event.key === 'Escape') { event.preventDefault(); closeSheet(); return; }
  if (event.key !== 'Tab') return;
  const panel = state.sheet === 'chat' ? ui.chatPanel : ui.leftRail;
  const nodes = [...panel.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')]
    .filter(node => node.getClientRects().length && !node.closest('[hidden]'));
  if (!nodes.length) return;
  const first = nodes[0], last = nodes[nodes.length - 1];
  if (!panel.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
  else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

/* —— 换客厅 —— */

let roomsDialog = null;
let roomsList = null;
let roomsStatus = null;

function ensureRoomsDialog() {
  if (roomsDialog) return;
  roomsDialog = el('dialog', 'rooms-dialog');
  roomsDialog.setAttribute('aria-label', '换客厅');
  const box = el('div', 'rooms-box');
  const head = el('div', 'rooms-head');
  const title = el('h2', '', '去哪个客厅');
  const close = btn('关闭', () => roomsDialog.close(), { ghost: true, small: true });
  head.append(title, close);
  roomsStatus = el('p', 'rooms-status muted', '');
  roomsList = el('div', 'rooms-list');
  const create = el('div', 'rooms-create');
  create.append(el('h3', '', '开一间新的'));
  const nameInput = el('input');
  nameInput.type = 'text';
  nameInput.maxLength = 32;
  nameInput.placeholder = '客厅名字（2–32 个字）';
  const visInput = el('select');
  for (const [value, label] of [['public', '公开'], ['unlisted', '不公开'], ['private', '私密']]) {
    const option = el('option', '', label);
    option.value = value;
    visInput.append(option);
  }
  const capInput = el('span', 'muted', '固定 30 人');
  const createBtn = btn('开一间', async () => {
    const name = nameInput.value.trim();
    if (name.length < 2) {
      showToast('客厅名字至少两个字', 'bad');
      return;
    }
    createBtn.disabled = true;
    try {
      const created = await api('/v1/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          visibility: visInput.value,
          capacity: ROOM_CAPACITY,
        }),
      });
      await goRoom(created.room.id);
    } catch (error) {
      showToast(error.message || '开不了这间客厅', 'bad');
    } finally {
      createBtn.disabled = false;
    }
  }, { small: true, primary: true });
  create.append(nameInput, visInput, capInput, createBtn);
  box.append(head, roomsStatus, roomsList, create);
  roomsDialog.append(box);
  roomsDialog.addEventListener('click', (event) => {
    if (event.target === roomsDialog) roomsDialog.close();
  });
  document.body.append(roomsDialog);
}

async function openRooms() {
  ensureRoomsDialog();
  roomsStatus.textContent = '正在取客厅目录…';
  clear(roomsList);
  if (typeof roomsDialog.showModal === 'function') {
    if (!roomsDialog.open) roomsDialog.showModal();
  } else {
    roomsDialog.setAttribute('open', '');
  }
  try {
    const [hall, directory] = await Promise.all([api('/v1/hall'), api('/v1/rooms?all=1')]);
    const here = (state.snap && state.snap.id) || currentRoom();
    roomsStatus.textContent = hall.me ? '选一个客厅过去；串门会释放现在的席位。' : '';
    const rows = [
      { id: 'hall', name: '大厅', sub: `${(hall.hall.seats || []).length} 人 · 入口` },
      ...(directory.rooms || []).map((room) => ({
        id: room.id,
        name: room.name,
        sub: `${room.seats}/${room.capacity} 人 · ${room.visibility === 'public' ? '公开' : room.visibility === 'unlisted' ? '不公开' : '私密'}${room.topic ? ' · ' + room.topic : ''}`,
      })),
    ];
    for (const row of rows) {
      const node = el('button', 'rooms-row');
      node.type = 'button';
      const text = el('span', 'rooms-row-text');
      text.append(el('strong', '', row.name), el('small', '', row.sub));
      node.append(text);
      if (row.id === here) {
        node.classList.add('is-here');
        node.append(el('span', 'rooms-here', '这里'));
      } else {
        node.append(icon('arrow'));
      }
      node.addEventListener('click', () => { void goRoom(row.id); });
      roomsList.append(node);
    }
  } catch (error) {
    roomsStatus.textContent = error.message || '取不到客厅目录';
  }
}

async function goRoom(id, options = {}) {
  if (!state.cfg) return;
  if (roomSwitching || state.busy) { showToast('正在处理动作，请稍等再换客厅。'); return false; }
  const from = (state.snap && state.snap.id) || currentRoom();
  if (!from) {
    showToast('还没进过客厅，先加入一个', 'bad');
    return;
  }
  if (id === from) {
    if (roomsDialog) roomsDialog.close();
    return true;
  }
  roomSwitching = true;
  try {
    const moved = await api(`/v1/rooms/${encodeURIComponent(from)}/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: id }),
    });
    writeStore({
      ...state.cfg,
      room: moved.room,
      token: moved.token,
      seatId: moved.seat.id,
      name: moved.seat.name,
    });
    if (draftScope && ui.sayInput) club.saveDraft(draftScope, ui.sayInput.value);
    const target = routeUrl(moved.room, 'lobby');
    if (options.replace) location.replace(target);
    else location.assign(target);
    return true;
  } catch (error) {
    showToast(error.message || '换不了客厅', 'bad');
    return false;
  } finally {
    roomSwitching = false;
  }
}

/* —— 房主：成员管理（私密厅的成员 / 邀请 / 可见性） —— */

let accessDialog = null;
let accessStatus = null;
let accessBody = null;

function accessRoomId() {
  return (state.snap && state.snap.id) || currentRoom() || '';
}

function ensureAccessDialog() {
  if (accessDialog) return;
  accessDialog = el('dialog', 'rooms-dialog');
  accessDialog.setAttribute('aria-label', '成员管理');
  const box = el('div', 'rooms-box');
  const head = el('div', 'rooms-head');
  const close = btn('关闭', () => accessDialog.close(), { ghost: true, small: true });
  head.append(el('h2', '', '成员管理'), close);
  accessStatus = el('p', 'rooms-status muted', '');
  accessBody = el('div', 'access-body');
  box.append(head, accessStatus, accessBody);
  accessDialog.append(box);
  accessDialog.addEventListener('click', (event) => {
    if (event.target === accessDialog) accessDialog.close();
  });
  document.body.append(accessDialog);
}

async function openAccess() {
  if (inHall()) return;
  ensureAccessDialog();
  if (typeof accessDialog.showModal === 'function') {
    if (!accessDialog.open) accessDialog.showModal();
  } else {
    accessDialog.setAttribute('open', '');
  }
  await loadAccess();
}

async function loadAccess() {
  const room = accessRoomId();
  clear(accessBody);
  accessStatus.classList.remove('bad');
  if (!room) {
    accessStatus.textContent = '还没进过客厅。';
    return;
  }
  accessStatus.textContent = '正在取成员…';
  try {
    const data = await api('/v1/rooms/' + encodeURIComponent(room) + '/access');
    accessStatus.textContent = '';
    renderAccess(data || {});
  } catch (error) {
    clear(accessBody);
    accessStatus.textContent = error && error.status === 403
      ? '只有房主能管理这个客厅'
      : (error && error.message) || '取不到成员';
    accessStatus.classList.add('bad');
  }
}

function renderAccess(data) {
  clear(accessBody);
  const visibility = data.room && data.room.visibility ? data.room.visibility : 'public';
  accessBody.append(el('p', 'access-owner',
    '房主：' + (data.owner ? data.owner.name : '—')));

  // 现在在厅里：按活跃席位来，公开厅也能看见来客并请出去。
  const seats = data.seats || [];
  const seatBox = el('section', 'access-section');
  seatBox.append(el('h3', '', '现在在厅里'));
  if (!seats.length) {
    seatBox.append(el('p', 'muted', '现在没有人在厅里。'));
  }
  for (const seat of seats) {
    const row = el('div', 'access-row');
    const who = el('span', 'access-who');
    who.append(el('strong', '', seat.name || seat.cooId));
    const tags = [KIND_LABELS[seat.kind] || seat.kind];
    if (seat.owner) tags.push('房主');
    if (seat.self) tags.push('你');
    who.append(el('small', 'muted', tags.join(' · ')));
    row.append(who);
    if (!seat.owner && !seat.self) {
      row.append(btn('请出去', () => {
        void revokeMember({ cooId: seat.cooId, name: seat.name }, '请出');
      }, { ghost: true, small: true, danger: true }));
    }
    seatBox.append(row);
  }
  seatBox.append(el('p', 'note', '公开/不列目录厅里，请出去的人还能再进来；私密厅移出就是撤销成员资格。'));
  accessBody.append(seatBox);

  const members = (data.members || []).filter((member) => member.status === 'active');
  const memberBox = el('section', 'access-section');
  memberBox.append(el('h3', '', '成员'));
  if (!members.length) {
    memberBox.append(el('p', 'muted', '还没有单独授权的人；私密客厅只有房主和被邀请的人能进。'));
  }
  for (const member of members) {
    const row = el('div', 'access-row');
    const who = el('span', 'access-who');
    who.append(el('strong', '', member.name || member.cooId));
    who.append(el('small', 'muted', member.source === 'invite' ? '接受邀请进来的' : '房主授权'));
    row.append(who);
    row.append(btn('移出', () => { void revokeMember(member); }, {
      ghost: true, small: true, danger: true,
    }));
    memberBox.append(row);
  }
  accessBody.append(memberBox);

  const invitations = data.invitations || [];
  const inviteBox = el('section', 'access-section');
  inviteBox.append(el('h3', '', '等接受的邀请'));
  if (!invitations.length) inviteBox.append(el('p', 'muted', '没有挂着的邀请。'));
  for (const invitation of invitations) {
    const row = el('div', 'access-row');
    const who = el('span', 'access-who');
    who.append(el('strong', '', invitation.targetName || invitation.targetCooId));
    who.append(el('small', 'muted', '到期 ' + fmtDateTime(invitation.expiresAt)));
    row.append(who);
    inviteBox.append(row);
  }
  accessBody.append(inviteBox);

  const inviteSection = el('section', 'access-section');
  inviteSection.append(el('h3', '', '邀请一个人'));
  const inviteRow = el('div', 'access-row');
  const inviteInput = el('input', 'access-input');
  inviteInput.type = 'text';
  inviteInput.maxLength = 40;
  inviteInput.placeholder = '对方的席位名或家长名';
  const inviteBtn = btn('邀请', () => { void invitePerson(inviteInput, inviteBtn); }, {
    primary: true, small: true,
  });
  inviteRow.append(inviteInput, inviteBtn);
  inviteSection.append(inviteRow);
  inviteSection.append(el('p', 'note', '只能邀请私密客厅；对方在网页「信箱」里点「接受并进去」。'));
  accessBody.append(inviteSection);

  const visSection = el('section', 'access-section');
  visSection.append(el('h3', '', '可见性'));
  const visRow = el('div', 'access-row');
  const select = el('select', 'access-input');
  for (const [value, label] of [['public', '公开'], ['unlisted', '不列目录'], ['private', '私密']]) {
    const option = el('option', '', label);
    option.value = value;
    select.append(option);
  }
  select.value = visibility;
  const saveBtn = btn('保存', () => { void saveVisibility(select, visibility, saveBtn); }, {
    primary: true, small: true,
  });
  visRow.append(select, saveBtn);
  visSection.append(visRow);
  visSection.append(el('p', 'note', '改成私密不会自动授权现在在厅里的人，要在这里逐个授权或邀请。'));
  accessBody.append(visSection);

  const deleteSection = el('section', 'access-section');
  deleteSection.append(el('h3', '', '删除客厅'));
  deleteSection.append(el('p', 'note', '删除后从目录移除，在场席位和未接受的邀请会失效。历史、身份和筹码保留；有未结束牌桌时不能删除。'));
  const deleteBtn = btn('删除客厅', () => { void deleteRoom(data.room, deleteBtn); }, {
    danger: true, small: true,
  });
  deleteSection.append(deleteBtn);
  accessBody.append(deleteSection);
}

async function deleteRoom(room, button) {
  if (!room || !confirm('确定删除「' + room.name + '」？在场的所有人都会离开，未接受的邀请会失效。')) return;
  button.disabled = true;
  try {
    await api('/v1/rooms/' + encodeURIComponent(room.id) + '/delete', { method: 'POST' });
    accessDialog.close();
    if (currentRoom() === room.id) {
      if (state.stream) state.stream.close();
      state.stream = null;
      clearTimeout(state.reconnect);
      clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
      clearStore();
      if (await tryParentEntry('', { room: 'hall' })) {
        if (state.cfg) location.href = '/play?room=hall';
      } else {
        await loadEntryPolicy();
        renderJoin('客厅已删除，请重新加入大厅。');
      }
    } else {
      showToast('客厅已删除');
      void loadHall(true);
    }
  } catch (error) {
    showToast(error.message || '删除失败', 'bad');
  } finally {
    button.disabled = false;
  }
}

/** verb：成员列表用「移出」，在场列表用「请出」；两处走同一个 revoke。 */
async function revokeMember(member, verb = '移出') {
  const name = member.name || member.cooId;
  if (!confirm('把「' + name + '」' + verb + '这个客厅？正在打的牌局会先托管。')) return;
  try {
    await api('/v1/rooms/' + encodeURIComponent(accessRoomId()) + '/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'revoke', cooId: member.cooId }),
    });
    showToast('已经把「' + name + '」' + verb + '去了');
    scheduleRefresh();
  } catch (error) {
    showToast(error.message || (verb === '请出' ? '请不出去' : '移不出去'), 'bad');
  }
  await loadAccess();
}

async function invitePerson(input, button) {
  const to = input.value.trim();
  if (!to) {
    showToast('先填要邀请的人', 'bad');
    return;
  }
  button.disabled = true;
  try {
    const result = await api('/v1/rooms/' + encodeURIComponent(accessRoomId()) + '/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to }),
    });
    input.value = '';
    showToast('邀请已经送到「' + ((result && result.name) || to) + '」的信箱');
  } catch (error) {
    showToast(error.message || '邀请发不出去', 'bad');
  } finally {
    button.disabled = false;
    await loadAccess();
  }
}

async function saveVisibility(select, before, button) {
  const next = select.value;
  if (next === before) {
    showToast('可见性没变');
    return;
  }
  if (next === 'private' && before !== 'private') {
    if (!confirm('改成私密后，现在在厅里、又没有单独授权的人会被请出去（正在打的牌交给脚本托管到结算）。继续吗？')) {
      select.value = before;
      return;
    }
  }
  button.disabled = true;
  try {
    await api('/v1/rooms/' + encodeURIComponent(accessRoomId()) + '/visibility', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: next }),
    });
    showToast('可见性改成「' + (next === 'public' ? '公开' : next === 'unlisted' ? '不列目录' : '私密') + '」了');
  } catch (error) {
    showToast(error.message || '改不了可见性', 'bad');
  } finally {
    await loadAccess();
  }
}

/* —— 说话 / 小工具 —— */

async function sendSay() {
  if (state.busy || roomSwitching) { showToast('正在发送，请稍等。'); return; }
  const text = ui.sayInput.value.trim();
  if (!text) return;
  // 牌桌 tab 发的是桌内私聊（只有同桌看得见）；客厅 tab 仍是全房间公开。
  const toTable = state.tab === 'table';
  if (toTable && !tableChatOpen()) {
    showToast('你不在这一桌；想去客厅说就切到「客厅」。');
    return;
  }
  const scope = draftScope;
  ui.sayInput.value = '';
  club.saveDraft(scope, '');
  try {
    await act(toTable ? { type: 'table_say', text } : { type: 'say', text });
  } catch {
    if (!club.draft(scope)) club.saveDraft(scope, text);
    if (draftScope === scope && !ui.sayInput.value) ui.sayInput.value = club.draft(scope);
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
  const table = activeTable();
  const signup = snap.monopoly && snap.monopoly.signup;
  const names = namesMap();
  ui.infoGame.textContent = table ? (table.label || gameLabel(table.game)) : (signup ? '大富翁（报名）' : '—');
  ui.infoStake.textContent = table ? (table.stake ? table.stake + ' 枚' : '不押') : '—';
  ui.infoStatus.textContent = table
    ? (STATUS_LABELS[table.status] || table.status)
    : (signup ? '报名中' : '空闲');
  ui.infoTurn.textContent = table && table.turn ? (names.get(table.turn) || '？') : '—';
  ui.ruleNote.textContent = table
    ? (RULES[table.game] || '')
    : (signup ? '大富翁正在报名；人数够了由发起人开局。' : '开一张斗地主桌，或者等 Coo 开。');
  ui.infoClock.textContent = '服务器时刻 ' + fmtClock(serverNow()).slice(0, 5) + '（UTC+8）';
}

/* —— 加入 / 离线 —— */

function renderJoin(message = '') {
  featuredCarousel.setActive(false);
  state.shell = false;
  disposeGame();
  clear(app);
  const join = el('div', 'join');
  const panel = el('section', 'panel');
  panel.append(themePicker(), brandNode());
  panel.append(el('h1', '', state.guestJoin ? '客厅 · 下场玩' : '客厅 · 入口已关闭'));
  if (!state.guestJoin) {
    panel.append(el('p', 'sub', message
      || '这个入口已经关闭。请向房主要带钥匙的「下场玩」链接；有 Coo 的话也可以让 Coo 带你进客厅。'));
    // 家长会话还有效的话，仍然给「以家长身份下场」这一条路。
    void offerParentPlay(panel);
    join.append(panel);
    app.append(join);
    return;
  }
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
  void offerParentPlay(panel);

  async function submitJoin() {
    const name = nameInput.value.trim();
    const invite = inviteInput.value.trim();
    const wantedRoom = new URLSearchParams(location.search).get('room') || '';
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
      if (state.globalIdentity) {
        beginGlobalEntry(state.globalIdentity.authority, { invite, room: wantedRoom || 'hall', name }); return;
      }
      const response = await fetch('/v1/player/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-parlor-invite': invite },
        body: JSON.stringify({ name, ...(wantedRoom ? { room: wantedRoom } : {}) }),
        ...timeoutSignal(),
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
      state.appliedSeq = 0;
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
  featuredCarousel.setActive(false);
  state.shell = false;
  disposeGame();
  clear(app);
  const join = el('div', 'join');
  const panel = el('section', 'panel');
  panel.append(themePicker(), brandNode());
  panel.append(el('h1', '', '连不上客厅'));
  panel.append(el('p', 'sub', message || '网络没有通。'));
  const actions = el('div', 'actions');
  actions.append(btn('重试', () => {
    startBootClock();
    note('正在重新连接…');
    void boot();
  }, { primary: true }));
  actions.append(btn('换一个席位', () => {
    clearStore();
    location.reload();
  }, { ghost: true }));
  panel.append(actions);
  join.append(panel);
  app.append(join);
}

/**
 * 加入页发现这台浏览器有家长会话时，给一个「以家长身份下场」的入口。
 * 家长身份固定在服务器那边，不受这里清 localStorage 影响；每次下场会换一张新令牌。
 */
async function offerParentPlay(panel) {
  try {
    const response = await fetch('/v1/parent/me');
    if (!response.ok) return;
    const body = await response.json().catch(() => null);
    const account = body && body.account;
    if (!account) return;
    const box = el('div', 'parent-play');
    box.append(
      el('p', 'sub', '这台浏览器登录了「' + (account.displayName || '家长') + '」，可以直接以这个身份下场。'),
      btn('以家长身份下场', () => { void parentPlay(); }, { primary: true }),
    );
    panel.append(box);
  } catch {
    /* 没有家长会话就当普通加入页 */
  }
}

async function parentPlay() {
  try {
    const response = await fetch('/v1/parent/play', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || '现在下不了场');
    if (body.globalEntry) { beginGlobalEntry(body.globalEntry, { room: body.room, parent: true }); return; }
    writeStore({
      room: body.room,
      seatId: body.seat.id,
      name: body.seat.name,
      token: body.token,
      cooId: body.identity.cooId,
      cooSecret: body.identity.cooSecret,
    });
    location.href = '/play?room=' + encodeURIComponent(body.room);
  } catch (error) {
    showToast(error.message || '现在下不了场', 'bad');
  }
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

// 大厅里的人数与目录会变：停在大厅时每 20 秒悄悄刷一次。
setInterval(() => {
  if (state.shell && state.view === 'hall' && !document.hidden) {
    void loadHall(true);
    // 掉线不广播事件：快照里的 online 名单要跟手刷，离线的人才会在 20 秒内从「大厅里」消失。
    scheduleRefresh();
  }
}, 20000);

document.addEventListener('visibilitychange', () => {
  syncFeaturedRotation();
  if (document.hidden) return;
  // 手机/浏览器切回来时 EventSource 可能已经悄悄断了；没开着就立刻重连，别等 3 秒定时器。
  if (state.cfg && (!state.stream || state.stream.readyState !== EventSource.OPEN)) connect();
  scheduleRefresh();
});
window.addEventListener('focus', () => scheduleRefresh());

/* —— 私聊浮窗 —— */
/* 位置存在本地：拖标题栏移动、点窗外空白或 Esc 关闭；手机上是全屏抽屉。 */

let dmSearchTimer = 0;
let dmRefreshTimer = 0;

function dm() {
  return state.dm;
}

function toggleDm() {
  if (dm().open) closeDm();
  else openDm();
}

function openDm(peer = '', name = '', handle = '') {
  if (!state.cfg) return;
  const view = ensureDmWindow();
  dm().open = true;
  view.win.hidden = false;
  restoreDmPos();
  paintDmThreads();
  paintDmPeople();
  void loadDmThreads();
  if (peer) void openDmThread(peer, name, handle);
  else view.search.focus();
  startDmPolling();
}

function closeDm() {
  const view = ui.dm;
  if (!view) return;
  dm().open = false;
  view.win.hidden = true;
  stopDmPolling();
}

function startDmPolling() {
  stopDmPolling();
  dm().timer = setInterval(() => {
    if (!dm().open) return;
    void loadDmThreads();
    if (dm().peer) void loadDmMessages(dm().peer.cooId, true);
  }, 5000);
}

function stopDmPolling() {
  if (dm().timer) clearInterval(dm().timer);
  dm().timer = 0;
}

/** 收到一条私聊事件时轻刷一次会话列表（有未读就亮角标）。 */
function dmRefreshSoon() {
  if (!state.shell) return;
  clearTimeout(dmRefreshTimer);
  dmRefreshTimer = setTimeout(() => { void loadDmThreads(); }, 400);
}

function ensureDmWindow() {
  if (ui.dm) return ui.dm;
  const win = el('aside', 'dm');
  win.hidden = true;
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-label', '私聊');

  const head = el('header', 'dm-head');
  const title = el('span', 'dm-title', '私聊');
  const close = el('button', 'dm-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭私聊');
  close.addEventListener('click', () => closeDm());
  head.append(title, close);

  const body = el('div', 'dm-body');
  const list = el('div', 'dm-list');
  const search = el('input', 'dm-search');
  search.placeholder = '搜名字、#号 或会话';
  search.setAttribute('aria-label', '搜索用户');
  search.addEventListener('input', () => {
    dm().q = search.value.trim();
    clearTimeout(dmSearchTimer);
    dmSearchTimer = setTimeout(() => { void loadDmPeople(); }, 250);
  });
  const threadsBox = el('div', 'dm-threads');
  const peopleBox = el('div', 'dm-people');
  list.append(search, threadsBox, peopleBox);

  const pane = el('div', 'dm-pane');
  const peerBox = el('div', 'dm-peer', '选一个人说话');
  const msgs = el('div', 'dm-msgs');
  const form = el('form', 'dm-send');
  const input = el('textarea', 'dm-input');
  input.rows = 1;
  input.placeholder = '说点什么…（Enter 发送，Shift+Enter 换行）';
  const send = btn('发送', null, { primary: true, small: true });
  send.type = 'submit';
  form.append(input, send);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void sendDm();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void sendDm();
  });
  pane.append(peerBox, msgs, form);
  body.append(list, pane);
  win.append(head, body);
  document.body.append(win);

  ui.dm = { win, head, list, search, threadsBox, peopleBox, peerBox, msgs, form, input, send };

  dragDm(head);

  document.addEventListener('pointerdown', (event) => {
    if (!dm().open) return;
    if (win.contains(event.target)) return;
    if (ui.dmBtn && ui.dmBtn.contains(event.target)) return;
    closeDm();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dm().open) closeDm();
  });
  return ui.dm;
}

/** 拖标题栏；手机（窄屏）不拖，窗口是全屏。 */
function dragDm(head) {
  head.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.dm-close')) return;
    if (window.matchMedia('(max-width: 820px)').matches) return;
    const win = ui.dm.win;
    const rect = win.getBoundingClientRect();
    dm().drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    try { head.setPointerCapture(event.pointerId); } catch { /* 合成事件没有真实指针 */ }
  });
  head.addEventListener('pointermove', (event) => {
    const drag = dm().drag;
    if (!drag) return;
    const win = ui.dm.win;
    const left = Math.min(Math.max(0, event.clientX - drag.dx), Math.max(0, window.innerWidth - win.offsetWidth));
    const top = Math.min(Math.max(0, event.clientY - drag.dy), Math.max(0, window.innerHeight - win.offsetHeight));
    win.style.left = left + 'px';
    win.style.top = top + 'px';
    win.style.right = 'auto';
  });
  head.addEventListener('pointerup', () => {
    if (!dm().drag) return;
    dm().drag = null;
    try {
      const win = ui.dm.win;
      localStorage.setItem('parlor-dm-pos-v1', JSON.stringify({ left: win.offsetLeft, top: win.offsetTop }));
    } catch { /* 存不了就这次有效 */ }
  });
}

function restoreDmPos() {
  const win = ui.dm.win;
  try {
    const raw = JSON.parse(localStorage.getItem('parlor-dm-pos-v1') || 'null');
    if (!raw || typeof raw.left !== 'number' || typeof raw.top !== 'number') return;
    const left = Math.min(Math.max(0, raw.left), Math.max(0, window.innerWidth - win.offsetWidth));
    const top = Math.min(Math.max(0, raw.top), Math.max(0, window.innerHeight - win.offsetHeight));
    win.style.left = left + 'px';
    win.style.top = top + 'px';
    win.style.right = 'auto';
  } catch { /* 没存过 */ }
}

async function loadDmThreads() {
  if (!state.cfg) return;
  try {
    const data = await api('/v1/dm/threads');
    dm().threads = data.threads || [];
    dm().unread = data.unread || 0;
    paintDmThreads();
    updateDmBadge();
  } catch { /* 掉线时静默，下一次轮询再试 */ }
}

async function loadDmPeople() {
  const query = dm().q;
  if (!query) {
    dm().people = [];
    paintDmPeople();
    return;
  }
  try {
    const data = await api('/v1/people?q=' + encodeURIComponent(query));
    if (dm().q !== query) return;
    dm().people = data.people || [];
    paintDmPeople();
  } catch { /* 搜索失败就当没有 */ }
}

async function openDmThread(peer, name = '', handle = '') {
  dm().peer = { cooId: peer, name, handle };
  paintDmPeer();
  ui.dm.msgs.replaceChildren(el('p', 'chat-empty', '正在取聊天…'));
  await loadDmMessages(peer);
  await markDmRead(peer);
  ui.dm.input.focus();
}

async function loadDmMessages(peer, quiet = false) {
  try {
    const data = await api('/v1/dm?peer=' + encodeURIComponent(peer) + '&limit=60');
    if (!dm().peer || dm().peer.cooId !== peer) return;
    if (data.peer && data.peer.name) dm().peer.name = data.peer.name;
    if (data.peer && data.peer.handle) dm().peer.handle = data.peer.handle;
    dm().messages = data.messages || [];
    paintDmPeer();
    paintDmMessages(!quiet);
  } catch (error) {
    if (!quiet) ui.dm.msgs.replaceChildren(el('p', 'chat-empty bad', error.message || '取不到聊天'));
  }
}

async function sendDm() {
  const view = ui.dm;
  const peer = dm().peer;
  const text = view.input.value.trim();
  if (!peer || !text || view.send.disabled) return;
  view.send.disabled = true;
  try {
    const data = await api('/v1/dm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: peer.cooId, text }),
    });
    dm().messages.push(data.message);
    view.input.value = '';
    paintDmMessages(true);
    await loadDmThreads();
  } catch (error) {
    showToast(error.message || '没发出去', 'bad');
  } finally {
    view.send.disabled = false;
    view.input.focus();
  }
}

async function markDmRead(peer) {
  try {
    await api('/v1/dm/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peer }),
    });
    await loadDmThreads();
  } catch { /* 已读标不上不影响看 */ }
}

function paintDmThreads() {
  const view = ui.dm;
  if (!view) return;
  clear(view.threadsBox);
  const threads = dm().threads;
  if (!threads.length) {
    view.threadsBox.append(el('p', 'chat-empty', '还没有私聊。上面搜个名字开始。'));
  }
  const active = dm().peer ? dm().peer.cooId : '';
  for (const thread of threads) {
    const node = el('button', 'dm-thread' + (thread.peer === active ? ' is-active' : ''));
    node.type = 'button';
    const who = el('span', 'dm-who');
    who.append(el('span', 'dm-name', thread.name || '某人'));
    if (thread.handle) who.append(el('span', 'dm-handle', '#' + thread.handle));
    if (thread.online) who.append(el('span', 'dm-online', '在线'));
    if (thread.unread > 0) who.append(el('span', 'badge', String(thread.unread)));
    node.append(
      who,
      el('span', 'dm-last', (thread.lastFromMe ? '我：' : '') + readable(thread.lastText || '')),
      el('time', 'dm-time', fmtClock(thread.lastTs).slice(0, 5)),
    );
    node.addEventListener('click', () => { void openDmThread(thread.peer, thread.name, thread.handle); });
    view.threadsBox.append(node);
  }
  updateDmBadge();
}

function paintDmPeople() {
  const view = ui.dm;
  if (!view) return;
  clear(view.peopleBox);
  if (!dm().q) return;
  if (!dm().people.length) {
    view.peopleBox.append(el('p', 'chat-empty', '没有找到（名字只搜在线或聊过的人；有 #号 可以直接搜）'));
    return;
  }
  view.peopleBox.append(el('p', 'dm-hint', '找人'));
  for (const person of dm().people) {
    const node = el('button', 'dm-thread dm-person');
    node.type = 'button';
    const who = el('span', 'dm-who');
    who.append(el('span', 'dm-name', person.name || '某人'));
    if (person.handle) who.append(el('span', 'dm-handle', '#' + person.handle));
    if (person.online) who.append(el('span', 'dm-online', '在线'));
    node.append(who);
    node.addEventListener('click', () => {
      view.search.value = '';
      dm().q = '';
      paintDmPeople();
      void openDmThread(person.cooId, person.name, person.handle);
    });
    view.peopleBox.append(node);
  }
}

function paintDmPeer() {
  const view = ui.dm;
  if (!view) return;
  const peer = dm().peer;
  if (!peer) {
    view.peerBox.textContent = '选一个人说话';
    view.input.disabled = true;
    view.send.disabled = true;
    return;
  }
  view.peerBox.replaceChildren(el('strong', '', peer.name || '某人'));
  const thread = dm().threads.find((item) => item.peer === peer.cooId);
  const handle = peer.handle || (thread && thread.handle) || '';
  if (handle) view.peerBox.append(el('span', 'dm-handle', '#' + handle));
  if (thread && thread.online) view.peerBox.append(el('span', 'dm-online', '在线'));
  view.input.disabled = false;
  view.send.disabled = false;
}

function paintDmMessages(scroll = true) {
  const view = ui.dm;
  if (!view) return;
  const nearBottom = view.msgs.scrollHeight - view.msgs.scrollTop - view.msgs.clientHeight < 80;
  clear(view.msgs);
  if (!dm().peer) {
    view.msgs.append(el('p', 'chat-empty', '选左边一个人，或者上面搜个名字。'));
    return;
  }
  if (!dm().messages.length) {
    view.msgs.append(el('p', 'chat-empty', '还没有消息。'));
    return;
  }
  for (const message of dm().messages) {
    const node = el('article', 'dm-msg' + (message.fromMe ? ' is-me' : ''));
    node.append(el('p', 'dm-text', readable(message.text || '')));
    node.append(el('time', 'dm-time', fmtClock(message.ts).slice(0, 5)));
    view.msgs.append(node);
  }
  if (scroll && nearBottom) view.msgs.scrollTop = view.msgs.scrollHeight;
}

function updateDmBadge() {
  if (!ui.dmBadge) return;
  const unread = dm().unread || 0;
  ui.dmBadge.textContent = String(unread);
  ui.dmBadge.hidden = unread <= 0;
}

function beginGlobalEntry(authority, input = {}) {
  const target = new URL(authority);
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(target.hostname))) throw new Error('身份服务需要 HTTPS');
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  sessionStorage.setItem('parlor-identity-pending', JSON.stringify({ ...input, state: nonce }));
  target.pathname = '/identity';
  target.search = new URLSearchParams({ returnTo: location.origin + location.pathname + location.search, state: nonce, name: input.name || '' }).toString();
  location.assign(target.href);
}
