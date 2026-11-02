/** 浏览器自己的偏好：收藏与草稿。键名与旧 club-state.js 一致，切换时不丢。 */
import { reactive } from 'vue';

const NAMESPACE = 'parlor-club-v1';

interface ClubData {
  favorites: string[];
  drafts: Record<string, string>;
}

function load(): ClubData {
  try {
    const saved = JSON.parse(localStorage.getItem(NAMESPACE) || '{}') || {};
    return {
      favorites: Array.isArray(saved.favorites) ? saved.favorites.filter((id: unknown) => typeof id === 'string') : [],
      drafts: saved.drafts && typeof saved.drafts === 'object' && !Array.isArray(saved.drafts) ? saved.drafts : {},
    };
  } catch {
    return { favorites: [], drafts: {} };
  }
}

export const club = reactive<ClubData>(load());

function persist(): void {
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
  persist();
}
