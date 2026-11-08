/**
 * 会馆首屏的运营公告横幅：有新公告才出现，一句话 + 「查看详情」+ 「知道了」。
 * 点过「知道了」把公告 id 记在本地，同一条不再打扰；运营发了新的再出现。
 * 只读已有接口，不进牌桌、不动存档。
 */
import { el, btn, icon } from './common.js';
/* 内部模块统一带同一个版本号：版本不一致会让浏览器当成两份，订阅会各记各的。 */
import { onAnnouncements } from './announcements.js?v=0.37.6';
import { pickAnnouncement, rememberDismissed, excerpt } from './announcement-rules.js?v=0.37.6';

const DISMISSED_KEY = 'parlor-announcements-dismissed';
const SEEN_KEY = 'parlor-announcements-seen';

function readList(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
  } catch { return []; }
}

function writeList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* 记不住就下次再说 */ }
}

/** container 通常是大厅或客厅视图；横幅插在这块的第一个位置。 */
export function mountAnnouncementBanner(container) {
  const node = el('aside', 'announce-banner');
  node.hidden = true;
  node.setAttribute('aria-live', 'polite');
  const mark = el('span', 'announce-mark');
  mark.append(icon('mail'));
  const text = el('p', 'announce-text');
  const link = document.createElement('a');
  link.className = 'announce-link';
  link.href = '/support';
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = '查看详情';
  const dismiss = btn('知道了', () => {
    if (!current) return;
    // 一次点掉「现在这一批」，别为了三条公告让人点三次；以后新发的照常出现。
    const ids = latest.map((item) => item && item.id).filter((id) => typeof id === 'string');
    let dismissed = readList(DISMISSED_KEY);
    for (const id of ids) dismissed = rememberDismissed(dismissed, id);
    writeList(DISMISSED_KEY, dismissed);
    // 点了「知道了」就等于看过了：左栏那个「N 条新公告」也一起清掉，别两处各说各的。
    writeList(SEEN_KEY, [...new Set([...readList(SEEN_KEY), ...ids])]);
    document.dispatchEvent(new CustomEvent('parlor:announcements-read'));
  }, { ghost: true, small: true });
  dismiss.classList.add('announce-dismiss');
  node.append(mark, text, link, dismiss);
  container.prepend(node);

  let latest = [];
  let current = null;

  const paint = () => {
    const picked = pickAnnouncement(latest, readList(DISMISSED_KEY));
    current = picked;
    if (!picked) { node.hidden = true; return; }
    const body = excerpt(picked.text);
    text.textContent = body ? '运营公告：' + body : '运营发了一条新公告。';
    node.title = String(picked.text || '');
    node.hidden = false;
  };

  onAnnouncements((list) => { latest = list; paint(); });
  // 另一处（客厅或大厅）点了「知道了」：这一份也跟着收起。
  document.addEventListener('parlor:announcements-read', paint);
  return node;
}
