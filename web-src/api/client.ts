/** 网络层：与旧 play.js 同一套请求形状、同一套令牌与错误字段。 */
import { currentRoom, saveSeat, seat } from '../stores/session.ts';
import { seatTokenFrom } from '../lib/seat-errors.ts';
import { parentPlayBody, parseEntryKey } from '../lib/entry.ts';
import type { ParentPlayBody } from '../lib/entry.ts';
import type { Health, JoinResult } from './types.ts';

export { parentPlayBody, parseEntryKey };
export type { ParentPlayBody };

export class ApiError extends Error {
  status: number;
  seatToken: string;

  constructor(message: string, status: number, seatToken: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.seatToken = seatToken;
  }
}

/**
 * 身份票据或回跳凭据本身失效：重试不会变好，只能回上一页重新点一次入场。
 * 网络失败（断网、超时）不走这个类型——那种要保留票据让「再试一次」继续用。
 */
export class IdentityExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityExpiredError';
  }
}

/** 单客厅接口改走 /v1/rooms/:id/...；信箱顺带取全局（跨厅邀请在里面）。 */
export function roomPath(path: string): string {
  const room = currentRoom();
  if (!room) return path;
  const [base, query] = path.split('?');
  const match = /^\/v1\/(room|table|action|mail|replay|history|stream)$/.exec(base || '');
  if (!match) return path;
  let q = query || '';
  if (match[1] === 'mail' && !/(^|&)all=/.test(q)) q = q ? q + '&all=1' : 'all=1';
  return '/v1/rooms/' + encodeURIComponent(room) + '/' + match[1] + (q ? '?' + q : '');
}

/** 普通接口 25 秒没回话就当超时；首屏卡住时能自己走到「重试」，而不是一直转。 */
function timeoutSignal(): AbortSignal | undefined {
  if (typeof AbortSignal === 'undefined' || !AbortSignal.timeout) return undefined;
  return AbortSignal.timeout(25_000);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers || {});
  const cfg = seat.value;
  if (cfg) {
    headers.set('authorization', 'Bearer ' + cfg.token);
    if (cfg.cooSecret !== 'seat-only') {
      headers.set('x-parlor-coo', cfg.cooId);
      headers.set('x-parlor-coo-secret', cfg.cooSecret);
    }
  }
  const response = await send(path, init, headers);
  return read<T>(response, headers);
}

/**
 * 单客厅服务器（serve.ts）只认 /v1/... 别名，没有 /v1/rooms/:id/... 这组路径。
 * 用 healthz 有没有 rooms 字段判断能力，不靠 404 猜——否则房间真被删掉时
 * 会悄悄拿到默认客厅的数据。
 */
let scopedPaths: boolean | null = null;
let scopedTask: Promise<boolean> | undefined;

async function send(path: string, init: RequestInit, headers: Headers): Promise<Response> {
  const room = currentRoom();
  // 位置、目录、切厅等全局/显式房间接口无需能力探测，直接发出。
  const candidate = roomPath(path);
  const scoped = room && candidate !== path && (await supportsScopedPaths()) ? candidate : path;
  const request = fetch(scoped, { ...init, headers, signal: init.signal ?? timeoutSignal() });
  // 全局请求先发出，顺便预热后续快照的能力探测，二者并行。
  if (room && candidate === path && scopedPaths === null) void supportsScopedPaths();
  return request;
}

async function supportsScopedPaths(): Promise<boolean> {
  if (scopedPaths !== null) return scopedPaths;
  if (scopedTask) return scopedTask;
  scopedTask = (async () => {
    const health = await fetchHealth();
    if (!health) return !!currentRoom();
    scopedPaths = typeof health.rooms === 'number';
    return scopedPaths;
  })().finally(() => { scopedTask = undefined; });
  return scopedTask;
}

/** SSE 这类不走 api() 的地址也用它：能力还没探到时按「有房间号」处理，真服务器不会错。 */
export function scopedPath(path: string): string {
  return currentRoom() && scopedPaths !== false ? roomPath(path) : path;
}

async function read<T>(response: Response, headers: Headers): Promise<T> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string')
      ? body.error
      : '请求失败（' + response.status + '）';
    throw new ApiError(message, response.status, seatTokenFrom(headers));
  }
  return body as T;
}

let healthTask: Promise<Health | null> | undefined;

export function fetchHealth(): Promise<Health | null> {
  healthTask ??= fetch('/healthz', { signal: timeoutSignal() })
    .then(response => response.ok ? response.json() as Promise<Health> : null)
    .catch(() => null)
    .finally(() => { healthTask = undefined; });
  return healthTask;
}

/** 普通入场：邀请码放在请求头，名字放在正文。统一身份在时由调用方走跳转流程。 */
export async function joinPlayer(name: string, invite: string, room = ''): Promise<void> {
  const response = await fetch('/v1/player/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-parlor-invite': invite },
    body: JSON.stringify({ name, ...(room ? { room } : {}) }),
    signal: timeoutSignal(),
  });
  const body = await response.json().catch(() => ({})) as Partial<JoinResult> & { error?: string };
  if (!response.ok) throw new Error(body.error || '加入失败');
  const joined = body as JoinResult;
  saveSeat({
    room: joined.room,
    seatId: joined.seat.id,
    name: joined.seat.name,
    token: joined.token,
    cooId: joined.identity.cooId,
    cooSecret: joined.identity.cooSecret,
  });
}

/** 统一身份：跳去身份服务，回来时带 #identity=…&state=…。 */
export function beginGlobalEntry(authority: string, input: { invite?: string; name?: string; room?: string; parent?: boolean }): void {
  const target = new URL(authority);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && local)) throw new Error('身份服务需要 HTTPS');
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  sessionStorage.setItem('parlor-identity-pending', JSON.stringify({ ...input, state: nonce }));
  target.pathname = '/identity';
  target.search = new URLSearchParams({
    returnTo: location.origin + location.pathname + location.search,
    state: nonce,
    name: input.name || '',
  }).toString();
  location.assign(target.href);
}

/** 统一身份回跳：用地址栏里的票据换席位。 */
export async function finishGlobalEntry(ticket: string, state: string): Promise<void> {
  const pending = JSON.parse(sessionStorage.getItem('parlor-identity-pending') || 'null');
  if (!pending || pending.state !== state) throw new IdentityExpiredError('这次的身份连接已失效，请回上一页重新点一次入场');
  let body: JoinResult;
  try {
    body = await api<JoinResult>('/v1/global/player/join', {
      method: 'POST',
      headers: { 'x-parlor-identity': ticket },
      body: JSON.stringify({ invite: pending.invite, room: pending.room || 'hall', parent: pending.parent === true }),
    });
  } catch (error) {
    // 401 / 403 是票据被拒（过期、换过设备、家长链接不放行）：重试只会拿到同一句。
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      throw new IdentityExpiredError('这次的身份票据已经失效，请回上一页重新点一次入场');
    }
    throw error;
  }
  sessionStorage.removeItem('parlor-identity-pending');
  saveSeat({
    room: body.room,
    seatId: body.seat.id,
    name: body.seat.name,
    token: body.token,
    cooId: body.identity.cooId,
    cooSecret: body.identity.cooSecret,
  });
}

/** 从 #key=… 取一次性钥匙；取到就从地址栏抹掉（不进历史，也不会被复制外发）。 */
export function takeKeyFromHash(): string {
  const key = parseEntryKey(location.hash);
  if (key) history.replaceState(null, '', location.pathname + location.search);
  return key;
}

export interface ParentPlayResult {
  globalEntry?: string;
  room?: string;
  seat?: { id: string; name: string };
  token?: string;
  identity?: { cooId: string; cooSecret: string };
}

/**
 * 家长下场：带钥匙时一次做完「换会话 + 领席位」；不带钥匙就用这台浏览器已有的家长会话。
 * 需要统一身份时回 globalEntry，由调用方跳转。
 */
export async function parentPlay(key = '', room = ''): Promise<ParentPlayResult> {
  const response = await fetch('/v1/parent/play', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(parentPlayBody(key, room)),
    signal: timeoutSignal(),
  });
  const body = await response.json().catch(() => ({})) as ParentPlayResult & { error?: string };
  if (!response.ok) throw new Error(body.error || (key ? '这个家长链接不对，或已经失效了' : '现在下不了场'));
  if (body.globalEntry) return body;
  if (!body.seat || !body.token || !body.identity || !body.room) throw new Error('家长下场没有换到席位');
  saveSeat({
    room: body.room,
    seatId: body.seat.id,
    name: body.seat.name,
    token: body.token,
    cooId: body.identity.cooId,
    cooSecret: body.identity.cooSecret,
  });
  return body;
}
