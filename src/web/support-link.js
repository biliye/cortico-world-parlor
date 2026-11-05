/** 公告入口独立刷新，避免打断牌桌和聊天草稿。取数在 announcements.js，首屏横幅用的是同一份。 */
import { onAnnouncements } from './announcements.js?v=0.36.7';

export function supportLink(getToken) {
  const link = document.createElement('a');
  link.href = '/support'; link.target = '_blank'; link.rel = 'noopener';
  link.className = 'ghost-btn'; link.textContent = '反馈与公告';
  let latest = [];
  const paint = () => {
    if (!link.isConnected || !getToken()) return;
    let seen = [];
    try { seen = JSON.parse(localStorage.getItem('parlor-announcements-seen') || '[]'); } catch {}
    const unread = latest.filter(item => !seen.includes(item.id)).length;
    link.textContent = `反馈与公告${unread ? ` (${unread} 条新公告)` : ''}`;
  };
  onAnnouncements((list) => { latest = list; paint(); });
  // 首屏横幅上点了「知道了」：这边跟着少掉那个数字，不用等下一次轮询。
  document.addEventListener('parlor:announcements-read', paint);
  return link;
}
