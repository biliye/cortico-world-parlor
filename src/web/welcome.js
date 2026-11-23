/**
 * 对外页的脚本负责五件事：
 * 1. 明暗：在 body 解析前就把存过的偏好写到 <html> 上，避免先画一帧纸色再跳成深色；
 * 2. 换色动效：从顶栏那颗按钮向外扩散（View Transitions）；不支持的浏览器整页淡过去；
 * 3. 滚轮：桌面上接管竖直滚轮，先推目标再逐帧追（有减速尾巴）；停手 200ms 后
 *    离屏边够近、或一口气滚过 0.9 屏，就把目标改到那一屏，减速直接接上吸附。
 *    键盘、滚动条、触屏仍由浏览器自己滚（之后同样接一段软吸附）；页内锚点走缓动；
 * 4. 滚动驱动：封面会名随滚动上移淡出、门厅的实景回正、上一屏内容提前离场、
 *    顶栏下沿一条线标读到哪儿了；
 * 5. 换屏进场：滚到下一屏时给 .screen 挂 is-in，CSS 再按 --i 依次抬起子元素；
 *    屏里的列表再挂一层 data-stagger，编号与条目按 45ms 一个地排队浮现；
 * 6. 玩法规则：点一格弹出规则层（<dialog>），Esc / 点遮罩 / 右上角都能关；
 *    没脚本时不挂 ef-rules，八块规则平铺在页尾，仍然读得到。
 *
 * 页面 CSP 是 default-src 'none'; script-src 'self'，不能写内联 onclick，
 * 所以只有这一段外链脚本。触屏上的滚动翻页仍是纯 CSS（html 上的 scroll-snap）。
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

  // ---------- 滚轮：逐帧追 + 软吸附 ----------

  /**
   * 桌面上的竖直滚轮改成「先推目标、再逐帧追」：一次滚轮只把目标推远一点，
   * 画面用十几帧追上去，手停下来之后还有一小段减速尾巴；手停 200ms 后若落点
   * 离某屏边界不到 38% 视口，或一口气滚过 0.9 屏，就把目标改到那一屏——
   * 减速直接接上吸附，中间没有「停死 → 等 → 再起步」，这就是软吸附。
   *
   * 只接管竖直滚轮：Ctrl+滚轮（缩放）、横向滚动、规则弹层打开时都不拦。
   * 键盘、滚动条、地址栏带 # 的落点统一交给浏览器——scroll 事件里发现位置
   * 不是这一帧写下去的，就把目标对齐过去，「键盘翻过页、下一格滚轮又把页面
   * 拽回原处」不会发生；松手之后照样接一段同样的软吸附。
   *
   * 触屏设备整个不注册：原生滚动本来就有惯性，接管只会更差；
   * 那些设备上的翻页吸附仍由 CSS 的 scroll-snap 负责（见 welcome.css 的 is-smooth）。
   */
  const bindSmoothScroll = () => {
    if (still()) return;
    if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    if (!('scrollBehavior' in root.style)) return;

    const FOLLOW = 0.12; // 每帧追掉差距的比例：约 16 帧贴住，尾巴看得见但不拖沓
    // 停手多久之后看落点。不能太短：鼠标一格约 100px、慢速连滚的间隔可以到 150ms，
    // 140ms 会在两格之间就把页面往回吸，慢速滚轮永远推不过第一屏（实测 134ms 间隔必现）。
    const SETTLE = 200;
    const bar = document.querySelector('.top');

    let target = scrollY;
    let applied = scrollY;
    let frame = 0;
    let mode = 'idle'; // idle | follow | glide
    let glideFrom = 0;
    let glideTo = 0;
    let glideAt = 0;
    let glideDur = 0;
    let settleTimer = 0;
    let last = 0;
    let lastWheelAt = 0;

    const maxY = () => Math.max(0, root.scrollHeight - innerHeight);
    const clamp = (y) => Math.min(Math.max(y, 0), maxY());
    const headH = () => (bar ? bar.offsetHeight : 0);
    const locked = () => root.classList.contains('ef-rule-open');

    /**
     * 落点：每屏的顶对齐到顶栏下沿；最后再补一个文档底。
     * 比视口高的屏（.is-tall）不算落点——它本来就要连续读，把它当吸附点等于
     * 把读到一半的内容拽回屏顶（375×667 的家长屏踩过）。
     */
    const stops = () => {
      const list = [...document.querySelectorAll('.screen')]
        .filter((el) => !el.classList.contains('is-tall'))
        .map((el) => Math.round(el.getBoundingClientRect().top + scrollY - headH()));
      // 第一屏的落点就是页顶。scroll-padding 会把它算成 3px（顶上那条三色带），
      // 吸过去等于一进站就先滚掉一条色带，不合适。
      list[0] = 0;
      list.push(maxY());
      return list;
    };

    /** 落点在某张高屏里：那截要连续读，别吸。 */
    const inTall = (y) => {
      for (const el of document.querySelectorAll('.screen.is-tall')) {
        const top = el.getBoundingClientRect().top + scrollY - headH();
        if (y > top + 1 && y < top + el.offsetHeight - 2) return true;
      }
      return false;
    };

    /* 写位置时把浏览器取整后的真值记下来：scroll 事件里靠它分清
       「这一帧是我写的」还是「别人挪的」，差两三个像素不算别人。 */
    const paint = (y) => {
      window.scrollTo(0, y);
      applied = scrollY;
    };

    /** 定长缓动：吸附与锚点跳转都走它，收尾比指数逼近干净。
     *  曲线是 ease-in-out：两头速度都归零。用 ease-out 的话起点就是最大速度，
     *  刚静止下来的画面会被「拽」一下——僵硬感有一半来自这里。 */
    const glide = (to) => {
      glideFrom = scrollY;
      glideTo = clamp(to);
      const dist = glideTo - glideFrom;
      if (Math.abs(dist) < 1) return;
      glideAt = performance.now();
      glideDur = Math.min(680, 240 + Math.abs(dist) * 0.55);
      target = glideTo;
      mode = 'glide';
      if (!frame) frame = requestAnimationFrame(step);
    };

    /**
     * 手停下 200ms 之后把落点收进屏边界，中间态一律不留（2026-11-23：不要留白）。
     *
     * 取最近的落点：滚过半屏就翻到下一屏，没过半屏就退回上一屏。原来是
     * 「离屏边不到 38% 才吸」，剩下的空档靠「一口气滚过 0.9 屏」去猜，
     * 滚四五格停手就卡在两屏之间，上一屏下面露出一块白。
     *
     * 唯一的例外是落点在某张比视口高的屏里（.is-tall）：那截要连续读，不吸。
     *
     * 关键在于「还在走的时候就改目标」，而不是等停稳了再起步：先停死、等 200ms、
     * 再动一段，那 200ms 的静止 + 起步的加速度正是「僵硬」的来源。
     * 这里只把 target 挪到吸附点，追帧的循环照旧跑着，减速会直接接上吸附。
     * 判断距离用的是 target（要停在哪），不是 scrollY（现在在哪）。
     */
    const retarget = () => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (mode === 'glide' || locked()) return;
        if (inTall(target)) return;
        const list = stops();
        let pick = list[0];
        for (const at of list) {
          if (Math.abs(at - target) < Math.abs(pick - target)) pick = at;
        }
        target = clamp(pick);
        if (!frame) {
          last = 0;
          frame = requestAnimationFrame(step);
        }
      }, SETTLE);
    };

    const step = (now) => {
      frame = 0;
      if (mode === 'glide') {
        const p = Math.min((now - glideAt) / glideDur, 1);
        const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
        paint(glideFrom + (glideTo - glideFrom) * e);
        if (p < 1) {
          frame = requestAnimationFrame(step);
          return;
        }
        mode = 'idle';
        paint(glideTo);
        return;
      }
      const gap = clamp(target) - scrollY;
      if (Math.abs(gap) < 0.4) {
        mode = 'idle';
        paint(clamp(target));
        return;
      }
      /* 按「过去了几个 60Hz 帧」折算，120Hz 屏不会比 60Hz 快一倍；
         切标签页回来那一大跳也夹住，别一下冲过去。 */
      const dt = last ? Math.min((now - last) / 16.667, 4) : 1;
      last = now;
      const next = gap * (1 - Math.pow(1 - FOLLOW, dt));
      // 尾巴收得干脆一点：最后几像素按固定步长走完，
      // 不然指数逼近会一直「爬」——手早就停了，画面还在动 5px
      paint(scrollY + (Math.abs(next) < 0.75 ? Math.sign(gap) * 0.75 : next));
      frame = requestAnimationFrame(step);
    };

    addEventListener(
      'wheel',
      (event) => {
        if (event.ctrlKey || locked()) return;
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
        const delta = event.deltaY * unit;
        if (!delta) return;
        // 已经在两端还往外滚：不拦，留给系统的回弹
        if ((scrollY <= 0 && delta < 0) || (scrollY >= maxY() - 0.5 && delta > 0)) return;
        event.preventDefault();
        if (mode === 'glide') {
          // 吸附途中又滚了：从当前位置接过来，不和那段缓动抢
          // （目标是缓动的终点，直接加位移会一下冲出去）
          mode = 'follow';
          target = scrollY;
          cancelAnimationFrame(frame);
          frame = 0;
        }
        lastWheelAt = performance.now();
        target = clamp(target + delta);
        if (!frame) {
          last = 0;
          frame = requestAnimationFrame(step);
        }
        retarget();
      },
      { passive: false },
    );

    // 别人挪的（键盘、滚动条、浏览器恢复上次位置）：把目标对齐过去，不要拽回来；
    // 正在跑的吸附缓动也要停，否则它会把位置又推回原来的落点。
    //
    // 这里刻意不 cancelAnimationFrame：scroll 事件可能比滚轮晚一拍送进来，
    // 取消掉刚排上的那一帧，整段滚轮就会毫无反应（实测向上连滚六格画面不动）。
    // 只把 mode 退回 idle、目标对齐到现位置，等下一帧自己收住就够了。
    addEventListener(
      'scroll',
      () => {
        if (Math.abs(scrollY - applied) <= 2) return;
        // 滚轮刚动过：这一下多半是上一帧写位置的余波，别抢正在进行的手势
        if (performance.now() - lastWheelAt < SETTLE + 60) return;
        target = scrollY;
        mode = 'idle';
        // 键盘、拖滚动条也是「松手就吸」：松手之后同一条减速接上吸附
        retarget();
      },
      { passive: true },
    );

    // 页内锚点也走同一段缓动：滚轮是缓的、点一下「下滑」瞬移，会是两种语言
    document.addEventListener('click', (event) => {
      const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
      if (!link) return;
      const id = link.getAttribute('href').slice(1);
      const box = id ? document.getElementById(id) : null;
      if (!box) return;
      event.preventDefault();
      glide(box.getBoundingClientRect().top + scrollY - (box.classList.contains('screen') ? headH() : 0));
    });

    addEventListener('resize', () => {
      target = clamp(target);
    });

    root.classList.add('is-smooth');
  };

  // ---------- 滚动驱动：封面 / 门厅 / 顶栏进度线 / 上一屏离场 ----------

  /**
   * 只往元素上写四个 CSS 变量，不碰布局：
   *   .cover 的 --sc     这一屏滚出去多少（0 → 1）
   *   .hall  的 --hall   那张实景走到眼前多少（0 → 1），图从 1.1 回正到 1.0
   *   .top   的 --read   整页读到哪儿（0 → 1），顶栏下沿那条线按它伸长
   *   其余各屏的 --out  这一屏滚出去多少（0 → 1），内容按它上移并淡下去
   * 和换屏进场不同：那套是进一次就完，这套只要还在滚就一直在算——省掉它，
   * 页面滚到一半会像一张贴好的海报，现在会随滚动继续走。
   * 要「减少动态效果」就一次都不注册，CSS 里的默认值 0 正好是静止的最终状态。
   */
  const bindScrollMotion = () => {
    if (still()) return;
    const cover = document.getElementById('top');
    const hall = document.getElementById('hall');
    const bar = document.querySelector('.top');
    const leaves = [...document.querySelectorAll('.screen')].filter(
      (screen) => screen !== cover,
    );
    if (!cover && !hall && !bar) return;

    let queued = 0;
    const frame = () => {
      queued = 0;
      const vh = innerHeight || 1;
      // 先读后写：都读完了再写变量，避免写一个变量就触发一次样式重算
      const coverBox = cover ? cover.getBoundingClientRect() : null;
      const hallBox = hall ? hall.getBoundingClientRect() : null;
      const leaveBoxes = leaves.map((el) => [el, el.getBoundingClientRect()]);
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
      for (const [el, box] of leaveBoxes) {
        // 顶边贴住视口上沿是 0，整屏滚出去（顶边到 -一屏）是 1
        const out = Math.min(Math.max(-box.top / (box.height || vh), 0), 1);
        el.style.setProperty('--out', out.toFixed(3));
        el.classList.toggle('is-out', out > 0.002);
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

  // ---------- 屏比视口高：这一屏不参与吸附 ----------

  /**
   * 一屏一页靠 CSS 的 proximity 吸附。屏比视口还高的时候（320 宽的旧机、
   * 横屏、系统字号调大），proximity 会把滚到一半的页面拽回屏顶——屏幕上看得见
   * 的那截永远只是屏开头，页脚与反馈入口读不到（375×667 的家长屏实测被拽回 115px）。
   *
   * 这类屏摘掉吸附点，整页继续连续滚；装得下的屏照旧一页一屏。
   * 用 clientHeight 而不是 innerHeight：移动浏览器的地址栏收起时 innerHeight 会变，
   * 按它算会把「其实装得下」的屏也判成高屏。
   */
  const bindTallScreens = () => {
    const bar = document.querySelector('.top');
    const screens = [...document.querySelectorAll('.screen')];
    if (!screens.length) return;

    const sync = () => {
      const room = (root.clientHeight || innerHeight) - (bar ? bar.offsetHeight : 0);
      for (const screen of screens) {
        screen.classList.toggle('is-tall', screen.offsetHeight > room + 1);
      }
    };

    sync();
    addEventListener('resize', sync);
    addEventListener('load', sync);
    // 自托管字体换上来之后行高会动一截，装不装得下要重新量
    document.fonts?.ready.then(sync).catch(() => {});
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
    bindSmoothScroll();
    bindScrollMotion();
    bindTallScreens();
    bindReveal();
    bindRules();
  });
})();
