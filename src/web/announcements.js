/**
 * 运营公告：只在这里取一次，左栏入口和首屏横幅订阅同一份。
 * 一分钟看一眼；页面在后台时不发请求。拿不到就安安静静地不提示。
 */
let cache = null;
const listeners = new Set();
let watching = false;

export function onAnnouncements(listener) {
  listeners.add(listener);
  if (cache) listener(cache);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) {
    try { listener(cache || []); } catch { /* 一处坏了不影响别处 */ }
  }
}

export async function refreshAnnouncements(getToken) {
  if (typeof document !== 'undefined' && document.hidden) return;
  const token = getToken ? getToken() : '';
  if (!token) return;
  try {
    const response = await fetch('/v1/support/announcements', {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return;
    const data = await response.json();
    cache = Array.isArray(data.announcements) ? data.announcements : [];
    emit();
  } catch { /* 断网不弹提示。 */ }
}

/** 整个页面只起一份计时器；重复调用不会叠加。 */
export function startAnnouncementWatch(getToken, { interval = 60_000 } = {}) {
  if (watching) return;
  watching = true;
  setTimeout(() => { void refreshAnnouncements(getToken); }, 0);
  setInterval(() => { void refreshAnnouncements(getToken); }, interval);
}
