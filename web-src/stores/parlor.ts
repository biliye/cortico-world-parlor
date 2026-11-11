/**
 * 状态层：快照、在线名单、客厅目录、SSE、动作与日志。
 * 并发闸门照旧：同一时刻只允许一次快照刷新、一次目录请求；SSE 断了 3 秒后重连。
 */
import { computed, ref } from 'vue';
import { api, beginGlobalEntry, finishGlobalEntry, IdentityExpiredError, parentPlay, scopedPath, takeKeyFromHash } from '../api/client.ts';
import { seatChanged } from '../lib/seat-switch.ts';
import { decideExpiredSeat } from '../lib/seat-errors.ts';
import { SEAT_EXPIRED_MESSAGE } from '../lib/join.ts';
import { noteChatEvent, resetChatState } from './chat.ts';
import { noteWhisper, resetDmState } from './dm.ts';
import { resetMailState } from './mail.ts';
import { saveSeat, seat, clearSeat, readStoredSeat, adoptSeat, STORE_KEY } from './session.ts';
import { showToast } from './ui.ts';
import { backToRoom, enterTable, readView, watchTableId } from './view.ts';
import type { ChatEvent, Directory, HallPayload, HallSeat, RoomCard, SeatConfig, Snapshot, TableSummary } from '../api/types.ts';
import type { TableEntryResponse, TableRecruitment } from '../../src/room/table-discovery-db.ts';

export const snapshot = ref<Snapshot | null>(null);
export const offset = ref(0);
export const latest = ref(0);
export const connection = ref<'idle' | 'connecting' | 'on' | 'off'>('idle');
export const hallSeats = ref<HallSeat[]>([]);
export const recruitments = ref<TableRecruitment[]>([]);
export const rooms = ref<RoomCard[]>([]);
export const hallLoaded = ref(false);
export const hallError = ref('');
export const bootError = ref('');
export const log = ref<ChatEvent[]>([]);
export const roomTransition = ref<{ from: string; to: string; name: string; error: string } | null>(null);

let stream: EventSource | null = null;
/**
 * 地址栏里那把家长钥匙的页内副本。
 *
 * `#key=` 取到就立刻从地址栏抹掉（不进历史、不会被复制外发），但第一次请求可能根本没到
 * 服务器（断网、超时）。旧页在这里留了一份内存副本供重试，Vue 照做：**只有换到席位、
 * 或已经转交统一身份之后才清掉**，否则失败一次就再也拼不回这把钥匙。
 */
let entryKey = '';
/**
 * 统一身份回跳票据的页内副本（`#identity=…&state=…`）。
 *
 * 和钥匙一样，地址栏一进来就抹掉，但换席位请求可能断在网络上；旧页在 `catch` 里
 * 直接渲染离线页，票据就丢了，重试一次请求都不发。这里留到换到席位为止。
 * 票据本身失效（`IdentityExpiredError`）则立刻清掉——再试也是同一句，得回上一页重新授权。
 */
let identityTicket = '';
let identityState = '';
let reconnectTimer: number | undefined;
let reconnectFailures = 0;
let locationTask: { key: string; promise: Promise<boolean> } | undefined;
let sharedSeatPending = false;
let refreshTimer: number | undefined;
let hallTimer: number | undefined;
let refreshTask: { key: string; promise: Promise<void> } | undefined;
let hallFetching = false;
let hallAt = 0;
const seen = new Set<number>();
let syncEpoch = 0;
let appliedTableSeq = 0;
let tableTargetSeq = 0;
let tableTimer: number | undefined;
let tableFetching = false;
let tableQueued = false;
let ledgerTimer: number | undefined;

type TablePatch = {
  seq?: number;
  table?: TableSummary | null;
  tablePrivate?: Snapshot['tablePrivate'];
  tables?: TableSummary[];
};

function seatKey(cfg: SeatConfig | null = seat.value): string {
  return cfg ? JSON.stringify([cfg.room, cfg.seatId, cfg.token, cfg.cooId]) : '';
}

function replaceRoomUrl(room: string, resetView = true): void {
  const params = new URLSearchParams(location.search);
  params.set('room', room);
  if (resetView) { params.delete('table'); params.delete('view'); }
  history.replaceState({ ...history.state, parlor: true }, '', location.pathname + '?' + params);
}

/** 各窗口跟随同一身份的最新席位；不向服务器发起换厅，也不回写共享存储。 */
function adoptSharedSeat(): boolean {
  const stored = readStoredSeat();
  const previous = seat.value;
  if (seatKey(stored) === seatKey()) return false;
  disconnect();
  window.clearTimeout(refreshTimer);
  refreshTimer = undefined;
  roomTransition.value = null;
  const moved = !stored || !previous || stored.room !== previous.room
    || stored.seatId !== previous.seatId || stored.cooId !== previous.cooId;
  if (moved) { resetRoomState(); backToRoom(); }
  else syncEpoch += 1; // 同席位只换令牌，保留牌桌视图及输入。
  if (stored?.cooId !== previous?.cooId) {
    rooms.value = []; hallSeats.value = []; recruitments.value = [];
    hallLoaded.value = false; hallAt = 0; hallError.value = '';
  }
  adoptSeat(stored, stored ? '' : '这台浏览器的席位已退出，请重新加入。');
  if (stored) replaceRoomUrl(stored.room, moved);
  return true;
}

/** storage事件本身可能迟到：只读此刻存储，不采用event.newValue。 */
export function onSeatStorage(event: StorageEvent): void {
  if (event.key !== STORE_KEY && event.key !== null) return;
  if (event.storageArea && event.storageArea !== localStorage) return;
  if (switching) { sharedSeatPending = true; return; }
  void followSharedSeat();
}

async function followSharedSeat(): Promise<void> {
  await syncLocation();
  if (seat.value && !stream) connect();
}

/** 去重后追加；上限 300 条，和旧版一样只留最近的。 */
function pushLog(event: ChatEvent): void {
  if ((event.type === 'parlor.joined' || event.type === 'parlor.left') && event.data?.presenceWeb === false) return;
  if (typeof event.seq === 'number') {
    if (seen.has(event.seq)) return;
    seen.add(event.seq);
    if (seen.size > 4000) {
      const keep = [...seen].sort((a, b) => b - a).slice(0, 2000);
      seen.clear();
      keep.forEach((seq) => seen.add(seq));
    }
  }
  log.value = [...log.value, event].slice(-300);
}

/** 换席位后清掉上一个厅的界面状态：事件 seq 每厅各自从 1 开始，不能跨厅去重。 */
function resetRoomState(): void {
  syncEpoch += 1;
  appliedTableSeq = tableTargetSeq = 0;
  tableQueued = false;
  window.clearTimeout(tableTimer);
  window.clearTimeout(ledgerTimer);
  tableTimer = ledgerTimer = undefined;
  log.value = [];
  seen.clear();
  latest.value = 0;
  offset.value = 0;
  snapshot.value = null;
  resetChatState();
  resetDmState();
  resetMailState();
}

/** 首屏补历史；拿不到不影响开局。 */
export async function seedLog(): Promise<void> {
  const key = seatKey();
  try {
    const page = await api<{ events?: ChatEvent[] }>('/v1/replay?limit=80');
    if (key !== seatKey()) return;
    for (const event of page.events || []) pushLog(event);
    log.value = [...log.value].sort((a, b) => (a.seq || 0) - (b.seq || 0));
  } catch {
    /* 回放失败就等 SSE */
  }
}

export function serverNow(): number {
  return Date.now() + offset.value;
}

export function tableIdOf(table?: TableSummary | null): string {
  if (!table) return '';
  if (typeof table.tableId === 'string' && table.tableId) return table.tableId;
  if (typeof table.id === 'string' && table.id) return table.id;
  return '';
}

/** 快照里的桌列表；老服务器没有 tables 时退回单桌快照。 */
export function tableList(): TableSummary[] {
  const snap = snapshot.value;
  if (!snap) return [];
  if (Array.isArray(snap.tables) && snap.tables.length) return snap.tables;
  return snap.table ? [snap.table] : [];
}

/** 正在看的那张桌；没指定就看服务器给的「我的桌 / 唯一那张」。 */
export const watchedTable = computed<TableSummary | null>(() => {
  if (!watchTableId.value) return null;
  return tableList().find((table) => tableIdOf(table) === watchTableId.value) || null;
});

export const activeTable = computed<TableSummary | null>(() => watchTableId.value ? watchedTable.value : (snapshot.value?.table || null));

export const myTable = computed<TableSummary | null>(() => {
  const priv = snapshot.value?.tablePrivate;
  if (!priv) return null;
  const id = typeof priv.tableId === 'string' ? priv.tableId : (typeof priv.id === 'string' ? priv.id : '');
  const found = id ? tableList().find((table) => tableIdOf(table) === id) : null;
  return found || snapshot.value?.table || null;
});

/** 只有看着自己那张桌时才带私视图；看别人的桌子就当旁观者。 */
export function activePrivate(): Record<string, unknown> | null {
  const priv = snapshot.value?.tablePrivate;
  if (!priv) return null;
  const table = activeTable.value;
  if (!table) return null;
  const privId = typeof priv.tableId === 'string' ? priv.tableId : (typeof priv.id === 'string' ? priv.id : '');
  const mine = privId
    ? tableIdOf(table) === privId
    : tableIdOf(table) === tableIdOf(snapshot.value?.table);
  return mine ? (priv as Record<string, unknown>) : null;
}

export async function refreshSnapshot(): Promise<void> {
  if (!seat.value) return;
  const key = seatKey();
  if (refreshTask?.key === key) return refreshTask.promise;
  const epoch = syncEpoch;
  const coveredSeq = tableTargetSeq;
  const task = { key, promise: Promise.resolve() };
  task.promise = (async () => {
    try {
      const next = await api<Snapshot>('/v1/room?limit=1');
      if (key !== seatKey() || epoch !== syncEpoch) return;
      syncEpoch += 1;
      snapshot.value = next;
      appliedTableSeq = Math.max(appliedTableSeq, coveredSeq);
      offset.value = next.now - Date.now();
    } catch (error) {
      if (key !== seatKey()) return;
      if ((error as { status?: number }).status === 401) {
        await handleExpiredSeat((error as { seatToken?: string }).seatToken || seat.value?.token || '');
      }
      throw error;
    } finally {
      if (refreshTask === task) refreshTask = undefined;
    }
  })();
  refreshTask = task;
  return task.promise;
}

function newerTable(incoming: { tableId?: string; id?: string; revision?: number }, current?: typeof incoming | null): boolean {
  if (!current || tableIdOf(incoming as TableSummary) !== tableIdOf(current as TableSummary)) return true;
  return (incoming.revision ?? 0) >= (current.revision ?? 0);
}

/** 回执与 /table 共用投影；迟到响应不能盖掉更高 revision 的桌或私视图。 */
function applyTablePatch(patch: TablePatch): boolean {
  const snap = snapshot.value;
  if (!snap || (patch.seq !== undefined && patch.seq < appliedTableSeq)) return false;
  let next: Snapshot = { ...snap };
  if (Array.isArray(patch.tables)) {
    next.tables = patch.tables.map((table) => {
      const current = tableList().find(entry => tableIdOf(entry) === tableIdOf(table));
      return newerTable(table, current) ? table : current!;
    });
  }
  const acceptTable = !patch.table || newerTable(patch.table, snap.table);
  if ('table' in patch && acceptTable) next.table = patch.table ?? null;
  if (patch.table) {
    const entries = [...(next.tables ?? [])];
    const index = entries.findIndex(entry => tableIdOf(entry) === tableIdOf(patch.table));
    if (index < 0) entries.push(patch.table);
    else if (newerTable(patch.table, entries[index])) entries[index] = patch.table;
    next.tables = entries;
  }
  if ('tablePrivate' in patch && acceptTable
    && (!patch.tablePrivate || newerTable(patch.tablePrivate, snap.tablePrivate))) {
    next.tablePrivate = patch.tablePrivate ?? null;
  }
  syncEpoch += 1;
  if (typeof patch.seq === 'number') appliedTableSeq = Math.max(appliedTableSeq, patch.seq);
  snapshot.value = next;
  return true;
}

function scheduleTableRefresh(delay = 120): void {
  if (!seat.value || tableTimer) return;
  tableTimer = window.setTimeout(() => {
    tableTimer = undefined;
    void refreshTable();
  }, delay);
}

async function refreshTable(): Promise<void> {
  if (!seat.value || !snapshot.value || tableTargetSeq <= appliedTableSeq) { tableQueued = false; return; }
  // 自己的 SSE 往往先于 POST 回执；先等回执，避免同一状态再拉两次。
  if (acting || tableFetching) { tableQueued = true; return; }
  tableFetching = true;
  tableQueued = false;
  const key = seatKey();
  const epoch = syncEpoch;
  const coveredSeq = tableTargetSeq;
  let failed = false;
  try {
    const patch = await api<TablePatch>('/v1/table');
    if (key !== seatKey() || epoch !== syncEpoch) return;
    if (!('table' in patch) && !('tablePrivate' in patch) && !Array.isArray(patch.tables)) {
      throw new Error('服务器未返回牌桌增量');
    }
    if (applyTablePatch(patch)) appliedTableSeq = Math.max(appliedTableSeq, coveredSeq);
  } catch (error) {
    failed = true;
    if (key !== seatKey()) return;
    if ((error as { status?: number }).status === 401) await handleExpiredSeat(seat.value?.token || '');
    else scheduleRefresh(0); // 旧服务器没有 /table 时保留全量兜底。
  } finally {
    tableFetching = false;
    if (!failed && (tableQueued || tableTargetSeq > appliedTableSeq)) scheduleTableRefresh(0);
  }
}

/** 开局押注与终局改变账本；单独刷新，不让成功动作等待另一次网络请求。 */
function scheduleLedgerRefresh(delay = 200): void {
  if (!seat.value || ledgerTimer) return;
  ledgerTimer = window.setTimeout(async () => {
    ledgerTimer = undefined;
    const key = seatKey();
    try {
      const body = await api<{ ledger?: Record<string, unknown> }>('/v1/me/ledger');
      if (key === seatKey() && snapshot.value && body.ledger) snapshot.value = { ...snapshot.value, ledger: body.ledger };
    } catch { /* 账本失败不改变已确认动作，下次快照仍可恢复。 */ }
  }, delay);
}

/**
 * 席位令牌失效（401）分两种：存着的令牌就是刚失败的那个 → 真失效，清掉回加入页；
 * 存的已经换了（别的标签页换过席位）→ 就地采用新席位，不能重载旧地址或删新令牌。
 * 与旧 play.js 的 handleExpiredSeat 同一套判断。
 */
async function handleExpiredSeat(token: string): Promise<void> {
  if (switching || readPendingEntry()) return;
  if (!locationTask && token === seat.value?.token && await syncLocation()) { connect(); return; }
  const decision = decideExpiredSeat(
    token,
    readStoredSeat()?.token ?? null,
    seat.value?.token ?? null,
  );
  if (decision === 'ignore') return;
  if (decision === 'reload') {
    // 兼容纯判断函数的旧分支名；实际恢复不再重载页面。
    adoptSharedSeat();
    void followSharedSeat();
    return;
  }
  disconnect();
  clearSeat(SEAT_EXPIRED_MESSAGE);
}

export function scheduleRefresh(delay = 120): void {
  if (!seat.value || refreshTimer) return;
  refreshTimer = window.setTimeout(async () => {
    refreshTimer = undefined;
    try {
      await refreshSnapshot();
    } catch (error) {
      if ((error as { status?: number }).status === 401) {
        await handleExpiredSeat((error as { seatToken?: string }).seatToken || seat.value?.token || '');
      }
    }
  }, delay);
}

/** 大厅目录比快照还贵：加入/离开的高峰期最多 1.2 秒取一次。 */
export function scheduleHallRefresh(): void {
  if (!seat.value || hallTimer) return;
  hallTimer = window.setTimeout(() => {
    hallTimer = undefined;
    void loadHall(true);
  }, 1200);
}

export async function loadHall(force = false): Promise<void> {
  if (!seat.value || hallFetching) return;
  if (!force && hallLoaded.value && Date.now() - hallAt < 8000) return;
  hallFetching = true;
  try {
    const [payload, directory] = await Promise.all([
      api<HallPayload>('/v1/hall'),
      api<Directory>('/v1/rooms?all=1'),
    ]);
    hallSeats.value = payload.hall?.seats || [];
    recruitments.value = payload.recruitments || [];
    rooms.value = (directory.rooms || []).filter((room) => !room.archived);
    hallAt = Date.now();
    hallLoaded.value = true;
    hallError.value = '';
  } catch (error) {
    if ((error as { status?: number }).status === 401) {
      await handleExpiredSeat((error as { seatToken?: string }).seatToken || seat.value?.token || '');
    }
    hallError.value = (error as Error).message || String(error);
  } finally {
    hallFetching = false;
  }
}

function handleEvent(event: ChatEvent): void {
  if (typeof event.seq !== 'number') return;
  latest.value = Math.max(latest.value, event.seq);
  pushLog(event);
  const type = event.type || '';
  if (!((type === 'parlor.joined' || type === 'parlor.left') && event.data?.presenceWeb === false)) noteChatEvent(event);
  if (type === 'parlor.whisper') {
    noteWhisper();
    // 私聊会改信箱未读；快照里带着 mailUnread，顶栏角标靠它更新。
    scheduleRefresh(300);
  }
  if (type === 'parlor.joined' || type === 'parlor.left') {
    scheduleRefresh(1000);
    scheduleHallRefresh();
  }
  if (type === 'parlor.ledger') {
    scheduleRefresh(120);
  }
  if (type.startsWith('parlor.table.') && type !== 'parlor.table.say') {
    tableTargetSeq = Math.max(tableTargetSeq, event.seq);
    if (event.seq > appliedTableSeq) scheduleTableRefresh();
    if (type === 'parlor.table.end' || type === 'parlor.table.cancel') scheduleLedgerRefresh();
  }
}

export async function syncLocation(): Promise<boolean> {
  if (switching) return false;
  const adopted = adoptSharedSeat();
  if (roomTransition.value) return false;
  const cfg = seat.value;
  if (!cfg) return adopted;
  const key = seatKey();
  if (locationTask?.key === key) return locationTask.promise;
  const task = { key, promise: Promise.resolve(false) };
  task.promise = (async () => {
    let changed = adopted;
    try {
      const current = await api<{ room:string|null;seat:{id:string;name:string}|null }>('/v1/me/location');
      if (switching || roomTransition.value) return false;
      if (!current?.room || !current.seat || key !== seatKey()) return false;
      // 另一窗可能刚完成换厅但storage事件尚未分发，旧位置响应不能写回覆盖它。
      if (seatKey(readStoredSeat()) !== key) {
        adoptSharedSeat(); void followSharedSeat(); return true;
      }
      if (current.room !== cfg.room || current.seat.id !== cfg.seatId) {
        disconnect(); resetRoomState(); backToRoom();
        saveSeat({ ...cfg, room:current.room, seatId:current.seat.id, name:current.seat.name });
        replaceRoomUrl(current.room);
        changed = true;
        showToast(current.room === 'hall' ? '席位已更新，现已回到大厅。' : '席位已更新，已跟随到当前客厅。');
      }
      if (changed) { await refreshSnapshot(); void seedLog(); }
      return changed;
    } catch (error) {
      if (key !== seatKey()) return false;
      if (adoptSharedSeat()) { void followSharedSeat(); return true; }
      if ((error as { status?: number }).status === 401) {
        disconnect(); resetRoomState(); clearSeat(SEAT_EXPIRED_MESSAGE);
      }
      return changed;
    }
    finally { if (locationTask === task) locationTask = undefined; }
  })();
  locationTask = task;
  return task.promise;
}

export function connect(refreshOnOpen = true): void {
  if (!seat.value) return;
  disconnect();
  connection.value = 'connecting';
  const source = new EventSource(scopedPath('/v1/stream?cap=seat-location-v1&since=' + latest.value + '&token=' + encodeURIComponent(seat.value.token)));
  stream = source;
  source.onopen = () => {
    if (stream !== source) return;
    connection.value = 'on';
    reconnectFailures = 0;
    if (refreshOnOpen) scheduleRefresh();
    else if (snapshot.value && seat.value && snapshot.value.id === seat.value.room) {
      // 首屏刚取过；连接确认后只补上本人在线状态，避免又拉一次整厅。
      snapshot.value = { ...snapshot.value, online: [...new Set([...(snapshot.value.online || []), seat.value.seatId])] };
    }
  };
  source.onmessage = (message) => {
    if (stream !== source) return;
    let event: { seq?: number; type?: string };
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    handleEvent(event);
  };
  source.onerror = () => {
    if (stream !== source) return;
    connection.value = 'off';
    source.close();
    if (stream === source) stream = null;
    const delay = Math.min(30000, 3000 * 2 ** Math.min(reconnectFailures++, 4)) + Math.floor(Math.random()*1500);
    reconnectTimer = window.setTimeout(() => { void syncLocation().then(() => { if (seat.value && !stream) connect(); }); }, delay);
  };
}

export function disconnect(): void {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  if (stream) {
    stream.close();
    stream = null;
  }
  connection.value = 'idle';
}

let switching = false;

/** 服务器确认换席位后就地加载目的地，不再重载整页和串行等待聊天历史。 */
export async function goRoom(id: string, targetTable = '', replace = false): Promise<boolean> {
  const cfg = seat.value;
  // 启动时快照还没到，用席位里记着的客厅当出发地。
  const from = cfg?.room || snapshot.value?.id || '';
  if (!cfg || !from || switching) return false;
  if (id === from) return true;
  if (acting) {
    showToast('上一操作正在处理，请稍后再换客厅。', 'bad');
    return false;
  }
  switching = true;
  const key = seatKey();
  const previousTransition = roomTransition.value;
  roomTransition.value = {
    from: from === 'hall' ? '大厅' : (snapshot.value?.name || '客厅'),
    to: id,
    name: id === 'hall' ? '大厅' : (rooms.value.find(room => room.id === id)?.name || '客厅'),
    error: '',
  };
  disconnect();
  window.clearTimeout(refreshTimer);
  refreshTimer = undefined;
  let movedSeat = false;
  try {
    const moved = await api<{ room: string; token: string; seat: { id: string; name: string }; snapshot?: Snapshot }>(
      `/v1/rooms/${encodeURIComponent(from)}/switch`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: id, includeSnapshot: true }) },
    );
    if (key !== seatKey() || seatKey(readStoredSeat()) !== key) {
      sharedSeatPending = true;
      roomTransition.value = null;
      return false;
    }
    saveSeat({ ...cfg, room: moved.room, token: moved.token, seatId: moved.seat.id, name: moved.seat.name });
    movedSeat = true;
    resetRoomState();
    const params = new URLSearchParams(location.search);
    params.set('room', moved.room);
    params.delete('view');
    params.delete('table');
    if (targetTable) {
      params.set('view', 'table');
      params.set('table', targetTable);
    }
    history[replace ? 'replaceState' : 'pushState']({ parlor: true }, '', '/play?' + params.toString());
    readView();
    return await finishRoomTransition(moved.snapshot);
  } catch (error) {
    if (movedSeat) {
      if (roomTransition.value) roomTransition.value.error = (error as Error).message || '暂时没有读到目的地，请重试。';
      return false;
    }
    roomTransition.value = previousTransition;
    if ((error as { status?:number }).status === 401) sharedSeatPending = true;
    if ((error as { status?:number }).status === 403) await syncLocation();
    hallError.value = (error as Error).message || '换不了客厅';
    showToast(hallError.value, 'bad');
    if (seat.value?.token === cfg.token && !roomTransition.value) connect();
    return false;
  } finally {
    switching = false;
    if (sharedSeatPending) { sharedSeatPending = false; void followSharedSeat(); }
  }
}

/** 换席位已经成功时，重试只补目的地快照，不能再发一次换厅请求。 */
export async function finishRoomTransition(initial?: Snapshot): Promise<boolean> {
  const transition = roomTransition.value;
  if (!transition) return false;
  transition.error = '';
  try {
    if (initial && initial.id === seat.value?.room && initial.seat?.id === seat.value?.seatId) {
      syncEpoch += 1;
      snapshot.value = initial;
      offset.value = initial.now - Date.now();
    } else {
      await refreshSnapshot();
    }
    const next = snapshot.value;
    if (!next || next.id !== seat.value?.room) throw new Error('暂时没有读到目的地，请重试。');
    latest.value = next.latest || 0;
    connect(false);
    void seedLog();
    roomTransition.value = null;
    return true;
  } catch (error) {
    transition.error = (error as Error).message || '暂时没有读到目的地，请重试。';
    return false;
  }
}

/** 地址栏里的 ?room= 与当前席位不同就换过去；分享/邀请链接靠它生效。 */
export async function syncRouteRoom(): Promise<boolean> {
  const wanted = new URLSearchParams(location.search).get('room') || '';
  if (!seat.value || !wanted || wanted === seat.value.room) return false;
  return goRoom(wanted, new URLSearchParams(location.search).get('table') || '', true);
}

let acting = false;

/** 需要幂等键的动作；与旧 play.js 的 IDEMPOTENT_ACTIONS 一致。 */
const IDEMPOTENT = new Set([
  'table_open', 'table_join', 'table_leave', 'table_start', 'table_rematch', 'table_action', 'ddz_action', 'werewolf_action', 'monopoly',
  'monopoly2d_action', 'gomoku_action', 'table_discovery',
]);

/**
 * 严格版本（整桌 revision 乐观锁）的玩法动作。浏览器不引服务端注册表，
 * 这里维护一份最小清单；新增严格模式游戏时同步加一行，测试会盯住发送行为。
 */
const STRICT_ACTIONS = new Set(['table_action', 'ddz_action', 'monopoly2d_action', 'gomoku_action']);

function newRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* 有些环境 randomUUID 不可调用 */
  }
  const bytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 大厅匹配/定向入桌共用服务端事务，失败时不会只换了厅却没坐下。 */
type EntryTarget = { game: string } | { room: string; table: string };
const ENTRY_PENDING_KEY = 'parlor-table-entry-pending';
let pendingEntry: { sourceSeatId: string; requestId: string; target: EntryTarget } | null = null;
function readPendingEntry(): typeof pendingEntry {
  try {
    const saved = JSON.parse(sessionStorage.getItem(ENTRY_PENDING_KEY) || 'null');
    if (saved?.sourceSeatId === seat.value?.seatId && typeof saved.requestId === 'string' && saved.target
      && (typeof saved.target.game === 'string' || (typeof saved.target.room === 'string' && typeof saved.target.table === 'string'))) return saved;
  } catch { /* 不支持会话存储时用内存保留重试编号。 */ }
  return pendingEntry?.sourceSeatId === seat.value?.seatId ? pendingEntry : null;
}
function savePendingEntry(value: typeof pendingEntry): void {
  pendingEntry = value;
  try { if (value) sessionStorage.setItem(ENTRY_PENDING_KEY, JSON.stringify(value)); else sessionStorage.removeItem(ENTRY_PENDING_KEY); } catch { /* 私密浏览 */ }
}

export async function enterDiscoveredTable(target: { game: string } | { room: string; table: string }): Promise<boolean> {
  if (switching || acting || !seat.value) return false;
  switching = true;
  const cfg = seat.value;
  const key = seatKey();
  const previous = readPendingEntry();
  const entry = previous || { sourceSeatId: cfg.seatId, requestId: newRequestId(), target };
  if (previous) showToast('正在确认上一次加入的结果…');
  savePendingEntry(entry);
  let unresolved = true;
  let navigating = false;
  disconnect();
  try {
    const send = () => api<TableEntryResponse>('/v1/table-entry', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...entry.target, requestId: entry.requestId }),
    });
    let result: TableEntryResponse;
    try { result = await send(); } catch (error) {
      if (!(error instanceof TypeError) && (error as Error).name !== 'TimeoutError') throw error;
      if (key !== seatKey() || seatKey(readStoredSeat()) !== key) { unresolved = false; sharedSeatPending = true; savePendingEntry(null); return false; }
      result = await send();
    }
    unresolved = false;
    savePendingEntry(null);
    if (key !== seatKey() || seatKey(readStoredSeat()) !== key) { sharedSeatPending = true; return false; }
    if (!result.matched) {
      showToast('暂时没有合适的开放牌桌，你仍在原来的客厅。');
      return false;
    }
    saveSeat({ ...cfg, room: result.room, token: result.token, seatId: result.seat.id, name: result.seat.name });
    navigating = true;
    location.assign('/play?' + new URLSearchParams({ room: result.room, view: 'table', table: result.tableId }));
    return true;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status && status < 500) { unresolved = false; savePendingEntry(null); }
    if (unresolved) {
      const message = '加入结果尚未确认，请重试或刷新页面，系统会确认同一次请求。';
      showToast(message, 'bad');
      throw new Error(message);
    }
    showToast((error as { status?: number }).status === 404 ? '服务器尚未支持匹配，或这张桌已经关闭，请刷新后重试。' : ((error as Error).message || '加入牌桌失败'), 'bad');
    throw error;
  } finally {
    switching = false;
    if (sharedSeatPending) { sharedSeatPending = false; void followSharedSeat(); }
    // 结果不确定时保留原凭证与编号；不能让旧 SSE 的 401 把恢复入口清掉。
    if (!unresolved && !navigating && seat.value?.token === cfg.token) connect();
  }
}

/** 牌桌动作只写「做什么」；「对哪张桌、基于哪一版」在这里补。与旧版 withTableFields 一致。 */
function withTableFields(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body };
  const type = typeof out.type === 'string' ? out.type : '';
  if (!type || type === 'table_open') return out;
  if (type === 'table_join') {
    if (!out.table) {
      const target = activeTable.value;
      if (target) out.table = tableIdOf(target);
    }
    return out;
  }
  if (!type.startsWith('table_') && !STRICT_ACTIONS.has(type) && type !== 'werewolf_action') return out;
  const mine = tableIdOf(myTable.value);
  if (mine && !out.table) out.table = mine;
  if (STRICT_ACTIONS.has(type)) {
    const priv = snapshot.value?.tablePrivate as Record<string, unknown> | null | undefined;
    const revision = priv?.revision;
    if (typeof revision === 'number' && out.revision === undefined) out.revision = revision;
  }
  return out;
}

/** 有桌增量时直接应用；非牌桌动作或旧服务器仍走全量快照。 */
export async function act(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (switching || roomTransition.value) {
    showToast('正在换客厅，请稍后再操作。', 'bad');
    return null;
  }
  if (acting) {
    showToast('上一操作正在处理，这次尚未发送，请稍后重试。', 'bad');
    return null;
  }
  if (adoptSharedSeat()) {
    void followSharedSeat();
    showToast('席位已更新，请确认当前客厅后再操作。');
    return null;
  }
  acting = true;
  const key = seatKey();
  try {
    const payload = withTableFields(body);
    const retryable = typeof payload.type === 'string' && IDEMPOTENT.has(payload.type);
    if (retryable) payload.requestId = newRequestId();
    const send = () => api<Record<string, unknown>>('/v1/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let receipt: Record<string, unknown>;
    try {
      receipt = await send();
    } catch (error) {
      // 只重发「可能没到服务器」的那一次；同一个 requestId，服务器会去重。
      if (!retryable || !(error instanceof TypeError)) throw error;
      if (key !== seatKey() || seatKey(readStoredSeat()) !== key) { void followSharedSeat(); return null; }
      receipt = await send();
    }
    if (key !== seatKey() || seatKey(readStoredSeat()) !== key) { void followSharedSeat(); return null; }
    if (typeof receipt.seq === 'number') latest.value = Math.max(latest.value, receipt.seq);
    if ('table' in receipt || 'tablePrivate' in receipt || Array.isArray(receipt.tables)) {
      if (!applyTablePatch(receipt as TablePatch)) {
        if (!snapshot.value) await refreshSnapshot();
      }
      if (payload.type === 'table_start') scheduleLedgerRefresh(0);
    } else {
      await refreshSnapshot();
    }
    return receipt;
  } catch (error) {
    if (key !== seatKey()) throw error;
    if ((error as { status?: number }).status === 401) {
      await handleExpiredSeat((error as { seatToken?: string }).seatToken || seat.value?.token || '');
      throw error;
    }
    // 渲染器把 act 的错误吞掉了（`.catch(() => {})`），所以提示要在这里发。
    showToast((error as Error).message || '动作没成功', 'bad');
    if ((error as { status?: number }).status === 409) scheduleRefresh(0);
    throw error;
  } finally {
    acting = false;
    if (tableQueued || tableTargetSeq > appliedTableSeq) {
      tableQueued = false;
      scheduleTableRefresh(0);
    }
  }
}

export async function openRoomTable(game: string, requireHuman = false, seatCount?: 6 | 9 | 12): Promise<boolean> {
  const receipt = await act({ type: 'table_open', game, ...(requireHuman ? { requireHuman: true } : {}), ...(seatCount === undefined ? {} : { seatCount }) });
  if (!receipt) return false;
  enterTable(typeof receipt.tableId === 'string' ? receipt.tableId : '');
  return true;
}

export async function joinRoomTable(id: string): Promise<boolean> {
  const receipt = await act({ type: 'table_join', ...(id ? { table: id } : {}) });
  if (!receipt) return false;
  enterTable(id);
  return true;
}

/**
 * 再来一局：本厅已有同玩法、还开着、没坐满的桌就并入，没有就开一张新的。
 * 服务端不复用刚结束的那张桌（终局表以桌号为主键），所以这里只需要一次动作。
 */
export async function rematchRoomTable(game: string, seatCount?: 6 | 9 | 12): Promise<boolean> {
  const receipt = await act({
    type: 'table_rematch', game,
    ...(seatCount === undefined ? {} : { seatCount }),
  });
  if (!receipt) return false;
  enterTable(typeof receipt.tableId === 'string' ? receipt.tableId : '');
  return true;
}

export async function startRoomTable(): Promise<boolean> {
  return (await act({ type: 'table_start' })) !== null;
}

export async function leaveRoomTable(): Promise<boolean> {
  const done = (await act({ type: 'table_leave' })) !== null;
  if (done) backToRoom();
  return done;
}

/** 首次进入：钥匙/统一身份票据 → 取第一份快照 → 连 SSE。没有席位时返回 false。 */
export async function boot(): Promise<boolean> {
  const previousSeat = seat.value;
  const identityArgs = new URLSearchParams(location.hash.slice(1));
  const entrySearch = location.search;
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const explicitEntry = identityArgs.has('identity') || identityArgs.has('key');
  // 新打开的分享链接是换厅意图；刷新、历史恢复及已消费的页内地址只恢复当前位置。
  const useEntryRoom = explicitEntry || (navigation?.type !== 'reload' && navigation?.type !== 'back_forward' && !history.state?.parlor);
  const target = new URLSearchParams(entrySearch);
  const wanted = useEntryRoom ? target.get('room') || '' : '';
  const hashIdentity = identityArgs.get('identity') || '';
  if (hashIdentity) {
    identityTicket = hashIdentity;
    identityState = identityArgs.get('state') || '';
    history.replaceState(null, '', location.pathname + location.search);
  }
  // 与钥匙同一条规矩：地址栏里新粘的票据优先；已有席位时不拿内存里的旧票据替用户换身份。
  // 回跳票据留在内存里，断网导致第一次请求没到服务器时，「再试一次」还能用同一张票。
  const ticket = hashIdentity || (seat.value ? '' : identityTicket);
  if (ticket) {
    try {
      await finishGlobalEntry(ticket, hashIdentity ? identityArgs.get('state') || '' : identityState);
      // 换到席位才算这张票用完了；断网失败要留着，否则重试一次请求都不发。
      identityTicket = '';
      identityState = '';
    } catch (error) {
      // 票据/授权本身失效：留着只会一直报同一句，清掉并让加入页引导重新授权。
      if (error instanceof IdentityExpiredError) {
        identityTicket = '';
        identityState = '';
      }
      if (!seat.value) throw error;
      showToast((error as Error).message || '统一身份没换成席位', 'bad');
    }
  }
  // 面板给的 #key= 链接：一次请求换会话 + 领席位，用完从地址栏抹掉。
  // 换不到但旧席位还在时，沿用旧席位继续（与旧版一致），只在没有旧席位时把错误抛给加入页。
  // 地址栏抹掉后钥匙留在 entryKey 里：断网时第一次请求可能没到服务器，重试还要用它。
  // 已经有席位就不再替用户换身份（比如重试失败后改用邀请码入场）；地址栏里新粘的 key 仍然优先。
  const key = takeKeyFromHash() || (seat.value ? '' : entryKey);
  if (key) {
    entryKey = key;
    try {
      const played = await parentPlay(key);
      if (played.globalEntry) {
        beginGlobalEntry(played.globalEntry, { room: played.room || 'hall', parent: true });
        // 已经转交统一身份：回来时用 sessionStorage 里的 pending，不再需要这把钥匙。
        entryKey = '';
        return false;
      }
      // 换到席位才算这把钥匙用完了；失败时留着，下一次 boot() 还能再试一次。
      entryKey = '';
    } catch (error) {
      if (!seat.value) throw error;
      showToast((error as Error).message || '这个家长链接没换成席位', 'bad');
    }
  }
  // 页面内换席位（#key= / 身份回跳）：清掉上一个厅的日志与游标，否则旧厅 seq 会吞新厅事件。
  if (seatChanged(previousSeat, seat.value)) resetRoomState();
  if (!seat.value) return false;
  history.replaceState({ ...history.state, parlor: true }, '', location.pathname + location.search);
  await syncLocation();
  if (!seat.value) return false;
  const unfinishedEntry = readPendingEntry();
  if (unfinishedEntry && await enterDiscoveredTable(unfinishedEntry.target)) return false;
  if (wanted && wanted !== seat.value.room) {
    const moved = await goRoom(wanted, target.get('table') || '', true);
    if (moved) return true;
    throw new Error(hallError.value || '换不到这个客厅');
  }
  if (wanted) history.replaceState({ ...history.state, parlor: true }, '', location.pathname + entrySearch);
  else if (target.get('room') !== seat.value.room) replaceRoomUrl(seat.value.room);
  await refreshSnapshot();
  latest.value = snapshot.value?.latest || 0;
  connect(false);
  void seedLog();
  return true;
}
