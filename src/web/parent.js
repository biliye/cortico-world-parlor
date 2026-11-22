/** 家长只读页：用 ownerKey 换 HttpOnly 会话，然后按孩子当前席位的可见范围看。 */
import { mountStoryArchive } from './story-archive.js';
import { beginGlobalEntry } from './identity-entry.js';

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
  leaveSeat: document.getElementById('leave-child-seat'),
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
  invites: document.getElementById('guest-invites'),
  toast: document.getElementById('toast'),
  backToTea: document.getElementById('back-to-tea'),
  dialog: document.getElementById('account-dialog'),
  closeAccount: document.getElementById('account-close'),
  tabs: {
    account: document.getElementById('tab-account'),
    rename: document.getElementById('tab-rename'),
    credentials: document.getElementById('tab-credentials'),
    history: document.getElementById('tab-history'),
  },
  panes: {
    account: document.getElementById('pane-account'),
    rename: document.getElementById('pane-rename'),
    credentials: document.getElementById('pane-credentials'),
    history: document.getElementById('pane-history'),
  },
  factName: document.getElementById('fact-name'),
  factLogin: document.getElementById('fact-login'),
  gotoRename: document.getElementById('goto-rename'),
  gotoCredentials: document.getElementById('goto-credentials'),
  logoutAccount: document.getElementById('account-logout'),
  renameForm: document.getElementById('rename-form'),
  renameInput: document.getElementById('rename-input'),
  renameError: document.getElementById('rename-error'),
  renameSave: document.getElementById('rename-save'),
  credentialsForm: document.getElementById('credentials-form'),
  credLogin: document.getElementById('cred-login'),
  credPassword: document.getElementById('cred-password'),
  credConfirm: document.getElementById('cred-confirm'),
  credHint: document.getElementById('cred-hint'),
  credError: document.getElementById('cred-error'),
  credSave: document.getElementById('cred-save'),
  historyForm: document.getElementById('history-filters'),
  historyKind: document.getElementById('history-kind'),
  historyGame: document.getElementById('history-game'),
  historyFrom: document.getElementById('history-from'),
  historyUntil: document.getElementById('history-until'),
  historyRoom: document.getElementById('history-room'),
  historySummary: document.getElementById('history-summary'),
  historyError: document.getElementById('history-error'),
  historyList: document.getElementById('history-list'),
  historyEmpty: document.getElementById('history-empty'),
  historyMore: document.getElementById('history-more'),
};

let timer = 0;
let lastSignature = '';
let toastTimer = 0;
const VIEW_LIMIT = 80;
let viewRequest;
let viewGeneration = 0;
let viewVersions;
let currentView;

/** 账户弹窗的状态：当前账户、选中的分区、登录名缓存、战绩分页。 */
const ACCOUNT_TABS = ['account', 'rename', 'credentials', 'history'];
const HISTORY_PAGE = 20;
let currentAccount = null;
let accountTab = 'account';
/** undefined=还没读过；null=读失败；否则是服务端给的登录名与建议名。 */
let credential;
/** 战绩分页。别叫 history —— 会把 window.history 遮住（boot 里要用 replaceState）。 */
let records = { loaded: false, items: [], next: null, filters: null, epoch: 0, games: false };

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

/** 切换家长会话时重置输入和提交状态。 */
function resetAccountForms() {
  ui.renameInput.value = '';
  ui.renameError.textContent = '';
  ui.renameSave.disabled = false;
  ui.credLogin.value = '';
  ui.credPassword.value = '';
  ui.credConfirm.value = '';
  ui.credError.textContent = '';
  ui.credSave.disabled = false;
}

function showGate(message = '') {
  clearTimeout(timer);
  if (ui.dialog.open) ui.dialog.close();
  viewGeneration += 1;
  viewRequest = undefined;
  viewVersions = undefined;
  currentView = undefined;
  currentAccount = null;
  ui.who = null;
  credential = undefined;
  records = { ...records, loaded: false, items: [], next: null, filters: null, epoch: records.epoch + 1 };
  lastSignature = '';
  ui.backToTea.hidden = true;
  ui.gate.hidden = false;
  ui.view.hidden = true;
  ui.stories.replaceChildren();
  ui.invites.replaceChildren();
  ui.account.replaceChildren();
  resetAccountForms();
  ui.historyError.textContent = '';
  ui.gateError.textContent = message;
  ui.gateKey.focus();
}

function showView(account) {
  ui.gate.hidden = true;
  ui.view.hidden = false;
  currentAccount = account;
  credential = undefined;
  resetAccountForms();
  records = { ...records, loaded: false, items: [], next: null, filters: null, epoch: records.epoch + 1 };
  clear(ui.historyList);
  ui.historyEmpty.hidden = true;
  ui.historyMore.hidden = true;
  mountGuestInvites();
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
  ui.who = who;
  ui.account.append(who);
  const open = el('button', 'board-btn primary small', '账户');
  open.type = 'button';
  open.title = '改名字、多端登录、账户历史战绩';
  open.addEventListener('click', () => openAccount('account'));
  ui.account.append(open);
  ui.backToTea.hidden = false;
  renderAccountFacts();
}

function mountGuestInvites() {
  const panel = document.getElementById('guest-invite-template').content.firstElementChild.cloneNode(true);
  ui.invites.replaceChildren(panel);
  const create = panel.querySelector('[data-invite-create]');
  const copy = panel.querySelector('[data-invite-copy]');
  const linkBox = panel.querySelector('.guest-invite-link');
  const link = linkBox.querySelector('input');
  const status = panel.querySelector('[data-invite-status]');
  const list = panel.querySelector('[data-invite-list]');
  const base = '/v1/web/parent/invites';
  const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
  const format = time => new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  let latestId = '';
  let busy = false;

  async function refresh() {
    const { invites } = await api(base);
    list.replaceChildren(...invites.map(invite => {
      const deadline = invite.accessUntil ?? invite.redeemBy;
      const ended = deadline <= Date.now();
      const state = invite.revokedAt ? '已撤销' : ended ? '已到期' : (invite.guestId ? '试玩至 ' : '待使用，有效至 ') + format(deadline);
      const who = invite.guestHandle ? `${invite.guestName} #${invite.guestHandle} · ` : '';
      const row = el('li', '', who + state);
      if (!invite.revokedAt && !ended) {
        const revoke = el('button', 'board-btn ghost small', '撤销');
        revoke.type = 'button';
        revoke.addEventListener('click', () => void run(async () => {
          await api(`${base}/${invite.id}/revoke`, post);
          if (latestId === invite.id) {
            link.value = '';
            linkBox.hidden = true;
          }
          await refresh();
        }));
        row.append(revoke);
      }
      return row;
    }));
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    create.disabled = true;
    status.textContent = '';
    try { await action(); }
    catch (error) { status.textContent = error.message || '邀请操作失败'; }
    finally { busy = false; create.disabled = false; }
  }

  panel.addEventListener('toggle', () => { if (panel.open) void run(refresh); });
  create.addEventListener('click', () => void run(async () => {
    const result = await api(base, post);
    latestId = result.id;
    link.value = result.link;
    linkBox.hidden = false;
    await refresh();
  }));
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link.value);
      status.textContent = '邀请链接已复制，可以发给朋友。';
    } catch {
      link.focus();
      link.select();
      status.textContent = '已选中邀请链接，请手动复制。';
    }
  });
}

/* ── 账户弹窗：账户 / 改名字 / 多端登录 / 账户历史战绩 ───────────── */

const stamp = ts => new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const RESULT_LABEL = { win: '胜', loss: '负', draw: '平' };
const DIRECTION_LABEL = { in: '收到', out: '送出', used: '喝掉/吃掉' };

function openAccount(tab = 'account') {
  if (!currentAccount) return;
  ui.renameInput.value = currentAccount.displayName || '';
  ui.renameError.textContent = '';
  ui.credError.textContent = '';
  showAccountTab(tab);
  renderAccountFacts();
  if (!ui.dialog.open) ui.dialog.showModal();
  ui.tabs[accountTab].focus();
  void loadCredentials();
  if (accountTab === 'history' && !records.loaded) void loadHistory();
}

function showAccountTab(tab) {
  accountTab = ACCOUNT_TABS.includes(tab) ? tab : 'account';
  for (const name of ACCOUNT_TABS) {
    ui.tabs[name].className = name === accountTab ? 'sheet-tab is-on' : 'sheet-tab';
    ui.tabs[name].setAttribute('aria-current', name === accountTab ? 'true' : 'false');
    ui.panes[name].hidden = name !== accountTab;
  }
}

function renderAccountFacts() {
  const loginName = credential ? credential.loginName : '';
  ui.factName.textContent = currentAccount?.displayName || '家长';
  ui.factLogin.textContent = credential === undefined ? '正在读取…'
    : credential ? (loginName || '未开通') : '读不到，稍后再试';
  ui.credSave.textContent = loginName ? '更新登录名和密码' : '开通多端登录';
  ui.credHint.textContent = loginName
    ? '密码至少 12 个字符。更新后，其他设备需要用新密码重新登录。'
    : '密码至少 12 个字符。开通后可以在会馆首页用登录名和密码从别的设备进来。';
  if (!ui.credLogin.value) ui.credLogin.value = credential?.suggestedName || currentAccount?.displayName || '';
}

async function loadCredentials() {
  const account = currentAccount;
  try {
    const info = await api('/v1/web/credentials');
    if (account !== currentAccount) return;
    credential = { loginName: info.loginName || '', suggestedName: info.suggestedName || '' };
    if (credential.loginName) ui.credLogin.value = credential.loginName;
  } catch {
    if (account !== currentAccount) return;
    credential = null;
  }
  renderAccountFacts();
}

/** 两次密码不一致、太短、没填登录名：都在面板里用红字说清楚，一个请求都不发。 */
function credentialProblem(loginName, password, confirm) {
  if (!loginName) return { message: '先填登录名。', field: ui.credLogin };
  if (Array.from(password).length < 12) return { message: '密码至少 12 个字符。', field: ui.credPassword };
  if (password !== confirm) return { message: '两次输入的密码不一致，请重新确认。', field: ui.credConfirm };
  return null;
}

async function saveCredentials() {
  const account = currentAccount;
  if (!account || ui.credSave.disabled) return;
  const loginName = ui.credLogin.value.trim();
  const password = ui.credPassword.value;
  const problem = credentialProblem(loginName, password, ui.credConfirm.value);
  if (problem) {
    ui.credError.textContent = problem.message;
    problem.field.focus();
    return;
  }
  ui.credError.textContent = '';
  ui.credSave.disabled = true;
  try {
    await api('/v1/web/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loginName, password }),
    });
    if (account !== currentAccount) return;
    credential = { ...(credential || {}), loginName };
    ui.credPassword.value = '';
    ui.credConfirm.value = '';
    renderAccountFacts();
    toast('已保存，可以从会馆首页登录了。');
  } catch (error) {
    if (account !== currentAccount) return;
    ui.credError.textContent = error.message || '现在无法设置多端登录';
  } finally {
    if (account === currentAccount) ui.credSave.disabled = false;
  }
}

/** 改名字：账户显示名、玩家身份名、当前席位名一起改（服务器一个接口）。 */
async function saveRename() {
  const account = currentAccount;
  if (!account || ui.renameSave.disabled) return;
  const name = ui.renameInput.value.trim();
  if (!name) {
    ui.renameError.textContent = '名字不能为空。';
    ui.renameInput.focus();
    return;
  }
  ui.renameError.textContent = '';
  ui.renameSave.disabled = true;
  try {
    const result = await api('/v1/parent/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (account !== currentAccount) return;
    account.displayName = result.account.displayName;
    if (ui.who) ui.who.textContent = account.displayName;
    renderAccountFacts();
    toast('名字改好了');
    await loadView();
  } catch (error) {
    if (account !== currentAccount) return;
    ui.renameError.textContent = error.message || '改不了名字';
  } finally {
    if (account === currentAccount) ui.renameSave.disabled = false;
  }
}

/** 表单这一刻的筛选条件。 */
function readHistoryFilters() {
  return {
    kind: ui.historyKind.value,
    game: ui.historyGame.value,
    from: ui.historyFrom.value,
    until: ui.historyUntil.value,
    room: ui.historyRoom.value.trim(),
  };
}

/** 翻页要用生成游标的那一次筛选，不能跟着表单变——否则旧游标会配上新条件。 */
function historyParams(filters, before) {
  const q = new URLSearchParams({ kind: filters.kind, limit: String(HISTORY_PAGE) });
  if (filters.kind === 'games' && filters.game) q.set('game', filters.game);
  if (filters.room) q.set('room', filters.room);
  if (filters.from) q.set('from', String(new Date(filters.from + 'T00:00:00+08:00').getTime()));
  if (filters.until) {
    q.set('until', String(new Date(filters.until + 'T00:00:00+08:00').getTime() + 86400000));
  }
  if (before !== null) q.set('before', String(before));
  return q.toString();
}

async function loadHistory(more = false) {
  const before = more ? records.next : null;
  if (more && (before === null || ui.historyMore.disabled)) return;
  const epoch = ++records.epoch;
  const filters = more ? records.filters : readHistoryFilters();
  if (!more) {
    records.items = [];
    records.next = null;
    records.filters = filters;
    clear(ui.historyList);
    ui.historyEmpty.hidden = true;
    ui.historyMore.hidden = true;
  }
  ui.historyMore.disabled = true;
  ui.historyError.textContent = '';
  ui.historySummary.textContent = '正在读取…';
  try {
    const page = await api('/v1/parent/history?' + historyParams(filters, before));
    if (epoch !== records.epoch) return;
    records.loaded = true;
    fillHistoryGames(page.games || []);
    records.items = more ? [...records.items, ...page.items] : page.items;
    records.next = page.next;
    renderHistory(page);
  } catch (error) {
    if (epoch !== records.epoch) return;
    records.loaded = true;
    ui.historySummary.textContent = '';
    ui.historyError.textContent = error.message || '读不到战绩';
  } finally {
    if (epoch === records.epoch) ui.historyMore.disabled = false;
  }
}

/** 玩法名由服务端给，网页不另抄一份会漂移的名称表。 */
function fillHistoryGames(games) {
  if (records.games || games.length === 0) return;
  records.games = true;
  for (const game of games) {
    const option = el('option', '', game.label);
    option.value = game.id;
    ui.historyGame.append(option);
  }
}

function renderHistory(page) {
  const ledger = page.ledger;
  ui.historySummary.textContent = !page.player
    ? '还没下场玩过。点右上角「回到茶室」打一局，这里就有自己的战绩了。'
    : ledger && ledger.games
      ? `共 ${ledger.games} 局 · ${ledger.wins} 胜 ${ledger.losses} 负 ${ledger.draws} 平`
      : '还没有战绩。';
  clear(ui.historyList);
  for (const item of records.items) {
    // item.kind 是账本条目类型（game / gift / gift_used），只有对局才带 result。
    const games = item.result !== undefined;
    const row = el('li', 'history-row' + (games ? ' is-' + (item.result || 'loss') : ''));
    const head = el('p', 'history-head');
    head.append(el('strong', 'history-result', games
      ? (RESULT_LABEL[item.result || ''] || '对局')
      : (DIRECTION_LABEL[item.direction || ''] || '礼物') + ' · ' + (item.itemName || '礼物')));
    head.append(el('span', 'history-meta',
      stamp(item.ts) + ' · ' + item.roomName + (item.gameLabel ? ' · ' + item.gameLabel : '')));
    row.append(head, el('p', 'history-text', item.text));
    ui.historyList.append(row);
  }
  ui.historyEmpty.hidden = records.items.length > 0;
  ui.historyMore.hidden = !records.next;
}

/** 家长下场：领席位或完成统一身份跳转，然后去 /play。 */
async function playAsParent(button) {
  button.disabled = true;
  try {
    const result = await api('/v1/parent/play', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (result.globalEntry) {
      beginGlobalEntry(result.globalEntry, { room: result.room, parent: true }, location.origin + '/play');
      return;
    }
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

function scheduleView(delay = 3000) {
  clearTimeout(timer);
  if (!ui.view.hidden) timer = setTimeout(loadView, document.hidden ? 30000 : delay);
}

function loadView() {
  if (ui.view.hidden) return Promise.resolve(false);
  if (viewRequest) return viewRequest;
  clearTimeout(timer);
  const generation = viewGeneration;
  const query = new URLSearchParams({ limit: String(VIEW_LIMIT), view: 'compact-v1' });
  if (viewVersions) {
    for (const key of ['state', 'events', 'mail']) query.set(`${key}Version`, viewVersions[key]);
  }
  viewRequest = (async () => {
    try {
      const update = await api('/v1/parent/view?' + query);
      if (generation !== viewGeneration) return false;
      if (update.versions) {
        currentView = {
          ...(update.state ?? currentView),
          events: update.events ?? currentView?.events ?? [],
          mail: update.mail ?? currentView?.mail ?? [],
          now: update.now,
          at: true,
        };
        viewVersions = update.versions;
      } else {
        // 滚动部署时旧网关仍返回原有完整视图。
        viewVersions = undefined;
        currentView = update;
      }
      render(currentView);
      scheduleView();
      return true;
    } catch (error) {
      if (generation !== viewGeneration) return false;
      if (error.status === 401) {
        showGate('家长会话已经失效，请重新打开家长链接。');
        return false;
      }
      toast(error.message || '刷新失败');
      scheduleView(5000);
      return false;
    } finally {
      if (generation === viewGeneration) viewRequest = undefined;
    }
  })();
  return viewRequest;
}

ui.leaveSeat?.addEventListener('click', async () => {
  const seat = currentView?.seat;
  const roomName = ui.roomName.textContent;
  if (!seat || !confirm(`让孩子离开「${roomName}」？如果 World 仍在运行，它可能会重新入座。`)) return;
  const generation = viewGeneration;
  ui.leaveSeat.disabled = true;
  try {
    const result = await api('/v1/parent/leave', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seatId: seat.id }),
    });
    if (generation === viewGeneration) toast(result.left ? '已让孩子离开客厅。' : '孩子已经离开客厅。');
  } catch (error) {
    if (generation === viewGeneration) toast(error.message || '离开失败');
  } finally {
    await viewRequest;
    if (generation === viewGeneration) await loadView();
    ui.leaveSeat.disabled = false;
  }
});

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
  if (ui.leaveSeat) ui.leaveSeat.hidden = !seat;
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

/* 顶栏：回到茶室（原来的「下场玩」）与那一个账户入口。 */
ui.backToTea.addEventListener('click', () => { void playAsParent(ui.backToTea); });

for (const name of ACCOUNT_TABS) {
  ui.tabs[name].addEventListener('click', () => {
    showAccountTab(name);
    if (name === 'history' && !records.loaded) void loadHistory();
  });
}
ui.closeAccount.addEventListener('click', () => { if (ui.dialog.open) ui.dialog.close(); });
// 点遮罩关窗：backdrop 上的点击 target 就是 dialog 自己，盒子里面的点击都落在子元素上。
ui.dialog.addEventListener('click', (event) => { if (event.target === ui.dialog) ui.dialog.close(); });
ui.gotoRename.addEventListener('click', () => showAccountTab('rename'));
ui.gotoCredentials.addEventListener('click', () => showAccountTab('credentials'));
ui.logoutAccount.addEventListener('click', async () => {
  ui.logoutAccount.disabled = true;
  try { await api('/v1/parent/logout', { method: 'POST' }); } catch { /* 已经失效 */ }
  ui.logoutAccount.disabled = false;
  showGate('已经退出。');
});
ui.renameForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void saveRename();
});
ui.credentialsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void saveCredentials();
});
/** 两个密码框一边输一边比：已经不一致就先红字说清楚，不必等按保存。 */
function checkPasswordMatch() {
  const mismatch = ui.credConfirm.value !== '' && ui.credConfirm.value !== ui.credPassword.value;
  ui.credError.textContent = mismatch ? '两次输入的密码不一致' : '';
}
ui.credPassword.addEventListener('input', checkPasswordMatch);
ui.credConfirm.addEventListener('input', checkPasswordMatch);
ui.credLogin.addEventListener('input', () => { ui.credError.textContent = ''; });
ui.historyForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void loadHistory();
});
ui.historyMore.addEventListener('click', () => { void loadHistory(true); });
ui.historyKind.addEventListener('change', () => {
  ui.historyGame.disabled = ui.historyKind.value !== 'games';
  void loadHistory();
});

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
    if (await loadView()) toast('已经是最新的了');
  } finally {
    ui.refresh.disabled = false;
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) scheduleView();
  else void loadView();
});

void boot();
