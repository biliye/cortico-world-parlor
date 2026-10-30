/**
 * 网页客户端的静态文件。房主的客厅在香港，从国内拉一次 play.js（129KB）要七八秒；
 * 压完只有 30KB 左右，所以文本资源按文件压一次放内存，配上 ETag —— 第二次打开只回 304。
 */
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
  '.ico': 'image/x-icon',
};

/** 网页客户端只从本站取脚本、样式与接口；没有内联脚本。 */
export const PLAY_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** 这些类型压了有意义；webp/png 已经压过，再 gzip 只白花 CPU。 */
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.map']);

interface Asset {
  etag: string;
  body: Buffer;
  gzipped: Buffer;
}

/** 一个进程里每个文件只读一次盘、只压一次；文件换了（mtime/size 变了）就重来。 */
const assets = new Map<string, Asset>();

function loadAsset(rel: string): Asset {
  const file = new URL(`../web/${rel}`, import.meta.url);
  const info = statSync(file);
  const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const cached = assets.get(rel);
  if (cached && cached.etag === etag) return cached;
  const body = readFileSync(file);
  const asset: Asset = { etag, body, gzipped: gzipSync(body) };
  assets.set(rel, asset);
  return asset;
}

/** `gzip;q=0` 是不想要；`*` 也算接受。 */
function acceptsGzip(header: string | string[] | undefined): boolean {
  const raw = Array.isArray(header) ? header.join(',') : (header || '');
  for (const part of raw.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (name !== 'gzip' && name !== '*') continue;
    const q = params.map((piece) => piece.trim()).find((piece) => piece.startsWith('q='));
    if (!q) return true;
    if (Number.parseFloat(q.slice(2)) > 0) return true;
  }
  return false;
}

function etagMatches(header: string, etag: string): boolean {
  return header.split(',').some((item) => {
    const value = item.trim().replace(/^W\//, '');
    return value === '*' || value === etag;
  });
}

/**
 * 发一个 /play/assets/** 下的文件。找不到返回 false，由调用方决定怎么报 404。
 * 页面（play.html / parent.html）不缓存，资源缓存 5 分钟；两者都带 ETag，重开一次只是 304。
 */
export function sendWebAsset(
  rel: string,
  req: IncomingMessage,
  res: ServerResponse,
  page: boolean,
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
  const gzip = COMPRESSIBLE.has(ext) && acceptsGzip(req.headers['accept-encoding']);
  const etag = gzip ? asset.etag.replace(/"$/, '-gz"') : asset.etag;
  const cacheControl = page ? 'no-cache' : 'public, max-age=300';
  const headers: Record<string, string> = {
    etag,
    'cache-control': cacheControl,
    vary: 'accept-encoding',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(page ? { 'content-security-policy': PLAY_CSP } : {}),
  };

  const inm = req.headers['if-none-match'];
  if (inm && etagMatches(inm, etag)) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }

  const body = gzip ? asset.gzipped : asset.body;
  res.writeHead(200, {
    ...headers,
    'content-type': type ?? 'application/octet-stream',
    'content-length': body.length,
    ...(gzip ? { 'content-encoding': 'gzip' } : {}),
  });
  res.end(body);
  return true;
}
