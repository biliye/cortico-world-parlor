/**
 * 对外页（GET /）：页面契约、分享卡片的绝对地址、标签与静态资源的发法。
 *
 * 这里不起网关（网关要真 PG），只做两件事：
 * 1. 静态契约：页面里不能有内联 style/script/form（CSP 是 default-src 'none'），
 *    引用的每个 /welcome/assets/* 都要带版本号并且真的在包里；
 * 2. 发法：sendWebAsset 的 transform 把 {{origin}} 换成实例地址，ETag 跟着改写后的内容走。
 */
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fillOrigin, isPublicAsset, ORIGIN_TOKEN, sendWebAsset } from '../src/room/web-assets.ts';
import { RULE_PAGES, renderRuleDialog, renderRulesMarkup } from '../src/room/game-rules-doc.ts';
import { WEREWOLF_MAX_DAYS } from '../src/room/games/werewolf.ts';
import { DEFAULT_TURN_MS as DDZ_TURN_MS } from '../src/room/games/doudizhu-table.ts';
import { ENABLED_GAMES, gameLabel } from '../web-src/lib/games.ts';
import { GATEWAY_RETRY_DELAYS, gatewayOf, gatewaySettlement, isGatewayServer } from '../web-src/lib/gateway.ts';

const web = new URL('../src/web/', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
/* 源码里有中文与生成块，换行随平台（Windows 工作树是 CRLF、CI 是 LF）。
   断言只看内容，先归一成 LF，免得同一份文本在两边结论不同。 */
const read = (file: string) => readFileSync(new URL(file, web), 'utf8').replace(/\r\n/g, '\n');
const page = read('welcome.html');
/** 注释里会提到 <style>、CSP 这类字样，和 check-release 一样先剥掉注释再判。 */
const markup = page.replace(/<!--[\s\S]*?-->/g, '');
const assetRefs = [...page.matchAll(/(?:src|href)="(\/welcome\/assets\/[^"]*)"/g)].map(([, url]) => url);

function welcomeScroll(start: number, tall = false) {
  const events = new EventTarget();
  let y = start;
  const tallScreen = {
    offsetHeight: 800,
    getBoundingClientRect: () => ({ top: 600 - y }),
  };
  const nativeScroll = (top: number) => {
    y = top;
    events.dispatchEvent(new Event('scroll'));
  };
  const scrollTo = vi.fn(({ top }: { top: number }) => {
    y = Math.round(top);
  });
  runInNewContext(read('welcome.js'), {
    document: {
      documentElement: {
        style: { scrollBehavior: '' },
        scrollHeight: 2000,
        classList: { add: () => {}, contains: () => false },
      },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: (selector: string) => tall && selector === '.screen.is-tall' ? [tallScreen] : [],
      addEventListener: () => {},
    },
    window: { scrollTo },
    innerHeight: 600,
    get scrollY() { return y; },
    matchMedia: (query: string) => ({ matches: query.includes('pointer: fine') }),
    addEventListener: events.addEventListener.bind(events),
    requestAnimationFrame: (callback: (now: number) => void) => setTimeout(() => callback(Date.now()), 16),
    cancelAnimationFrame: clearTimeout,
    setTimeout,
    clearTimeout,
  });
  return {
    nativeScroll,
    scrollTo,
    position: () => y,
    wheel: (deltaY: number) => events.dispatchEvent(
      Object.assign(new Event('wheel', { cancelable: true }), { deltaY, deltaX: 0, deltaMode: 0 }),
    ),
  };
}

describe('对外页的桌面滚动', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('原生滚动保留小幅位移，并取消上一段滚轮追帧与吸附', () => {
    const { nativeScroll, scrollTo, position, wheel } = welcomeScroll(0);
    nativeScroll(40);
    vi.advanceTimersByTime(1000);
    expect(position()).toBe(40);
    expect(scrollTo).not.toHaveBeenCalled();

    wheel(200);
    vi.advanceTimersByTime(64);
    expect(position()).toBeGreaterThan(40);
    nativeScroll(140);
    scrollTo.mockClear();
    vi.advanceTimersByTime(1000);
    expect(position()).toBe(140);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('高屏内的小数滚轮位移取整后结束追帧', () => {
    const { scrollTo, position, wheel } = welcomeScroll(700, true);
    wheel(12.5);
    vi.advanceTimersByTime(1000);
    expect(position()).toBe(713);
    scrollTo.mockClear();
    vi.advanceTimersByTime(1000);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe('对外页的静态契约', () => {
  it('页头写明变体与语言，标题和描述不是空的', () => {
    expect(page).toMatch(/<html lang="zh-CN"/);
    expect(page).toContain('data-ef-variant="site"');
    expect(page).toContain('data-ef-accent="amber"');
    expect(page).toContain('data-ef-paper="warm"');
    expect(page).toContain('data-ef-ground="hatch"');
    expect(page).toMatch(/<title>[^<]{4,}<\/title>/);
    expect(page).toMatch(/<meta name="description" content="[^"]{20,}"/);
  });

  it('玩法目录和两份跑马灯都只列网页可开桌的玩法', () => {
    const compact = (label: string) => label.replace(/\s+/g, '');
    const enabled = ENABLED_GAMES.map(id => compact(gameLabel(id))).sort();
    const listed = [...markup.matchAll(/<span class="g">([^<]+)<\/span>/g)].map(([, label]) => compact(label));
    const ticker = [...markup.matchAll(/<a href="#games"[^>]*><b>\d+<\/b>([^<]+)<\/a>/g)]
      .map(([, label]) => compact(label));
    expect(listed.sort()).toEqual(enabled);
    expect(ticker.sort()).toEqual([...enabled, ...enabled].sort());
  });

  it('没有内联样式、内联脚本和表单（CSP 是 default-src none，form-action none）', () => {
    expect(markup).not.toMatch(/\sstyle\s*=/);
    expect(markup).not.toMatch(/<style/i);
    expect(markup).not.toMatch(/<form/i);
    const scripts = [...markup.matchAll(/<script\b([^>]*)>/gi)].map(([, attrs]) => attrs);
    expect(scripts.length).toBeGreaterThan(0);
    for (const attrs of scripts) expect(attrs).toMatch(/\ssrc="/);
    expect(markup).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it('引用的每个资源都带当前版本号，且文件真的在包里', () => {
    expect(assetRefs.length).toBeGreaterThanOrEqual(3);
    for (const url of assetRefs) {
      const parsed = new URL(url, 'http://localhost');
      expect(parsed.searchParams.getAll('v')).toEqual([version]);
      const file = new URL(parsed.pathname.replace('/welcome/assets/', ''), web);
      expect(statSync(file, { throwIfNoEntry: false })?.isFile(), url).toBe(true);
    }
    for (const required of ['welcome-kit.css', 'welcome.css', 'welcome.js']) {
      expect(assetRefs.some((url) => url.startsWith('/welcome/assets/' + required + '?'))).toBe(true);
    }
  });

  it('分享卡片用占位符写绝对地址，而不是写死某一个域名', () => {
    const tokens = [...page.matchAll(/\{\{[^}]*\}\}/g)].map(([token]) => token);
    expect(tokens.length).toBeGreaterThan(0);
    expect(new Set(tokens)).toEqual(new Set([ORIGIN_TOKEN]));
    expect(page).toMatch(/<meta property="og:image" content="\{\{origin\}\}\/welcome\/assets\/welcome-og\.png">/);
    expect(page).toMatch(/<meta property="og:url" content="\{\{origin\}\}/);
    expect(page).toMatch(/<link rel="canonical" href="\{\{origin\}\}/);
  });

  it('分享图是 1200×630 的 PNG，字体是 woff2 且许可随附', () => {
    const png = readFileSync(new URL('welcome-og.png', web));
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
    expect(png.length).toBeLessThan(400_000);
    const font = readFileSync(new URL('welcome-saira.woff2', web));
    expect(font.subarray(0, 4).toString('latin1')).toBe('wOF2');
    expect(font.length).toBeLessThan(200_000);
    expect(read('welcome-saira-OFL.txt')).toContain('SIL Open Font License');
  });

  it('robots.txt 只挡接口，页面靠响应头 noindex 让人别收录', () => {
    const robots = read('robots.txt');
    expect(robots).toMatch(/^Disallow: \/v1\/$/m);
    // 挡抓取就读不到 X-Robots-Tag，反而可能只收一个光秃秃的网址；所以这几个页面不能在这儿 Disallow。
    for (const path of ['/play', '/parent', '/identity']) {
      expect(robots).not.toMatch(new RegExp(`^Disallow: ${path}$`, 'm'));
    }
    expect(robots).toMatch(/^Sitemap: \{\{origin\}\}\/sitemap\.xml$/m);
  });

  it('sitemap 只有首页一个地址', () => {
    const sitemap = read('sitemap.xml');
    expect(sitemap).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect([...sitemap.matchAll(/<loc>[^<]*<\/loc>/g)].map(([loc]) => loc)).toEqual(['<loc>{{origin}}/</loc>']);
  });

  it('网关的 / 路由指向这一页', () => {
    const server = readFileSync(new URL('../src/room/world-server.ts', import.meta.url), 'utf8');
    expect(server).toMatch(/pathname === '\/'\)\s*\{\s*this\.serveOriginFile\('welcome\.html'/);
    expect(server).toMatch(/pathname === '\/robots\.txt' \|\| pathname === '\/sitemap\.xml'/);
    expect(server).toContain("startsWith('/welcome/assets/')");
  });

  /**
   * assets 路由过去只认路径不认类型，于是 `/welcome/assets/welcome.html` 会把模板原样发出去：
   * 没有 CSP、`{{origin}}` 没替换、`/play/assets/welcome.html` 也能取到。
   */
  it('assets 只发资源，页面模板与对外页文本走各自的路由', () => {
    for (const blocked of ['welcome.html', 'play.html', 'robots.txt', 'sitemap.xml', 'welcome-saira-OFL.txt']) {
      expect(isPublicAsset(blocked), blocked).toBe(false);
    }
    for (const allowed of ['welcome.css', 'welcome.js', 'welcome-og.png', 'vue/main.js', 'welcome-saira.woff2']) {
      expect(isPublicAsset(allowed), allowed).toBe(true);
    }
    const server = readFileSync(new URL('../src/room/world-server.ts', import.meta.url), 'utf8');
    expect(server).toContain("if (!isPublicAsset(rel)) throw new HttpError(404");
    // HEAD 跟 GET 同状态：`curl -I` 不该拿到 404。
    expect(server).toMatch(/method === 'GET' \|\| method === 'HEAD'\)\s*&&\s*this\.serveWeb/);
  });

  it('入场页给出账号登录和邀请码试玩的真实入口', () => {
    const enter = markup.slice(markup.indexOf('id="enter"'), markup.indexOf('id="parent"'));
    expect(enter).toContain('href="/play?entry=login"');
    expect(enter).toContain('href="/play?entry=guest"');
    expect(enter).toContain('试玩客厅玩 24 小时');
    expect(markup).not.toMatch(/不开放注册|入口已关闭|房主发.*带钥匙/);
    // 反馈与公告用的是「当前浏览器」里的客厅席位令牌，加入客厅就发了，不需要上桌。
    expect(page).toContain('要先用当前浏览器加入客厅才能打开');
    expect(page).toContain('反馈与公告（需先加入客厅）');
  });

  it('顶栏只剩三个控件，正文改成一屏一屏的分页', () => {
    const top = markup.slice(markup.indexOf('<header class="top"'), markup.indexOf('</header>'));
    expect(top).toContain('href="/support"');
    expect(top).toMatch(/<a[^>]*href="\/play\?entry=login"[^>]*>登录<\/a>/);
    expect(top).toContain('data-act="theme"');
    expect(top).toContain('<a href="#top">鲸语会馆</a>');
    // 分区导航撤了：看哪一屏靠滚动，不靠顶栏（只剩左上角回第一屏的那个）
    for (const anchor of ['#what', '#games', '#enter', '#parent']) {
      expect(top).not.toContain(`href="${anchor}"`);
    }

    // 屏序就是阅读顺序，改版式时这条会先炸
    const ids = [...markup.matchAll(/<section class="screen[^"]*" id="([^"]+)"/g)].map(([, id]) => id);
    expect(ids).toEqual(['top', 'hall', 'what', 'games', 'enter', 'parent']);

    const css = read('welcome.css');
    expect(css).toMatch(/scroll-snap-type:\s*y proximity/);
    expect(css).toMatch(/scroll-snap-align:\s*start/);
    expect(css).toMatch(/min-height:\s*calc\(100svh - var\(--top-h\)/);
  });

  it('入场与家长两屏写清 Coo 客厅页里的两条入口', () => {
    expect(page).toContain('客厅 · 我下场玩（带钥匙，勿转发）');
    expect(page).toContain('客厅 · 家长页（只读，带钥匙）');
    expect(page).toContain('「客厅」页');
  });

  /**
   * 2026-11-22 改版：首屏只留会名，大厅实景与「这里是这样的地方」各占一屏。
   * 首屏空下来的代价是内容多滚两屏，所以这里同时钉住两条：
   * 1. 封面里不许再出现图、段落、按钮组——它是一块只印名字的牌子；
   * 2. 实景图与三栏都还在，只是搬到了 02 / 03 屏。
   */
  it('封面只有会名，没有图、段落与按钮组', () => {
    const cover = markup.slice(markup.indexOf('id="top"'), markup.indexOf('id="hall"'));
    expect(cover).toContain('class="ef-wordmark"');
    expect(cover).toContain('鲸语会馆');
    expect(cover).toContain('PARLOR CLUB');
    // 一屏只放字：这几样都不许出现在封面里
    expect(cover).not.toContain('<img');
    expect(cover).not.toContain('<figure');
    expect(cover).not.toContain('class="lead"');
    expect(cover).not.toContain('class="ef-actions"');
    expect(cover).not.toContain('class="claim"');
    // 会名逐字推出来：每个字一个 span，靠 nth-child 排延迟（CSP 不许内联 style）
    const chars = [...cover.matchAll(/<span class="solid"[^>]*>([\s\S]*?)<\/span>\s*<span class="hollow"/g)];
    expect(chars.length).toBe(1);
    expect([...chars[0][1].matchAll(/<span>/g)].length).toBe(4);
    // 屏幕阅读器读的是 h1 的 aria-label，不是四个拆开的字
    expect(cover).toMatch(/<h1 class="ef-wordmark" aria-label="[^"]{4,}"/);
    // 进客厅仍然在第一屏够得着，只是做成一条带下划线的字
    expect(cover).toContain('class="cover-go" href="/play"');
    // 跑马灯还在，当这一屏的页脚
    expect(cover).toContain('class="ef-ticker"');
  });

  it('02 屏是大厅实景，不是内联线稿', () => {
    const hall = markup.slice(markup.indexOf('id="hall"'), markup.indexOf('id="what"'));
    expect(hall).not.toContain('<svg');
    const img = hall.match(/<img[^>]*welcome-lobby\.webp[^>]*>/);
    expect(img, '门厅那屏要引用大厅实景图').toBeTruthy();
    expect(img![0]).toMatch(/\salt="[^"]{10,}"/);
    expect(img![0]).toMatch(/\swidth="\d+"\s+height="\d+"/);
    // 图真的在包里，而且是 WebP（RIFF....WEBP）
    const bytes = readFileSync(new URL('welcome-lobby.webp', web));
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString('latin1')).toBe('WEBP');
    expect(bytes.length).toBeLessThan(200_000);
    expect(isPublicAsset('welcome-lobby.webp')).toBe(true);
  });

  it('03 屏是「这里是这样的地方」，三栏都在，自己占一屏', () => {
    const what = markup.slice(markup.indexOf('id="what"'), markup.indexOf('id="games"'));
    expect(what).toContain('这里是这样的地方');
    expect(what).toContain('Coo 也是同桌');
    expect(what).toContain('输赢记在自己名下');
    expect(what).toContain('可以在旁边看');
    // 三栏都是这一屏的直接内容，没有被塞进首屏
    expect(what).toContain('class="what-cols"');
    // 顶栏仍然不给锚点：看哪一屏靠滚，不靠导航
    expect(markup).not.toContain('href="#what"');
  });

  /**
   * 三条动效口径：吸附只有接近一档（不硬拽、不限一次一屏）；换屏内容依次抬起；
   * 明暗从按钮向外扩散，且都留了「减少动态效果」的退路。
   */
  it('吸附、换屏进场与明暗扩散都有脚本配合，并且都能关掉', () => {
    const css = read('welcome.css');
    const js = read('welcome.js');

    // 吸附只有接近一档：滚到一屏附近才吸，滚快一点可以连着走，也不限一次只走一屏
    expect(css).toMatch(/html\s*\{[^}]*scroll-snap-type:\s*y proximity/);
    expect(css).not.toMatch(/scroll-snap-type:\s*y mandatory/);
    expect(css).not.toMatch(/scroll-snap-stop:\s*always/);
    // 既然没有强制吸附，就不需要脚本量「每屏装不装得下」再切档；
    // 只有比视口还高的屏要摘掉吸附点（见下面手机档那条），量的是越界，不是切档
    expect(js).not.toContain('measureSnap');
    expect(js).not.toContain('dataset.snap');

    // 换屏进场：脚本挂 data-reveal + is-in，CSS 按 --i 错开（屏级 100ms）
    expect(js).toContain("screen.dataset.reveal");
    expect(js).toContain("classList.add('is-in')");
    expect(js).toContain('IntersectionObserver');
    expect(css).toMatch(/\.screen\[data-reveal\]\.is-in\s*>\s*\*/);
    expect(css).toMatch(/animation-delay:\s*calc\(var\(--i, 0\) \* 100ms\)/);

    // 屏里的列表再挂一层队列：编号与条目 45ms 一个地浮现
    expect(js).toContain('STAGGER_GROUPS');
    expect(js).toContain('dataset.stagger');
    expect(css).toMatch(/\[data-stagger\]\.is-in\s*>\s*\*/);
    expect(css).toMatch(/animation-delay:\s*calc\(var\(--i, 0\) \* 45ms\)/);
    // 队列里超过八项就停在同一档，整段出场不拖过一秒
    expect(css).toMatch(/\[data-stagger\] > \*:nth-child\(n \+ 8\)\s*\{\s*--i:\s*7/);

    // 明暗：View Transitions 的圆形裁切 + 不支持时整页淡过去
    expect(js).toContain('startViewTransition');
    expect(js).toContain("root.dataset.vt = 'theme'");
    expect(css).toMatch(/html\[data-vt='theme'\]::view-transition-new\(root\)/);
    expect(css).toMatch(/clip-path:\s*circle\(/);
    expect(js).toContain('ef-theme-fade');
    expect(css).toContain('html.ef-theme-fade');

    // 三处都要能被「减少动态效果」关掉
    expect(js).toContain('prefers-reduced-motion: reduce');
    expect(css).toContain('prefers-reduced-motion: no-preference');
  });

  /**
   * 矮窗口（1366×768 的笔记本、1080×675 的截图档）里首屏只剩会名，
   * 但页脚那行与跑马灯仍然要落在第一屏内，所以那一档要单独把会名收小。
   */
  it('矮窗口把封面会名收一档，页脚与跑马灯仍落在第一屏里', () => {
    const css = read('welcome.css');
    const defaults = css.indexOf('.cover .ef-wordmark {');
    expect(defaults).toBeGreaterThan(-1);
    const tight = css.indexOf('@media (max-height: 780px)', defaults);
    expect(tight).toBeGreaterThan(defaults);
    expect(css.slice(tight, tight + 700)).toMatch(/\.cover \.ef-wordmark\s*\{[^}]*--ef-wordmark:/);
  });

  /**
   * 2026-11-22 加的这套和「换屏进场」是两回事：进场是进一次就完，
   * 这套只要还在滚就一直在算。三个变量都由脚本按帧写，CSS 只读；
   * 系统要「减少动态效果」时脚本一次都不注册，CSS 默认值 0 就是静止的最终状态。
   */
  it('封面、门厅与顶栏进度线都吃滚动进度，且能整段关掉', () => {
    const css = read('welcome.css');
    const js = read('welcome.js');

    expect(js).toContain('bindScrollMotion');
    expect(js).toContain("'--sc'");
    expect(js).toContain("'--hall'");
    expect(js).toContain("'--read'");
    // 写变量走 rAF，scroll 用 passive，别在滚动里读布局再同步写
    expect(js).toMatch(/requestAnimationFrame\(frame\)/);
    expect(js).toMatch(/addEventListener\('scroll', onScroll, \{ passive: true \}\)/);

    // CSS 只读不写：三个变量都有默认值，没有脚本时停在最终状态
    expect(css).toMatch(/\.cover\s*\{[^}]*--sc:\s*0/);
    expect(css).toMatch(/\.hall\s*\{[^}]*--hall:\s*0/);
    expect(css).toMatch(/opacity:\s*calc\(1 - var\(--sc\)\)/);
    expect(css).toMatch(/scale\(calc\(1\.1 - var\(--hall\) \* 0\.1\)\)/);
    expect(css).toMatch(/scaleX\(var\(--read, 0\)\)/);
    // 逐字推出：一个字一个延迟档，超过四个不再往后
    expect(css).toMatch(/@keyframes ef-type-in/);
    expect(css).toMatch(/animation-delay:\s*calc\(var\(--i, 0\) \* 70ms \+ 160ms\)/);

    // 减少动态效果：整套不注册
    expect(js).toMatch(/const bindScrollMotion = \(\) => \{\s*if \(still\(\)\) return;/);
  });

  /**
   * 2026-11-22 第二轮（用户：「吸附很僵硬」「上一页的内容没有动」「滚轮停了页面也一并停」）：
   * 桌面滚轮改成受控的逐帧追，吸附在「还在走」的时候改目标，上一屏内容比屏框先离场。
   */
  it('桌面滚轮是逐帧追的受控滚动，吸附中途改目标而不是停死再起步', () => {
    const css = read('welcome.css');
    const js = read('welcome.js');

    // 接管只在细指针 + 没开减少动效时发生；触屏走原生滚动
    expect(js).toMatch(/const bindSmoothScroll = \(\) => \{\s*if \(still\(\)\) return;/);
    expect(js).toMatch(/\(hover: hover\) and \(pointer: fine\)/);
    // 接管之后必须把原生吸附关掉，否则两套吸附互相抢，正是「僵硬」的来源
    expect(css).toMatch(/html\.is-smooth\s*\{[^}]*scroll-snap-type:\s*none/);
    expect(js).toContain("root.classList.add('is-smooth')");

    // 逐帧追：手停下之后还有一小段减速尾巴（指数逼近，按过去了几个 60Hz 帧折算）
    expect(js).toMatch(/const FOLLOW = 0\.1\d/);
    expect(js).toMatch(/Math\.pow\(1 - FOLLOW, dt\)/);

    // 吸附：手停 200ms 后把落点收进最近的屏边界，循环照旧跑着，减速直接接上吸附；
    // 不是等停稳（mode === 'idle'）再起步——那段静止加起步加速度就是僵硬感
    expect(js).toMatch(/const retarget = \(\) =>/);
    expect(js).toMatch(/Math\.abs\(at - target\)/);
    expect(js).toMatch(/target = clamp\(pick\);\s*\n\s*if \(!frame\) \{/);
    expect(js).not.toContain('settle();');
    // 2026-11-23：滚四五格停手不再卡在两屏之间，取最近落点，空档不留
    expect(js).not.toContain('REACH');
    expect(js).not.toContain('FLING');
    expect(js).toMatch(/let pick = list\[0\];\s*\n\s*for \(const at of list\)/);
    // 比视口高的屏不当落点，落进去也不吸（那截要连续读）
    expect(js).toMatch(/filter\(\(el\) => !el\.classList\.contains\('is-tall'\)\)/);
    expect(js).toContain('inTall(target)) return;');
    // 追帧即时写位置，锚点可以沿用浏览器的平滑滚动和历史记录。
    expect(js).toContain("window.scrollTo({ top: y, behavior: 'instant' })");
    expect(css).toMatch(/html\s*\{[^}]*scroll-behavior:\s*smooth/);
    expect(css).not.toMatch(/html\.is-smooth\s*\{[^}]*scroll-behavior:/);
  });

  /**
   * 上一屏离场：屏框被滚动带着走，里面的内容要跟着先走一步。
   * 用独立的 translate / filter，避开入场动画占着的 transform / opacity。
   */
  it('上一屏的内容比屏框先离场，且静止时不挂合成层', () => {
    const css = read('welcome.css');
    const js = read('welcome.js');

    expect(js).toContain("el.style.setProperty('--out'");
    expect(js).toContain("classList.toggle('is-out', out > 0.002)");
    // 位移与淡化都挂在 --out 上，默认值 0 就是静止的最终状态
    expect(css).toMatch(/\.screen:not\(\.cover\)\.is-out\s*>\s*\* \{[^}]*translate: 0 calc\(var\(--out, 0\) \* -[\d.]+vh\)/);
    expect(css).toMatch(/\.screen:not\(\.cover\)\.is-out\s*>\s*\* \{[^}]*filter: opacity\(/);
    // filter 一旦不是 none 就会让整块进合成层、正文掉成灰度抗锯齿，
    // 所以只在 is-out 挂上时才加，静止时这条规则不命中
    expect(css).not.toMatch(/\.screen\s*>\s*\* \{[^}]*filter:\s*opacity/);
    expect(css).toContain('prefers-reduced-motion: no-preference');
  });


  /**
   * 2026-11-23（用户：「切到手机显示有问题」）：
   * 一屏一页在手机上得真的装得下 —— 装不下的屏不许吸附，否则滚到屏中间会被
   * 拽回屏顶，屏底那截永远读不到（375×667 的家长屏实测被拽回 115px）；
   * 横屏另排一遍；窄机不许把会名藏掉留半条空顶栏。
   */
  it('手机档：装不下的屏不吸附，横屏重排，窄机不藏会名', () => {
    const css = read('welcome.css');
    const js = read('welcome.js');

    // 逐屏量高，超出视口的那一屏摘掉吸附点
    expect(js).toContain('bindTallScreens');
    expect(js).toContain("classList.toggle('is-tall'");
    expect(js).toContain('root.clientHeight');
    // 字体换上来之后行高会动，装不装得下要重新量
    expect(js).toContain('document.fonts');
    expect(css).toMatch(/\.screen\.is-tall\s*\{[^}]*scroll-snap-align:\s*none/);
    // 连续滚过去的屏不参与「翻页离场」，否则读到一半自己淡下去
    expect(css).toMatch(/\.screen\.is-tall\.is-out > \* \{[^}]*filter:\s*none/);

    // 玩法屏不再用死高度 + overflow:hidden 把最后一行悄悄裁掉
    expect(css).toMatch(/\.games-screen\s*\{[^}]*min-height:\s*max\(calc\(100svh/);
    expect(css).not.toMatch(/\.games-screen\s*\{[^}]*[^-]height:\s*calc\(100svh/);
    // 网格被压到比内容还矮，说明会溢到下一格
    expect(css).toMatch(/\.rule-grid\s*\{[^}]*min-height:\s*min-content/);

    // 375×667 那一档整页收一档字号与块间距，家长屏才装得下页脚
    expect(css).toMatch(/@media \(max-width: 599px\) and \(max-height: 720px\)/);

    // 横屏手机（844×390）：连续滚 + 图回右侧 + 三栏与八格重排 + 刘海让位
    const land = css.indexOf('@media (orientation: landscape) and (max-height: 560px)');
    expect(land).toBeGreaterThan(-1);
    const block = css.slice(land, land + 2200);
    expect(block).toMatch(/scroll-snap-type:\s*none/);
    expect(block).toMatch(/\.hall\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.02fr\)/);
    expect(block).toMatch(/\.rule-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4/);
    expect(block).toContain('env(safe-area-inset-left)');

    // 窄机（320–375）把会名收一档字号，不再 display:none
    const narrow = css.indexOf('@media (max-width: 379px)');
    expect(narrow).toBeGreaterThan(-1);
    expect(css.slice(narrow, narrow + 300)).toMatch(/\.top \.mark\s*\{[^}]*font-size:/);
    expect(css).not.toMatch(/\.top \.mark\s*\{[^}]*display:\s*none/);
  });

  it('明暗偏好可以保存，登录与试玩通过普通链接导航', () => {
    expect(markup).not.toContain('data-act="account"');
    const js = read('welcome.js');
    expect(js).not.toContain('[data-act="account"]');
    // 明暗记在 localStorage，重开还是上次选的那个
    expect(js).toContain('parlor-welcome-theme');
    expect(js).toContain('dataset.theme');
  });
});

/**
 * 规则页由 `src/room/game-rules-doc.ts` 生成：这里核四件事 ——
 * 两段生成物都真的写进了页面、八格按钮与八块规则一一对上、
 * 没脚本时规则仍读得到、#66 里玩家问到的口径都在。
 */
describe('八种玩法的规则页', () => {
  const slice = (begin: string, end: string) => {
    const from = page.indexOf(begin);
    const to = page.indexOf(end);
    expect(from, begin).toBeGreaterThan(-1);
    expect(to, begin).toBeGreaterThan(from);
    return page.slice(from + begin.length, to).trim();
  };

  const cards = slice('<!-- rules:begin -->', '<!-- rules:end -->');
  const dialog = slice('<!-- rules-dialog:begin -->', '<!-- rules-dialog:end -->');

  it('页面里的两段就是生成器的输出，没有手改', () => {
    expect(cards).toBe(renderRulesMarkup().trim());
    expect(dialog).toBe(renderRuleDialog().trim());
  });

  it('八格按钮与八块规则一一对上，编号 01–08', () => {
    const buttons = [...cards.matchAll(/class="rule-card"[^>]*\bdata-rule="([^"]+)"/g)].map(([, id]) => id);
    const articles = [...dialog.matchAll(/class="rule"\s+id="rule-([^"]+)"/g)].map(([, id]) => id);
    expect(buttons).toEqual(RULE_PAGES.map((rule) => rule.id));
    expect(articles).toEqual(buttons);
    expect([...buttons].sort()).toEqual([...ENABLED_GAMES].sort());
    expect(RULE_PAGES.map((rule) => rule.no)).toEqual(['01', '02', '03', '04', '05', '06', '07', '08']);
    // 按钮与规则块靠 data-rule 对上，脚本就是按它找的
    for (const id of buttons) expect(dialog).toContain(`data-rule="${id}"`);
  });

  it('没有脚本时八块规则平铺在页面里，仍读得到', () => {
    // 规则块默认不带 hidden：脚本跑起来才收成一块
    expect(dialog).not.toMatch(/<article class="rule"[^>]*\shidden/);
    // 弹层放在所有屏之后：平铺时不会把某一屏撑破
    expect(page.indexOf('<!-- rules-dialog:begin -->')).toBeGreaterThan(page.indexOf('id="parent"'));
    const js = read('welcome.js');
    const css = read('welcome.css');
    expect(js).toContain("root.classList.add('ef-rules')");
    expect(css).toMatch(/html:not\(\.ef-rules\) \.rule-dialog/);
    expect(css).toMatch(/html:not\(\.ef-rules\) \.rule-dialog-bar\s*\{[^}]*display:\s*none/);
  });

  it('#66 里玩家问到的四件事都有成文说法', () => {
    const werewolf = RULE_PAGES.find((rule) => rule.id === 'werewolf');
    expect(werewolf).toBeTruthy();
    const text = werewolf!.blocks
      .flatMap((block) => block.items)
      .map((item) => (typeof item === 'string' ? item : item.text))
      .join('\n');
    expect(text).toContain('首夜可自救，之后不能自救，不能自毒');
    expect(text).toContain('屠边没达成，对局继续');
    expect(text).toContain('复投再平，当天无人出局');
    expect(text).toContain('强制平局收场');
    expect(text).toContain(`第 ${WEREWOLF_MAX_DAYS} 个白天`);
  });

  it('每个玩法都写了胜负与超时，秒数直接来自实现常量', () => {
    for (const rule of RULE_PAGES) {
      const titles = rule.blocks.map((block) => block.title);
      expect(titles, rule.id).toContain('胜负与收尾');
      expect(titles, rule.id).toContain('时长与超时');
      expect(rule.facts.length, rule.id).toBeGreaterThanOrEqual(3);
    }
    const ddz = RULE_PAGES.find((rule) => rule.id === 'ddz')!;
    expect(ddz.facts.join(' ')).toContain(`出牌 ${Math.round(DDZ_TURN_MS / 1000)} 秒`);
  });

  it('规则层是 dialog：点一格开、Esc 与点遮罩都能关，进出都有动画', () => {
    const js = read('welcome.js');
    const css = read('welcome.css');
    expect(js).toContain('bindRules');
    expect(js).toContain('showModal');
    expect(js).toContain("addEventListener('cancel'");
    // 退场先挂 is-out 播动画，再 close()
    expect(js).toContain('is-out');
    expect(css).toMatch(/@keyframes ef-dialog-in/);
    expect(css).toMatch(/@keyframes ef-dialog-out/);
    expect(css).toMatch(/\.rule-dialog\[open\]\.is-out/);
    // 整屏仍是一屏，规则不占它的高度；层里只有正文滚，滚到底不带动身后的页
    expect(css).toMatch(/\.games-screen\s*\{[^}]*height:\s*calc\(100svh - var\(--top-h\)/);
    expect(css).toMatch(/\.rule-pages\s*\{[^}]*overscroll-behavior:\s*contain/);
    expect(css).toMatch(/html\.ef-rule-open\s*\{[^}]*overflow:\s*hidden/);
    // 减少动态效果时两层都不播
    expect(css).toMatch(/prefers-reduced-motion: no-preference\)\s*\{\s*\.rule-dialog\[open\]/);
  });
});

/** 这些页面的源码文本：模板断言比渲染更快，也够挡住「忘了加判断」这类回退。 */
const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const pages = {
  parent: read('parent.html'),
  support: read('support.html'),
  join: source('../web-src/views/JoinView.vue'),
};

describe('子页都能回首页', () => {
  it('家长页顶栏与没钥匙的 gate 都有回首页的入口', () => {
    const hud = pages.parent.slice(pages.parent.indexOf('<header class="hud"'), pages.parent.indexOf('</header>'));
    expect(hud).toMatch(/<a class="brand" href="\/"/);
    expect(hud).toMatch(/class="hud-home" href="\/"/);
    const gate = pages.parent.slice(pages.parent.indexOf('id="gate"'), pages.parent.indexOf('id="view"'));
    expect(gate).toContain('href="/"');
    expect(gate).toContain('回会馆首页');
    // 跳过导航还在，品牌区加了链接不等于把无障碍入口挤掉
    expect(pages.parent).toContain('<a class="skip-link" href="#main">跳到主要内容</a>');
  });

  it('反馈页的「回会馆」改回首页，去客厅另留一条', () => {
    const header = pages.support.slice(pages.support.indexOf('<header>'), pages.support.indexOf('</header>'));
    expect(header).toContain('href="/"');
    expect(header).toContain('回会馆首页');
    expect(header).toContain('href="/play"');
  });

  it('/play 顶栏不再挂账户入口，账户只在家长页', () => {
    const shell = source('../web-src/components/AppShell.vue');
    expect(shell).not.toContain('AccountPanel');
    expect(shell).not.toContain('accountOpen');
  });

  it('一律用相对根路径，不写死实例域名', () => {
    for (const [name, text] of Object.entries(pages)) {
      expect(text, name).not.toContain('parlor.com.cn');
    }
  });
});

/**
 * 单厅（serve.ts）与网关共用同一份 /play 与 Vue 产物，但不发 `/`、`/parent`、`/support`。
 * 所以入口必须按 healthz 的服务器形态收起来——只有网关那几页可以无条件写 `href="/"`。
 */
describe('回首页的入口只在多客厅网关出现', () => {
  it('用 healthz 有没有 rooms 认网关，拿不到就留作未确认', () => {
    // 网关 healthz（src/room/world-server.ts）与单厅 healthz（src/room/server.ts）的真实形状。
    expect(isGatewayServer({ ok: true, room: 'hall', version, protocol: 2, rooms: 3 })).toBe(true);
    expect(isGatewayServer({ ok: true, room: 'lobby', version, seats: 2, maxSeats: 8, latest: 0, replay: 0 })).toBe(false);
    expect(isGatewayServer({})).toBe(false);
    // 拿不到 healthz（503 / 断网 / 响应不是 JSON）不是「单厅」，是未确认。
    expect(gatewayOf(null)).toBeNull();
    expect(gatewayOf(undefined)).toBeNull();
    expect(gatewayOf({ ok: true, room: 'hall', rooms: 3 })).toBe(true);
    expect(gatewayOf({ ok: true, room: 'lobby', version })).toBe(false);
  });

  it('入场页的品牌行与底部链接都挂在判断上，单厅退回纯品牌文字', () => {
    expect(pages.join).toMatch(/<a v-if="gateway" class="brand" href="\/"/);
    expect(pages.join).toMatch(/<p v-else class="brand">鲸语/);
    expect(pages.join).toMatch(/<p v-if="gateway" class="note home-note"><a href="\/">/);
    // 判断来自 healthz，不是写死 true
    expect(pages.join).toContain('detectGateway');
  });

  it('家长页与反馈页只有网关会发，所以那两页不用加判断', () => {
    const world = readFileSync(new URL('../src/room/world-server.ts', import.meta.url), 'utf8');
    expect(world).toContain("this.sendWeb('parent.html'");
    expect(world).toContain("this.sendWeb('support.html'");
    // 单厅只发 /play 与 /play/assets/**；哪天它开始发这两页，上面两段就得跟着加判断。
    const room = readFileSync(new URL('../src/room/server.ts', import.meta.url), 'utf8');
    const serveWeb = room.slice(room.indexOf('private serveWeb'), room.indexOf('private sendWeb'));
    expect(serveWeb).not.toContain('parent.html');
    expect(serveWeb).not.toContain('support.html');
  });
});

/**
 * 首屏 healthz 可能正好撞上网关重启（503）或断网。把「拿不到」当成「不是网关」
 * 缓存下来，服务恢复后要刷新页面入口才回来；这里锁住「失败不落结论」。
 */
describe('healthz 探测失败不算结论', () => {
  it('没拿到 healthz 留未确认，并给出退避重试的间隔', () => {
    expect(gatewaySettlement(null)).toEqual({ value: null, retryIn: GATEWAY_RETRY_DELAYS[0] });
    expect(gatewaySettlement(undefined, 3)).toEqual({ value: null, retryIn: GATEWAY_RETRY_DELAYS[3] });
    // 退避用完就不再自动重试，留给打开账户弹窗 / 点「再试一次」去救。
    expect(gatewaySettlement(null, GATEWAY_RETRY_DELAYS.length)).toEqual({ value: null, retryIn: null });
  });

  it('拿到 healthz 才是定论：网关一次定 true，单厅一次定 false', () => {
    expect(gatewaySettlement({ ok: true, room: 'hall', rooms: 3 })).toEqual({ value: true, retryIn: null });
    expect(gatewaySettlement({ ok: true, room: 'lobby', version })).toEqual({ value: false, retryIn: null });
  });

  it('store 按这条落账：未确认不写进 gateway', () => {
    const store = source('../web-src/stores/server.ts');
    expect(store).toContain('gatewaySettlement');
    // 上一版的写法：一失败就 isGatewayServer(null) => false，把首屏抖动钉成单厅。
    expect(store).not.toMatch(/gateway\.value\s*=\s*isGatewayServer/);
    expect(store).toMatch(/if \(value === null\)/);
  });
});

describe('对外页的发法', () => {
  const serve = async (origin: string) => {
    const server = createServer((req, res) => {
      if (!sendWebAsset('welcome.html', req, res, true, (body) => fillOrigin(body, origin))) {
        res.writeHead(404);
        res.end('missing');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务器没有端口');
    return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  };

  it('把占位符换成实例地址，页面按 no-cache 发并带 CSP', async () => {
    const gate = await serve('https://parlor.example/');
    try {
      const response = await fetch(gate.url + '/');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
      const body = await response.text();
      expect(body).not.toContain(ORIGIN_TOKEN);
      expect(body).toContain('content="https://parlor.example/welcome/assets/welcome-og.png"');
      expect(body).toContain('https://parlor.example</p>');
    } finally {
      await gate.close();
    }
  });

  it('ETag 跟着改写后的内容走：换实例地址就不是同一个指纹，同地址再要一次是 304', async () => {
    const one = await serve('https://parlor.example');
    const two = await serve('https://tearoom.example');
    try {
      const first = await fetch(one.url + '/', { headers: { 'accept-encoding': 'identity' } });
      const other = await fetch(two.url + '/', { headers: { 'accept-encoding': 'identity' } });
      const etag = first.headers.get('etag');
      expect(etag).toBeTruthy();
      expect(other.headers.get('etag')).not.toBe(etag);
      const again = await fetch(one.url + '/', { headers: { 'if-none-match': etag!, 'accept-encoding': 'identity' } });
      expect(again.status).toBe(304);
    } finally {
      await one.close();
      await two.close();
    }
  });

  it('牌桌与家长页带 noindex，对外页不带', async () => {
    const server = createServer((req, res) => {
      const page = (req.url ?? '').startsWith('/play');
      if (page) sendWebAsset('play.html', req, res, true, undefined, true);
      else sendWebAsset('welcome.html', req, res, true, (body) => fillOrigin(body, 'https://parlor.example'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务器没有端口');
    try {
      const play = await fetch(`http://127.0.0.1:${address.port}/play`);
      expect(play.status).toBe(200);
      expect(play.headers.get('x-robots-tag')).toBe('noindex');
      expect(play.headers.get('content-security-policy')).toContain("default-src 'none'");
      const home = await fetch(`http://127.0.0.1:${address.port}/`);
      expect(home.status).toBe(200);
      expect(home.headers.get('x-robots-tag')).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('fillOrigin 只换占位符，并把末尾斜杠去掉', () => {
    const out = fillOrigin(Buffer.from(`a ${ORIGIN_TOKEN}/b`), 'https://parlor.example///').toString('utf8');
    expect(out).toBe('a https://parlor.example/b');
  });
});
