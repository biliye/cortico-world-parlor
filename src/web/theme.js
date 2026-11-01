/** Run before styles: restore appearance without rebuilding the client or flashing the wrong theme. */
(() => {
  const key = 'parlor-theme-v1';
  let theme = 'dark';
  try { if (localStorage.getItem(key) === 'light') theme = 'light'; } catch { /* private browsing */ }

  function apply() {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f5f7ef' : '#10191b');
    document.dispatchEvent(new CustomEvent('parlor:themechange', { detail: theme }));
  }

  window.parlorTheme = {
    get value() { return theme; },
    toggle() {
      theme = theme === 'light' ? 'dark' : 'light';
      try { localStorage.setItem(key, theme); } catch { /* retain the choice in memory */ }
      apply();
    },
  };
  apply();
})();
