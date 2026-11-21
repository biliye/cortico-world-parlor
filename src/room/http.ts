import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { gzipSync } from 'node:zlib';
import { acceptsGzip } from './web-assets.ts';

function canonicalIp(address: string): string | undefined {
  if (address.includes('%')) return;
  const version = isIP(address);
  if (version === 4) return address;
  if (version !== 6) return;
  const ip = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(ip);
  if (!mapped) return ip;
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

type ClientAddressRequest = Pick<IncomingMessage, 'headers'> & {
  socket: Pick<IncomingMessage['socket'], 'remoteAddress'>;
};

/** 仅接受同机可信反代追加的最后一个地址。 */
export const clientIp = (req: ClientAddressRequest, trustProxy: boolean): string => {
  const peer = canonicalIp(req.socket.remoteAddress ?? '') ?? 'unknown';
  if (trustProxy && (peer === '::1' || peer.startsWith('127.'))) {
    const forwarded = headerValue(req, 'x-forwarded-for').split(',').at(-1)?.trim() ?? '';
    const ip = canonicalIp(forwarded);
    if (ip) return ip;
  }
  return peer;
};

/** IPv4 按地址计量，IPv6 将同一 /64 内的地址合用一个额度。 */
export const clientIpRateKey = (req: ClientAddressRequest, trustProxy: boolean): string => {
  const ip = clientIp(req, trustProxy);
  if (!ip.includes(':')) return ip;
  const [prefix, suffix] = ip.split('::');
  const leading = prefix ? prefix.split(':') : [];
  if (leading.length >= 4) return `${leading.slice(0, 4).join(':')}::/64`;
  const trailing = suffix ? suffix.split(':') : [];
  const parts = [...leading, ...Array<string>(8 - leading.length - trailing.length).fill('0'), ...trailing];
  return `${parts.slice(0, 4).join(':')}::/64`;
};

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

export const json = (res: ServerResponse, status: number, body: unknown, req?: IncomingMessage): void => {
  const raw = Buffer.from(JSON.stringify(body));
  // 回放/补档的大段文本可压缩；未接受 gzip 的旧客户端仍收到普通 JSON。
  const gzip = req && raw.length >= 1024 && acceptsGzip(req.headers['accept-encoding']);
  const data = gzip ? gzipSync(raw) : raw;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    ...(req ? { vary: 'accept-encoding' } : {}),
    ...(gzip ? { 'content-encoding': 'gzip' } : {}),
  });
  res.end(data);
};

const readBody = (req: IncomingMessage, limit = 64 * 1024): Promise<string> => new Promise((resolve, reject) => {
  let size = 0;
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > limit) {
      reject(new HttpError(413, '请求体太大'));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

export const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const text = await readBody(req);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, '请求体不是 JSON 对象');
  }
};

export const bearer = (req: IncomingMessage): string => {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};

export const headerValue = (req: Pick<IncomingMessage, 'headers'>, name: string): string => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
};
