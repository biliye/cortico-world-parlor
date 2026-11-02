/** 浏览器自己的偏好：聊天开合、收藏与草稿。键名与旧 club-state.js 一致，切换时不丢。 */
import { reactive } from 'vue';

const NAMESPACE = 'parlor-club-v1';

interface ClubData {
  chatOpen: boolean;
  mobileChatOpen: boolean;
  favorites: string[];
  drafts: Record<string, string>;
}

function load(): ClubData {
  try {
    const saved = JSON.parse(localStorage.getItem(NAMESPACE) || '{}') || {};
    return {
      chatOpen: saved.chatOpen !== false,
      mobileChatOpen: saved.mobileChatOpen === true,
      favorites: Array.isArray(saved.favorites) ? saved.favorites.filter((id: unknown) => typeof id === 'string') : [],
      drafts: saved.drafts && typeof saved.drafts === 'object' && !Array.isArray(saved.drafts) ? saved.drafts : {},
    };
  } catch {
    return { chatOpen: true, mobileChatOpen: false, favorites: [], drafts: {} };
  }
}

export const club = reactive<ClubData>(load());

export function persistClub(): void {
  try {
    localStorage.setItem(NAMESPACE, JSON.stringify({ ...club }));
  } catch {
    /* 存不了就只在内存里用 */
  }
}

export function isFavorite(id: string): boolean {
  return club.favorites.includes(id);
}

export function toggleFavorite(id: string): void {
  club.favorites = isFavorite(id)
    ? club.favorites.filter((value) => value !== id)
    : [...club.favorites, id];
  persistClub();
}

export function draft(key: string): string {
  return typeof club.drafts[key] === 'string' ? club.drafts[key] : '';
}

export function saveDraft(key: string, text: string): void {
  if (text) club.drafts[key] = String(text).slice(0, 400);
  else delete club.drafts[key];
  persistClub();
}
