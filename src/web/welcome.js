/**
 * 对外页唯一的一段脚本，做三件事：
 * 1. 明暗：在 body 解析前就把存过的偏好写到 <html> 上，避免先画一帧纸色再跳成深色；
 * 2. 顶栏那两个按钮：色调切换、登录/注册的占位提示；
 * 3. 首屏画框的指针视差。
 *
 * 页面 CSP 是 default-src 'none'; script-src 'self'，不能写内联 onclick，
 * 所以只有这一段外链脚本。滚动翻页本身是纯 CSS（html 上的 scroll-snap），不在这里做。
 */
(() => {
  const root = document.documentElement;
  const KEY = 'parlor-welcome-theme';

  /** localStorage 在隐私模式、禁用存储、沙箱 iframe 里都会抛；读不到就当没存过。 */
  const read = () => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  };
  const save = (value) => {
    try {
      localStorage.setItem(KEY, value);
    } catch {
      /* 存不下就只管这一次；下次进来回到跟随系统 */
    }
  };

  const stored = read();
  if (stored === 'light' || stored === 'dark') root.dataset.theme = stored;

  /** 当前生效的明暗：设过 data-theme 就是它，没设就是系统。 */
  const current = () =>
    root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  const onReady = (fn) => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  };

  onReady(() => {
    // ---------- 色调 ----------
    const themeBtn = document.querySelector('[data-act="theme"]');
    const syncTheme = () => {
      if (!themeBtn) return;
      const label = `切换到${current() === 'dark' ? '浅色' : '深色'}`;
      themeBtn.setAttribute('aria-label', label);
      themeBtn.title = label;
    };
    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        const next = current() === 'dark' ? 'light' : 'dark';
        root.dataset.theme = next;
        save(next);
        syncTheme();
      });
    }
    syncTheme();

    // ---------- 登录 / 注册：占位 ----------
    const toast = document.querySelector('.toast');
    const accountBtn = document.querySelector('[data-act="account"]');
    if (toast && accountBtn) {
      let timer = 0;
      accountBtn.addEventListener('click', () => {
        toast.hidden = false;
        clearTimeout(timer);
        timer = setTimeout(() => {
          toast.hidden = true;
        }, 6000);
      });
    }

    // ---------- 首屏画框的指针视差 ----------
    // 只有这一个动效需要脚本；入场、悬停、跑马灯都是 welcome-kit.css 里的纯 CSS。
    // 系统开了「减少动态效果」或粗指针设备就完全不注册，页面直接是静止的最终状态。
    // 位移量写在 welcome.css 里（≤ 14px），这里只把指针位置换算成 -0.5 ~ 0.5。
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    const hero = document.querySelector('.hero');
    if (!hero) return;

    let queued = 0;
    hero.addEventListener('pointermove', (event) => {
      if (queued) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        const box = hero.getBoundingClientRect();
        if (!box.width || !box.height) return;
        hero.style.setProperty('--mx', ((event.clientX - box.left) / box.width - 0.5).toFixed(3));
        hero.style.setProperty('--my', ((event.clientY - box.top) / box.height - 0.5).toFixed(3));
      });
    });
  });
})();
