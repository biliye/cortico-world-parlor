/**
 * 对外页的脚本负责五件事：
 * 1. 明暗：在 body 解析前就把存过的偏好写到 <html> 上，避免先画一帧纸色再跳成深色；
 * 2. 换色动效：从顶栏那颗按钮向外扩散（View Transitions）；不支持的浏览器整页淡过去；
 * 3. 滚动驱动：封面会名随滚动上移淡出、门厅的实景回正、顶栏下沿一条线标读到哪儿了；
 * 4. 换屏进场：滚到下一屏时给 .screen 挂 is-in，CSS 再按 --i 依次抬起子元素；
 *    屏里的列表再挂一层 data-stagger，编号与条目按 45ms 一个地排队浮现；
 * 5. 玩法规则：点一格弹出规则层（<dialog>），Esc / 点遮罩 / 右上角都能关；
 *    没脚本时不挂 ef-rules，八块规则平铺在页尾，仍然读得到。
 *
 * 页面 CSP 是 default-src 'none'; script-src 'self'，不能写内联 onclick，
 * 所以只有这一段外链脚本。滚动翻页本身仍是纯 CSS（html 上的 scroll-snap）。
 */
(() => {
  const root = document.documentElement;
  const KEY = 'parlor-welcome-theme';
  /** 需要「一条一条排队浮现」的列表：玩法八格、入场三步、「这里是这样的地方」三栏。 */
  const STAGGER_GROUPS = '.what-screen .what-cols, .enter .steps, .rule-grid';

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

  // ---------- 封面会名的指针视差 ----------

  // 会名跟着指针走 5px：字太大，再多就成了抖。
  // 系统开了「减少动态效果」或粗指针设备就完全不注册，页面直接是静止的最终状态。
  // 位移量写在 welcome.css 里；这里只把指针位置换算成 -0.5 ~ 0.5。
  const bindParallax = () => {
    if (still() || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    const cover = document.querySelector('.cover');
    if (!cover) return;

    let queued = 0;
    cover.addEventListener('pointermove', (event) => {
      if (queued) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        const box = cover.getBoundingClientRect();
        if (!box.width || !box.height) return;
        cover.style.setProperty('--mx', ((event.clientX - box.left) / box.width - 0.5).toFixed(3));
        cover.style.setProperty('--my', ((event.clientY - box.top) / box.height - 0.5).toFixed(3));
      });
    });
  };

  // ---------- 滚动驱动：封面 / 门厅 / 顶栏进度线 ----------

  /**
   * 只往元素上写三个 CSS 变量，不碰布局：
   *   .cover 的 --sc     这一屏滚出去多少（0 → 1）
   *   .hall  的 --hall   那张实景走到眼前多少（0 → 1），图从 1.1 回正到 1.0
   *   .top   的 --read   整页读到哪儿（0 → 1），顶栏下沿那条线按它伸长
   * 和换屏进场不同：那套是进一次就完，这套只要还在滚就一直在算——省掉它，
   * 页面滚到一半会像一张贴好的海报，现在会随滚动继续走。
   * 要「减少动态效果」就一次都不注册，CSS 里的默认值 0 正好是静止的最终状态。
   */
  const bindScrollMotion = () => {
    if (still()) return;
    const cover = document.getElementById('top');
    const hall = document.getElementById('hall');
    const bar = document.querySelector('.top');
    if (!cover && !hall && !bar) return;

    let queued = 0;
    const frame = () => {
      queued = 0;
      const vh = innerHeight || 1;
      // 先读后写：三处都读完了再写变量，避免写一个变量就触发一次样式重算
      const coverBox = cover ? cover.getBoundingClientRect() : null;
      const hallBox = hall ? hall.getBoundingClientRect() : null;
      const max = root.scrollHeight - vh;
      const y = scrollY;
      if (coverBox && cover) {
        // 封面正好一屏高：顶边滚到 -一屏时算 1
        cover.style.setProperty('--sc', Math.min(Math.max(-coverBox.top / (coverBox.height || vh), 0), 1).toFixed(3));
      }
      if (hallBox && hall) {
        // 顶边刚探进视口下沿是 0，顶边贴住视口上沿是 1
        hall.style.setProperty('--hall', Math.min(Math.max((vh - hallBox.top) / vh, 0), 1).toFixed(3));
      }
      if (bar) {
        const p = max > 0 ? Math.min(y / max, 1) : 0;
        bar.style.setProperty('--read', p.toFixed(4));
      }
    };
    const onScroll = () => {
      if (!queued) queued = requestAnimationFrame(frame);
    };

    frame();
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll);
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

  // ---------- 玩法规则：点一格，规则从弹层里出来 ----------

  /**
   * 八格是按钮，规则都装在页尾那个 <dialog> 里：点一格开一层，只显这一块。
   * 关上走一段 170ms 的退场动画再 close()，不然会「啪」地消失。
   * 不支持 showModal 的浏览器直接 return：页面上没有 ef-rules，CSS 就退回平铺。
   */
  const bindRules = () => {
    const dialog = document.getElementById('rule-dialog');
    const cards = [...document.querySelectorAll('.rule-card')];
    const pages = [...document.querySelectorAll('.rule-pages .rule')];
    if (!dialog || !cards.length || !pages.length || typeof dialog.showModal !== 'function') return;

    const body = dialog.querySelector('.rule-pages');
    const count = dialog.querySelector('.rule-dialog-no');
    const closeBtn = dialog.querySelector('[data-act="rule-close"]');
    let opener = null;
    let closing = 0;

    /** 只留一块：其余 hidden，编号条跟着换，正文回到顶部。 */
    const fill = (id) => {
      const page = pages.find((item) => item.dataset.rule === id) ?? pages[0];
      for (const item of pages) item.hidden = item !== page;
      if (count) count.textContent = page.dataset.no ?? '';
      if (body) body.scrollTop = 0;
      page.classList.remove('is-fresh');
      if (still()) return;
      void page.offsetWidth;
      page.classList.add('is-fresh');
    };

    const finishClose = () => {
      closing = 0;
      dialog.classList.remove('is-out');
      dialog.close();
      root.classList.remove('ef-rule-open');
      // 焦点回到点中的那一格，键盘用户不会掉到页首。
      opener?.focus({ preventScroll: true });
    };

    const close = () => {
      if (!dialog.open || closing) return;
      // 退场与 CSS 的 170ms 对齐；减少动态效果时不留这段空档。
      closing = setTimeout(finishClose, still() ? 0 : 170);
      dialog.classList.add('is-out');
    };

    const open = (card) => {
      fill(card.dataset.rule);
      opener = card;
      dialog.classList.remove('is-out');
      root.classList.add('ef-rule-open');
      dialog.showModal();
    };

    for (const card of cards) {
      card.addEventListener('click', () => open(card));
    }

    closeBtn?.addEventListener('click', close);

    // 点遮罩：事件目标是 dialog 自己（面板内部点到的是子元素）。
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) close();
    });

    // Esc 默认会直接 close()，先拦下来走同一段退场。
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      close();
    });

    // 任何路径真的关掉之后，都要把锁滚动和退场标记清干净。
    dialog.addEventListener('close', () => {
      root.classList.remove('ef-rule-open');
      dialog.classList.remove('is-out');
    });

    // 先把第一块摆好，再挂 ef-rules：挂上之前，CSS 让弹层以平铺形态出现在页面里。
    fill(cards[0].dataset.rule);
    root.classList.add('ef-rules');
  };

  onReady(() => {
    bindTheme();
    bindParallax();
    bindScrollMotion();
    bindReveal();
    bindRules();
  });
})();
