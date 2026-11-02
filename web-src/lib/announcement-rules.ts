/** 公告纯规则的桥：逻辑仍住在旧版 `announcement-rules.js`，单测也在那边。 */
// @ts-ignore 旧规则是 JS，没有类型声明。
import { pickAnnouncement, rememberDismissed, excerpt } from '../../src/web/announcement-rules.js';

export interface Announcement {
  id: string;
  text?: string;
  created_at?: string;
}

export function pick(list: Announcement[], dismissed: string[]): Announcement | null {
  return pickAnnouncement(list, dismissed) as Announcement | null;
}

export function remember(list: string[], id: string, cap = 50): string[] {
  return rememberDismissed(list, id, cap) as string[];
}

export function excerptOf(text: unknown, max = 46): string {
  return excerpt(text, max) as string;
}
