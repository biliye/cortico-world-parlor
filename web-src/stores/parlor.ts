/**
 * 迁移期的状态层：先只接大厅需要的部分（快照、在线名单、客厅目录、SSE）。
 * 并发闸门照旧：同一时刻只允许一次快照刷新、一次目录请求；SSE 断了 3 秒后重连。
 * 牌桌与聊天的增量逻辑留在旧 play.js，等第 3 刀再搬。
 */
import { computed, ref } from 'vue';
import { api, beginGlobalEntry, finishGlobalEntry, parentPlay, scopedPath, takeKeyFromHash } from '../api/client.ts';
import { noteChatEvent } from './chat.ts';
import { noteWhisper } from './dm.ts';
import { saveSeat, seat, clearSeat, readStoredSeat } from './session.ts';
import { showToast } from './ui.ts';
import { backToRoom, enterTable, watchTableId } from './view.ts';
import type { ChatEvent, Directory, HallPayload, HallSeat, RoomCard, Snapshot, TableSummary } from '../api/types.ts';

export const snapshot = ref<Snapshot | null>(null);
export const offset = ref(0);
export const latest = ref(0);
export const connection = ref<'idle' | 'connecting' | 'on' | 'off'>('idle');
export const hallSeats = ref<HallSeat[]>([]);
export const rooms = ref<RoomCard[]>([]);
export const hallLoaded = ref(false);
export const hallError = ref('');
export const bootError = ref('');
export const log = ref<ChatEvent[]>([]);

let stream: EventSource | null = null;
let reconnectTimer: number | undefined;
let refreshTimer: number | undefined;
let hallTimer: number | undefined;
let refreshing = false;
let hallFetching = false;
let hallAt = 0;
const seen = new Set<number>();

/** 去重后追加；上限 300 条，和旧版一样只留最近的。 */
function pushLog(event: ChatEvent): void {
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

/** 首屏补历史；拿不到不影响开局。 */
export async function seedLog(): Promise<void> {
  try {
    const page = await api<{ events?: ChatEvent[] }>('/v1/replay?limit=80');
    for (const event of page.events || []) pushLog(event);
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

export const activeTable = computed<TableSummary | null>(() => watchedTable.value || snapshot.value?.table || null);

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
  if (!seat.value || refreshing) return;
  refreshing = true;
  try {
    const next = await api<Snapshot>('/v1/room?limit=1');
    snapshot.value = next;
    offset.value = next.now - Date.now();
  } catch (error) {
    if ((error as { status?: number }).status === 401) {
      await handleExpiredSeat((error as { seatToken?: string }).seatToken || seat.value?.token || '');
    }
    throw error;
  } finally {
    refreshing = false;
  }
}

/**
 * 席位令牌失效（401）分两种：存着的令牌就是刚失败的那个 → 真失效，清掉回加入页；
 * 存的已经换了（别的标签页换过席位）→ 这一页只是旧了，重载一次，不能把新令牌删掉。
 * 与旧 play.js 的 handleExpiredSeat 同一套判断。
 */
async function handleExpiredSeat(token: string): Promise<void> {
  const stored = readStoredSeat();
  if (stored && token && stored.token !== token) {
    if (seat.value && seat.value.token === stored.token) return;
    location.reload();
    return;
  }
  if (!stored && !seat.value) return;
  disconnect();
  clearSeat();
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
  noteChatEvent(event);
  const type = event.type || '';
  if (type === 'parlor.whisper') noteWhisper();
  if (type === 'parlor.say' || type === 'parlor.table.say') return;
  if (type === 'parlor.joined' || type === 'parlor.left') {
    scheduleRefresh(1000);
    scheduleHallRefresh();
  }
}

export function connect(): void {
  if (!seat.value) return;
  disconnect();
  connection.value = 'connecting';
  const source = new EventSource(scopedPath('/v1/stream?since=' + latest.value + '&token=' + encodeURIComponent(seat.value.token)));
  stream = source;
  source.onopen = () => {
    connection.value = 'on';
    scheduleRefresh();
  };
  source.onmessage = (message) => {
    let event: { seq?: number; type?: string };
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    handleEvent(event);
  };
  source.onerror = () => {
    connection.value = 'off';
    source.close();
    if (stream === source) stream = null;
    scheduleRefresh();
    reconnectTimer = window.setTimeout(connect, 3000);
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

/** 换客厅：服务器换一张令牌，然后整页跳到新客厅（与旧版同一做法）。 */
export async function goRoom(id: string): Promise<boolean> {
  const cfg = seat.value;
  const from = snapshot.value?.id || cfg?.room || '';
  if (!cfg || !from || switching) return false;
  if (id === from) return true;
  switching = true;
  try {
    const moved = await api<{ room: string; token: string; seat: { id: string; name: string } }>(
      `/v1/rooms/${encodeURIComponent(from)}/switch`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: id }) },
    );
    saveSeat({ ...cfg, room: moved.room, token: moved.token, seatId: moved.seat.id, name: moved.seat.name });    const params = new URLSearchParams(location.search);
    params.set('room', moved.room);
    params.delete('view');
    params.delete('table');
    location.assign('/play?' + params.toString());
    return true;
  } catch (error) {
    hallError.value = (error as Error).message || '换不了客厅';
    return false;
  } finally {
    switching = false;
  }
}

let acting = false;

/** 需要幂等键的动作；与旧 play.js 的 IDEMPOTENT_ACTIONS 一致。 */
const IDEMPOTENT = new Set([
  'table_open', 'table_join', 'table_leave', 'table_start', 'table_action', 'ddz_action', 'werewolf_action', 'monopoly',
]);

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
  if (!type.startsWith('table_') && type !== 'ddz_action' && type !== 'werewolf_action') return out;
  const mine = tableIdOf(myTable.value);
  if (mine && !out.table) out.table = mine;
  if (type === 'table_action' || type === 'ddz_action') {
    const priv = snapshot.value?.tablePrivate as Record<string, unknown> | null | undefined;
    const revision = priv?.revision;
    if (typeof revision === 'number' && out.revision === undefined) out.revision = revision;
  }
  return out;
}

/** 通用动作。回执里可能带桌与私视图，这一刀先统一「动作后拉一份快照」，保证状态一致。 */
export async function act(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (acting) return null;
  acting = true;
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
      receipt = await send();
    }
    if (typeof receipt.seq === 'number') latest.value = Math.max(latest.value, receipt.seq);
    await refreshSnapshot();
    return receipt;
  } catch (error) {
    if ((error as { status?: number }).status === 401) {
      await handleExpiredSeat((error as { seatToken?: string }).seatToken || seat.value?.token || '');
      throw error;
    }
    // 渲染器把 act 的错误吞掉了（`.catch(() => {})`），所以提示要在这里发。
    showToast((error as Error).message || '动作没成功', 'bad');
    throw error;
  } finally {
    acting = false;
  }
}

export async function openRoomTable(game: string): Promise<boolean> {
  const receipt = await act({ type: 'table_open', game });
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
  const identityArgs = new URLSearchParams(location.hash.slice(1));
  if (identityArgs.has('identity')) {
    history.replaceState(null, '', location.pathname + location.search);
    await finishGlobalEntry(identityArgs.get('identity') || '', identityArgs.get('state') || '');
  }
  // 面板给的 #key= 链接：一次请求换会话 + 领席位，用完从地址栏抹掉。
  // 换不到但旧席位还在时，沿用旧席位继续（与旧版一致），只在没有旧席位时把错误抛给加入页。
  const key = takeKeyFromHash();
  if (key) {
    try {
      const played = await parentPlay(key);
      if (played.globalEntry) {
        beginGlobalEntry(played.globalEntry, { room: played.room || 'hall', parent: true });
        return false;
      }
    } catch (error) {
      if (!seat.value) throw error;
      showToast((error as Error).message || '这个家长链接没换成席位', 'bad');
    }
  }
  if (!seat.value) return false;
  await refreshSnapshot();
  latest.value = snapshot.value?.latest || 0;
  await seedLog();
  connect();
  return true;
}
