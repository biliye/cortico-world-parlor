/**
 * 多客厅 HTTP 网关（聊天切片）。
 *
 * 一条进程、一个 SQLite 库、多个客厅；每房一个 RoomHost。
 * 现有旧 World 通过 `/v1/...` 别名落到默认客厅；新客户端走 `/v1/rooms/:id/...`。
 * 牌桌/家长门户/大厅目录还没接进来；这一步先把多房 + 可见区间 + 全局账户跑通。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isCooId, isCooSecret } from './ledger.ts';
import { serverClock } from './clock.ts';
import { CooAccountDb } from './coo-account-db.ts';
import { migrate, openDb, type Db } from './db.ts';
import { MailDb } from './mail-db.ts';
import { HostError, RoomHost } from './room-host.ts';
import {
  RoomSeatError, activeSeatForCoo, activeSeats, createRoom, getRoom, listRooms, memberOf, resolveRoom,
  type RoomRow,
} from './room-seat-db.ts';
import type { RoomEvent, RoomSnapshot, Seat, SeatKind, WakeTier } from './protocol.ts';

export interface WorldServerOptions {
  dbFile?: string;
  host?: string;
  port?: number;
  defaultRoomId?: string;
  inviteCode?: string;
  now?: () => number;
}

interface SseClient {
  cooId: string;
  seatId: string;
  since: number;
  lastPing: number;
  res: ServerResponse;
}

const WEB_TYPES: Readonly<Record<string, string>> = {
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

const PACKAGE_VERSION = ((): string => {
  try {
    const raw = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof raw.version === 'string' ? raw.version : '';
  } catch { return ''; }
})();

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
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
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

const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
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

const bearer = (req: IncomingMessage): string => {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};

const headerValue = (req: IncomingMessage, name: string): string => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
};

const statusOf = (error: unknown): number => {
  if (error instanceof HttpError) return error.status;
  if (error instanceof HostError) {
    if (error.code === 'not_found') return 404;
    if (error.code === 'forbidden') return 403;
    if (error.code === 'conflict' || error.code === 'full' || error.code === 'already_seated') return 409;
    return 400;
  }
  if (error instanceof RoomSeatError) {
    if (error.code === 'room_not_found' || error.code === 'seat_not_found' || error.code === 'unknown_coo') return 404;
    if (error.code === 'room_full' || error.code === 'already_seated' || error.code === 'name_taken' || error.code === 'room_exists') return 409;
    return 400;
  }
  return 500;
};

const messageOf = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const seatOfRow = (roomId: string, seat: { id: string; name: string; kind: SeatKind; tier: WakeTier; joinedAt: number }): Seat => ({
  id: seat.id, name: seat.name, kind: seat.kind, tier: seat.tier, joinedAt: seat.joinedAt,
});

const roomSummary = (db: Db, room: RoomRow) => ({
  id: room.id,
  kind: room.kind,
  name: room.name,
  topic: room.topic,
  visibility: room.visibility,
  capacity: room.capacity,
  seats: activeSeats(db, room.id).filter((seat) => seat.kind !== 'observer').length,
  archived: room.archivedAt !== null,
  lastActiveAt: room.lastActiveAt,
});

export class WorldServer {
  private readonly db: Db;
  private readonly coo: CooAccountDb;
  private readonly now: () => number;
  private readonly defaultRoomId: string;
  private readonly inviteCode: string;
  private readonly hostName: string;
  private readonly port: number;
  private server?: Server;
  private baseUrl = '';
  private readonly sse = new Map<string, Set<SseClient>>();
  private pumpTimer?: NodeJS.Timeout;
  private clockTimer?: NodeJS.Timeout;
  /** 每厅一个 RoomHost：牌桌引擎在内存里，必须跨请求共用同一个实例。 */
  private readonly hosts = new Map<string, RoomHost>();
  /** 定向邀请的限频：每个 Coo 一小时的发送时刻。 */
  private readonly inviteTimes = new Map<string, number[]>();

  constructor(options: WorldServerOptions = {}) {
    this.db = openDb(options.dbFile ?? ':memory:');
    migrate(this.db);
    this.now = options.now ?? Date.now;
    this.coo = new CooAccountDb(this.db, { now: this.now });
    this.defaultRoomId = options.defaultRoomId ?? 'lobby';
    this.inviteCode = options.inviteCode ?? '';
    this.hostName = options.host ?? '127.0.0.1';
    this.port = options.port ?? 0;
    this.ensureDefaultRoom();
  }

  get url(): string {
    return this.baseUrl;
  }

  get dbHandle(): Db {
    return this.db;
  }

  async listen(): Promise<{ url: string; host: string; port: number }> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        if (res.headersSent) {
          try { res.end(); } catch { /* 已断开 */ }
          return;
        }
        json(res, statusOf(error), { error: messageOf(error) });
      });
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      server.once('error', reject);
      server.listen(this.port, this.hostName, () => resolve());
    });
    const address = this.server.address() as AddressInfo;
    const host = this.hostName === '0.0.0.0' || this.hostName === '::' ? '127.0.0.1' : this.hostName;
    this.baseUrl = `http://${host}:${address.port}`;
    this.pumpTimer = setInterval(() => this.pump(), 400);
    this.pumpTimer.unref?.();
    this.clockTimer = setInterval(() => this.tickClock(), 1000);
    this.clockTimer.unref?.();
    return { url: this.baseUrl, host: this.hostName, port: address.port };
  }

  async close(): Promise<void> {
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    this.pumpTimer = undefined;
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = undefined;
    this.hosts.clear();
    for (const clients of this.sse.values()) {
      for (const client of clients) {
        try { client.res.end(); } catch { /* 已断开 */ }
      }
    }
    this.sse.clear();
    const server = this.server;
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.server = undefined;
    }
    this.db.close();
  }

  private ensureDefaultRoom(): void {
    const system = 'system-owner';
    this.db.prepare(
      'INSERT OR IGNORE INTO coos(id, kind, display_name, created_at) VALUES (?, ?, ?, ?)',
    ).run(system, 'system', '系统', this.now());
    if (!getRoom(this.db, this.defaultRoomId)) {
      createRoom(this.db, {
        id: this.defaultRoomId,
        name: '默认客厅',
        ownerCooId: system,
        visibility: 'unlisted',
        capacity: 8,
      }, this.now());
    }
    this.ensureHall();
  }

  /** 大厅是特殊客厅（kind = 'hall'）：有席位、能说话，但不进目录、没有牌桌。 */
  private ensureHall(): RoomRow {
    const existing = this.db.prepare("SELECT id FROM rooms WHERE kind = 'hall' LIMIT 1").get() as { id: string } | undefined;
    if (existing) return getRoom(this.db, existing.id)!;
    const now = this.now();
    this.db.prepare(
      `INSERT INTO rooms(id, kind, name, owner_coo_id, visibility, capacity, topic, epoch, seq, created_at, last_active_at)
       VALUES (?, 'hall', ?, NULL, 'public', 32, ?, ?, 0, ?, ?)`,
    ).run('hall', '大厅', '所有客厅的入口：看谁在线、有哪些客厅、去哪串门。', randomUUID(), now, now);
    return getRoom(this.db, 'hall')!;
  }

  get hallId(): string {
    return this.ensureHall().id;
  }

  private host(roomId: string): RoomHost {
    const existing = this.hosts.get(roomId);
    if (existing) return existing;
    const host = new RoomHost(this.db, roomId, { now: this.now });
    this.hosts.set(roomId, host);
    return host;
  }

  /**
   * 每秒：牌桌超时、承诺到期、余额补给。
   * 没人访问的客厅也要走到：先按「有活跃席位 / 有到期承诺」把 host 建出来。
   */
  private tickClock(): void {
    const now = this.now();
    try {
      const occupied = this.db.prepare(
        'SELECT DISTINCT room_id FROM room_seats WHERE released_at IS NULL',
      ).all() as { room_id: string }[];
      const due = this.db.prepare(
        `SELECT DISTINCT room_id FROM ledger_entries
          WHERE kind = 'promise' AND due_at IS NOT NULL AND due_at <= ? AND room_id IS NOT NULL`,
      ).all(now) as { room_id: string }[];
      for (const row of [...occupied, ...due]) this.host(row.room_id);
      for (const host of this.hosts.values()) {
        try { host.tickClock(now); } catch (error) {
          console.error('parlor: 客厅时钟出错', error);
        }
      }
    } catch (error) {
      console.error('parlor: 时钟扫描失败', error);
    }
  }

  /** Coo 身份：缺行就自动注册；secret 不匹配拒绝。 */
  private cooAuth(req: IncomingMessage, name = ''): string {
    const cooId = headerValue(req, 'x-parlor-coo').trim();
    const secret = headerValue(req, 'x-parlor-coo-secret').trim();
    if (!isCooId(cooId) || !isCooSecret(secret)) throw new HttpError(400, '账本身份格式不对');
    const claim = this.coo.claimIdentity(cooId, secret);
    if (claim === 'mismatch') throw new HttpError(403, '这个账本身份已经被占用了');
    if (claim === 'invalid') {
      const created = this.coo.registerCoo(cooId, secret, 'pet', name);
      if (created === 'mismatch') throw new HttpError(403, '这个账本身份已经被占用了');
      if (created !== 'ok') throw new HttpError(400, '账本身份格式不对');
    }
    return cooId;
  }

  private identify(req: IncomingMessage): string | null {
    const cooId = headerValue(req, 'x-parlor-coo').trim();
    const secret = headerValue(req, 'x-parlor-coo-secret').trim();
    if (!isCooId(cooId) || !isCooSecret(secret)) return null;
    return this.coo.claimIdentity(cooId, secret) === 'ok' ? cooId : null;
  }

  private seatAuth(req: IncomingMessage, roomId: string, tokenOverride?: string) {
    const token = tokenOverride ?? bearer(req);
    if (!token) throw new HttpError(401, '缺少席位令牌');
    try {
      return this.host(roomId).seatByToken(token);
    } catch (error) {
      if (error instanceof HostError) throw new HttpError(401, error.message);
      throw error;
    }
  }

  private checkInvite(req: IncomingMessage, body: Record<string, unknown>): void {
    if (!this.inviteCode) return;
    const invite = headerValue(req, 'x-parlor-invite').trim() || String(body.invite ?? '');
    if (invite !== this.inviteCode) throw new HttpError(403, '邀请码不对');
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    if (method === 'GET' && this.serveWeb(url.pathname, res)) return;

    if (method === 'GET' && url.pathname === '/healthz') {
      const room = getRoom(this.db, this.defaultRoomId);
      json(res, 200, {
        ok: true,
        room: this.defaultRoomId,
        version: PACKAGE_VERSION,
        protocol: 2,
        hall: this.hallId,
        rooms: listRooms(this.db, { kind: 'room' }).length,
        seats: room ? activeSeats(this.db, room.id).filter((seat) => seat.kind !== 'observer').length : 0,
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/me') {
      const cooId = this.cooAuth(req);
      const seat = activeSeatForCoo(this.db, cooId);
      json(res, 200, {
        cooId,
        seat: seat ? {
          room: seat.roomId, id: seat.id, name: seat.name, kind: seat.kind, tier: seat.tier,
        } : null,
        rooms: listRooms(this.db, { kind: 'room' })
          .filter((room) => room.visibility === 'public' || memberOf(this.db, room.id, cooId) !== null)
          .map((room) => roomSummary(this.db, room)),
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/hall') {
      const cooId = this.cooAuth(req);
      const hall = this.ensureHall();
      json(res, 200, {
        hall: {
          id: hall.id,
          name: hall.name,
          topic: hall.topic,
          capacity: hall.capacity,
          seats: activeSeats(this.db, hall.id).map((seat) => ({
            id: seat.id, name: seat.name, kind: seat.kind,
          })),
        },
        me: (() => {
          const seat = activeSeatForCoo(this.db, cooId);
          return seat ? { room: seat.roomId, id: seat.id, name: seat.name } : null;
        })(),
        rooms: listRooms(this.db, { kind: 'room' })
          .filter((room) => room.visibility === 'public' || memberOf(this.db, room.id, cooId) !== null)
          .map((room) => roomSummary(this.db, room)),
      });
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/invite') {
      const cooId = this.cooAuth(req);
      const body = await readJson(req);
      const seat = activeSeatForCoo(this.db, cooId);
      if (!seat) throw new HttpError(403, '你不在任何客厅里；先进一个客厅再邀请');
      const to = typeof body.to === 'string' ? body.to.trim() : '';
      if (!to) throw new HttpError(400, '要写邀请谁（席位名或 Coo 身份）');
      const rows = this.db.prepare(
        `SELECT room_id, id, coo_id, name FROM room_seats
          WHERE released_at IS NULL AND (coo_id = ? OR name = ? COLLATE NOCASE)`,
      ).all(to, to) as { room_id: string; id: string; coo_id: string; name: string }[];
      const target = rows.find((row) => row.coo_id === to)
        ?? rows.find((row) => row.name.toLowerCase() === to.toLowerCase());
      if (!target) throw new HttpError(404, `没有找到「${to}」这个席位`);
      if (target.coo_id === cooId) throw new HttpError(400, '不能邀请自己');
      const roomValue = typeof body.room === 'string' && body.room.trim() ? body.room.trim() : seat.roomId;
      const room = getRoom(this.db, roomValue) ?? resolveRoom(this.db, roomValue);
      if (!room) throw new HttpError(404, '要去的客厅不存在');
      if (room.archivedAt !== null) throw new HttpError(409, '那个客厅已经归档了');
      this.checkInviteRate(cooId);
      const extra = typeof body.text === 'string' ? body.text.trim().slice(0, 200) : '';
      const line = `${seat.name} 邀请你去「${room.name}」${extra ? `：${extra}` : ''}。用 parlor_room_visit 进去。`;
      const letter = new MailDb(this.db, { now: this.now }).append({
        to: target.coo_id,
        room: room.id,
        kind: 'invite',
        action: 'invite',
        fromName: seat.name,
        text: line,
      });
      this.host(target.room_id).pingSeat(target.coo_id, line, {
        room: room.id, roomName: room.name, from: seat.name, mailSeq: letter.seq,
      });
      json(res, 200, { ok: true, room: room.id, to: target.name, mailSeq: letter.seq });
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/rooms') {
      const all = url.searchParams.get('all') === '1';
      const cooId = all ? this.cooAuth(req) : null;
      const rooms = listRooms(this.db, { kind: 'room' }).filter((room) => (
        room.visibility === 'public'
        || (all && cooId !== null && memberOf(this.db, room.id, cooId) !== null)
      ));
      json(res, 200, { rooms: rooms.map((room) => roomSummary(this.db, room)) });
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/rooms') {
      const cooId = this.cooAuth(req);
      const body = await readJson(req);
      const name = typeof body.name === 'string' ? body.name : '';
      const visibility = typeof body.visibility === 'string' ? body.visibility as 'public' | 'unlisted' | 'private' : undefined;
      const capacity = typeof body.capacity === 'number' ? body.capacity : undefined;
      const topic = typeof body.topic === 'string' ? body.topic : undefined;
      const room = createRoom(this.db, {
        name,
        ownerCooId: cooId,
        ...(visibility ? { visibility } : {}),
        ...(capacity ? { capacity } : {}),
        ...(topic ? { topic } : {}),
      }, this.now());
      json(res, 200, { room: roomSummary(this.db, room) });
      return;
    }

    const detail = url.pathname.match(/^\/v1\/rooms\/([^/]+)$/);
    if (method === 'GET' && detail) {
      const room = getRoom(this.db, detail[1]);
      if (!room) throw new HttpError(404, '客厅不存在');
      if (room.visibility !== 'public') {
        const cooId = this.identify(req);
        if (!cooId || memberOf(this.db, room.id, cooId) === null) throw new HttpError(404, '客厅不存在');
      }
      json(res, 200, { room: roomSummary(this.db, room) });
      return;
    }

    const route = url.pathname.match(/^\/v1\/rooms\/([^/]+)\/(join|leave|switch|room|history|action|mail|stream|replay)$/);
    if (route) {
      const roomId = route[1];
      const action = route[2];
      await this.roomRoute(req, res, url, roomId, action, method);
      return;
    }

    if (url.pathname === '/v1/join' && method === 'POST') {
      const body = await readJson(req);
      this.checkInvite(req, body);
      const name = typeof body.name === 'string' ? body.name : '';
      const cooId = this.cooAuth(req, name);
      const host = this.host(this.defaultRoomId);
      if (host.seatOf(cooId)) host.leave(cooId);
      const joined = host.join(cooId, {
        name,
        ...(typeof body.kind === 'string' ? { kind: body.kind as SeatKind } : {}),
        ...(typeof body.tier === 'string' ? { tier: body.tier as WakeTier } : {}),
      });
      const account = this.coo.ensureAccount(cooId, name);
      json(res, 200, {
        room: this.defaultRoomId,
        seat: seatOfRow(this.defaultRoomId, joined.seat),
        token: joined.token,
        ownerToken: '',
        maxSeats: host.room().capacity,
        ...(account.created && account.ownerKey ? { ownerKey: account.ownerKey } : {}),
      });
      return;
    }

    if (url.pathname === '/v1/player/join' && method === 'POST') {
      const body = await readJson(req);
      this.checkInvite(req, body);
      const name = typeof body.name === 'string' ? body.name : '';
      const cooId = randomUUID();
      const secret = randomBytes(32).toString('base64url');
      this.coo.registerCoo(cooId, secret, 'human', name);
      const host = this.host(this.defaultRoomId);
      const joined = host.join(cooId, { name, kind: 'human', tier: 'off' });
      json(res, 200, {
        room: this.defaultRoomId,
        seat: seatOfRow(this.defaultRoomId, joined.seat),
        token: joined.token,
        maxSeats: host.room().capacity,
        identity: { cooId, cooSecret: secret },
      });
      return;
    }

    const alias = url.pathname.match(/^\/v1\/(room|history|action|mail|stream|replay)$/);
    if (alias) {
      await this.roomRoute(req, res, url, this.defaultRoomId, alias[1], method);
      return;
    }

    if (url.pathname === '/v1/owner') {
      throw new HttpError(410, '旧家长页已停用；请用扩展面板的新家长链接');
    }

    throw new HttpError(404, '没有这个地址');
  }

  private async roomRoute(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    roomId: string,
    action: string,
    method: string,
  ): Promise<void> {
    if (action === 'join' && method === 'POST') {
      const body = await readJson(req);
      const name = typeof body.name === 'string' ? body.name : '';
      const cooId = this.cooAuth(req, name);
      const host = this.host(roomId);
      const joined = host.join(cooId, {
        name,
        ...(typeof body.kind === 'string' ? { kind: body.kind as SeatKind } : {}),
        ...(typeof body.tier === 'string' ? { tier: body.tier as WakeTier } : {}),
      });
      const account = this.coo.ensureAccount(cooId, name);
      json(res, 200, {
        room: roomId,
        seat: seatOfRow(roomId, joined.seat),
        token: joined.token,
        maxSeats: host.room().capacity,
        ...(account.created && account.ownerKey ? { ownerKey: account.ownerKey } : {}),
      });
      return;
    }

    if (action === 'switch' && method === 'POST') {
      const seat = this.seatAuth(req, roomId);
      const body = await readJson(req);
      const value = typeof body.to === 'string' ? body.to : '';
      const target = getRoom(this.db, value) ?? resolveRoom(this.db, value);
      if (!target) throw new HttpError(404, `目标客厅不存在：${value}`);
      const moved = this.host(roomId).switchTo(seat.cooId, target.id, {
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
      });
      json(res, 200, {
        ok: true,
        room: target.id,
        seat: seatOfRow(target.id, moved.seat),
        token: moved.token,
        leaveSeq: moved.leaveEvent.seq,
        joinSeq: moved.joinEvent.seq,
      });
      return;
    }

    if (action === 'leave' && method === 'POST') {
      const seat = this.seatAuth(req, roomId);
      const left = this.host(roomId).leave(seat.cooId);
      json(res, 200, {
        ok: true,
        seq: left.event.seq,
        at: serverClock(left.event.ts),
      });
      return;
    }

    if (action === 'room' && method === 'GET') {
      const seat = this.seatAuth(req, roomId);
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      const limit = Number(url.searchParams.get('limit') ?? 30) || 30;
      const snapshot: RoomSnapshot = this.host(roomId).snapshot(seat.cooId, { since, limit });
      json(res, 200, { ...snapshot, online: this.onlineSeatIds(roomId) });
      return;
    }

    if (action === 'history' && method === 'GET') {
      const seat = this.seatAuth(req, roomId);
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      const limit = Number(url.searchParams.get('limit') ?? 30) || 30;
      const host = this.host(roomId);
      json(res, 200, { latest: host.latest(), events: host.history(seat.cooId, { since, limit }) });
      return;
    }

    if (action === 'action' && method === 'POST') {
      const seat = this.seatAuth(req, roomId);
      const body = await readJson(req);
      const type = typeof body.type === 'string' ? body.type : '';
      const host = this.host(roomId);
      let delivered: unknown;
      let seats: unknown;
      let deadline: number | undefined;
      let turn: string | undefined;
      let text: string | undefined;

      if (type === 'say') {
        host.say(seat.cooId, typeof body.text === 'string' ? body.text : '');
      } else if (type === 'table_say') {
        host.tableSay(seat.cooId, typeof body.text === 'string' ? body.text : '');
      } else if (type === 'whisper') {
        const result = host.whisper(
          seat.cooId,
          typeof body.to === 'string' ? body.to : '',
          typeof body.text === 'string' ? body.text : '',
        );
        delivered = result.delivered;
      } else if (type === 'set_tier') {
        if (typeof body.tier !== 'string') throw new HttpError(400, '挡位不对');
        host.setTier(seat.cooId, body.tier as WakeTier);
      } else if (type === 'gift') {
        const result = host.gift(
          seat.cooId,
          typeof body.to === 'string' ? body.to : '',
          typeof body.text === 'string' ? body.text : '',
          body.chips,
        );
        delivered = result.delivered;
      } else if (type === 'promise') {
        const result = host.promise(
          seat.cooId,
          typeof body.to === 'string' ? body.to : '',
          typeof body.text === 'string' ? body.text : '',
          body.due,
          body.chips,
        );
        delivered = result.delivered;
      } else if (type === 'respond') {
        const actionName = body.action;
        if (actionName !== 'accept' && actionName !== 'decline' && actionName !== 'done' && actionName !== 'cancel') {
          throw new HttpError(400, '回应只能是 accept / decline / done / cancel');
        }
        const result = host.respond(seat.cooId, typeof body.id === 'string' ? body.id : '', actionName);
        delivered = result.delivered;
      } else if (type === 'table_open') {
        host.openTable(seat.cooId, {
          game: typeof body.game === 'string' ? body.game : undefined,
          stake: body.stake,
        });
      } else if (type === 'table_join') {
        host.joinTable(seat.cooId);
      } else if (type === 'table_leave') {
        host.leaveTable(seat.cooId);
      } else if (type === 'table_start') {
        const receipt = host.startTable(seat.cooId);
        seats = receipt.seats;
        deadline = receipt.deadline;
        turn = receipt.turn;
      } else if (type === 'table_action') {
        if (host.tablePublic()?.game !== 'dice') {
          throw new HttpError(400, '这张桌子不是骰子桌；斗地主用 ddz_action');
        }
        const receipt = host.tableAction(seat.cooId, { type: body.action, die: body.die });
        deadline = receipt.deadline;
        turn = receipt.turn;
      } else if (type === 'ddz_action') {
        if (host.tablePublic()?.game !== 'ddz') throw new HttpError(400, '这张桌子不是斗地主桌');
        const receipt = host.tableAction(seat.cooId, { move: body.move, call: body.call, cards: body.cards });
        deadline = receipt.deadline;
        turn = receipt.turn;
      } else if (type === 'monopoly') {
        throw new HttpError(400, '这台服务器只跑骰子与斗地主；大富翁请用旧服务器');
      } else {
        throw new HttpError(400, '未知动作');
      }

      const ts = this.now();
      json(res, 200, {
        ok: true,
        seq: host.latest(),
        ts,
        at: serverClock(ts),
        ...(delivered && Array.isArray(delivered) && delivered.length > 0 ? { delivered } : {}),
        ...(seats ? { seats } : {}),
        ...(deadline ? { deadline, deadlineAt: serverClock(deadline) } : {}),
        ...(turn ? { turn } : {}),
        ...(text ? { text } : {}),
      });
      return;
    }

    if (action === 'replay' && method === 'GET') {
      const seat = this.seatAuth(req, roomId);
      const limit = Number(url.searchParams.get('limit') ?? 50) || 50;
      const before = Number(url.searchParams.get('before') ?? 0) || undefined;
      const host = this.host(roomId);
      const page = host.replay(seat.cooId, { limit, ...(before ? { before } : {}) });
      json(res, 200, {
        room: roomId,
        latest: host.latest(),
        now: this.now(),
        at: serverClock(this.now()),
        retentionDays: 7,
        events: page.events.map((event) => ({
          seq: event.seq,
          ts: event.ts,
          at: serverClock(event.ts),
          type: event.type,
          from: event.from,
          text: event.text,
          ...(event.data ? { data: event.data } : {}),
        })),
        older: page.older,
      });
      return;
    }

    if (action === 'mail' && method === 'GET') {
      const seat = this.seatAuth(req, roomId);
      const limit = Number(url.searchParams.get('limit') ?? 10) || 10;
      const peek = url.searchParams.get('peek') === '1';
      const all = url.searchParams.get('all') === '1';
      json(res, 200, this.host(roomId).readMail(seat.cooId, limit, !peek, all));
      return;
    }

    if (action === 'stream' && method === 'GET') {
      const token = url.searchParams.get('token') ?? bearer(req);
      this.seatAuth(req, roomId, token);
      this.stream(req, res, roomId, token, Number(url.searchParams.get('since') ?? 0) || 0);
      return;
    }

    throw new HttpError(405, '这个动作不支持这个 HTTP 方法');
  }

  private stream(req: IncomingMessage, res: ServerResponse, roomId: string, token: string, since: number): void {
    const host = this.host(roomId);
    const seat = host.seatByToken(token);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');
    const initial = host.eventsSince(seat.cooId, since, 200);
    let cursor = since;
    for (const event of initial) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      cursor = event.seq;
    }
    const client: SseClient = { cooId: seat.cooId, seatId: seat.id, since: cursor, lastPing: this.now(), res };
    let clients = this.sse.get(roomId);
    if (!clients) {
      clients = new Set();
      this.sse.set(roomId, clients);
    }
    clients.add(client);
    req.on('close', () => {
      clients?.delete(client);
      if (clients?.size === 0) this.sse.delete(roomId);
    });
  }

  /** 有推送连接的席位（快照里的在线标记）。 */
  private onlineSeatIds(roomId: string): string[] {
    const clients = this.sse.get(roomId);
    return clients ? [...new Set([...clients].map((client) => client.seatId))] : [];
  }

  /** 定向邀请限频：一小时最多 20 次，防止拿邀请刷别人的提醒。 */
  private checkInviteRate(cooId: string): void {
    const now = this.now();
    const cutoff = now - 3_600_000;
    const times = (this.inviteTimes.get(cooId) ?? []).filter((at) => at >= cutoff);
    if (times.length >= 20) throw new HttpError(429, '一小时内最多邀请 20 次，过一会儿再来');
    times.push(now);
    this.inviteTimes.set(cooId, times);
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

  private pump(): void {
    const now = this.now();
    for (const [roomId, clients] of this.sse) {
      const host = this.host(roomId);
      for (const client of [...clients]) {
        try {
          if (!host.seatOf(client.cooId)) {
            clients.delete(client);
            client.res.end();
            continue;
          }
          const events: RoomEvent[] = host.eventsSince(client.cooId, client.since, 200);
          for (const event of events) {
            client.res.write(`data: ${JSON.stringify(event)}\n\n`);
            client.since = event.seq;
          }
          if (events.length === 0 && now - client.lastPing >= 15_000) {
            client.res.write(': ping\n\n');
            client.lastPing = now;
          }
        } catch {
          clients.delete(client);
          try { client.res.end(); } catch { /* 已断开 */ }
        }
      }
      if (clients.size === 0) this.sse.delete(roomId);
    }
  }
}
