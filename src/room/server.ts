/**
 * 客厅服务器：房间状态、席位令牌、SSE 推送、家长页。
 * 只发某席位能看见的事件；可见性判断全部来自 RoomKernel。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { RoomError, RoomKernel, type StoredSeat } from './kernel.ts';
import type { ActionRequest, JoinRequest, RoomEvent, RoomSnapshot } from './protocol.ts';

export interface ParlorServerOptions {
  id: string;
  inviteCode: string;
  maxSeats?: number;
  dataFile?: string;
  host?: string;
  port?: number;
  historyLimit?: number;
}

export interface ParlorAddress {
  url: string;
  host: string;
  port: number;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
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

const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const text = await readBody(req);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, '请求体不是 JSON 对象');
  }
};

const bearer = (req: IncomingMessage): string => {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};

const localUrlHost = (host: string): string => (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host);

interface Client {
  res: ServerResponse;
  seat: StoredSeat;
}

export class ParlorServer {
  readonly kernel: RoomKernel;
  private readonly options: ParlorServerOptions;
  private server?: Server;
  private address?: ParlorAddress;
  private readonly clients = new Set<Client>();
  private readonly online = new Map<string, number>();
  private readonly heartbeat: NodeJS.Timeout;
  private persistTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(options: ParlorServerOptions) {
    this.options = options;
    this.kernel = this.load(options);
    this.heartbeat = setInterval(() => this.ping(), 15_000);
    this.heartbeat.unref?.();
    this.kernel.onEvent((event) => {
      this.broadcast(event);
      this.schedulePersist();
    });
  }

  get url(): string {
    return this.address?.url ?? '';
  }

  async listen(): Promise<ParlorAddress> {
    if (this.address) return this.address;
    const host = this.options.host ?? '127.0.0.1';
    const port = this.options.port ?? 8790;
    const server = createServer((req, res) => {
      void this.route(req, res).catch((error: unknown) => this.fail(req, res, error));
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { server.off('listening', onListening); reject(error); };
      const onListening = (): void => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    const actual = server.address();
    const actualPort = typeof actual === 'object' && actual ? actual.port : port;
    this.address = { url: `http://${localUrlHost(host)}:${actualPort}`, host, port: actualPort };
    return this.address;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistNow();
    for (const client of this.clients) {
      try { client.res.end(); } catch { /* 已断开 */ }
    }
    this.clients.clear();
    this.online.clear();
    const server = this.server;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
  }

  /** 供测试与家长页使用：当前有推送连接的席位。 */
  onlineSeats(): string[] {
    return [...this.online.keys()];
  }

  private load(options: ParlorServerOptions): RoomKernel {
    const file = options.dataFile;
    if (!file || !existsSync(file)) {
      return new RoomKernel({
        id: options.id,
        inviteCode: options.inviteCode,
        maxSeats: options.maxSeats,
        historyLimit: options.historyLimit,
      });
    }
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      return RoomKernel.fromJSON(raw, {
        id: options.id,
        inviteCode: options.inviteCode,
        maxSeats: options.maxSeats,
        historyLimit: options.historyLimit,
      });
    } catch {
      return new RoomKernel({
        id: options.id,
        inviteCode: options.inviteCode,
        maxSeats: options.maxSeats,
        historyLimit: options.historyLimit,
      });
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://parlor.local');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      json(res, 200, {
        ok: true,
        room: this.kernel.id,
        seats: this.kernel.seatsPublic().length,
        maxSeats: this.kernel.maxSeats,
        latest: this.kernel.latest(),
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/join') {
      const body = await readJson(req);
      const invite = String(req.headers['x-parlor-invite'] ?? body.invite ?? '');
      if (!invite || invite !== this.options.inviteCode) throw new HttpError(403, '邀请码不对');
      try {
        const joined = this.kernel.join(body as unknown as JoinRequest);
        this.schedulePersist();
        json(res, 200, joined);
      } catch (error) {
        if (error instanceof RoomError) throw new HttpError(error.code === 'full' ? 409 : error.code === 'conflict' ? 409 : 400, error.message);
        throw error;
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/stream') {
      this.stream(req, res, url);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/room') {
      const auth = this.auth(req, url);
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      const limit = Number(url.searchParams.get('limit') ?? 30) || 30;
      const snapshot: RoomSnapshot = {
        ...this.kernel.snapshot(auth.seat.id, since, limit),
        seat: publicSeatOf(auth.seat),
        online: this.onlineSeats(),
      };
      json(res, 200, snapshot);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/history') {
      const auth = this.auth(req, url);
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      const limit = Number(url.searchParams.get('limit') ?? 30) || 30;
      json(res, 200, { latest: this.kernel.latest(), events: this.kernel.history(auth.seat.id, since, limit) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/action') {
      const auth = this.auth(req, url);
      const body = await readJson(req) as unknown as ActionRequest;
      if (auth.role === 'owner' && body.type !== 'set_tier') {
        throw new HttpError(403, '家长页目前只能改提醒挡位');
      }
      try {
        const seq = this.action(auth.seat, body);
        json(res, 200, { ok: true, seq });
      } catch (error) {
        if (error instanceof RoomError) throw new HttpError(error.code === 'not_found' ? 404 : 400, error.message);
        throw error;
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/owner') {
      const auth = this.auth(req, url);
      this.ownerPage(res, auth.seat);
      return;
    }
    throw new HttpError(404, '没有这个地址');
  }

  private auth(req: IncomingMessage, url: URL): { seat: StoredSeat; role: 'pet' | 'owner' } {
    const token = bearer(req) || url.searchParams.get('token') || '';
    const auth = this.kernel.authenticate(token);
    if (!auth) throw new HttpError(401, '令牌无效');
    return auth;
  }

  private action(seat: StoredSeat, body: ActionRequest): number {
    switch (body.type) {
      case 'say': return this.kernel.say(seat, body.text ?? '').seq;
      case 'whisper': return this.kernel.whisper(seat, body.to ?? '', body.text ?? '').seq;
      case 'set_tier': return this.kernel.setTier(seat, body.tier ?? 'digest') ? this.kernel.latest() : this.kernel.latest();
      default: throw new HttpError(400, '未知动作');
    }
  }

  private stream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const auth = this.auth(req, url);
    const since = Number(url.searchParams.get('since') ?? 0) || 0;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');
    for (const event of this.kernel.history(auth.seat.id, since, 200)) this.writeEvent(res, event);
    const client: Client = { res, seat: auth.seat };
    this.clients.add(client);
    this.online.set(auth.seat.id, (this.online.get(auth.seat.id) ?? 0) + 1);
    req.on('close', () => {
      this.clients.delete(client);
      const count = (this.online.get(auth.seat.id) ?? 1) - 1;
      if (count <= 0) this.online.delete(auth.seat.id);
      else this.online.set(auth.seat.id, count);
    });
  }

  private broadcast(event: RoomEvent): void {
    for (const client of this.clients) {
      if (!this.kernel.visibleTo(event, client.seat.id)) continue;
      this.writeEvent(client.res, event);
    }
  }

  private writeEvent(res: ServerResponse, event: RoomEvent): void {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    } catch { /* 连接已断 */ }
  }

  private ping(): void {
    for (const client of this.clients) {
      if (client.res.writableEnded || client.res.destroyed) continue;
      try { client.res.write(': ping\n\n'); } catch { /* 连接已断 */ }
    }
  }

  private ownerPage(res: ServerResponse, seat: StoredSeat): void {
    const html = ownerHtml(this.kernel.id, seat.name);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self'",
    });
    res.end(html);
  }

  private fail(req: IncomingMessage, res: ServerResponse, error: unknown): void {
    if (res.writableEnded || res.headersSent) return;
    if (error instanceof HttpError) {
      json(res, error.status, { error: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (req.url?.startsWith('/v1/stream')) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(message);
      return;
    }
    json(res, 500, { error: message });
  }

  private schedulePersist(): void {
    if (!this.options.dataFile || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistNow();
    }, 200);
    this.persistTimer.unref?.();
  }

  private persistNow(): void {
    const file = this.options.dataFile;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.kernel.toJSON())}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, file);
      chmodSync(file, 0o600);
    } catch { /* 持久化失败不阻断房间 */ }
  }
}

const publicSeatOf = (seat: StoredSeat): RoomSnapshot['seat'] => ({
  id: seat.id, name: seat.name, kind: seat.kind, tier: seat.tier, joinedAt: seat.joinedAt,
});

const ownerHtml = (room: string, seatName: string): string => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>客厅 · 家长页</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; background: #14161a; color: #e7e8ea; }
  header { padding: 18px 20px 10px; border-bottom: 1px solid #2a2d33; }
  h1 { margin: 0; font-size: 18px; font-weight: 600; }
  .sub { margin: 4px 0 0; color: #9aa0a6; font-size: 13px; }
  main { display: grid; grid-template-columns: 260px 1fr; gap: 20px; padding: 16px 20px 40px; }
  @media (max-width: 720px) { main { grid-template-columns: 1fr; } }
  h2 { font-size: 13px; color: #9aa0a6; font-weight: 600; margin: 0 0 8px; letter-spacing: .04em; }
  ul { list-style: none; margin: 0; padding: 0; }
  .seat { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 8px; background: #1b1e23; margin-bottom: 6px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #4a4f57; flex: 0 0 auto; }
  .dot.on { background: #3fb950; }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tier { color: #9aa0a6; font-size: 12px; }
  #log { list-style: none; margin: 0; padding: 0; }
  #log li { padding: 8px 10px; border-radius: 8px; background: #1b1e23; margin-bottom: 6px; white-space: pre-wrap; word-break: break-word; }
  #log li .who { color: #79c0ff; }
  #log li.whisper { background: #241f16; border: 1px solid #3d3320; }
  #log li.system { color: #9aa0a6; background: transparent; padding-left: 0; }
  .bar { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
  select, button { font: inherit; color: inherit; background: #22262c; border: 1px solid #363b43; border-radius: 7px; padding: 5px 8px; }
  button { cursor: pointer; }
  #error { color: #ff7b72; padding: 12px 20px; }
</style></head>
<body>
<header><h1>客厅 · ${escapeHtml(room)}</h1><p class="sub">家长页：公开的事，和自家孩子（${escapeHtml(seatName)}）的私聊。</p></header>
<div id="error" hidden></div>
<main>
  <section><h2>席位</h2><ul id="seats"></ul>
    <div class="bar"><span class="tier">自家提醒</span><select id="tier">
      <option value="full">热闹</option><option value="digest">摘要</option><option value="quiet">只 @</option><option value="off">离开</option>
    </select><button id="save">改</button></div>
  </section>
  <section><h2>消息</h2><ul id="log"></ul></section>
</main>
<script>
  const token = new URLSearchParams(location.search).get('token') || '';
  const headers = { authorization: 'Bearer ' + token };
  const error = document.getElementById('error');
  const seats = document.getElementById('seats');
  const log = document.getElementById('log');
  const tier = document.getElementById('tier');
  let latest = 0, mine = null;
  const showError = (text) => { error.hidden = false; error.textContent = text; };
  const line = (event) => {
    const li = document.createElement('li');
    if (event.type === 'parlor.whisper') li.className = 'whisper';
    if (event.from === 'system') li.className = 'system';
    if (event.type !== 'parlor.whisper' && event.from !== 'system') {
      const who = document.createElement('span'); who.className = 'who';
      who.textContent = (event.data && event.data.name ? event.data.name : event.from) + '：';
      li.append(who);
    }
    li.append(document.createTextNode(event.text));
    return li;
  };
  const addEvent = (event) => {
    if (event.seq <= latest) return;
    latest = event.seq;
    log.append(line(event));
    while (log.children.length > 300) log.firstElementChild.remove();
    window.scrollTo(0, document.body.scrollHeight);
  };
  const renderSeats = (snapshot) => {
    seats.textContent = '';
    for (const seat of snapshot.seats) {
      const li = document.createElement('li'); li.className = 'seat';
      const dot = document.createElement('span'); dot.className = 'dot' + (snapshot.online && snapshot.online.includes(seat.id) ? ' on' : '');
      const name = document.createElement('span'); name.className = 'name'; name.textContent = seat.name;
      const label = document.createElement('span'); label.className = 'tier';
      label.textContent = ({ full: '热闹', digest: '摘要', quiet: '只 @', off: '离开' })[seat.tier] || seat.tier;
      li.append(dot, name, label); seats.append(li);
      if (seat.id === snapshot.seat.id) { mine = seat; tier.value = seat.tier; }
    }
  };
  async function load() {
    const response = await fetch('/v1/room?limit=80', { headers });
    if (!response.ok) { showError('令牌无效，或房间已经重开。'); return; }
    const snapshot = await response.json();
    renderSeats(snapshot);
    latest = snapshot.latest;
    for (const event of snapshot.events) addEvent(event);
    const source = new EventSource('/v1/stream?since=' + latest + '&token=' + encodeURIComponent(token));
    source.onmessage = (message) => { try { addEvent(JSON.parse(message.data)); } catch {} };
    source.onerror = () => { /* 浏览器自动重连 */ };
  }
  document.getElementById('save').onclick = async () => {
    const response = await fetch('/v1/action', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'set_tier', tier: tier.value }),
    });
    if (!response.ok) { const body = await response.json().catch(() => ({})); showError(body.error || '改不了提醒挡位'); }
  };
  load().catch(() => showError('连不上房间。'));
</script>
</body></html>`;

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char] as string);
