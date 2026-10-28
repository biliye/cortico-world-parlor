/**
 * 客厅服务器：房间状态、席位令牌、SSE 推送、家长页。
 * 只发某席位能看见的事件；可见性判断全部来自 RoomKernel。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { COO_HEADER, COO_SECRET_HEADER, type CooIdentity } from './identity.ts';
import { GAME_LABELS } from './game-labels.ts';
import { RoomError, RoomKernel, type StoredSeat } from './kernel.ts';
import { LedgerStore } from './ledger.ts';
import { MailStore } from './mail.ts';
import { REPLAY_RETENTION_DAYS, ReplayStore } from './replay.ts';
import { serverClock } from './clock.ts';
import type {
  ActionRequest, ActionResponse, JoinRequest, JoinResponse, PlayerJoinResponse, RoomEvent, RoomSnapshot,
} from './protocol.ts';

export interface ParlorServerOptions {
  id: string;
  inviteCode: string;
  maxSeats?: number;
  dataFile?: string;
  host?: string;
  port?: number;
  historyLimit?: number;
  /** 牌桌每次行动的时限；测试里可以调短。 */
  tableTurnMs?: number;
  /** 账本文件；不填时与 dataFile 同目录的 ledger.json。 */
  ledgerFile?: string;
  /** 信箱文件；不填时与 dataFile 同目录的 mail.json。 */
  mailFile?: string;
  /** 回放文件；不填时与 dataFile 同目录的 replay.jsonl。 */
  replayFile?: string;
  /** 大富翁活动存档；不填时与 dataFile 同目录的 activity.json。 */
  activityFile?: string;
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

const roomStatus = (error: RoomError): number => (
  error.code === 'not_found' ? 404
    : error.code === 'forbidden' ? 403
      : error.code === 'conflict' || error.code === 'full' ? 409
        : 400
);

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

const headerValue = (req: IncomingMessage, name: string): string => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
};

const identityOf = (req: IncomingMessage): CooIdentity | null => {
  const cooId = headerValue(req, COO_HEADER).trim();
  const cooSecret = headerValue(req, COO_SECRET_HEADER).trim();
  return cooId && cooSecret ? { cooId, cooSecret } : null;
};

const localUrlHost = (host: string): string => (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host);

/** 从包里读一次版本，给 `/healthz` 报，排障时不用再 SSH 翻 package.json。 */
const PACKAGE_VERSION = ((): string => {
  try {
    const raw = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof raw.version === 'string' ? raw.version : '';
  } catch {
    return '';
  }
})();

const WEB_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 网页客户端只从本站取脚本、样式与接口；没有内联脚本。 */
const PLAY_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

interface Client {
  res: ServerResponse;
  seat: StoredSeat;
  role: 'pet' | 'owner';
}

export class ParlorServer {
  readonly kernel: RoomKernel;
  readonly ledger: LedgerStore;
  readonly mail: MailStore;
  readonly replay: ReplayStore;
  private readonly options: ParlorServerOptions;
  private server?: Server;
  private address?: ParlorAddress;
  private readonly clients = new Set<Client>();
  private readonly online = new Map<string, number>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly tableClock: NodeJS.Timeout;
  private persistTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(options: ParlorServerOptions) {
    this.options = options;
    this.ledger = LedgerStore.load({
      file: options.ledgerFile ?? (options.dataFile ? join(dirname(options.dataFile), 'ledger.json') : undefined),
    });
    this.mail = MailStore.load({
      file: options.mailFile ?? (options.dataFile ? join(dirname(options.dataFile), 'mail.json') : undefined),
    });
    this.replay = ReplayStore.load({
      file: options.replayFile ?? (options.dataFile ? join(dirname(options.dataFile), 'replay.jsonl') : undefined),
    });
    this.kernel = this.load(options);
    // 房间数据被清空重建时，游标会从头开始，旧回放的序号对不上：整份作废。
    if (this.kernel.roomEvents().length === 0) this.replay.reset();
    // 崩溃/重启后，房间数据里还留着的事件补进回放（按 seq 去重）。
    this.replay.seed(this.kernel.roomEvents());
    this.heartbeat = setInterval(() => this.ping(), 15_000);
    this.heartbeat.unref?.();
    this.tableClock = setInterval(() => {
      try {
        this.kernel.tickTable(Date.now());
        this.kernel.expireLedger(Date.now());
        this.kernel.refillLedger(Date.now());
      } catch { /* 一局坏掉不影响房间 */ }
    }, 1000);
    this.tableClock.unref?.();
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
    clearInterval(this.tableClock);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistNow();
    this.ledger.flush();
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
    const common = {
      id: options.id,
      inviteCode: options.inviteCode,
      maxSeats: options.maxSeats,
      historyLimit: options.historyLimit,
      tableTurnMs: options.tableTurnMs,
      ledger: this.ledger,
      mail: this.mail,
      replay: this.replay,
      activityFile: options.activityFile
        ?? (options.dataFile ? join(dirname(options.dataFile), 'activity.json') : undefined),
    };
    const file = options.dataFile;
    if (!file || !existsSync(file)) return new RoomKernel(common);
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      return RoomKernel.fromJSON(raw, common);
    } catch {
      return new RoomKernel(common);
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://parlor.local');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      json(res, 200, {
        ok: true,
        room: this.kernel.id,
        version: PACKAGE_VERSION,
        seats: this.kernel.seatsPublic().length,
        maxSeats: this.kernel.maxSeats,
        latest: this.kernel.latest(),
        replay: this.replay.count(),
      });
      return;
    }
    if (req.method === 'GET' && this.serveWeb(url.pathname, res)) return;
    if (req.method === 'POST' && url.pathname === '/v1/join') {
      const body = await readJson(req);
      const invite = String(req.headers['x-parlor-invite'] ?? body.invite ?? '');
      if (!invite || invite !== this.options.inviteCode) throw new HttpError(403, '邀请码不对');
      const identity = identityOf(req);
      let cooId: string | undefined;
      if (identity) {
        const claim = this.ledger.claimIdentity(identity.cooId, identity.cooSecret);
        if (claim === 'mismatch') throw new HttpError(409, '这个账本身份已经被占用了');
        if (claim === 'invalid') throw new HttpError(400, '账本身份格式不对');
        cooId = identity.cooId;
      }
      try {
        const joined = this.kernel.join(body as unknown as JoinRequest, cooId);
        this.schedulePersist();
        json(res, 200, joined);
      } catch (error) {
        if (error instanceof RoomError) throw new HttpError(roomStatus(error), error.message);
        throw error;
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/player/join') {
      const body = await readJson(req);
      const invite = headerValue(req, 'x-parlor-invite').trim() || String(body.invite ?? '');
      if (!invite || invite !== this.options.inviteCode) throw new HttpError(403, '邀请码不对');
      const name = typeof body.name === 'string' ? body.name : '';
      const cooId = randomUUID();
      const cooSecret = randomBytes(32).toString('base64url');
      if (this.ledger.claimIdentity(cooId, cooSecret) !== 'ok') {
        throw new HttpError(500, '给这位家长生成账本身份失败（身份表满了）');
      }
      let joined: JoinResponse;
      try {
        joined = this.kernel.join({ name, kind: 'human', tier: 'off' }, cooId);
      } catch (error) {
        if (error instanceof RoomError) throw new HttpError(roomStatus(error), error.message);
        throw error;
      }
      this.schedulePersist();
      const response: PlayerJoinResponse = {
        room: joined.room,
        seat: joined.seat,
        token: joined.token,
        maxSeats: joined.maxSeats,
        identity: { cooId, cooSecret },
      };
      json(res, 200, response);
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
      const base = this.kernel.snapshot(auth.seat.id, since, limit);
      const hidden = auth.role === 'owner' && this.ownerPrivateHidden();
      const snapshot: RoomSnapshot = {
        ...base,
        ...(hidden ? { events: this.withoutPrivateTurns(base.events), tablePrivate: null } : {}),
        seat: publicSeatOf(auth.seat),
        online: this.onlineSeats(),
        ...(hidden ? { ownerPrivateHidden: true } : {}),
      };
      json(res, 200, snapshot);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/history') {
      const auth = this.auth(req, url);
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      const limit = Number(url.searchParams.get('limit') ?? 30) || 30;
      const events = this.kernel.history(auth.seat.id, since, limit);
      const hidden = auth.role === 'owner' && this.ownerPrivateHidden();
      json(res, 200, {
        latest: this.kernel.latest(),
        events: hidden ? this.withoutPrivateTurns(events) : events,
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/mail') {
      const auth = this.auth(req, url);
      const limit = Number(url.searchParams.get('limit') ?? 10) || 10;
      const unread = this.kernel.mailUnread(auth.seat);
      const hidden = auth.role === 'owner' && this.ownerPrivateHidden();
      if (auth.role === 'owner' && url.searchParams.get('recent') !== '1') {
        throw new HttpError(403, '家长页只能看最近几封；读信是孩子自己的动作');
      }
      if (url.searchParams.get('recent') === '1') {
        const items = this.kernel.mailRecent(auth.seat, limit);
        json(res, 200, {
          unread,
          remaining: unread,
          items: hidden ? items.filter((item) => item.action !== 'mail-turn') : items,
          marked: false,
          ...(hidden ? { ownerPrivateHidden: true } : {}),
        });
        return;
      }
      const peek = url.searchParams.get('peek') === '1';
      json(res, 200, this.kernel.readMail(auth.seat, limit, !peek));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/replay') {
      const auth = this.auth(req, url);
      const limit = Number(url.searchParams.get('limit') ?? 100) || 100;
      const before = Number(url.searchParams.get('before') ?? 0) || 0;
      const page = this.replay.page(auth.seat.id, limit, before || undefined);
      const now = this.kernel.nowMs();
      const hidden = auth.role === 'owner' && this.ownerPrivateHidden();
      json(res, 200, {
        room: this.kernel.id,
        latest: this.kernel.latest(),
        now,
        at: serverClock(now),
        retentionDays: REPLAY_RETENTION_DAYS,
        events: hidden ? this.withoutPrivateTurns(page.events) : page.events,
        older: page.older,
        ...(hidden ? { ownerPrivateHidden: true } : {}),
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/action') {
      const auth = this.auth(req, url);
      const body = await readJson(req) as unknown as ActionRequest;
      if (auth.role === 'owner' && body.type !== 'set_tier') {
        throw new HttpError(403, '家长页目前只能改提醒挡位');
      }
      try {
        const receipt = this.action(auth.seat, body);
        json(res, 200, { ok: true, ...receipt });
      } catch (error) {
        if (error instanceof RoomError) throw new HttpError(roomStatus(error), error.message);
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
    if (auth.role === 'pet') this.bindIdentity(req, auth.seat);
    return auth;
  }

  /** 老席位第一次带 cooId 来时把它绑上；已经是真身份的就只补发筹码。 */
  private bindIdentity(req: IncomingMessage, seat: StoredSeat): void {
    const identity = identityOf(req);
    if (!identity) return;
    const claim = this.ledger.claimIdentity(identity.cooId, identity.cooSecret);
    if (claim !== 'ok') return;
    if (seat.cooId && !seat.cooId.startsWith('legacy:')) {
      // 老座位在 0.6.0 之前就绑过身份：补上第一次进房的筹码。
      this.ledger.ensureGrant(identity.cooId, this.kernel.id);
      return;
    }
    if (this.kernel.bindCooId(seat, identity.cooId)) this.schedulePersist();
  }

  /**
   * 家长下场玩时，家长页要只看公开桌面。
   * 判据不用绑定「哪个真人是谁」：只要正在进行的桌上坐着任何真人席位，就藏。
   * 这样朋友下场时也不会漏；代价是桌前没有真人时会照旧显示她的私视图。
   */
  private ownerPrivateHidden(): boolean {
    const table = this.kernel.tablePublic();
    if (!table || table.status === 'open' || table.status === 'ended') return false;
    const raw = (table as { seats?: unknown }).seats;
    if (!Array.isArray(raw)) return false;
    const ids = new Set<string>();
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const id = (entry as { id?: unknown }).id;
      if (typeof id === 'string') ids.add(id);
    }
    if (ids.size === 0) return false;
    return this.kernel.seatsPublic().some((entry) => entry.kind === 'human' && ids.has(entry.id));
  }

  /** 私牌事件只给本人的私视图；家长页在对打期间连日志里也不给。 */
  private withoutPrivateTurns<T extends { type: string }>(events: T[]): T[] {
    return events.filter((event) => event.type !== 'parlor.table.turn');
  }

  /** 网页客户端的静态文件：/play 与 /play/assets/**。 */
  private serveWeb(pathname: string, res: ServerResponse): boolean {
    if (pathname === '/play' || pathname === '/play/') {
      this.sendWeb('play.html', res, true);
      return true;
    }
    const prefix = '/play/assets/';
    if (!pathname.startsWith(prefix)) return false;
    const rel = pathname.slice(prefix.length);
    if (!rel || rel.startsWith('/') || rel.includes('..') || rel.includes('\\')
      || !/^[A-Za-z0-9._/-]+$/.test(rel)) {
      throw new HttpError(404, '没有这个文件');
    }
    this.sendWeb(rel, res, false);
    return true;
  }

  private sendWeb(rel: string, res: ServerResponse, page: boolean): void {
    let body: Buffer;
    try {
      body = readFileSync(new URL(`../web/${rel}`, import.meta.url));
    } catch {
      throw new HttpError(404, '没有这个文件');
    }
    const dot = rel.lastIndexOf('.');
    const type = dot >= 0 ? WEB_TYPES[rel.slice(dot).toLowerCase()] : undefined;
    res.writeHead(200, {
      'content-type': type ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...(page ? { 'content-security-policy': PLAY_CSP } : {}),
    });
    res.end(body);
  }

  private action(seat: StoredSeat, body: ActionRequest): Omit<ActionResponse, 'ok'> {
    let delivered: ActionResponse['delivered'];
    let seats: ActionResponse['seats'];
    let deadline: number | undefined;
    let turn: string | undefined;
    let text: string | undefined;
    switch (body.type) {
      case 'say': this.kernel.say(seat, body.text); break;
      case 'whisper': delivered = this.kernel.whisper(seat, body.to, body.text).delivered; break;
      case 'set_tier': this.kernel.setTier(seat, body.tier); break;
      case 'gift': delivered = this.kernel.gift(seat, body.to, body.text, body.chips).delivered; break;
      case 'promise': delivered = this.kernel.promise(seat, body.to, body.text, body.due, body.chips).delivered; break;
      case 'respond': delivered = this.kernel.respond(seat, body.id, body.action).delivered; break;
      case 'table_open': this.kernel.openTable(seat, body.game, body.stake); break;
      case 'table_join': this.kernel.joinTable(seat); break;
      case 'table_start': {
        const receipt = this.kernel.startTable(seat);
        seats = receipt.seats;
        deadline = receipt.deadline;
        turn = receipt.turn;
        break;
      }
      case 'table_action': {
        const receipt = this.kernel.tableAction(seat, { type: body.action, die: body.die });
        deadline = receipt.deadline;
        turn = receipt.turn;
        break;
      }
      case 'ddz_action': {
        const receipt = this.kernel.ddzAction(seat, { move: body.move, call: body.call, cards: body.cards });
        deadline = receipt.deadline;
        turn = receipt.turn;
        break;
      }
      case 'monopoly': {
        const receipt = this.kernel.monopolyAction(seat, body);
        seats = receipt.seats;
        deadline = receipt.deadline;
        turn = receipt.turn;
        text = receipt.text;
        break;
      }
      default: throw new HttpError(400, '未知动作');
    }
    const ts = this.kernel.nowMs();
    return {
      seq: this.kernel.latest(),
      ts,
      at: serverClock(ts),
      ...(delivered && delivered.length > 0 ? { delivered } : {}),
      ...(seats ? { seats } : {}),
      ...(deadline ? { deadline, deadlineAt: serverClock(deadline) } : {}),
      ...(turn ? { turn } : {}),
      ...(text ? { text } : {}),
    };
  }

  private stream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const auth = this.auth(req, url);
    const since = Number(url.searchParams.get('since') ?? 0) || 0;
    const hidden = auth.role === 'owner' && this.ownerPrivateHidden();
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');
    for (const event of this.kernel.history(auth.seat.id, since, 200)) {
      if (hidden && event.type === 'parlor.table.turn') continue;
      this.writeEvent(res, event);
    }
    const client: Client = { res, seat: auth.seat, role: auth.role };
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
      if (client.role === 'owner' && event.type === 'parlor.table.turn' && this.ownerPrivateHidden()) {
        continue;
      }
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
  #ledger .entry, #replay .entry { padding: 7px 10px; border-radius: 8px; background: #1b1e23; margin-bottom: 6px; color: #c9ccd1; font-size: 13px; white-space: pre-wrap; word-break: break-word; }
  #ledger .tier, #replay .tier { margin: 8px 0 4px; }
  #table .entry, #table .tier, #table .title, #table .note { padding: 7px 10px; border-radius: 8px; background: #1b1e23; margin-bottom: 6px; color: #c9ccd1; font-size: 13px; white-space: pre-wrap; word-break: break-word; }
  #table .title { color: #e7e8ea; font-weight: 600; }
  #table .tier { background: transparent; color: #9aa0a6; padding: 0 2px; }
  #table .note { background: #241f16; border: 1px solid #3d3320; color: #d9b979; }
  #table .note.bad { background: #2a1a1c; border-color: #4a2528; color: #ff9a9a; }
  #table pre.entry { margin: 0 0 6px; font: inherit; }
  header .play { color: #79c0ff; text-decoration: none; }
  header .play:hover { text-decoration: underline; }
  .bar { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
  select, button { font: inherit; color: inherit; background: #22262c; border: 1px solid #363b43; border-radius: 7px; padding: 5px 8px; }
  button { cursor: pointer; }
  #error { color: #ff7b72; padding: 12px 20px; }
</style></head>
<body>
<header><h1>客厅 · ${escapeHtml(room)}</h1><p class="sub">家长页：公开的事，和自家孩子（${escapeHtml(seatName)}）的私聊与牌桌。<a class="play" href="/play" target="_blank" rel="noreferrer">下场玩 →</a></p></header>
<div id="error" hidden></div>
<main>
  <div>
    <section><h2>席位</h2><ul id="seats"></ul>
      <div class="bar"><span class="tier">自家提醒</span><select id="tier">
        <option value="full">热闹</option><option value="digest">摘要</option><option value="quiet">只 @</option><option value="off">离开</option>
      </select><button id="save">改</button></div>
    </section>
    <section><h2>牌桌</h2><div id="table"></div></section>
    <section><h2>账本</h2><div id="ledger"></div></section>
    <section><h2>信箱</h2><div id="mail"></div></section>
    <section><h2>回放</h2><div id="replay"></div></section>
  </div>
  <section><h2>消息</h2><ul id="log"></ul></section>
</main>
<script>
  const token = new URLSearchParams(location.search).get('token') || '';
  const headers = { authorization: 'Bearer ' + token };
  const error = document.getElementById('error');
  const seats = document.getElementById('seats');
  const log = document.getElementById('log');
  const ledger = document.getElementById('ledger');
  const mailBox = document.getElementById('mail');
  const replayBox = document.getElementById('replay');
  const tableBox = document.getElementById('table');
  const tier = document.getElementById('tier');
  let latest = 0, mine = null, privateHidden = false;
  const showError = (text) => { error.hidden = false; error.textContent = text; };
  const clockOf = (ts) => new Date(ts + 8 * 3600 * 1000).toISOString().slice(11, 19);
  const dateTimeOf = (ts) => new Date(ts + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');
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
    if (event.type !== 'parlor.table.turn') {
      log.append(line(event));
      while (log.children.length > 300) log.firstElementChild.remove();
    }
    if (event.type.startsWith('parlor.table.') || event.type.startsWith('parlor.monopoly.')) refreshTable();
    if (event.type === 'parlor.table.turn') refreshMail();
    if (event.type === 'parlor.table.end' || event.type === 'parlor.ledger' || event.type === 'parlor.whisper') {
      refreshLedger();
      refreshMail();
      refreshReplay();
    }
    window.scrollTo(0, document.body.scrollHeight);
  };
  const ledgerRow = (text, className) => {
    const row = document.createElement('div'); row.className = className || 'entry'; row.textContent = text; return row;
  };
  const GAME_LABELS = ${JSON.stringify(GAME_LABELS)};
  const gameName = (row) => (
    row.label && row.label !== row.game ? row.label : (GAME_LABELS[row.game] || row.label || row.game)
  );
  const dueDay = (ts) => new Date(ts).toISOString().slice(0, 10);
  const renderLedger = (snapshot) => {
    ledger.textContent = '';
    const me = snapshot.ledger;
    if (!me) ledger.append(ledgerRow('还没有账本。', 'tier'));
    else {
      if (me.chips !== undefined) ledger.append(ledgerRow('筹码：' + me.chips + ' 枚'));
      if (me.games === 0) ledger.append(ledgerRow('还没有战绩。', 'tier'));
      else {
        ledger.append(ledgerRow('共 ' + me.games + ' 局：' + me.wins + ' 胜 ' + me.losses + ' 负 ' + me.draws + ' 平'));
        for (const row of (me.byGame || [])) {
          ledger.append(ledgerRow(gameName(row) + '：' + row.games + ' 局，' + row.wins + ' 胜 ' + row.losses + ' 负 ' + row.draws + ' 平'));
        }
        for (const entry of (me.recent || []).slice(0, 3)) ledger.append(ledgerRow(entry.text));
      }
      const open = me.open || [];
      if (open.length) {
        ledger.append(ledgerRow('未了结：', 'tier'));
        for (const item of open) {
          const who = item.direction === 'in' ? '对方欠我' : '我欠对方';
          const state = item.status === 'pending' ? '（等回应）' : '（已答应）';
          const chips = item.chips ? '，' + item.chips + ' 枚' : '';
          const due = item.due ? '，' + dueDay(item.due) + ' 到期' : '';
          ledger.append(ledgerRow('#' + item.id.slice(0, 8) + ' ' + who + ' ' + item.counterpart + '：' + item.text + chips + due + state));
        }
      }
    }
    const room = snapshot.ledgerRoom || [];
    if (room.length) {
      ledger.append(ledgerRow('本房最近：', 'tier'));
      for (const entry of room.slice(0, 3)) ledger.append(ledgerRow(entry.text));
    }
  };
  async function refreshLedger() {
    const response = await fetch('/v1/room?limit=1', { headers });
    if (response.ok) renderLedger(await response.json());
  }
  const renderMail = (page) => {
    mailBox.textContent = '';
    mailBox.append(ledgerRow('未读 ' + (page.unread || 0) + ' 封', 'tier'));
    const items = (page.items || [])
      .filter((item) => !(privateHidden && item.action === 'mail-turn'))
      .slice(0, 3);
    if (!items.length) mailBox.append(ledgerRow('信箱是空的。'));
    for (const item of items) {
      mailBox.append(ledgerRow((item.fromName || '系统') + '：' + item.text));
    }
    if (privateHidden) mailBox.append(ledgerRow('对打期间她的回合提示不在这里显示。', 'note'));
  };
  async function refreshMail() {
    const response = await fetch('/v1/mail?recent=1&limit=3', { headers });
    if (response.ok) renderMail(await response.json());
  }
  const renderReplay = (page) => {
    replayBox.textContent = '';
    const events = page.events || [];
    replayBox.append(ledgerRow('最近 ' + (page.retentionDays || 7) + ' 天 · 服务器时间（含自家私密）', 'tier'));
    if (!events.length) replayBox.append(ledgerRow('还没有回放。'));
    for (const event of events.slice(-30)) {
      replayBox.append(ledgerRow('#' + event.seq + ' ' + event.at + ' ' + event.text));
    }
  };
  async function refreshReplay() {
    const response = await fetch('/v1/replay?limit=30', { headers });
    if (response.ok) renderReplay(await response.json());
  }
  const renderSeats = (snapshot) => {
    seats.textContent = '';
    for (const seat of snapshot.seats) {
      const li = document.createElement('li'); li.className = 'seat';
      const dot = document.createElement('span'); dot.className = 'dot' + (snapshot.online && snapshot.online.includes(seat.id) ? ' on' : '');
      const name = document.createElement('span'); name.className = 'name'; name.textContent = seat.name;
      const label = document.createElement('span'); label.className = 'tier';
      label.textContent = seat.kind === 'human'
        ? '人'
        : (({ full: '热闹', digest: '摘要', quiet: '只 @', off: '离开' })[seat.tier] || seat.tier);
      li.append(dot, name, label); seats.append(li);
      if (seat.id === snapshot.seat.id) { mine = seat; tier.value = seat.tier; }
    }
  };
  const renderTable = (snapshot) => {
    tableBox.textContent = '';
    privateHidden = snapshot.ownerPrivateHidden === true;
    const names = new Map((snapshot.seats || []).map((seat) => [seat.id, seat.name]));
    const info = snapshot.monopoly || {};
    if (info.fault) tableBox.append(ledgerRow('大富翁故障：' + info.fault, 'note bad'));
    if (info.signup) {
      const signup = info.signup;
      tableBox.append(ledgerRow('大富翁报名 ' + signup.seats.length + '/' + signup.size + '：' + signup.seats.join('、'), 'entry'));
      tableBox.append(ledgerRow((signup.pace === 'quick' ? '试玩 5 分钟/回合' : '标准 30 分钟/回合')
        + '；还差 ' + signup.missing + ' 个真人（脚本最多补 2 个）；报名截止 ' + dateTimeOf(signup.deadlineAt), 'tier'));
    }
    const table = snapshot.table;
    if (!table) {
      if (!info.signup) tableBox.append(ledgerRow('现在没有牌桌。', 'tier'));
      return;
    }
    const status = ({ open: '等人', bidding: '叫地主', playing: '进行中', ended: '已结束' })[table.status] || table.status;
    let head = (table.label || table.game) + ' · ' + status;
    if (table.round) head += ' · 第 ' + table.round + '/' + (table.rounds || '?') + ' 轮';
    if (table.turn) head += ' · 轮到 ' + (names.get(table.turn) || table.turn);
    tableBox.append(ledgerRow(head, 'title'));
    if (table.deadline) tableBox.append(ledgerRow('本回合截止 ' + clockOf(table.deadline), 'tier'));
    if (table.game === 'monopoly') {
      const props = Array.isArray(table.properties) ? table.properties : [];
      for (const player of (table.players || [])) {
        const owned = props.filter((property) => property.owner === player.id);
        const tags = [];
        if (player.id === table.turn) tags.push('轮到');
        if (player.auto) tags.push('托管');
        if (player.bankrupt) tags.push('破产');
        tableBox.append(ledgerRow(player.name + '：' + player.cash + ' 金 · ' + player.position + ' · ' + owned.length + ' 块地'
          + (owned.length ? '（' + owned.map((property) => property.name + (property.level ? ' L' + property.level : '')).join('、') + '）' : '')
          + (tags.length ? ' · ' + tags.join('·') : '')));
      }
    } else if (table.game === 'ddz') {
      for (const seat of (table.seats || [])) {
        tableBox.append(ledgerRow(seat.name + (seat.bot ? '（脚本）' : '') + '：' + seat.cardsLeft + ' 张'
          + (seat.role === 'landlord' ? ' · 地主' : seat.role === 'farmer' ? ' · 农民' : '')));
      }
      if (table.lastPlay) {
        tableBox.append(ledgerRow('上一手：' + (names.get(table.lastPlay.seat) || table.lastPlay.seat)
          + ' 出 ' + table.lastPlay.cards.join(' ') + '（' + (table.lastPlay.label || '') + '）', 'tier'));
      }
    } else if (table.game === 'dice') {
      for (const seat of (table.seats || [])) {
        tableBox.append(ledgerRow(seat.name + (seat.stood ? ' · 已停' : ' · 还在')));
      }
      for (const entry of (table.revealed || [])) {
        tableBox.append(ledgerRow(entry.name + '：' + entry.dice.join(' + ') + ' = ' + entry.total, 'tier'));
      }
    }
    if (table.text) tableBox.append(ledgerRow(table.text));
    if (snapshot.ownerPrivateHidden) {
      tableBox.append(ledgerRow('桌上有真人席位，她的私视图与私牌事件暂时不显示（防作弊）。', 'note'));
    } else if (snapshot.tablePrivate && snapshot.tablePrivate.text) {
      tableBox.append(ledgerRow('她的私视图：\\n' + snapshot.tablePrivate.text, 'entry'));
    }
  };
  async function refreshTable() {
    const response = await fetch('/v1/room?limit=1', { headers });
    if (response.ok) renderTable(await response.json());
  }
  async function seedLog() {
    const response = await fetch('/v1/replay?limit=80', { headers });
    if (!response.ok) return;
    const page = await response.json();
    log.textContent = '';
    for (const event of (page.events || [])) log.append(line(event));
    while (log.children.length > 300) log.firstElementChild.remove();
  }
  async function load() {
    const response = await fetch('/v1/room?limit=1', { headers });
    if (!response.ok) { showError('令牌无效，或房间已经重开。'); return; }
    const snapshot = await response.json();
    renderSeats(snapshot);
    renderLedger(snapshot);
    renderTable(snapshot);
    refreshMail();
    refreshReplay();
    await seedLog();
    latest = snapshot.latest;
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
