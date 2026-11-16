/**
 * 网页客户端的静态文件。房主的客厅在香港，从国内拉一次网页脚本要七八秒；
 * 压完只有 30KB 左右，所以文本资源按文件压一次放内存，配上 ETag —— 第二次打开只回 304。
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';

export const WEB_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.ico': 'image/x-icon',
};

/** 网页客户端只从本站取脚本、样式与接口；没有内联脚本。 */
export const PLAY_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** 这些类型压了有意义；webp/png 已经压过，再 gzip 只白花 CPU。 */
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.map', '.txt', '.xml']);

/**
 * 能从 `/xxx/assets/**` 直接取的只有资源本身。
 * 页面模板（.html）与对外页专属文本（robots.txt / sitemap.xml）必须走各自的路由：
 * 前者要带 CSP 与 no-cache，后者要把 `{{origin}}` 换成实例地址 —— 挪到 assets 下这两件事都会掉，
 * 还会把没替换过的模板当成静态文件发出去。
 */
const PUBLIC_ASSETS = new Set(['.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff2', '.ico']);

/** 这个文件名能不能当静态资源发（不看文件在不在）。 */
export function isPublicAsset(rel: string): boolean {
  const dot = rel.lastIndexOf('.');
  return dot >= 0 && PUBLIC_ASSETS.has(rel.slice(dot).toLowerCase());
}


/**
 * 对外页里的占位符：发出去之前换成实例的公开地址。
 * 分享卡片（og:image / og:url）、canonical、robots 与 sitemap 都要求绝对 URL，
 * 而自建客厅的域名各不相同，所以不能写死在文件里。
 */
export const ORIGIN_TOKEN = '{{origin}}';

/** 把 `{{origin}}` 换成实例地址（去掉末尾斜杠）；其余内容原样保留。 */
export function fillOrigin(body: Buffer, origin: string): Buffer {
  return Buffer.from(body.toString('utf8').replaceAll(ORIGIN_TOKEN, origin.replace(/\/+$/, '')), 'utf8');
}

interface Asset {
  /** 缓存判据：大小 / mtime / inode 任一变了就重读。npm 包里 mtime 是固定的 1985，inode 是唯一可靠的信号。 */
  stamp: string;
  etag: string;
  body: Buffer;
  gzipped: Buffer;
}

/** 一个进程里每个文件只读一次盘、只压一次；文件换了就重来。 */
const assets = new Map<string, Asset>();

/** 内容指纹。npm 打包会把 mtime 抹平，同长度的改动只能靠内容认出来。 */
function digest(body: Buffer): string {
  return `"${createHash('sha1').update(body).digest('base64url').slice(0, 18)}"`;
}

function loadAsset(rel: string): Asset {
  const file = new URL(`../web/${rel}`, import.meta.url);
  const info = statSync(file);
  const stamp = `${info.size}:${Math.floor(info.mtimeMs)}:${info.ino}`;
  const cached = assets.get(rel);
  if (cached && cached.stamp === stamp) return cached;
  const body = readFileSync(file);
  const etag = digest(body);
  // 字体这类已经压过的二进制不再 gzip：省下的那份内存和首次请求的 CPU 都是白花的。
  const dot = rel.lastIndexOf('.');
  const ext = dot >= 0 ? rel.slice(dot).toLowerCase() : '';
  const gzipped = COMPRESSIBLE.has(ext) ? gzipSync(body) : body;
  const asset: Asset = { stamp, etag, body, gzipped };
  assets.set(rel, asset);
  return asset;
}

/** `gzip;q=0` 是不想要；`*` 也算接受。 */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  const raw = Array.isArray(header) ? header.join(',') : (header || '');
  let wildcard = false;
  for (const part of raw.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (name !== 'gzip' && name !== '*') continue;
    const q = params.map((piece) => piece.trim()).find((piece) => piece.startsWith('q='));
    const accepted = !q || Number(q.slice(2)) > 0;
    // 明确 gzip;q=0 优先于通配符，不能把客户端拒绝的编码发回去。
    if (name === 'gzip') return accepted;
    wildcard = accepted;
  }
  return wildcard;
}

function etagMatches(header: string, etag: string): boolean {
  return header.split(',').some((item) => {
    const value = item.trim().replace(/^W\//, '');
    return value === '*' || value === etag;
  });
}

/**
 * 发一个 /play/assets/**、/parent/assets/**、/welcome/assets/** 下的文件。
 * 找不到返回 false，由调用方决定怎么报 404。
 * 页面（play.html / parent.html / welcome.html）不缓存，资源缓存 5 分钟；两者都带 ETag，重开一次只是 304。
 *
 * `transform` 给对外页用：它要把页面里的 `{{origin}}` 换成实例的公开地址（分享卡片要绝对 URL）。
 * 传了 transform 就按改写后的内容重算 ETag 和 gzip，避免把「原文的指纹」发给改写后的正文。
 *
 * `noindex` 给牌桌/家长页这类私人页面用：用响应头告诉搜索引擎别收录。
 * 不能只靠 robots.txt 的 Disallow —— 那样爬虫根本抓不到页面，也就读不到这个头，
 * 而首页又直接链到 /play，结果可能只剩一个没描述的网址被收进去。
 */
export function sendWebAsset(
  rel: string,
  req: IncomingMessage,
  res: ServerResponse,
  page: boolean,
  transform?: (body: Buffer) => Buffer,
  noindex = false,
): boolean {
  let asset: Asset;
  try {
    asset = loadAsset(rel);
  } catch {
    return false;
  }
  const dot = rel.lastIndexOf('.');
  const ext = dot >= 0 ? rel.slice(dot).toLowerCase() : '';
  const type = WEB_TYPES[ext];
  const compressible = COMPRESSIBLE.has(ext);
  const source = transform ? transform(asset.body) : asset.body;
  const baseEtag = transform ? digest(source) : asset.etag;
  const gzip = compressible && acceptsGzip(req.headers['accept-encoding']);
  const etag = gzip ? baseEtag.replace(/"$/, '-gz"') : baseEtag;
  const cacheControl = page ? 'no-cache' : 'public, max-age=300';
  const headers: Record<string, string> = {
    etag,
    'cache-control': cacheControl,
    vary: 'accept-encoding',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(page ? { 'content-security-policy': PLAY_CSP } : {}),
    ...(noindex ? { 'x-robots-tag': 'noindex' } : {}),
  };

  const inm = req.headers['if-none-match'];
  if (inm && etagMatches(inm, etag)) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }

  const body = gzip ? (transform ? gzipSync(source) : asset.gzipped) : source;
  res.writeHead(200, {
    ...headers,
    'content-type': type ?? 'application/octet-stream',
    'content-length': body.length,
    ...(gzip ? { 'content-encoding': 'gzip' } : {}),
  });
  res.end(body);
  return true;
}
