/** 公告入口独立刷新，避免打断牌桌和聊天草稿。 */
export function supportLink(getToken) {
  const link = document.createElement('a');
  link.href = '/support'; link.target = '_blank'; link.rel = 'noopener';
  link.className = 'ghost-btn'; link.textContent = '反馈与公告';
  const check = async () => {
    if (document.hidden || !link.isConnected || !getToken()) return;
    try {
      const response = await fetch('/v1/support/announcements', { headers: { authorization: `Bearer ${getToken()}` }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) return;
      const data = await response.json();
      let seen = [];
      try { seen = JSON.parse(localStorage.getItem('parlor-announcements-seen') || '[]'); } catch {}
      const unread = data.announcements.filter(item => !seen.includes(item.id)).length;
      link.textContent = `反馈与公告${unread ? ` (${unread} 条新公告)` : ''}`;
    } catch { /* 断网不弹提示。 */ }
  };
  setInterval(() => { void check(); }, 60000);
  setTimeout(() => { void check(); }, 0);
  return link;
}
