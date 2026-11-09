/**
 * 运营公告：一分钟看一次，页面在后台不发；同一份给首屏横幅用。
 * 点过「知道了」把公告 id 记在本地，同时把左栏那套「已读」一起记上。
 */
import { computed, ref } from 'vue';
import { api } from '../api/client.ts';
import { seat } from './session.ts';
import { pick, remember, type Announcement } from '../lib/announcement-rules.ts';

const DISMISSED_KEY = 'parlor-announcements-dismissed';
const SEEN_KEY = 'parlor-announcements-seen';

export const items = ref<Announcement[]>([]);
export const dismissed = ref<string[]>(readList(DISMISSED_KEY));
/** 第一次请求落地（成功或失败）就置 true；大厅小报据此判断「是不是真的没有公告」。 */
export const loaded = ref(false);

export const current = computed<Announcement | null>(() => pick(items.value, dismissed.value));

let watching = false;

function readList(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function writeList(key: string, list: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* 记不住就下次再说 */
  }
}

/** force：首屏与切回前台时不受「后台不发请求」限制；轮询仍然跳过后台。 */
export async function refreshAnnouncements(force = false): Promise<void> {
  if (!force && typeof document !== 'undefined' && document.hidden) return;
  const token = seat.value?.token || '';
  if (!token) return;
  try {
    const response = await fetch('/v1/support/announcements', {
      headers: { authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return;
    const data = await response.json() as { announcements?: Announcement[] };
    items.value = Array.isArray(data.announcements) ? data.announcements : [];
  } catch {
    /* 断网不弹提示 */
  } finally {
    loaded.value = true;
  }
}

/** 整个页面只起一份计时器；从后台切回来时立刻补一次。 */
export function startAnnouncementWatch(interval = 60_000): void {
  if (watching) return;
  watching = true;
  window.setTimeout(() => { void refreshAnnouncements(true); }, 0);
  window.setInterval(() => { void refreshAnnouncements(); }, interval);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refreshAnnouncements(true);
  });
}

/** 一次点掉「现在这一批」，以后新发的照常出现。 */
export function dismissAll(): void {
  const ids = items.value.map((item) => item.id).filter((id) => typeof id === 'string');
  let next = dismissed.value;
  for (const id of ids) next = remember(next, id);
  dismissed.value = next;
  writeList(DISMISSED_KEY, next);
  writeList(SEEN_KEY, [...new Set([...readList(SEEN_KEY), ...ids])]);
  document.dispatchEvent(new CustomEvent('parlor:announcements-read'));
}
