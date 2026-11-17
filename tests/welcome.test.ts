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
import { describe, expect, it } from 'vitest';
import { fillOrigin, isPublicAsset, ORIGIN_TOKEN, sendWebAsset } from '../src/room/web-assets.ts';

const web = new URL('../src/web/', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const read = (file: string) => readFileSync(new URL(file, web), 'utf8');
const page = read('welcome.html');
/** 注释里会提到 <style>、CSP 这类字样，和 check-release 一样先剥掉注释再判。 */
const markup = page.replace(/<!--[\s\S]*?-->/g, '');
const assetRefs = [...page.matchAll(/(?:src|href)="(\/welcome\/assets\/[^"]*)"/g)].map(([, url]) => url);

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

  it('门面通往登录及一次性邀请，并说明 Coo 直接进场', () => {
    expect(page).toContain('href="/play?entry=login"');
    expect(page).toContain('href="/play?entry=guest"');
    expect(page).toContain('点「我下场玩」');
    expect(page).toContain('试玩客厅玩 24 小时');
    // 反馈与公告用的是「当前浏览器」里的客厅席位令牌，加入客厅就发了，不需要上桌。
    expect(page).toContain('要先用当前浏览器加入客厅才能打开');
    expect(page).toContain('反馈与公告（需先加入客厅）');
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
