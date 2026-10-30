/**
 * 多客厅 HTTP 网关（聊天切片）。
 *
 * 一条进程、一个 SQLite 库、多个客厅；每房一个 RoomHost。
 * 现有旧 World 通过 `/v1/...` 别名落到默认客厅；新客户端走 `/v1/rooms/:id/...`。
 * 牌桌/家长门户/大厅目录还没接进来；这一步先把多房 + 可见区间 + 全局账户跑通。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isCooId, isCooSecret } from './ledger.ts';
import { serverClock } from './clock.ts';
import { CooAccountDb, type ParentAccount } from './coo-account-db.ts';
import { migrate, openDb, type Db } from './db.ts';
import { HALL_CAPACITY } from './schema.ts';
import { MailDb } from './mail-db.ts';
import { gameByActionType } from './games/registry.ts';
import { HostError, RoomHost } from './room-host.ts';
import {
  RoomSeatError, activeSeatForCoo, activeSeats, createRoom, getRoom, hashSeatToken,
  humanSeatsForOfflineRelease, listRooms, memberOf, renameSeat, resolveRoom, seatByTokenHash,
  touchSeatSeen, type RoomRow,
} from './room-seat-db.ts';
import type { RoomEvent, RoomSnapshot, Seat, SeatKind, WakeTier } from './protocol.ts';

export interface WorldServerOptions {
  dbFile?: string;
  host?: string;
  port?: number;
  defaultRoomId?: string;
  inviteCode?: string;
  /** 网页「用户名 + 邀请码」的访客入口；默认关。 */
  allowGuestJoin?: boolean;
  /** 真人席位离线多少小时后释放；默认 6，0 = 关。 */
  offlineReleaseHours?: number;
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

const cookieOf = (req: IncomingMessage, name: string): string => {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
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
  private readonly allowGuestJoin: boolean;
  private readonly offlineReleaseMs: number;
  private readonly hostName: string;
  private readonly port: number;
  private server?: Server;
  private baseUrl = '';
  private readonly sse = new Map<string, Set<SseClient>>();
  private pumpTimer?: NodeJS.Timeout;
  private clockTimer?: NodeJS.Timeout;
  private janitorTimer?: NodeJS.Timeout;
  private janitorFirstTimer?: NodeJS.Timeout;
  /** 每厅一个 RoomHost：牌桌引擎在内存里，必须跨请求共用同一个实例。 */
  private readonly hosts = new Map<string, RoomHost>();
  /** 定向邀请的限频：每个 Coo 一小时的发送时刻。 */
  private readonly inviteTimes = new Map<string, number[]>();
  /** 家长链接试错限频：每个 IP 一小时最多 10 次。 */
  private readonly parentKeyTimes = new Map<string, number[]>();
  /** 事件清理：每小时一次，超过 7 天且不在最后 500 条的删掉。 */
  private lastPrune = 0;

  constructor(options: WorldServerOptions = {}) {
    this.db = openDb(options.dbFile ?? ':memory:');
    migrate(this.db);
    this.now = options.now ?? Date.now;
    this.coo = new CooAccountDb(this.db, { now: this.now });
    this.defaultRoomId = options.defaultRoomId ?? 'lobby';
    this.inviteCode = options.inviteCode ?? '';
    this.allowGuestJoin = options.allowGuestJoin ?? false;
    this.offlineReleaseMs = Math.max(0, options.offlineReleaseHours ?? 6) * 3_600_000;
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
    // 真人席位离线清理：每 5 分钟一次；刚启动 10 秒先扫一遍（这时还没有 SSE）。
    this.janitorTimer = setInterval(() => this.releaseOfflineSeats(), 5 * 60_000);
    this.janitorTimer.unref?.();
    this.janitorFirstTimer = setTimeout(() => this.releaseOfflineSeats(), 10_000);
    this.janitorFirstTimer.unref?.();
    return { url: this.baseUrl, host: this.hostName, port: address.port };
  }

  async close(): Promise<void> {
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    this.pumpTimer = undefined;
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = undefined;
    if (this.janitorTimer) clearInterval(this.janitorTimer);
    this.janitorTimer = undefined;
    if (this.janitorFirstTimer) clearTimeout(this.janitorFirstTimer);
    this.janitorFirstTimer = undefined;
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
       VALUES (?, 'hall', ?, NULL, 'public', ?, ?, ?, 0, ?, ?)`,
    ).run('hall', '大厅', HALL_CAPACITY, '所有客厅的入口：看谁在线、有哪些客厅、去哪串门。', randomUUID(), now, now);
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
      if (now - this.lastPrune >= 3_600_000) {
        this.lastPrune = now;
        this.pruneEvents(now);
      }
    } catch (error) {
      console.error('parlor: 时钟扫描失败', error);
    }
  }

  /**
   * 真人席位离线超过阈值就释放；Coo 的 pet 席位不动。
   * 「在线」以 SSE 连接为准：还有一条连着就不动；牌桌锁着也不动。
   * 返回这次释放了几个，方便测试和运维日志。
   */
  releaseOfflineSeats(now = this.now()): number {
    if (this.offlineReleaseMs <= 0) return 0;
    const cutoff = now - this.offlineReleaseMs;
    const online = new Set<string>();
    for (const clients of this.sse.values()) {
      for (const client of clients) online.add(client.cooId);
    }
    let released = 0;
    for (const seat of humanSeatsForOfflineRelease(this.db)) {
      if (online.has(seat.cooId)) continue;
      if (seat.lastSeenAt > cutoff) continue;
      try {
        if (this.host(seat.roomId).releaseOffline(seat.cooId, now)) released += 1;
      } catch { /* 这间房暂时有问题就跳过，下一轮再试 */ }
    }
    return released;
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

  /** 网页用席位令牌也能看目录/大厅；Coo 客户端仍用身份头。 */
  private cooOrSeat(req: IncomingMessage): string {
    const direct = this.identify(req);
    if (direct) return direct;
    const token = bearer(req);
    if (!token) throw new HttpError(401, '缺少身份');
    const seat = seatByTokenHash(this.db, hashSeatToken(token));
    if (!seat || seat.releasedAt !== null) throw new HttpError(401, '席位令牌无效或已经离开');
    return seat.cooId;
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
        guestJoin: this.allowGuestJoin,
        offlineReleaseHours: this.offlineReleaseMs / 3_600_000,
        hall: this.hallId,
        rooms: listRooms(this.db, { kind: 'room' }).length,
        seats: room ? activeSeats(this.db, room.id).filter((seat) => seat.kind !== 'observer').length : 0,
      });
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/parent/session') {
      const body = await readJson(req);
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      this.checkParentKeyRate(req);
      const account = key ? this.coo.verifyOwnerKey(key) : null;
      if (!account) throw new HttpError(401, '这个家长链接不对，或已经失效了');
      const session = this.coo.createSession(account.id);
      if (!session) throw new HttpError(403, '这个家长账户被停用了');
      res.setHeader('set-cookie', this.parentCookie(session.token, req));
      json(res, 200, {
        account: { id: account.id, cooId: account.cooId, displayName: account.displayName },
        expiresAt: session.expiresAt,
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/parent/me') {
      const session = this.parentSession(req);
      json(res, 200, {
        account: { id: session.account.id, cooId: session.account.cooId, displayName: session.account.displayName },
        expiresAt: session.expiresAt,
        seat: this.parentSeatView(session.account.cooId),
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/parent/view') {
      const session = this.parentSession(req);
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      const limit = Number(url.searchParams.get('limit') ?? 30) || 30;
      json(res, 200, this.parentView(session.account.cooId, since, limit));
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/parent/play') {
      const session = this.parentSession(req);
      const body = await readJson(req);
      json(res, 200, this.parentPlay(session.account, body));
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/parent/rename') {
      const session = this.parentSession(req);
      const body = await readJson(req);
      json(res, 200, this.parentRename(session.account, body));
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/parent/logout') {
      const token = cookieOf(req, 'parlor_parent');
      if (token) this.coo.revokeSession(token);
      res.setHeader('set-cookie', this.clearParentCookie(req));
      json(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/me/owner-key/rotate') {
      const cooId = this.cooAuth(req);
      let account = this.coo.byCooId(cooId);
      if (!account) {
        // 迁移过来的老 Coo 可能还没有 accounts 行：第一次要 key 时建一个。
        const ensured = this.coo.ensureAccount(cooId);
        account = ensured.account;
        if (ensured.ownerKey) {
          json(res, 200, { ownerKey: ensured.ownerKey });
          return;
        }
      }
      const key = this.coo.rotateOwnerKey(cooId);
      if (!key) throw new HttpError(409, '轮换失败；稍后再试');
      this.coo.revokeAllSessions(account.id);
      json(res, 200, { ownerKey: key });
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
      const cooId = this.cooOrSeat(req);
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

    if (method === 'POST' && url.pathname === '/v1/dm') {
      const cooId = this.cooOrSeat(req);
      const body = await readJson(req);
      json(res, 200, this.sendDm(cooId, body));
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/dm/threads') {
      const cooId = this.cooOrSeat(req);
      json(res, 200, this.dmThreads(cooId));
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/dm') {
      const cooId = this.cooOrSeat(req);
      const peer = (url.searchParams.get('peer') ?? '').trim();
      if (!peer) throw new HttpError(400, '要看和谁的会话？');
      const before = Number(url.searchParams.get('before') ?? 0) || 0;
      const limit = Number(url.searchParams.get('limit') ?? 50) || 50;
      json(res, 200, this.dmThreadPage(cooId, peer, before, limit));
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/dm/read') {
      const cooId = this.cooOrSeat(req);
      const body = await readJson(req);
      const peer = typeof body.peer === 'string' ? body.peer.trim() : '';
      if (!peer) throw new HttpError(400, '要看和谁的会话？');
      const changed = new MailDb(this.db, { now: this.now }).markThreadRead(cooId, peer);
      json(res, 200, { ok: true, changed });
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/people') {
      const cooId = this.cooOrSeat(req);
      const q = (url.searchParams.get('q') ?? '').trim();
      json(res, 200, this.searchPeople(cooId, q));
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/rooms') {
      const all = url.searchParams.get('all') === '1';
      const cooId = all ? this.cooOrSeat(req) : null;
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
      const account = this.coo.ensureAccount(cooId);
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
      if (!this.allowGuestJoin) {
        throw new HttpError(403, '这个入口已经关闭；请用带钥匙的「下场玩」链接');
      }
      const body = await readJson(req);
      this.checkInvite(req, body);
      const name = typeof body.name === 'string' ? body.name : '';
      const value = typeof body.room === 'string' && body.room.trim() ? body.room.trim() : this.defaultRoomId;
      const room = getRoom(this.db, value) ?? resolveRoom(this.db, value);
      if (!room) throw new HttpError(404, `客厅不存在：${value}`);
      if (room.archivedAt !== null) throw new HttpError(409, '这个客厅已经归档了');
      const cooId = randomUUID();
      const secret = randomBytes(32).toString('base64url');
      this.coo.registerCoo(cooId, secret, 'human', name);
      const host = this.host(room.id);
      const joined = host.join(cooId, { name, kind: 'human', tier: 'off' });
      json(res, 200, {
        room: room.id,
        roomName: room.name,
        seat: seatOfRow(room.id, joined.seat),
        token: joined.token,
        maxSeats: room.capacity,
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
      // 0.13.x 的家长链接是 /v1/owner?token=<每厅 ownerToken>。迁移把哈希存进
      // room_seats.legacy_owner_token_hash；这里认出来就换一个 HttpOnly 会话，跳到新页面。
      const token = url.searchParams.get('token') ?? '';
      if (!token) throw new HttpError(410, '旧家长链接缺 token；请从扩展面板重新拿');
      const hash = createHash('sha256').update(token).digest('hex');
      const seat = this.db.prepare(
        'SELECT room_id, coo_id FROM room_seats WHERE legacy_owner_token_hash = ? LIMIT 1',
      ).get(hash) as { room_id: string; coo_id: string } | undefined;
      if (!seat) throw new HttpError(410, '这个旧家长链接已经失效；请从扩展面板重新拿');
      const account = this.coo.ensureAccount(seat.coo_id);
      const session = this.coo.createSession(account.account.id);
      if (!session) throw new HttpError(403, '这个家长账户被停用了');
      res.writeHead(302, {
        'set-cookie': this.parentCookie(session.token, req),
        location: '/parent',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
      res.end();
      return;
    }

    throw new HttpError(404, '没有这个地址');
  }

  /**
   * 一个人的展示信息：当前席位名优先，其次 coo 显示名。
   * online 只认**正在连着的客户端**（SSE），不认库里有没有旧席位——席位只在主动离开/换厅时释放，
   * 几天没来的人也会留着一个活跃席位，拿它当在线会把人全标成在线。
   */
  private personInfo(cooId: string, fallbackName = ''): { cooId: string; name: string; online: boolean; room: string | null } {
    const seat = activeSeatForCoo(this.db, cooId);
    const row = this.db.prepare('SELECT display_name FROM coos WHERE id = ?').get(cooId) as { display_name?: string } | undefined;
    const name = seat?.name || (row?.display_name ?? '').trim() || fallbackName || '某人';
    return { cooId, name, online: this.isOnline(cooId), room: seat?.roomId ?? null };
  }

  /** 有没有正在连着的客户端（网页或 Coo）；不看席位在不在。 */
  private isOnline(cooId: string): boolean {
    for (const clients of this.sse.values()) {
      for (const client of clients) if (client.cooId === cooId) return true;
    }
    return false;
  }

  /** 找人：优先 cooId（搜索结果带的就是它），退一步按当前唯一同名席位。 */
  private dmPeer(value: string, fromCooId: string): { cooId: string; name: string; online: boolean; room: string | null } {
    const needle = value.trim();
    if (!needle) throw new HttpError(400, '要写给谁？');
    if (isCooId(needle)) {
      const row = this.db.prepare("SELECT id FROM coos WHERE id = ? AND status = 'active'").get(needle);
      if (!row) throw new HttpError(404, '没有这个人');
      return this.personInfo(needle);
    }
    const bySeatId = this.db.prepare(
      'SELECT coo_id FROM room_seats WHERE released_at IS NULL AND id = ?',
    ).get(needle) as { coo_id: string } | undefined;
    if (bySeatId) return this.personInfo(bySeatId.coo_id);
    const seats = this.db.prepare(
      'SELECT coo_id FROM room_seats WHERE released_at IS NULL AND name = ? COLLATE NOCASE',
    ).all(needle) as { coo_id: string }[];
    const ids = [...new Set(seats.map((row) => row.coo_id))].filter((id) => id !== fromCooId);
    if (ids.length === 1) return this.personInfo(ids[0]);
    if (ids.length > 1) throw new HttpError(409, '有多个同名的人，用搜索结果选一个');
    // 不在座的人：按 coo 显示名再找一次，这样 Coo 能回已经走开的私聊。
    const coos = this.db.prepare(
      "SELECT id FROM coos WHERE status = 'active' AND display_name = ? COLLATE NOCASE",
    ).all(needle) as { id: string }[];
    const names = [...new Set(coos.map((row) => row.id))].filter((id) => id !== fromCooId);
    if (names.length === 1) return this.personInfo(names[0]);
    if (names.length > 1) throw new HttpError(409, '有多个同名的人，用搜索结果选一个');
    throw new HttpError(404, `没有找到「${needle}」（离线的人要用搜索结果选）`);
  }

  /** 私聊：对方离线也照常投信箱；在线时顺手往他所在的客厅推一条事件。 */
  private sendDm(cooId: string, body: Record<string, unknown>): Record<string, unknown> {
    const seat = activeSeatForCoo(this.db, cooId);
    if (!seat) throw new HttpError(403, '你不在任何客厅里；先进一个客厅再发私聊');
    const peer = this.dmPeer(typeof body.to === 'string' ? body.to : '', cooId);
    if (peer.cooId === cooId) throw new HttpError(400, '不能给自己发私聊');
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw new HttpError(400, '消息不能是空的');
    if (text.length > 2000) throw new HttpError(400, '一条最多 2000 字');
    this.checkDmRate(cooId);
    const letter = new MailDb(this.db, { now: this.now }).append({
      to: peer.cooId,
      fromCooId: cooId,
      room: seat.roomId,
      kind: 'whisper',
      fromName: seat.name,
      text,
    });
    const target = activeSeatForCoo(this.db, peer.cooId);
    if (target) {
      try {
        this.host(target.roomId).whisperNotice(cooId, seat.name, {
          cooId: target.cooId, id: target.id, name: target.name,
        }, text);
      } catch { /* 推事件失败不影响信 */ }
    }
    return {
      message: { seq: letter.seq, ts: letter.ts, text: letter.text, fromName: seat.name, fromMe: true, unread: false },
      peer,
    };
  }

  private dmThreads(cooId: string): Record<string, unknown> {
    const mail = new MailDb(this.db, { now: this.now });
    const threads = mail.threads(cooId).map((thread) => {
      const info = this.personInfo(thread.peer);
      return { ...thread, name: info.name, online: info.online, room: info.room };
    });
    return { threads, unread: mail.dmUnread(cooId) };
  }

  private dmThreadPage(cooId: string, peer: string, before: number, limit: number): Record<string, unknown> {
    if (!isCooId(peer)) throw new HttpError(400, '对方身份不对');
    const page = new MailDb(this.db, { now: this.now }).thread(cooId, peer, before, limit);
    return { peer: this.personInfo(peer), ...page };
  }

  /** 搜人：在线的人 + 我聊过的人；空查询就是全部候选。 */
  private searchPeople(cooId: string, query: string): Record<string, unknown> {
    const needle = query.trim().toLowerCase();
    const rows = this.db.prepare(
      "SELECT id, display_name FROM coos WHERE status = 'active' AND id <> ?",
    ).all(cooId) as { id: string; display_name: string }[];
    const past = new Set(new MailDb(this.db, { now: this.now }).threads(cooId).map((thread) => thread.peer));
    const people = rows
      .map((row) => this.personInfo(row.id, row.display_name))
      .filter((person) => (person.online || past.has(person.cooId))
        && (!needle || person.name.toLowerCase().includes(needle)))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, 'zh'))
      .slice(0, 20);
    return { people };
  }

  private readonly dmTimes = new Map<string, number[]>();

  private checkDmRate(cooId: string): void {
    const now = this.now();
    const times = (this.dmTimes.get(cooId) ?? []).filter((at) => at >= now - 3_600_000);
    if (times.filter((at) => at >= now - 60_000).length >= 20) throw new HttpError(429, '发得太快了，过一会儿再发');
    if (times.length >= 200) throw new HttpError(429, '一小时内最多 200 条私聊');
    times.push(now);
    this.dmTimes.set(cooId, times);
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
      // 这个接口原来不校验邀请码：知道房间 id 就能用一个新身份进来（lobby 这种 id 猜得到）。
      // 已有身份（cookies 里的 cooId+secret 认得出来）换房不受影响；新身份必须带邀请码。
      if (this.identify(req) === null) this.checkInvite(req, body);
      const cooId = this.cooAuth(req, name);
      const host = this.host(roomId);
      const joined = host.join(cooId, {
        name,
        ...(typeof body.kind === 'string' ? { kind: body.kind as SeatKind } : {}),
        ...(typeof body.tier === 'string' ? { tier: body.tier as WakeTier } : {}),
      });
      const account = this.coo.ensureAccount(cooId);
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
        // 私聊走全局那条：对方在别的客厅或不在线也照样投信箱（Coo 也能跨厅回）。
        const result = this.sendDm(seat.cooId, body);
        const message = result.message as { seq: number; ts: number };
        delivered = [{
          to: (result.peer as { name: string }).name,
          mailSeq: message.seq,
          ts: message.ts,
          at: serverClock(message.ts),
        }];
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
      } else {
        // 牌桌动作按注册表分发：加一个游戏不用再改这里，只要它在 games/registry.ts 里登记过。
        const game = gameByActionType(type);
        if (game) {
          if (host.tablePublic()?.game !== game.id) {
            throw new HttpError(400, `这张桌子不是${game.label}桌`);
          }
          const receipt = host.tableAction(seat.cooId, game.toAction(body));
          deadline = receipt.deadline;
          turn = receipt.turn;
        } else if (type === 'monopoly') {
          throw new HttpError(400, '这台服务器只跑骰子与斗地主；大富翁请用旧服务器');
        } else {
          throw new HttpError(400, '未知动作');
        }
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
    touchSeatSeen(this.db, roomId, seat.id, this.now());
    req.on('close', () => {
      clients?.delete(client);
      if (clients?.size === 0) this.sse.delete(roomId);
      try { touchSeatSeen(this.db, roomId, seat.id, this.now()); } catch { /* 席位已释放/库关了 */ }
    });
  }

  private checkParentKeyRate(req: IncomingMessage): void {
    const ip = (headerValue(req, 'x-forwarded-for').split(',')[0] || req.socket.remoteAddress || 'unknown').trim();
    const now = this.now();
    const cutoff = now - 3_600_000;
    const times = (this.parentKeyTimes.get(ip) ?? []).filter((at) => at >= cutoff);
    if (times.length >= 10) throw new HttpError(429, '试得太多了，过一会儿再试');
    times.push(now);
    this.parentKeyTimes.set(ip, times);
  }

  private parentCookie(token: string, req: IncomingMessage): string {
    const secure = headerValue(req, 'x-forwarded-proto') === 'https' ? '; Secure' : '';
    return `parlor_parent=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(30 * 24 * 3600)}${secure}`;
  }

  private clearParentCookie(req: IncomingMessage): string {
    const secure = headerValue(req, 'x-forwarded-proto') === 'https' ? '; Secure' : '';
    return `parlor_parent=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`;
  }

  private parentSession(req: IncomingMessage) {
    const token = cookieOf(req, 'parlor_parent');
    const session = token ? this.coo.verifySession(token) : null;
    if (!session) throw new HttpError(401, '家长会话已失效，请重新打开家长链接');
    return session;
  }

  private parentSeatView(cooId: string) {
    const seat = activeSeatForCoo(this.db, cooId);
    if (!seat) return null;
    const room = getRoom(this.db, seat.roomId);
    return {
      room: seat.roomId,
      roomName: room?.name ?? seat.roomId,
      id: seat.id,
      name: seat.name,
      kind: seat.kind,
      tier: seat.tier,
    };
  }

  /**
   * 家长下场：用家长会话给自己领一个 human 席位。
   * 玩家身份固定在 `accounts.player_coo_id` 上——同一个家长链接在任何浏览器都是同一个人；
   * 账本/筹码与孩子那份分开（孩子是 Coo 的 cooId，家长玩家是另一个 human coo）。
   */
  private parentPlay(account: ParentAccount, body: Record<string, unknown>): Record<string, unknown> {
    const requested = typeof body.room === 'string' && body.room.trim() ? body.room.trim() : '';
    const childSeat = activeSeatForCoo(this.db, account.cooId);
    const wanted = requested || childSeat?.roomId || this.defaultRoomId;
    const target = getRoom(this.db, wanted) ?? resolveRoom(this.db, wanted);
    if (!target) throw new HttpError(404, `客厅不存在：${wanted}`);
    if (target.archivedAt !== null) throw new HttpError(409, '这个客厅已经归档了');

    const player = this.ensurePlayerCoo(account, typeof body.name === 'string' ? body.name : '');
    let seat = activeSeatForCoo(this.db, player.cooId);
    let token: string;
    if (!seat) {
      const joined = this.host(target.id).join(player.cooId, {
        name: player.name, kind: 'human', tier: 'off',
      });
      seat = joined.seat;
      token = joined.token;
    } else if (seat.roomId === target.id) {
      const reissued = this.host(target.id).reissueSeatToken(player.cooId);
      seat = reissued.seat;
      token = reissued.token;
    } else {
      const moved = this.host(seat.roomId).switchTo(player.cooId, target.id, { name: player.name });
      seat = moved.seat;
      token = moved.token;
    }
    return {
      room: target.id,
      roomName: target.name,
      seat: seatOfRow(target.id, seat),
      token,
      identity: { cooId: player.cooId, cooSecret: player.secret },
      player: true,
    };
  }

  /**
   * 家长改名字：账户显示名 + 玩家身份名 + 当前席位名一次改完。
   * 还没下过场就顺手把玩家身份建出来，免得第一次下场又回到默认名。
   */
  private parentRename(account: ParentAccount, body: Record<string, unknown>): Record<string, unknown> {
    const raw = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    if (!raw) throw new HttpError(400, '名字不能为空');
    if (raw.length > 24) throw new HttpError(400, '名字最多 24 个字');

    const playerId = this.coo.playerCooOf(account.id);
    let seat: { room: string; id: string; name: string } | null = null;
    if (playerId) {
      const active = activeSeatForCoo(this.db, playerId);
      if (active) {
        // 同厅重名会抛 RoomSeatError('name_taken')，由 statusOf 转成 409。
        renameSeat(this.db, active.roomId, active.id, raw);
        seat = { room: active.roomId, id: active.id, name: raw };
      }
      this.coo.renameCooDisplay(playerId, raw);
    }
    const renamed = this.coo.rename(account.id, raw);
    if (!renamed) throw new HttpError(409, '改不了名字');
    if (!playerId) this.ensurePlayerCoo(renamed, raw);
    return {
      account: { id: renamed.id, cooId: renamed.cooId, displayName: renamed.displayName },
      seat,
    };
  }

  /** 家长玩家的固定 human 身份；每次下场换一枚新 secret（库里只存哈希）。 */
  private ensurePlayerCoo(account: ParentAccount, requested = ''): { cooId: string; secret: string; name: string } {
    const secret = randomBytes(32).toString('base64url');
    const existing = this.coo.playerCooOf(account.id);
    if (existing) {
      const name = this.coo.cooDisplayName(existing) || this.defaultPlayerName(account);
      this.coo.rotateSecret(existing, secret);
      return { cooId: existing, secret, name: name.slice(0, 24) };
    }
    const name = (requested.trim() || this.defaultPlayerName(account)).slice(0, 24);
    const cooId = randomUUID();
    const created = this.coo.registerCoo(cooId, secret, 'human', name);
    if (created !== 'ok') throw new HttpError(500, '建不了家长的游戏身份');
    this.coo.bindPlayerCoo(account.id, cooId);
    return { cooId, secret, name };
  }

  /** 家长玩家的默认名「<孩子名>家的家长」；孩子不在座就退回孩子的显示名，最后退回「家长」。 */
  private defaultPlayerName(account: ParentAccount): string {
    const seat = activeSeatForCoo(this.db, account.cooId);
    const child = (seat?.name || this.coo.cooDisplayName(account.cooId) || '').trim();
    return child ? `${child}家的家长` : '家长';
  }

  /** 家长只读视图：跟孩子当前席位走，可见范围与孩子自己完全一致。 */
  private parentView(cooId: string, since: number, limit: number): Record<string, unknown> {
    const now = this.now();
    const seat = activeSeatForCoo(this.db, cooId);
    const mail = new MailDb(this.db, { now: this.now });
    if (!seat) {
      return {
        seat: null,
        room: null,
        latest: 0,
        now,
        at: serverClock(now),
        events: [],
        tablePrivate: null,
        mail: [],
        mailUnread: mail.unreadCount(cooId),
      };
    }
    const room = getRoom(this.db, seat.roomId);
    const host = this.host(seat.roomId);
    const snapshot = host.snapshot(cooId, { since, limit });
    return {
      seat: snapshot.seat,
      room: { id: seat.roomId, name: room?.name ?? seat.roomId, kind: room?.kind ?? 'room' },
      latest: snapshot.latest,
      now: snapshot.now,
      at: snapshot.at,
      events: snapshot.events,
      ...(snapshot.table ? { table: snapshot.table } : {}),
      tablePrivate: snapshot.tablePrivate ?? null,
      ...(snapshot.ledger ? { ledger: snapshot.ledger } : {}),
      ledgerRoom: snapshot.ledgerRoom ?? [],
      mailUnread: snapshot.mailUnread ?? 0,
      mail: mail.recent(cooId, undefined, 5),
      ownerPrivateHidden: false,
    };
  }

  /** 回放是 7 天；事件表只增不减会一直长，所以每小时清一次。 */
  private pruneEvents(now: number): void {
    const before = now - 7 * 24 * 60 * 60_000;
    const rooms = this.db.prepare('SELECT id FROM rooms').all() as { id: string }[];
    for (const room of rooms) {
      try {
        this.host(room.id).pruneEvents(before, 500);
      } catch (error) {
        console.error(`parlor: 清理事件失败（${room.id}）`, error);
      }
    }
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
    if (pathname === '/parent' || pathname === '/parent/') {
      this.sendWeb('parent.html', res, true);
      return true;
    }
    const prefix = pathname.startsWith('/parent/assets/') ? '/parent/assets/' : '/play/assets/';
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
