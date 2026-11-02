/**
 * 迁移期的状态层：先只接大厅需要的部分（快照、在线名单、客厅目录、SSE）。
 * 并发闸门照旧：同一时刻只允许一次快照刷新、一次目录请求；SSE 断了 3 秒后重连。
 * 牌桌与聊天的增量逻辑留在旧 play.js，等第 3 刀再搬。
 */
import { ref } from 'vue';
import { api, finishGlobalEntry, scopedPath } from '../api/client.ts';
import { noteChatEvent } from './chat.ts';
import { saveSeat, seat } from './session.ts';
import type { ChatEvent, Directory, HallPayload, HallSeat, RoomCard, Snapshot } from '../api/types.ts';

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

export async function refreshSnapshot(): Promise<void> {
  if (!seat.value || refreshing) return;
  refreshing = true;
  try {
    const next = await api<Snapshot>('/v1/room?limit=1');
    snapshot.value = next;
    offset.value = next.now - Date.now();
  } finally {
    refreshing = false;
  }
}

export function scheduleRefresh(delay = 120): void {
  if (!seat.value || refreshTimer) return;
  refreshTimer = window.setTimeout(async () => {
    refreshTimer = undefined;
    try {
      await refreshSnapshot();
    } catch (error) {
      if ((error as { status?: number }).status === 401) disconnect();
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

/** 首次进入：换统一身份票据 → 取第一份快照 → 连 SSE。没有席位时返回 false。 */
export async function boot(): Promise<boolean> {
  const identityArgs = new URLSearchParams(location.hash.slice(1));
  if (identityArgs.has('identity')) {
    history.replaceState(null, '', location.pathname + location.search);
    await finishGlobalEntry(identityArgs.get('identity') || '', identityArgs.get('state') || '');
  }
  if (!seat.value) return false;
  await refreshSnapshot();
  latest.value = snapshot.value?.latest || 0;
  await seedLog();
  connect();
  return true;
}
