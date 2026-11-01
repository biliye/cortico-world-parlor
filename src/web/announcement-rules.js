/** 公告提示的纯规则：哪一条值得弹、点过之后记什么。DOM 与网络都不在这里，方便单测。 */

/** 公告列表里挑一条「还没被点掉」的，新的优先。拿不到时间就按服务器给的顺序（服务器已按新到旧）。 */
export function pickAnnouncement(list, dismissed) {
  if (!Array.isArray(list) || !list.length) return null;
  const skip = new Set(Array.isArray(dismissed) ? dismissed : []);
  const ordered = [...list].sort((left, right) => timeOf(right) - timeOf(left));
  return ordered.find((item) => item && typeof item.id === 'string' && !skip.has(item.id)) || null;
}

function timeOf(item) {
  const time = Date.parse((item && item.created_at) || '');
  return Number.isFinite(time) ? time : 0;
}

/** 点过「知道了」记下这一条；只留最近 cap 条，别把 localStorage 撑大。 */
export function rememberDismissed(dismissed, id, cap = 50) {
  const list = Array.isArray(dismissed) ? dismissed.filter((entry) => typeof entry === 'string') : [];
  if (typeof id !== 'string' || !id || list.includes(id)) return list.slice(-cap);
  return [...list, id].slice(-cap);
}

/** 横幅只有一行，正文压成一句短的；标题里放全文。 */
export function excerpt(text, max = 46) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}
