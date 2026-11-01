/** Run before styles: restore appearance without rebuilding the client or flashing the wrong theme.
 *  三套外观，换的是颜色不是布局：深色（会馆默认）、浅色、奶油（老客厅那套暖色）。
 *  第一次来跟着系统的深浅色走；点过之后以这台浏览器记下的为准。 */
(() => {
  const key = 'parlor-theme-v1';
  const themes = ['dark', 'light', 'cream'];
  const metaColor = { dark: '#10191b', light: '#f5f7ef', cream: '#fff8ee' };
  const system = () => {
    try {
      // 没有 matchMedia（老浏览器、测试环境）就当深色，不做猜测。
      if (!window.matchMedia) return 'dark';
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch { return 'dark'; }
  };
  let theme = system();
  try {
    const saved = localStorage.getItem(key);
    if (themes.includes(saved)) theme = saved;
  } catch { /* private browsing */ }

  function apply() {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', metaColor[theme] || metaColor.dark);
    document.dispatchEvent(new CustomEvent('parlor:themechange', { detail: theme }));
  }

  window.parlorTheme = {
    themes,
    get value() { return theme; },
    set(next) {
      if (!themes.includes(next) || next === theme) return;
      theme = next;
      try { localStorage.setItem(key, theme); } catch { /* retain the choice in memory */ }
      apply();
    },
    toggle() {
      window.parlorTheme.set(themes[(themes.indexOf(theme) + 1) % themes.length]);
    },
  };
  apply();
})();
