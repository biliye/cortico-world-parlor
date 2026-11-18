/**
 * 对外页的脚本负责五件事：
 * 1. 明暗：在 body 解析前就把存过的偏好写到 <html> 上，避免先画一帧纸色再跳成深色；
 * 2. 换色动效：从顶栏那颗按钮向外扩散（View Transitions）；不支持的浏览器整页淡过去；
 * 3. 换屏进场：滚到下一屏时给 .screen 挂 is-in，CSS 再按 --i 依次抬起子元素；
 *    屏里的列表再挂一层 data-stagger，编号与条目按 45ms 一个地排队浮现；
 * 4. 玩法规则：左列八格是页签，点一格右列换一块；没脚本时八块全展开，仍可读；
 * 5. 吸附强度：量一遍每屏是否都装得下，装得下就把 scroll-snap 收紧成 mandatory。
 *
 * 页面 CSP 是 default-src 'none'; script-src 'self'，不能写内联 onclick，
 * 所以只有这一段外链脚本。滚动翻页本身仍是纯 CSS（html 上的 scroll-snap）。
 */
(() => {
  const root = document.documentElement;
  const KEY = 'parlor-welcome-theme';
  /** 需要「一条一条排队浮现」的列表：玩法编号、入场三步、首屏三栏。 */
  const STAGGER_GROUPS = '.hero .what-cols, .enter .steps, .rule-tabs';

  /** 系统开了「减少动态效果」就一律走静止分支：不扩散、不淡入、不收紧吸附。 */
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

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

  /* 进场动画要先藏后显。支持 IntersectionObserver 才挂这个类：
     脚本半路出错时，内容仍是默认的「一直可见」，不会留一页空白。 */
  if ('IntersectionObserver' in window) root.classList.add('ef-js');

  const onReady = (fn) => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  };

  // ---------- 明暗 ----------

  /* 这段脚本在 <head> 里、body 还没解析就跑，所以按钮要等 DOM 就绪再取。 */
  let themeBtn = null;
  let switching = false;

  const syncTheme = () => {
    if (!themeBtn) return;
    const label = `切换到${current() === 'dark' ? '浅色' : '深色'}`;
    themeBtn.setAttribute('aria-label', label);
    themeBtn.title = label;
  };

  const applyTheme = (next) => {
    root.dataset.theme = next;
    save(next);
    syncTheme();
  };

  /**
   * 扩散：圆心取按钮中心，半径算到最远那个角。
   * 期间整页定格在新一轮 ::view-transition 快照里，520ms 后新配色盖满。
   */
  const dial = (next) => {
    const box = themeBtn
      ? themeBtn.getBoundingClientRect()
      : { left: innerWidth - 40, top: 16, width: 24, height: 24 };
    const x = Math.round(box.left + box.width / 2);
    const y = Math.round(box.top + box.height / 2);
    const r = Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)));
    root.style.setProperty('--vt-x', `${x}px`);
    root.style.setProperty('--vt-y', `${y}px`);
    root.style.setProperty('--vt-r', `${r}px`);
    root.dataset.vt = 'theme';
    const view = document.startViewTransition(() => applyTheme(next));
    view.finished.finally(() => {
      delete root.dataset.vt;
      for (const name of ['--vt-x', '--vt-y', '--vt-r']) root.style.removeProperty(name);
      switching = false;
    });
  };

  /** 没有 View Transitions：给整页挂 340ms 的颜色过渡，再换变量。 */
  const fade = (next) => {
    root.classList.add('ef-theme-fade');
    applyTheme(next);
    setTimeout(() => {
      root.classList.remove('ef-theme-fade');
      switching = false;
    }, 380);
  };

  const bindTheme = () => {
    themeBtn = document.querySelector('[data-act="theme"]');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        if (switching) return;
        const next = current() === 'dark' ? 'light' : 'dark';
        if (still()) {
          applyTheme(next);
          return;
        }
        switching = true;
        // 正在跑另一段页面切换时 startViewTransition 会抛，退回淡出。
        if (typeof document.startViewTransition === 'function') {
          try {
            dial(next);
          } catch {
            fade(next);
          }
        } else {
          fade(next);
        }
      });
    }
    syncTheme();
  };

  // ---------- 首屏画框的指针视差 ----------

  // 只有这一个动效跟指针走；入场、悬停、跑马灯都是 welcome-kit.css 里的纯 CSS。
  // 系统开了「减少动态效果」或粗指针设备就完全不注册，页面直接是静止的最终状态。
  // 位移量写在 welcome.css 里（≤ 12px），这里只把指针位置换算成 -0.5 ~ 0.5。
  const bindParallax = () => {
    if (still() || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
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
  };

  // ---------- 换屏进场 ----------

  /**
   * 首屏有自己的一套开屏动画（会名被推出来、色带扫过），不再叠一层；
   * 只给后面的屏挂 data-reveal，滚到才显形。
   */
  const bindReveal = () => {
    if (still() || !('IntersectionObserver' in window)) return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      },
      // 露出 12% 就开始抬；底边留 8% 余量，免得刚探个头就响。
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );

    const screens = [...document.querySelectorAll('.screen')].filter((screen) => screen.id !== 'top');
    for (const screen of screens) {
      screen.dataset.reveal = '';
      io.observe(screen);
    }

    /* 屏里的队列单独观察：首屏那三栏和首屏同屏，但常在折叠线以下，
       跟着自己什么时候进视口走，比跟着「屏」走准。 */
    for (const group of document.querySelectorAll(STAGGER_GROUPS)) {
      group.dataset.stagger = '';
      io.observe(group);
    }
  };

  // ---------- 玩法规则：左列选、右列读 ----------

  /**
   * 没脚本时八块规则全部展开（面板上没有 hidden），有脚本才收成一块一块的页签。
   * 键盘按 ARIA tablist 的约定：上下左右换格、Home / End 跳首尾。
   */
  const bindRules = () => {
    const list = document.querySelector('.rules-tabs');
    const tabs = [...document.querySelectorAll('.rule-tab')];
    if (!list || tabs.length === 0) return;

    const show = (id, { animate = false, revealTab = false } = {}) => {
      for (const tab of tabs) {
        const on = tab.getAttribute('aria-controls') === id;
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        tab.tabIndex = on ? 0 : -1;
      }
      for (const panel of document.querySelectorAll('.rule')) {
        const on = panel.id === id;
        panel.hidden = !on;
        if (!on) continue;
        // 先摘再挂，连点同一格也能重播一次；换人时不弹跳，只淡入。
        panel.classList.remove('is-fresh');
        if (animate && !still()) {
          void panel.offsetWidth;
          panel.classList.add('is-fresh');
        }
      }
      // 窄屏那条横向编号条：选中的一格滚进可视范围，别让它藏在边上。
      if (!revealTab || list.scrollWidth <= list.clientWidth) return;
      const tab = tabs.find((item) => item.getAttribute('aria-controls') === id);
      if (!tab) return;
      const box = tab.getBoundingClientRect();
      const frame = list.getBoundingClientRect();
      list.scrollTo({ left: list.scrollLeft + (box.left - frame.left) - 10, behavior: still() ? 'auto' : 'smooth' });
    };

    const choose = (tab) => show(tab.getAttribute('aria-controls'), { animate: true, revealTab: true });

    for (const tab of tabs) tab.addEventListener('click', () => choose(tab));

    list.addEventListener('keydown', (event) => {
      const index = tabs.indexOf(document.activeElement);
      if (index < 0) return;
      let next;
      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowRight':
          next = (index + 1) % tabs.length;
          break;
        case 'ArrowUp':
        case 'ArrowLeft':
          next = (index - 1 + tabs.length) % tabs.length;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = tabs.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      tabs[next].focus();
      choose(tabs[next]);
    });

    // 初始只留第一块（HTML 里标着 aria-selected="true" 那一格），不播换入动画。
    show(tabs[0].getAttribute('aria-controls'));
  };

  // ---------- 吸附强度 ----------

  /**
   * 每屏高度都 ≤ 一屏（减去顶栏）时才敢用 mandatory：这时一个滚轮动作正好一屏。
   * 有一屏比视口高（窄屏首屏、玩法九条）就必须退回 proximity，否则中间那截滚不出来。
   * 窗口尺寸与字体度量都会改变结果，所以 resize 与 fonts.ready 之后各重量一次。
   */
  const measureSnap = () => {
    /* 顶栏高度直接量盒子：读 --top-h 拿到的是「3.5rem」这种字符串，
       parseFloat 出来是 3.5 而不是像素，会把每屏都判成装得下。 */
    const header = document.querySelector('.top');
    const topH = header ? header.getBoundingClientRect().height : 0;
    const room = innerHeight - topH + 2;
    const screens = [...document.querySelectorAll('.screen')];
    const fit = screens.length > 0 && screens.every((screen) => screen.getBoundingClientRect().height <= room);
    root.dataset.snap = fit ? 'strict' : 'loose';
  };

  onReady(() => {
    bindTheme();
    bindParallax();
    bindReveal();
    bindRules();
    measureSnap();

    /* 量一次不够：字体换上来、图解码完、窗口被拖动都会改每屏高度。
       拿 ResizeObserver 盯住每屏自己，比「等 load 再量一次」靠谱。 */
    let timer = 0;
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(measureSnap, 80);
    };
    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(later);
      for (const screen of document.querySelectorAll('.screen')) ro.observe(screen);
    }
    addEventListener('resize', later);
    addEventListener('load', measureSnap);
    if (document.fonts?.ready) document.fonts.ready.then(measureSnap).catch(() => {});
  });
})();
