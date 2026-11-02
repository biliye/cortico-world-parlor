/**
 * 私聊浮窗的状态：会话列表、找人、当前对话、发送与已读。
 * 打开时每 5 秒轻刷一次（与旧版一致）；收到 whisper 事件也会轻刷会话列表。
 */
import { ref } from 'vue';
import { api } from '../api/client.ts';

export interface DmThread {
  peer: string;
  name?: string;
  handle?: string;
  online?: boolean;
  unread?: number;
  lastText?: string;
  lastFromMe?: boolean;
  lastTs?: number;
}

export interface DmMessage {
  fromMe?: boolean;
  text?: string;
  ts?: number;
}

export interface DmPerson {
  cooId: string;
  name?: string;
  handle?: string;
  online?: boolean;
}

const POS_KEY = 'parlor-dm-pos-v1';

export const open = ref(false);
export const threads = ref<DmThread[]>([]);
export const unread = ref(0);
export const query = ref('');
export const people = ref<DmPerson[]>([]);
export const peer = ref<{ cooId: string; name?: string; handle?: string } | null>(null);
export const messages = ref<DmMessage[]>([]);
export const loading = ref(false);
export const error = ref('');
export const pos = ref<{ left: number; top: number } | null>(readPos());

let timer: number | undefined;
let searchTimer: number | undefined;
let refreshTimer: number | undefined;

function readPos(): { left: number; top: number } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (!raw || typeof raw.left !== 'number' || typeof raw.top !== 'number') return null;
    return { left: raw.left, top: raw.top };
  } catch {
    return null;
  }
}

export function savePos(left: number, top: number): void {
  pos.value = { left, top };
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({ left, top }));
  } catch {
    /* 存不了就这次有效 */
  }
}

export async function loadThreads(): Promise<void> {
  try {
    const data = await api<{ threads?: DmThread[]; unread?: number }>('/v1/dm/threads');
    threads.value = data.threads || [];
    unread.value = data.unread || 0;
  } catch {
    /* 掉线时静默，下一次轮询再试 */
  }
}

export async function loadPeople(): Promise<void> {
  const text = query.value.trim();
  if (!text) {
    people.value = [];
    return;
  }
  try {
    const data = await api<{ people?: DmPerson[] }>('/v1/people?q=' + encodeURIComponent(text));
    if (query.value.trim() !== text) return;
    people.value = data.people || [];
  } catch {
    /* 搜索失败就当没有 */
  }
}

export function setQuery(value: string): void {
  query.value = value;
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => { void loadPeople(); }, 250);
}

async function loadMessages(cooId: string, quiet = false): Promise<void> {
  try {
    const data = await api<{ peer?: { name?: string; handle?: string }; messages?: DmMessage[] }>(
      '/v1/dm?peer=' + encodeURIComponent(cooId) + '&limit=60',
    );
    if (!peer.value || peer.value.cooId !== cooId) return;
    if (data.peer?.name) peer.value.name = data.peer.name;
    if (data.peer?.handle) peer.value.handle = data.peer.handle;
    messages.value = data.messages || [];
    error.value = '';
  } catch (caught) {
    if (!quiet) error.value = (caught as Error).message || '取不到聊天';
  }
}

async function markRead(cooId: string): Promise<void> {
  try {
    await api('/v1/dm/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peer: cooId }),
    });
    await loadThreads();
  } catch {
    /* 已读标不上不影响看 */
  }
}

export async function openThread(cooId: string, name = '', handle = ''): Promise<void> {
  peer.value = { cooId, name, handle };
  messages.value = [];
  loading.value = true;
  error.value = '';
  try {
    await loadMessages(cooId);
    await markRead(cooId);
  } finally {
    loading.value = false;
  }
}

export async function send(text: string): Promise<boolean> {
  const target = peer.value;
  if (!target || !text.trim()) return false;
  try {
    const data = await api<{ message?: DmMessage }>('/v1/dm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: target.cooId, text: text.trim() }),
    });
    if (data.message) messages.value = [...messages.value, data.message];
    await loadThreads();
    return true;
  } catch (caught) {
    error.value = (caught as Error).message || '没发出去';
    return false;
  }
}

function startPolling(): void {
  stopPolling();
  timer = window.setInterval(() => {
    if (!open.value) return;
    void loadThreads();
    if (peer.value) void loadMessages(peer.value.cooId, true);
  }, 5000);
}

function stopPolling(): void {
  window.clearInterval(timer);
  timer = undefined;
}

export function openWindow(): void {
  open.value = true;
  void loadThreads();
  void loadPeople();
  startPolling();
}

export function close(): void {
  open.value = false;
  stopPolling();
}

export function toggle(): void {
  if (open.value) close();
  else openWindow();
}

/** 收到一条 whisper：轻刷会话列表（有未读就亮角标）。 */
export function noteWhisper(): void {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => { void loadThreads(); }, 400);
}
