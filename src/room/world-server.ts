import { touchActivity } from './activity.ts';
import { RoomLifecycle } from './lifecycle.ts';
import { personalHistory } from './personal-account.ts';
import { EventDb } from './event-db.ts';
import { historySyncEvent } from './history-sync.ts';
/**
 * 多客厅 HTTP 网关（聊天切片）。
 *
 * 一条进程、一个 SQLite 库、多个客厅；每房一个 RoomHost。
 * 现有旧 World 通过 `/v1/...` 别名落到默认客厅；新客户端走 `/v1/rooms/:id/...`。
 * 牌桌/家长门户/大厅目录还没接进来；这一步先把多房 + 可见区间 + 全局账户跑通。
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { isCooId, isCooSecret } from './ledger.ts';
import { serverClock } from './clock.ts';
import { AccountLimitError, CooAccountDb, parentAccountName, type ParentAccount } from './coo-account-db.ts';
import { migrate, withTransaction, type Db } from './db.ts';
import { openStorage, type StorageKind } from './storage/open.ts';
import { HALL_CAPACITY } from './schema.ts';
import { LedgerDb } from './ledger-db.ts';
import { MailDb } from './mail-db.ts';
import { gameByActionType, gameById } from './games/registry.ts';
import { GAME_ACTION_SCHEMA, compactGameState, describeGame, gameActionBody, gameCatalog, gameState, validateParameters } from './game-api.ts';
import { GAME_RESPONSE_MAX_BYTES, type TableLogQuery } from './table-engine.ts';
import { likePrefix, parseHandleQuery } from './handles.ts';
import { isBlockedPort } from './ports.ts';
import { GLOBAL_HEADER, IdentityRegistry, enableGlobalIdentity, registeredHandle, identityOrigin, identityRequest, type GlobalPerson } from './global-identity.ts';
import { HostError, RoomHost } from './room-host.ts';
import {
  RoomSeatError, activeSeatForCoo, activeSeats, archive, unarchive, createRoom, getRoom, hashSeatToken,
  listRooms, memberOf, renameSeat, resolveRoom, seatByTokenHash, seatsForOfflineRelease,
  touchSeatSeen, type RoomRow,
} from './room-seat-db.ts';
import {
  acceptInvitationTx, canManageRoom, createRoomInvitationTx, declineInvitationTx,
  expireInvitations, findInvitation, grantRoomAccessTx, hasRoomAccess, isRoomOwner,
  listRoomAccess, pendingInvitationsForCoo, pendingInvitationsForRoom, revokeInvitationsFor,
  revokeRoomAccessTx, roomEntryRefusal,
} from './room-access-db.ts';
import type { RoomEvent, RoomSnapshot, Seat, SeatKind, WakeTier } from './protocol.ts';
import { acceptsGzip, sendWebAsset } from './web-assets.ts';
import { SupportDb } from './support-db.ts';
import { TableDiscovery } from './table-discovery.ts';
import { RecruitSnapshot } from './recruit-snapshot.ts';

export interface WorldServerOptions {
  /** 独立运营钥匙；不是房主的 ownerKey，不配置则关闭运营写入口。 */
  operatorKey?: string;
  /** 服务端只支持 PostgreSQL。 */
  storage?: StorageKind;
  /** 已停用的旧参数；传入会报错，不会创建 SQLite。 */
  dbFile?: string;
  /** PostgreSQL 连接串；storage=postgres 时必填，缺了直接报错。 */
  databaseUrl?: string;
  /** 连接池上限（只对 PostgreSQL 生效）。 */
  poolMax?: number;
  /** 单条语句超时毫秒（只对 PostgreSQL 生效）。 */
  statementTimeoutMs?: number;
  /** self = 本机提供统一身份；URL = 信任该身份服务；省略保留旧协议。 */
  identityAuthority?: string;
  /** 反向代理后的公开源地址；临时通行证只能用于这个目标。 */
  publicUrl?: string;
  host?: string;
  port?: number;
  defaultRoomId?: string;
  inviteCode?: string;
  /** 网页「用户名 + 邀请码」的访客入口；默认关。 */
  allowGuestJoin?: boolean;
  /** 真人席位离线多少小时后释放；默认 6，0 = 关。 */
  offlineReleaseHours?: number;
  /** 家长账户上限（应用层容量，不是库级约束）；默认 DEFAULT_ACCOUNT_LIMIT。 */
  accountLimit?: number;
  /** Coo 的 pet 席位离线多少小时后释放；默认 6，0 = 关。 */
  cooOfflineReleaseHours?: number;
  cooIdleMinutes?: number;
  roomArchiveHours?: number;
  /** 牌桌每手/每窗时限基准（staging/测试调短用；不传用各游戏默认）。 */
  tableTurnMs?: number;
  now?: () => number;
}

interface SseClient {
  locationCapable: boolean;
  cooId: string;
  seatId: string;
  seatName: string;
  since: number;
  lastPing: number;
  openedAt: number;
  /** 谁先关的：服务端主动收（席位没了/写失败）时写原因，客户端断则留空。 */
  closeReason?: string;
  closed: boolean;
  blockedAt?: number;
  res: ServerResponse;
}

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

const json = (res: ServerResponse, status: number, body: unknown, req?: IncomingMessage): void => {
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

function boundedGameJson(res: ServerResponse, body: unknown): void {
  if (Buffer.byteLength(JSON.stringify(body)) > GAME_RESPONSE_MAX_BYTES) {
    throw new HttpError(413, '游戏查询结果超出大小限制；历史请缩小范围后分页查询');
  }
  json(res, 200, body);
}

function gameLogQuery(params: URLSearchParams): TableLogQuery {
  const query: TableLogQuery = { review: ['true', '1'].includes(params.get('review') ?? '') };
  for (const key of ['day', 'seatNo', 'limit'] as const) {
    if (!params.has(key)) continue;
    const value = Number(params.get(key));
    if (!Number.isSafeInteger(value) || value < 1 || (key === 'limit' && value > 200)) {
      throw new HttpError(400, `${key} 要是正整数（limit ≤ 200）`);
    }
    query[key] = value;
  }
  const cursor = params.get('cursor');
  if (cursor !== null) {
    if (!cursor || cursor.length > 64) throw new HttpError(400, '历史游标无效');
    query.cursor = cursor;
  }
  return query;
}

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
  // 账户表满 = 服务端容量问题，回 503（可等房主扩容后再试），不要报成 500「服务端出错」。
  if (error instanceof AccountLimitError) return 503;
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

/**
 * 时钟的兜底拍：就算所有客厅都说「没东西要推进」，最多睡这么久也要醒一次，
 * 兜住漏掉的 poke（比如别处直接改了库）。有牌局在跑时这一拍只是一次空扫：
 * 没到点的桌不进 hydrate、不查库，省下来的正是每桌每秒的那份开销。
 */
const CLOCK_SAFETY_MS = 1_000;
/** 一张桌、一条承诺都没有时的空扫间隔：只是看一眼有没有新席位/新牌局。 */
const CLOCK_IDLE_MS = 10_000;

const messageOf = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const seatOfRow = async (db: Db, roomId: string, seat: {
  id: string; name: string; kind: SeatKind; tier: WakeTier; joinedAt: number; cooId: string;
}): Promise<Seat> => ({
  id: seat.id, name: seat.name, kind: seat.kind, tier: seat.tier, joinedAt: seat.joinedAt,
  handle: await registeredHandle(db, seat.cooId),
});

const roomSummary = async (db: Db, room: RoomRow) => {
  const tables = await db.prepare(
    "SELECT game, COUNT(*) AS n FROM tables WHERE room_id = ? AND status IN ('open', 'bidding', 'playing') GROUP BY game ORDER BY game",
  ).all(room.id) as { game: string; n: number }[];
  return {
    id: room.id,
    kind: room.kind,
    name: room.name,
    topic: room.topic,
    visibility: room.visibility,
    capacity: room.capacity,
    seats: (await activeSeats(db, room.id)).filter((seat) => seat.kind !== 'observer').length,
    tableCount: tables.reduce((total, row) => total + Number(row.n), 0),
    games: tables.map(row => row.game),
    archived: room.archivedAt !== null,
    lastActiveAt: room.lastActiveAt,
  };
};

export class WorldServer {
  private readonly db: Db;
  private readonly operatorHash?: Buffer;
  private readonly identityAuthority?: string;
  private readonly publicUrl?: string;
  private readonly registry: IdentityRegistry;
  private readonly verifiedPeople = new WeakMap<IncomingMessage, GlobalPerson>();
  private readonly identityRates = new Map<string, { until: number; count: number }>();
  private readonly coo: CooAccountDb;
  private readonly tableDiscovery: TableDiscovery;
  /** 招募快照按网关共享 30 秒：132 个 Coo 每分钟要的是同一份，不必各查一次。 */
  private readonly recruitSnapshot: RecruitSnapshot;
  private readonly now: () => number;
  private readonly defaultRoomId: string;
  private readonly inviteCode: string;
  private readonly allowGuestJoin: boolean;
  private readonly offlineReleaseMs: number;
  private readonly cooOfflineReleaseMs: number;
  private readonly tableTurnMs?: number;
  private readonly lifecycle: RoomLifecycle;
  private readonly hostName: string;
  private readonly port: number;
  private server?: Server;
  private baseUrl = '';
  private readonly sse = new Map<string, Set<SseClient>>();
  private pumpTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private janitorTimer?: NodeJS.Timeout;
  private janitorFirstTimer?: NodeJS.Timeout;
  /** 启动恢复基准：进程起来时读一次旧的 last_healthy_at，所有客厅共用。 */
  private readonly recovery: { lastHealthyAt?: number };
  private lastHeartbeatAt = 0;
  /** 每厅一个 RoomHost：牌桌引擎在内存里，必须跨请求共用同一个实例。 */
  private readonly hosts = new Map<string, RoomHost>();
  /** 正在建、还没建完的 host：同一客厅并发首访共用同一个 Promise，不会建出两份。 */
  private readonly hostPending = new Map<string, Promise<RoomHost>>();
  /** 定向邀请的限频：每个 Coo 一小时的发送时刻。 */
  private readonly inviteTimes = new Map<string, number[]>();
  /** 家长链接试错限频：每个 IP 一小时最多 10 次。 */
  private readonly parentKeyTimes = new Map<string, number[]>();
  /** 事件清理：每小时一次，超过 7 天且不在最后 500 条的删掉。 */
  private lastPrune = 0;
  /** 推送循环与客厅时钟改成异步后，上一轮没跑完就跳过这一轮（原来同步循环天然串行）。 */
  private pumping = false;
  private clocking = false;
  private closing = false;
  /** 时钟是「睡到下一次要推进的时刻」的自调度定时器，不是每秒 setInterval。 */
  private clockTimer?: NodeJS.Timeout;
  private clockAt = 0;
  /** 有新事件的客厅：提交后立刻推，不等节拍。 */
  private readonly dirtyRooms = new Set<string>();
  private pumpScheduled = false;
  private lastSweepAt = 0;
  /** 大厅 id 的同步快照：init() 建完大厅后填上，供 hallId 这个同步属性读。 */
  private hallIdValue = '';

  private constructor(db: Db, options: WorldServerOptions = {}) {
    this.db = db;
    if (options.operatorKey) this.operatorHash = createHash('sha256').update(options.operatorKey).digest();
    this.now = options.now ?? Date.now;
    this.tableDiscovery = new TableDiscovery(db, (room) => this.host(room), this.now);
    this.recruitSnapshot = new RecruitSnapshot(db, this.now);
    this.coo = new CooAccountDb(this.db, {
      now: this.now,
      ...(options.accountLimit !== undefined ? { limit: options.accountLimit } : {}),
    });
    this.identityAuthority = options.identityAuthority === 'self' ? 'self'
      : options.identityAuthority ? identityOrigin(options.identityAuthority) : undefined;
    this.publicUrl = options.publicUrl ? identityOrigin(options.publicUrl) : undefined;
    this.registry = new IdentityRegistry(this.db, this.now);
    this.defaultRoomId = options.defaultRoomId ?? 'lobby';
    this.inviteCode = options.inviteCode ?? '';
    this.allowGuestJoin = options.allowGuestJoin ?? false;
    this.offlineReleaseMs = Math.max(0, options.offlineReleaseHours ?? 6) * 3_600_000;
    this.cooOfflineReleaseMs = Math.max(0, options.cooOfflineReleaseHours ?? 6) * 3_600_000;
    this.tableTurnMs = options.tableTurnMs !== undefined && options.tableTurnMs > 0 ? options.tableTurnMs : undefined;
    this.hostName = options.host ?? '127.0.0.1';
    this.port = options.port ?? 0;
    // 启动恢复基准在 init() 里读；构造函数只落字段，不碰库。
    this.recovery = {};
    this.lifecycle = new RoomLifecycle(db, room => this.host(room), () => this.hallIdValue, this.defaultRoomId,
      (options.cooIdleMinutes ?? 300) * 60_000, (options.roomArchiveHours ?? 48) * 3_600_000,
      cooId => [...this.sse.values()].every(clients => [...clients].every(client => client.cooId !== cooId || client.closed || client.locationCapable)));
  }

  /**
   * 开库 + 迁移 + 初始化，全部完成后才返回。
   * 迁移是异步的，服务必须先 await 完迁移再开始接请求，所以构造不能是同步的。
   */
  static async create(options: WorldServerOptions = {}): Promise<WorldServer> {
    // 服务端缺少 PG 连接串时立即失败，不回退到本地空库。
    const db = await openStorage({
      storage: options.storage ?? 'postgres',
      ...(options.dbFile !== undefined ? { file: options.dbFile } : {}),
      ...(options.databaseUrl !== undefined ? { url: options.databaseUrl } : {}),
      ...(options.poolMax !== undefined ? { poolMax: options.poolMax } : {}),
      ...(options.statementTimeoutMs !== undefined ? { statementTimeoutMs: options.statementTimeoutMs } : {}),
    });
    await migrate(db);
    const server = new WorldServer(db, options);
    await server.init();
    return server;
  }

  /** 迁移之后的一次性初始化：建系统身份、默认客厅与大厅，读上次健康心跳。 */
  private async init(): Promise<void> {
    if (this.identityAuthority) await enableGlobalIdentity(this.db);
    await this.ensureDefaultRoom();
    const healthy = await this.db.prepare("SELECT value FROM meta WHERE key = 'last_healthy_at'").get() as
      { value?: string } | undefined;
    const lastHealthyAt = Number(healthy?.value ?? '');
    if (Number.isFinite(lastHealthyAt) && lastHealthyAt > 0) this.recovery.lastHealthyAt = lastHealthyAt;
  }

  get url(): string {
    return this.baseUrl;
  }

  get dbHandle(): Db {
    return this.db;
  }

  async listen(): Promise<{ url: string; host: string; port: number }> {
    // 先把所有有未结束牌局的客厅建出来：恢复要在开始接请求之前完成。
    await this.recoverOpenTables();
    const makeServer = (): Server => createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        if (res.headersSent) {
          try { res.end(); } catch { /* 已断开 */ }
          return;
        }
        if (statusOf(error) >= 500) console.error('parlor: 请求失败', { method: req.method, path: new URL(req.url ?? '/', 'http://localhost').pathname, error: messageOf(error) });
        json(res, statusOf(error), { error: messageOf(error) });
      });
    });
    const bind = (): Promise<number> => new Promise<number>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: unknown): void => reject(error);
      server.once('error', onError);
      server.listen(this.port, this.hostName, () => {
        server.removeListener('error', onError);
        resolve((server.address() as AddressInfo).port);
      });
    });
    let assigned = 0;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      this.server = makeServer();
      assigned = await bind();
      // 端口 0 由系统分配，偶尔会落到 fetch 规范禁用的端口（undici 直接报 bad port）。
      // 这时换一个：只在「让系统分配」时有这个问题，生产固定端口不会走这条。
      if (this.port !== 0 || !isBlockedPort(assigned)) break;
      const server = this.server;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const address = this.server!.address() as AddressInfo;
    const host = this.hostName === '0.0.0.0' || this.hostName === '::' ? '127.0.0.1' : this.hostName;
    this.baseUrl = `http://${host}:${address.port}`;
    // 定时器回调是异步的：统一吞掉拒绝并打日志，别让一次库错误变成 unhandled rejection。
    this.pumpTimer = setInterval(() => {
      void this.pump().catch((error) => { console.error('parlor: 推送循环出错', error); });
    }, 400);
    this.pumpTimer.unref?.();
    // 时钟不再每秒空转：睡到「下一次要推进的时刻」。动作提交后会 poke 一次，
    // 所以新产生的更早截止不会等满这一觉。
    this.scheduleClock(this.now());
    // 健康心跳：只反映「进程和数据库都能写」。有未结束牌局时每 5 秒一次。
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat().catch((error) => { console.error('parlor: 健康心跳写入失败', error); });
    }, 5_000);
    this.heartbeatTimer.unref?.();
    await this.heartbeat(true);
    // 离线席位清理（真人 + Coo）：每 5 分钟一次；刚启动 10 秒先扫一遍（这时还没有 SSE）。
    this.janitorTimer = setInterval(() => {
      void this.runLifecycle().catch(error => console.error('parlor: 生命周期维护失败', error));
      void this.releaseOfflineSeats().catch((error) => { console.error('parlor: 离线席位清理失败', error); });
    }, 5 * 60_000);
    this.janitorTimer.unref?.();
    this.janitorFirstTimer = setTimeout(() => {
      void this.runLifecycle().catch(error => console.error('parlor: 生命周期维护失败', error));
      void this.releaseOfflineSeats().catch((error) => { console.error('parlor: 离线席位清理失败', error); });
    }, 10_000);
    this.janitorFirstTimer.unref?.();
    return { url: this.baseUrl, host: this.hostName, port: address.port };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    this.pumpTimer = undefined;
    if (this.clockTimer) clearTimeout(this.clockTimer);
    this.clockTimer = undefined;
    this.clockAt = 0;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    // 等正在跑的推送/时钟收尾：它们的 await 还挂在库上，直接关池会报
    // 「Cannot use a pool after calling end on the pool」。
    for (let wait = 0; wait < 100 && (this.pumping || this.clocking); wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // 正常退出：把准确停止时刻记下来，下次启动算停机时长才有意义。
    try { await this.heartbeat(true); } catch { /* 库可能已经坏了 */ }
    if (this.janitorTimer) clearInterval(this.janitorTimer);
    this.janitorTimer = undefined;
    if (this.janitorFirstTimer) clearTimeout(this.janitorFirstTimer);
    this.janitorFirstTimer = undefined;
    this.hosts.clear();
    this.hostPending.clear();
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
    await this.db.close();
  }

  private async ensureDefaultRoom(): Promise<void> {
    const system = 'system-owner';
    // INSERT OR IGNORE → 两种后端都认的 ON CONFLICT DO NOTHING。
    await this.db.prepare(
      'INSERT INTO coos(id, kind, display_name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
    ).run(system, 'system', '系统', this.now());
    if (!(await getRoom(this.db, this.defaultRoomId))) {
      await createRoom(this.db, {
        id: this.defaultRoomId,
        name: '默认客厅',
        ownerCooId: system,
        visibility: 'unlisted',
      }, this.now());
    }
    await this.ensureHall();
  }

  /** 大厅是特殊客厅（kind = 'hall'）：有席位、能说话，但不进目录、没有牌桌。 */
  private async ensureHall(): Promise<RoomRow> {
    const existing = await this.db.prepare("SELECT id FROM rooms WHERE kind = 'hall' LIMIT 1").get() as { id: string } | undefined;
    if (existing) {
      const row = (await getRoom(this.db, existing.id))!;
      this.hallIdValue = row.id;
      return row;
    }
    const now = this.now();
    // 大厅靠 ux_rooms_hall 唯一：并发首访时后到的那条静默跳过，再把已有行读出来。
    await this.db.prepare(
      `INSERT INTO rooms(id, kind, name, owner_coo_id, visibility, capacity, topic, epoch, seq, created_at, last_active_at)
       VALUES (?, 'hall', ?, NULL, 'public', ?, ?, ?, 0, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).run('hall', '大厅', HALL_CAPACITY, '所有客厅的入口：看谁在线、有哪些客厅、去哪串门。', randomUUID(), now, now);
    const row = (await getRoom(this.db, 'hall'))!;
    this.hallIdValue = row.id;
    return row;
  }

  /** 大厅 id：init() 里一定建过，之后同步读（老调用方把它当属性用）。 */
  get hallId(): string {
    return this.hallIdValue;
  }

  private host(roomId: string): Promise<RoomHost> {
    const existing = this.hosts.get(roomId);
    if (existing) return Promise.resolve(existing);
    const pending = this.hostPending.get(roomId);
    if (pending) return pending;
    const created = RoomHost.create(this.db, roomId, {
      now: this.now,
      ...(this.tableTurnMs !== undefined ? { turnMs: this.tableTurnMs } : {}),
      recovery: this.recovery,
      onCommit: (id: string) => this.markDirty(id),
    }).then((host) => {
      this.hosts.set(roomId, host);
      this.hostPending.delete(roomId);
      return host;
    }, (error: unknown) => {
      // 恢复失败不留下坏缓存：下一个请求重试一次。
      this.hostPending.delete(roomId);
      throw error;
    });
    this.hostPending.set(roomId, created);
    return created;
  }

  /** 统一准入：初次加入、换房、家长下场、邀请跳转、重发令牌都先过这里。 */
  private async assertRoomEntry(roomId: string, cooId: string): Promise<void> {
    const refusal = await roomEntryRefusal(this.db, roomId, cooId);
    if (refusal) throw new HttpError(403, refusal);
  }

  /** 房主管理权限：房主本人（身份凭证或有效席位令牌）或该房主的家长管理会话。 */
  private async roomManager(req: IncomingMessage, roomId: string): Promise<string> {
    const cookie = cookieOf(req, 'parlor_parent');
    if (cookie) {
      const session = await this.coo.verifySession(cookie);
      if (session && await isRoomOwner(this.db, roomId, session.account.cooId)) return session.account.cooId;
    }
    const cooId = await this.cooOrSeat(req);
    if (cooId && await isRoomOwner(this.db, roomId, cooId)) return cooId;
    throw new HttpError(403, '只有房主（或房主的家长会话）能管理这个客厅');
  }

  /**
   * 启动恢复：所有还有未结束牌局的客厅都要先建出 host（恢复在 RoomHost.create 里做），
   * 不能等某个房间第一次被访问才恢复。
   */
  private async recoverOpenTables(): Promise<void> {
    const rows = await this.db.prepare(
      `SELECT DISTINCT room_id FROM tables WHERE status IN ('open','bidding','playing')`,
    ).all() as { room_id: string }[];
    for (const row of rows) {
      try {
        await this.host(row.room_id);
      } catch (error) {
        console.error(`parlor: 客厅 ${row.room_id} 的牌桌恢复失败`, error);
      }
    }
  }

  /**
   * 健康心跳：写进去本身就是一次数据库可用性检查。
   * 只有存在未结束牌局时才需要（它只用来算停机时长）。
   */
  private async heartbeat(force = false): Promise<void> {
    const now = this.now();
    if (!force && now - this.lastHeartbeatAt < 5_000) return;
    const live = await this.db.prepare(
      `SELECT 1 AS hit FROM tables WHERE status IN ('open','bidding','playing') LIMIT 1`,
    ).get() as { hit: number } | undefined;
    if (!force && !live) return;
    await this.db.prepare(
      `INSERT INTO meta(key, value) VALUES('last_healthy_at', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(now));
    this.lastHeartbeatAt = now;
  }

  /**
   * 睡到下一次需要推进的时刻。同一时刻已经有更早的定时器就不动它；
   * 运行期 poke 进来的更早时刻会把这一觉叫醒。
   */
  private scheduleClock(at: number): void {
    if (this.closing) return;
    if (this.clockTimer && this.clockAt <= at) return;
    if (this.clockTimer) clearTimeout(this.clockTimer);
    this.clockAt = at;
    this.clockTimer = setTimeout(() => {
      this.clockTimer = undefined;
      this.clockAt = 0;
      void this.tickClock().catch((error) => { console.error('parlor: 客厅时钟出错', error); });
    }, Math.max(0, at - this.now()));
    this.clockTimer.unref?.();
  }

  /**
   * 有事刚提交（出牌、开桌、承诺）：让时钟马上重算一次。
   * 错过这一下也不会错—错误只是多睡一会儿，兜底扫描会补上。
   */
  pokeClock(): void {
    this.scheduleClock(this.now());
  }

  /**
   * 一次时钟推进：牌桌超时、承诺到期、余额补给。
   * 没人访问的客厅也要走到：先按「有活跃席位 / 有到期承诺 / 有未结束牌局」把 host 建出来。
   * 跑完按各客厅给出的下一拍重新睡；没东西要推进就睡到兜底扫描。
   */
  private async tickClock(): Promise<void> {
    if (this.closing) return;
    // 上一轮还没跑完（库慢）就跳过这一轮，但要把下一拍排上，别把链断了。
    if (this.clocking) {
      this.scheduleClock(this.now() + 50);
      return;
    }
    this.clocking = true;
    const now = this.now();
    let next: number | undefined;
    let hasTables = false;
    try {
      const occupied = await this.db.prepare(
        'SELECT DISTINCT room_id FROM room_seats WHERE released_at IS NULL',
      ).all() as { room_id: string }[];
      // 席位可能都走了，但牌局还挂着：这些客厅也得继续推进。
      const tables = await this.db.prepare(
        "SELECT DISTINCT room_id FROM tables WHERE status IN ('open','bidding','playing')",
      ).all() as { room_id: string }[];
      hasTables = tables.length > 0;
      for (const row of [...occupied, ...tables]) await this.host(row.room_id);
      const needed = new Set([...occupied, ...tables].map(row => row.room_id));
      for (const [id, host] of this.hosts) {
        if (!needed.has(id) && !this.sse.has(id)) continue;
        try { await host.tickClock(); } catch (error) {
          console.error('parlor: 客厅时钟出错', error);
        }
        try {
          const at = await host.nextWakeAt(now);
          if (at !== undefined && (next === undefined || at < next)) next = at;
        } catch (error) {
          console.error('parlor: 客厅下一次推进时刻算不出来', error);
        }
      }
      if (now - this.lastPrune >= 3_600_000) {
        this.lastPrune = now;
        await this.pruneEvents(now);
      }
    } catch (error) {
      console.error('parlor: 时钟扫描失败', error);
    } finally {
      this.clocking = false;
    }
    // 运行期间有人 poke 过就一直排着更早的一拍，别再往后推。
    if (this.clockTimer) return;
    // 有牌局/承诺：一拍一秒（与旧的每秒 tick 同节奏，但没到点的桌不 hydrate）；
    // 什么都没有：十秒空扫一次，等席位或牌局出现。
    const at = next !== undefined
      ? Math.max(now + 50, hasTables ? Math.min(next, now + CLOCK_SAFETY_MS) : next)
      : now + CLOCK_IDLE_MS;
    this.scheduleClock(at);
  }

  /**
   * 席位离线超过阈值就释放：真人按 offlineReleaseHours，Coo 的 pet 席位按 cooOfflineReleaseHours。
   * 「在线」以 SSE 连接为准：还有一条连着就不动；牌桌锁着也不动（等这局结束）。
   * 返回这次释放了几个，方便测试和运维日志。
   */
  async runLifecycle(now = this.now()) { return this.lifecycle.sweep(now); }

  async releaseOfflineSeats(now = this.now()): Promise<number> {
    const sweeps = [
      { kind: 'human' as const, ms: this.offlineReleaseMs },
      { kind: 'pet' as const, ms: this.cooOfflineReleaseMs },
    ].filter((sweep) => sweep.ms > 0);
    if (sweeps.length === 0) return 0;
    const online = new Set<string>();
    for (const clients of this.sse.values()) {
      for (const client of clients) online.add(client.cooId);
    }
    let released = 0;
    for (const sweep of sweeps) {
      const cutoff = now - sweep.ms;
      for (const seat of await seatsForOfflineRelease(this.db, sweep.kind)) {
        if (online.has(seat.cooId)) continue;
        if (seat.lastSeenAt > cutoff) continue;
        try {
          if (await (await this.host(seat.roomId)).releaseOffline(seat.cooId, now)) released += 1;
        } catch { /* 这间房暂时有问题就跳过，下一轮再试 */ }
      }
    }
    return released;
  }

  /** Coo 身份：缺行就自动注册；secret 不匹配拒绝。 */
  private audienceUrl(): string { return this.publicUrl ?? this.baseUrl; }
  private authorityUrl(): string { return this.identityAuthority === 'self' ? this.audienceUrl() : this.identityAuthority!; }

  private async identityRoute(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<void> {
    if (!this.identityAuthority || this.identityAuthority !== 'self') throw new HttpError(404, '此服务器不是统一身份服务');
    if (method !== 'POST') throw new HttpError(405, '需要 POST');
    const body = await readJson(req);
    if (path === '/v1/identity/session') {
      const now = this.now();
      for (const [key, rate] of this.identityRates) if (rate.until <= now) this.identityRates.delete(key);
      const address = req.socket.remoteAddress ?? '';
      const rate = this.identityRates.get(address) ?? { until: now + 60_000, count: 0 };
      if (rate.count >= 120 || (!this.identityRates.has(address) && this.identityRates.size >= 2000)) throw new HttpError(429, '身份请求太频繁，请稍后重试');
      rate.count += 1; this.identityRates.set(address, rate);
      try {
        const audience = identityOrigin(String(body.audience ?? ''));
        let cooId = String(body.cooId ?? ''), secret = String(body.cooSecret ?? ''), name = String(body.name ?? '');
        let kind: 'pet' | 'human' = body.kind === 'human' ? 'human' : 'pet';
        if (body.useParent === true && cookieOf(req, 'parlor_parent')) {
          if (headerValue(req, 'origin') !== this.audienceUrl()) throw new HttpError(403, '来源不对');
          const player = await this.ensurePlayerCoo((await this.parentSession(req)).account);
          cooId = player.cooId; secret = player.secret; name = player.name; kind = 'human';
        }
        const person = await this.registry.enroll(cooId, secret, name, kind);
        json(res, 200, await this.registry.issue(person, audience));
      } catch (error) { throw new HttpError(403, messageOf(error)); }
      return;
    }
    if (path === '/v1/identity/verify') {
      const person = await this.registry.verify(headerValue(req, GLOBAL_HEADER), String(body.audience ?? ''));
      if (!person) throw new HttpError(401, '身份通行证无效、已过期或目标不匹配');
      json(res, 200, { person }); return;
    }
    throw new HttpError(404, '没有这个身份接口');
  }

  private async prepareIdentity(req: IncomingMessage): Promise<void> {
    if (!this.identityAuthority) throw new HttpError(401, '此服务器不支持统一身份');
    const token = headerValue(req, GLOBAL_HEADER);
    let person: GlobalPerson | null;
    try {
      person = this.identityAuthority === 'self' ? await this.registry.verify(token, this.audienceUrl())
        : (await identityRequest<{ person: GlobalPerson }>(this.authorityUrl(), '/v1/identity/verify', { audience: this.audienceUrl() }, token)).person;
    } catch { throw new HttpError(401, '无法验证统一身份，请重试'); }
    if (!person || !isCooId(person.cooId) || !/^[a-z0-9_-]{8,64}$/.test(person.handle)
      || !['pet','human'].includes(person.kind)) throw new HttpError(401, '统一身份无效');
    const existing = await this.coo.findCoo(person.cooId);
    if (existing?.status === 'disabled') throw new HttpError(403, '身份已在本服务器停用');
    await withTransaction(this.db, async () => {
      await this.db.prepare(`INSERT INTO coos(id,kind,display_name,created_at,last_seen_at) VALUES (?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,last_seen_at=excluded.last_seen_at`)
        .run(person!.cooId, person!.kind, person!.name, this.now(), this.now());
      await this.db.prepare('INSERT INTO global_handles(coo_id,handle) VALUES (?,?) ON CONFLICT(coo_id) DO UPDATE SET handle=excluded.handle')
        .run(person!.cooId, person!.handle);
    });
    this.verifiedPeople.set(req, person);
  }

  private async cooAuth(req: IncomingMessage, name = '', allowSeat = true): Promise<string> {
    const seatToken = bearer(req);
    if (seatToken && allowSeat) {
      const seat = await seatByTokenHash(this.db, hashSeatToken(seatToken));
      if (seat && seat.releasedAt === null) return seat.cooId;
    }
    const global = this.verifiedPeople.get(req);
    if (global) return global.cooId;
    const cooId = headerValue(req, 'x-parlor-coo').trim();
    const secret = headerValue(req, 'x-parlor-coo-secret').trim();
    if (!isCooId(cooId) || !isCooSecret(secret)) throw new HttpError(400, '账本身份格式不对');
    if (this.identityAuthority && this.identityAuthority !== 'self') throw new HttpError(401, '请使用统一身份通行证');
    const claim = await this.coo.claimIdentity(cooId, secret);
    if (claim === 'mismatch') throw new HttpError(403, '这个账本身份已经被占用了');
    if (claim === 'invalid') {
      const created = await this.coo.registerCoo(cooId, secret, 'pet', name);
      if (created === 'mismatch') throw new HttpError(403, '这个账本身份已经被占用了');
      if (created !== 'ok') throw new HttpError(400, '账本身份格式不对');
    }
    if (this.identityAuthority === 'self') await this.registry.enroll(cooId, secret, name);
    return cooId;
  }

  private async identify(req: IncomingMessage): Promise<string | null> {
    const global = this.verifiedPeople.get(req);
    if (global) return global.cooId;
    const cooId = headerValue(req, 'x-parlor-coo').trim();
    const secret = headerValue(req, 'x-parlor-coo-secret').trim();
    if (this.identityAuthority && this.identityAuthority !== 'self') return null;
    if (!isCooId(cooId) || !isCooSecret(secret)) return null;
    return await this.coo.claimIdentity(cooId, secret) === 'ok' ? cooId : null;
  }

  /** 网页用席位令牌也能看目录/大厅；Coo 客户端仍用身份头。 */
  private async cooOrSeat(req: IncomingMessage): Promise<string> {
    const direct = await this.identify(req);
    if (direct) return direct;
    const token = bearer(req);
    if (!token) throw new HttpError(401, '缺少身份');
    const seat = await seatByTokenHash(this.db, hashSeatToken(token));
    if (!seat || seat.releasedAt !== null) throw new HttpError(401, '席位令牌无效或已经离开');
    return seat.cooId;
  }

  private async seatAuth(req: IncomingMessage, roomId: string, tokenOverride?: string) {
    const token = tokenOverride ?? bearer(req);
    if (!token) throw new HttpError(401, '缺少席位令牌');
    try {
      return await (await this.host(roomId)).seatByToken(token);
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

    if (url.pathname.startsWith('/v1/identity/')) {
      await this.identityRoute(req, res, url.pathname, method); return;
    }
    if (headerValue(req, GLOBAL_HEADER)) await this.prepareIdentity(req);
    if (method === 'GET' && this.serveWeb(url.pathname, req, res)) return;

    if (url.pathname.startsWith('/v1/support/')) {
      res.setHeader('cache-control', 'no-store');
      const support = new SupportDb(this.db, this.now);
      const path = url.pathname.slice('/v1/support/'.length);
      if (path === 'announcements' && method === 'GET') {
        await this.cooOrSeat(req);
        json(res, 200, { announcements: await support.announcements() }); return;
      }
      // 公告 / 新闻 / 招募共用一次请求：Coo 侧只有 60 秒一个定时器，
      // 分成三条路由会让每个 Coo 每分钟发三次请求。
      if (path === 'inbox' && method === 'GET') {
        await this.cooOrSeat(req);
        const topics = new Set((url.searchParams.get('topics') ?? 'announcements,news,recruit')
          .split(',').map((item) => item.trim()).filter(Boolean));
        const afterPublish = Number(url.searchParams.get('after_publish') ?? 0) || 0;
        const afterId = url.searchParams.get('after_id') ?? '';
        // 同厅的桌已经走 SSE 即时通知；这里排掉，别让两条通路说同一桌、也别白占前三的名额。
        const here = (url.searchParams.get('room') ?? '').trim();
        json(res, 200, {
          ...(topics.has('announcements') ? { announcements: await support.announcements() } : {}),
          ...(topics.has('news') ? { news: await support.newsFeed(afterPublish, afterId) } : {}),
          ...(topics.has('recruit') ? { recruit: { tables: await this.recruitSnapshot.take(3, here) } } : {}),
        });
        return;
      }
      // 主动查：一律 200，找不到就是 news:null。旧服务器没有这条路由才是 404，
      // Coo 侧据此区分「本版没有新闻板块」和「这条还没发」。
      if (path === 'news' && method === 'GET') {
        await this.cooOrSeat(req);
        const id = url.searchParams.get('id') ?? '';
        // 没有就是 news:null——不能留 undefined，否则序列化成 {}，客户端判不出「这条还没发」。
        if (id) { json(res, 200, { news: (await support.newsById(id)) ?? null }); return; }
        if (url.searchParams.get('list') === '1') {
          json(res, 200, { news: await support.newsList(Number(url.searchParams.get('limit') ?? 5)) }); return;
        }
        json(res, 200, { news: (await support.latestNews()) ?? null }); return;
      }
      if (path === 'feedback' && (method === 'GET' || method === 'POST')) {
        const cooId = await this.cooOrSeat(req);
        if (method === 'GET') { json(res, 200, { feedback: await support.feedback(cooId) }); return; }
        const body = await readJson(req);
        const person = await this.personInfo(cooId);
        json(res, 200, { feedback: await support.submit(cooId, person.name, body.text, body.requestId) }); return;
      }
      if (path.startsWith('operator/')) {
        if (!this.operatorHash) throw new HttpError(503, '运营入口尚未配置');
        const hash = createHash('sha256').update(bearer(req)).digest();
        if (!timingSafeEqual(hash, this.operatorHash)) throw new HttpError(403, '运营钥匙不对');
        if (path === 'operator/feedback' && method === 'GET') {
          json(res, 200, { feedback: await support.feedback() }); return;
        }
        if (path === 'operator/reply' && method === 'POST') {
          const body = await readJson(req);
          await support.reply(String(body.id ?? ''), body.text, body.status);
          json(res, 200, { ok: true }); return;
        }
        if (path === 'operator/announcements' && method === 'POST') {
          const body = await readJson(req);
          json(res, 200, { announcement: await support.announce(body.text, body.requestId) }); return;
        }
        // 运营列表：玩家那条 `announcements` 走 Coo / 席位鉴权，运营钥匙调不动，
        // 所以工作台要自己有一条读法，否则改与删都没有入口。
        if (path === 'operator/announcements' && method === 'GET') {
          json(res, 200, { announcements: await support.announcementAdminList(Number(url.searchParams.get('limit') ?? 20)) }); return;
        }
        if (path === 'operator/announcements' && method === 'PATCH') {
          const body = await readJson(req);
          const id = String(body.id ?? '').trim();
          if (!id) throw new HttpError(400, '需要公告 id');
          // revision 必须是运营页面看到的那一版：服务端读到的版本不能当并发条件。
          // publishId 认「这一条发布」：删掉后用同一个 requestId 重发，版本又从 1 开始。
          json(res, 200, {
            announcement: (await support.editAnnouncement(id, body.text, body.revision, body.publishId)).item,
          }); return;
        }
        if (path === 'operator/announcements' && method === 'DELETE') {
          const id = (url.searchParams.get('id') ?? '').trim();
          if (!id) throw new HttpError(400, '需要公告 id');
          // 旧标签页拿着过期版本不能删掉别人刚改出来的新版；
          // publishId 再挡一层：不能删掉用同一个 requestId 重发的下一条。
          json(res, 200, {
            ok: true,
            deleted: await support.deleteAnnouncement(
              id, url.searchParams.get('revision') ?? '', url.searchParams.get('publishId') ?? '',
            ),
          }); return;
        }
        if (path === 'operator/news' && method === 'GET') {
          const id = (url.searchParams.get('id') ?? '').trim();
          if (id) {
            const item = await support.newsAdminById(id);
            if (!item) throw new HttpError(404, '没有这条新闻');
            json(res, 200, { news: item }); return;
          }
          // 运营列表含还没到可见时刻的预录条目：这条走运营钥匙，不走席位鉴权。
          json(res, 200, { news: await support.newsAdminList(Number(url.searchParams.get('limit') ?? 10)) }); return;
        }
        if (path === 'operator/news' && method === 'POST') {
          const body = await readJson(req);
          json(res, 200, { news: await support.publishNews(body) }); return;
        }
        // 改：只动内容与可见设置，不动 id 与日期；字段没给就保持原样。
        if (path === 'operator/news' && method === 'PATCH') {
          const body = await readJson(req);
          const result = await support.editNews(body);
          json(res, 200, { news: result.item, changed: result.changed }); return;
        }
        // 删：物理删除，当天可以重发；原文进留痕表，`deleted: null` 表示本来就没有。
        // `publishId` 必填：同一天重发沿用同一个 id，只带 id 的旧请求会误删新稿；
        // 也不用 createdAt——两次发布可以落在同一毫秒。
        if (path === 'operator/news' && method === 'DELETE') {
          const id = (url.searchParams.get('id') ?? '').trim();
          if (!id) throw new HttpError(400, '需要新闻 id');
          const publishId = (url.searchParams.get('publishId') ?? '').trim();
          if (!publishId) throw new HttpError(400, '需要 publishId（本次发布的唯一标识）');
          json(res, 200, { ok: true, deleted: await support.deleteNews(id, publishId) }); return;
        }
        if (path === 'operator/audit' && method === 'GET') {
          json(res, 200, { audit: await support.auditList(Number(url.searchParams.get('limit') ?? 20)) }); return;
        }
      }
      throw new HttpError(404, '没有这个反馈通道地址');
    }

    if (method === 'GET' && url.pathname === '/healthz') {
      const room = await getRoom(this.db, this.defaultRoomId);
      json(res, 200, {
        ok: true,
        room: this.defaultRoomId,
        version: PACKAGE_VERSION,
        protocol: 2,
        storage: 'postgres',
        capabilities: ['seat-location-v1','personal-history-v1','room-lifecycle-v1','promises-disabled'],
        ...(this.identityAuthority ? { globalIdentity: { authority: this.authorityUrl(), audience: this.audienceUrl() } } : {}),
        guestJoin: this.allowGuestJoin,
        offlineReleaseHours: this.offlineReleaseMs / 3_600_000,
        cooOfflineReleaseHours: this.cooOfflineReleaseMs / 3_600_000,
        hall: (await this.ensureHall()).id,
        rooms: (await listRooms(this.db, { kind: 'room' })).length,
        seats: room ? (await activeSeats(this.db, room.id)).filter((seat) => seat.kind !== 'observer').length : 0,
        // 能力发现：客户端按这些字段决定用哪套接口。
        tablesV2: true,
        durableActions: true,
        roomInvitesV1: true,
        maxTablesPerRoom: 10,
      });
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/parent/session') {
      const body = await readJson(req);
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      this.checkParentKeyRate(req);
      const account = key ? await this.coo.verifyOwnerKey(key) : null;
      if (!account) throw new HttpError(401, '这个家长链接不对，或已经失效了');
      const session = await this.coo.createSession(account.id);
      if (!session) throw new HttpError(403, '这个家长账户被停用了');
      res.setHeader('set-cookie', this.parentCookie(session.token, req));
      json(res, 200, {
        account: { id: account.id, cooId: account.cooId, displayName: account.displayName },
        expiresAt: session.expiresAt,
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/parent/me') {
      const session = await this.parentSession(req);
      json(res, 200, {
        account: { id: session.account.id, cooId: session.account.cooId, displayName: session.account.displayName },
        expiresAt: session.expiresAt,
        seat: await this.parentSeatView(session.account.cooId),
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/parent/view') {
      const session = await this.parentSession(req);
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      const limit = Number(url.searchParams.get('limit') ?? 30) || 30;
      json(res, 200, await this.parentView(session.account.cooId, since, limit));
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/parent/play') {
      const body = await readJson(req);
      // 带钥匙时一次做完「换会话 + 领席位」：跨境链路上每多一个来回就是两三秒。
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (key) {
        this.checkParentKeyRate(req);
        const account = await this.coo.verifyOwnerKey(key);
        if (!account) throw new HttpError(401, '这个家长链接不对，或已经失效了');
        const fresh = await this.coo.createSession(account.id);
        if (!fresh) throw new HttpError(403, '这个家长账户被停用了');
        res.setHeader('set-cookie', this.parentCookie(fresh.token, req));
        json(res, 200, await this.parentPlay(account, body));
        return;
      }
      const session = await this.parentSession(req);
      json(res, 200, await this.parentPlay(session.account, body));
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/parent/rename') {
      const session = await this.parentSession(req);
      const body = await readJson(req);
      json(res, 200, await this.parentRename(session.account, body));
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/parent/logout') {
      const token = cookieOf(req, 'parlor_parent');
      if (token) await this.coo.revokeSession(token);
      res.setHeader('set-cookie', this.clearParentCookie(req));
      json(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/me/rename') {
      const token = bearer(req);
      const seat = token ? await seatByTokenHash(this.db, hashSeatToken(token)) : undefined;
      if (!seat || seat.releasedAt !== null) throw new HttpError(401, '席位令牌无效或已经离开');
      const body = await readJson(req);
      const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
      if (!name) throw new HttpError(400, '名字不能为空');
      if (name.length > 24) throw new HttpError(400, '名字最多 24 个字');
      await withTransaction(this.db, async () => {
        await renameSeat(this.db, seat.roomId, seat.id, name);
        await this.coo.renameCooDisplay(seat.cooId, name);
      });
      json(res, 200, { name });
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/me/owner-key/rotate') {
      const cooId = await this.cooAuth(req, '', false);
      let account = await this.coo.byCooId(cooId);
      if (!account) {
        // 迁移过来的老 Coo 可能还没有 accounts 行：第一次要 key 时建一个。
        const ensured = await this.coo.ensureAccount(cooId);
        account = ensured.account;
        if (ensured.ownerKey) {
          json(res, 200, { ownerKey: ensured.ownerKey });
          return;
        }
      }
      const key = await this.coo.rotateOwnerKey(cooId);
      if (!key) throw new HttpError(409, '轮换失败；稍后再试');
      await this.coo.revokeAllSessions(account.id);
      json(res, 200, { ownerKey: key });
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/me') {
      const cooId = await this.cooAuth(req);
      const seat = await activeSeatForCoo(this.db, cooId);
      const visible: RoomRow[] = [];
      for (const room of await listRooms(this.db, { kind: 'room' })) {
        if (room.visibility === 'public' || room.ownerCooId === cooId
          || (await memberOf(this.db, room.id, cooId)) !== null) visible.push(room);
      }
      json(res, 200, {
        cooId,
        seat: seat ? {
          room: seat.roomId, id: seat.id, name: seat.name, kind: seat.kind, tier: seat.tier,
          handle: await registeredHandle(this.db, seat.cooId),
        } : null,
        rooms: await Promise.all(visible.map((room) => roomSummary(this.db, room))),
      });
      return;
    }

    // 身份级读取：被移出客厅、大厅满员时，自己的信箱/账本/历史还看得到。
    if (method === 'GET' && url.pathname === '/v1/me/message-history') {
      const cooId = await this.cooOrSeat(req);
      const after = Number(url.searchParams.get('after') ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, '历史游标须为非负整数');
      // 包括已读来信与本人发出的私聊，补档不改变任意一方的已读状态。
      json(res, 200, {
        items: await new MailDb(this.db).parentRecent(cooId, 200, after),
        seats: await this.db.prepare('SELECT id,room_id AS room FROM room_seats WHERE coo_id=?').all(cooId),
      });
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/mail/read-all') {
      const cooId = await this.cooOrSeat(req);
      json(res, 200, await new MailDb(this.db, { now: this.now }).markAllRead(cooId));
      return;
    }

    if (method === 'GET' && (url.pathname === '/v1/me/mail'
      || (url.pathname === '/v1/mail' && url.searchParams.get('all') !== '0'))) {
      const cooId = await this.cooOrSeat(req);
      const room = url.pathname === '/v1/me/mail' ? url.searchParams.get('room') || undefined : undefined;
      json(res, 200, await this.mailPage(cooId, url.searchParams, room));
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/me/location') {
      const cooId = await this.cooOrSeat(req);
      const current = await activeSeatForCoo(this.db, cooId);
      json(res, 200, { room: current?.roomId ?? null, seat: current ? await seatOfRow(this.db, current.roomId, current) : null });
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/me/history') {
      const cooId = await this.cooOrSeat(req);
      try {
        const q = Object.fromEntries(url.searchParams);
        const page = await personalHistory(this.db, cooId, {
          kind: (q.kind ?? 'games') as 'games' | 'gifts', game: q.game, room: q.room,
          ...Object.fromEntries(['from','until','before','limit'].filter(k => q[k] !== undefined).map(k => [k, Number(q[k])])),
        });
        json(res, 200, page);
      } catch (error) { throw new HttpError(400, messageOf(error)); }
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/me/ledger') {
      const cooId = await this.cooOrSeat(req);
      json(res, 200, { ledger: await new LedgerDb(this.db, { now: this.now }).summaryFor(cooId) });
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/me/history-sync') {
      const cooId = await this.cooOrSeat(req);
      const room = url.searchParams.get('room') ?? '';
      if (!room || !(await getRoom(this.db, room))) throw new HttpError(404, '客厅不存在');
      const after = Number(url.searchParams.get('after') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 200);
      if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, '历史游标须为非负整数');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, '补档每页须为 1–200 条');
      const page = await (await this.host(room)).archive(cooId, after, limit);
      json(res, 200, { events: page.events.map(historySyncEvent), more: page.more }, req);
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/me/replay') {
      const cooId = await this.cooOrSeat(req);
      const room = url.searchParams.get('room') ?? '';
      if (!room || !(await getRoom(this.db, room))) throw new HttpError(404, '客厅不存在');
      const limit = Number(url.searchParams.get('limit') ?? 50) || 50;
      const before = Number(url.searchParams.get('before') ?? 0) || undefined;
      const host = await this.host(room);
      const page = await host.replay(cooId, { limit, ...(before ? { before } : {}) });
      json(res, 200, {
        room,
        latest: await host.latest(),
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
      }, req);
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/table-entry') {
      const body = await readJson(req);
      const result = await this.tableDiscovery.enter(bearer(req), {
        requestId: typeof body.requestId === 'string' ? body.requestId : '',
        ...(typeof body.game === 'string' ? { game: body.game } : {}),
        ...(typeof body.room === 'string' ? { room: body.room } : {}),
        ...(typeof body.table === 'string' ? { table: body.table } : {}),
      }, headerValue(req, 'x-parlor-client').trim() || undefined);
      this.pokeClock();
      json(res, 200, result);
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/hall') {
      const cooId = await this.cooOrSeat(req);
      const hall = await this.ensureHall();
      const hallSeats = await activeSeats(this.db, hall.id);
      const meSeat = await activeSeatForCoo(this.db, cooId);
      const visible: RoomRow[] = [];
      for (const room of await listRooms(this.db, { kind: 'room' })) {
        if (room.visibility === 'public' || room.ownerCooId === cooId
          || (await memberOf(this.db, room.id, cooId)) !== null) visible.push(room);
      }
      json(res, 200, {
        hall: {
          id: hall.id,
          name: hall.name,
          topic: hall.topic,
          capacity: hall.capacity,
          seats: await Promise.all(hallSeats.map(async (seat) => ({
            id: seat.id, name: seat.name, kind: seat.kind, handle: await registeredHandle(this.db, seat.cooId),
          }))),
        },
        me: meSeat
          ? { room: meSeat.roomId, id: meSeat.id, name: meSeat.name, handle: await registeredHandle(this.db, meSeat.cooId) }
          : null,
        rooms: await Promise.all(visible.map((room) => roomSummary(this.db, room))),
        recruitments: await this.tableDiscovery.recruits(),
        matchables: await this.tableDiscovery.matchables(),
      });
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/invite') {
      const cooId = await this.cooAuth(req);
      const body = await readJson(req);
      const seat = await activeSeatForCoo(this.db, cooId);
      if (!seat) throw new HttpError(403, '你不在任何客厅里；先进一个客厅再邀请');
      const to = typeof body.to === 'string' ? body.to.trim() : '';
      if (!to) throw new HttpError(400, '要写邀请谁（席位名、Coo 身份或家长名）');
      const target = await this.resolveInviteTarget(to);
      if (target.cooId === cooId) throw new HttpError(400, '不能邀请自己');
      // 人类只邀请已有家长账户的人；无账户的旧访客席不接受邀请。
      if (target.kind === 'human' && !await this.coo.isPlayerCoo(target.cooId)) {
        throw new HttpError(403, `「${target.name}」没有家长账户；这个邀请只对家长开放`);
      }
      const roomValue = typeof body.room === 'string' && body.room.trim() ? body.room.trim() : seat.roomId;
      const room = (await getRoom(this.db, roomValue)) ?? (await resolveRoom(this.db, roomValue));
      if (!room) throw new HttpError(404, '要去的客厅不存在');
      if (room.archivedAt !== null) throw new HttpError(409, '那个客厅已经归档了');
      this.checkInviteRate(cooId);
      const extra = typeof body.text === 'string' ? body.text.trim().slice(0, 200) : '';
      const now = this.now();

      // 私密厅：只有房主能邀请；邀请先挂起，接受之后才写长期准入。
      if (room.visibility === 'private') {
        if (!await isRoomOwner(this.db, room.id, cooId)) {
          throw new HttpError(403, '这是私密客厅：只有房主能邀请人；成员不能把自己的邀请转给别人');
        }
        if (await hasRoomAccess(this.db, room.id, target.cooId)) {
          const line = `${seat.name} 说你可以进私密客厅「${room.name}」了。`;
          const letter = await new MailDb(this.db, { now: this.now }).append({
            to: target.cooId, room: room.id, kind: 'invite', action: 'notice', fromName: seat.name, text: line,
          });
          if (target.roomId) {
            await (await this.host(target.roomId)).pingSeat(target.cooId, line, {
              room: room.id, roomName: room.name, from: seat.name, mailSeq: letter.seq,
            });
          }
          json(res, 200, { ok: true, room: room.id, to: target.name, already: true, mailSeq: letter.seq });
          return;
        }
        let invitationId = '';
        let mailSeq = 0;
        await withTransaction(this.db, async () => {
          const invitation = await createRoomInvitationTx(this.db, {
            roomId: room.id, invitedBy: cooId, targetCooId: target.cooId, now,
          });
          invitationId = invitation.id;
          const line = target.kind === 'human'
            ? `${seat.name} 邀请你加入私密客厅「${room.name}」${extra ? `：${extra}` : ''}。打开网页的「信箱」，点「接受并进去」。`
            : `${seat.name} 邀请你加入私密客厅「${room.name}」${extra ? `：${extra}` : ''}。用 parlor_room {op:"accept",params:{id:"${invitation.id}"}} 接受。`;
          const letter = await new MailDb(this.db, { now: this.now }).append({
            to: target.cooId,
            room: room.id,
            kind: 'invite',
            action: 'room_invite',
            fromName: seat.name,
            text: line,
            invitationId: invitation.id,
          });
          mailSeq = letter.seq;
          if (target.roomId) {
            await (await this.host(target.roomId)).pingSeat(target.cooId, line, {
              room: room.id, roomName: room.name, from: seat.name, mailSeq: letter.seq,
              invitationId: invitation.id, private: true,
            });
          }
        });
        json(res, 200, {
          ok: true, room: room.id, to: target.name, invitationId, mailSeq, pending: true,
        });
        return;
      }

      const how = target.kind === 'human'
        ? '。打开网页的「信箱」点「进去」就到。'
        : '。用 parlor_room visit 进去。';
      const line = `${seat.name} 邀请你去「${room.name}」${extra ? `：${extra}` : ''}${how}`;
      const letter = await new MailDb(this.db, { now: this.now }).append({
        to: target.cooId,
        room: room.id,
        kind: 'invite',
        action: 'invite',
        fromName: seat.name,
        text: line,
      });
      if (target.roomId) {
        await (await this.host(target.roomId)).pingSeat(target.cooId, line, {
          room: room.id, roomName: room.name, from: seat.name, mailSeq: letter.seq,
        });
      }
      json(res, 200, { ok: true, room: room.id, to: target.name, mailSeq: letter.seq });
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/dm') {
      const cooId = await this.cooOrSeat(req);
      const body = await readJson(req);
      json(res, 200, await this.sendDm(cooId, body));
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/dm/threads') {
      const cooId = await this.cooOrSeat(req);
      json(res, 200, await this.dmThreads(cooId));
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/dm') {
      const cooId = await this.cooOrSeat(req);
      const peer = (url.searchParams.get('peer') ?? '').trim();
      if (!peer) throw new HttpError(400, '要看和谁的会话？');
      const before = Number(url.searchParams.get('before') ?? 0) || 0;
      const limit = Number(url.searchParams.get('limit') ?? 50) || 50;
      json(res, 200, await this.dmThreadPage(cooId, peer, before, limit));
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/dm/read') {
      const cooId = await this.cooOrSeat(req);
      const body = await readJson(req);
      const peer = typeof body.peer === 'string' ? body.peer.trim() : '';
      if (!peer) throw new HttpError(400, '要看和谁的会话？');
      const changed = await new MailDb(this.db, { now: this.now }).markThreadRead(cooId, peer);
      json(res, 200, { ok: true, changed });
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/people') {
      const cooId = await this.cooOrSeat(req);
      const q = (url.searchParams.get('q') ?? '').trim();
      json(res, 200, await this.searchPeople(cooId, q));
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/rooms') {
      const all = url.searchParams.get('all') === '1';
      const cooId = all ? await this.cooOrSeat(req) : null;
      const rooms: RoomRow[] = [];
      for (const room of await listRooms(this.db, { kind: 'room' })) {
        if (room.visibility === 'public') {
          rooms.push(room);
          continue;
        }
        if (!all || cooId === null) continue;
        if (room.ownerCooId === cooId || (await memberOf(this.db, room.id, cooId)) !== null) rooms.push(room);
      }
      json(res, 200, { rooms: await Promise.all(rooms.map(async (room) => ({
        ...await roomSummary(this.db, room),
        mine: cooId !== null && (room.ownerCooId === cooId || (await memberOf(this.db, room.id, cooId)) !== null),
      }))) });
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/rooms') {
      const cooId = await this.cooAuth(req);
      const body = await readJson(req);
      const name = typeof body.name === 'string' ? body.name : '';
      const visibility = typeof body.visibility === 'string' ? body.visibility as 'public' | 'unlisted' | 'private' : undefined;
      const capacity = typeof body.capacity === 'number' ? body.capacity : undefined;
      const topic = typeof body.topic === 'string' ? body.topic : undefined;
      const room = await createRoom(this.db, {
        name,
        ownerCooId: cooId,
        ...(visibility ? { visibility } : {}),
        ...(capacity !== undefined ? { capacity } : {}),
        ...(topic ? { topic } : {}),
      }, this.now());
      json(res, 200, { room: await roomSummary(this.db, room) });
      return;
    }

    const detail = url.pathname.match(/^\/v1\/rooms\/([^/]+)$/);
    if (method === 'GET' && detail) {
      const room = await getRoom(this.db, detail[1]);
      if (!room) throw new HttpError(404, '客厅不存在');
      if (room.visibility !== 'public') {
        const cooId = await this.identify(req);
        if (!cooId || (!await isRoomOwner(this.db, room.id, cooId) && await memberOf(this.db, room.id, cooId) === null)) {
          throw new HttpError(404, '客厅不存在');
        }
      }
      json(res, 200, { room: await roomSummary(this.db, room) });
      return;
    }

    // —— 房主：成员管理 / 可见性 / 房主邀请 / 删除客厅 ——
    const managed = url.pathname.match(/^\/v1\/rooms\/([^/]+)\/(access|visibility|invite|delete|restore)$/);
    if (managed) {
      const roomId = managed[1];
      const what = managed[2];
      const room = await getRoom(this.db, roomId);
      if (!room) throw new HttpError(404, '客厅不存在');
      const manager = await this.roomManager(req, roomId);
      const now = this.now();
      if (what === 'delete' && method === 'POST') {
        if (room.kind !== 'room' || room.id === this.defaultRoomId || room.ownerCooId === 'system-owner') {
          throw new HttpError(403, '大厅和系统默认客厅不能删除');
        }
        const host = await this.host(roomId);
        await withTransaction(this.db, async () => {
          const live = await this.db.prepare(
            "SELECT 1 FROM tables WHERE room_id = ? AND status IN ('open','bidding','playing') LIMIT 1",
          ).get(roomId);
          if (live) throw new HttpError(409, '客厅里还有未结束的牌桌，请先结束牌局或收起等待中的桌子');
          for (const seat of await activeSeats(this.db, roomId)) await host.remove(seat.cooId, now, 'room_deleted');
          await revokeInvitationsFor(this.db, roomId, null, now);
          await archive(this.db, roomId, now);
        });
        json(res, 200, { ok: true, room: await roomSummary(this.db, (await getRoom(this.db, roomId))!) });
        return;
      }
      if (what === 'restore' && method === 'POST') {
        await unarchive(this.db, roomId, now);
        json(res, 200, { ok:true, room: await roomSummary(this.db, (await getRoom(this.db,roomId))!) });
        return;
      }
      if (room.archivedAt !== null) throw new HttpError(409, '这个客厅已经删除');
      if (what === 'access' && method === 'GET') {
        await expireInvitations(this.db, now);
        const ownerRow = room.ownerCooId
          ? await this.db.prepare('SELECT id, display_name FROM coos WHERE id = ?').get(room.ownerCooId) as
            { id: string; display_name: string } | undefined
          : undefined;
        // 房主的家长会话：manager 是孩子的 cooId，本人在场时坐的是 player_coo_id 那个 human 身份。
        // 两个身份都不给「请出去」按钮，免得房主把自己踢下线。
        const managerAccount = await this.coo.byCooId(manager);
        const managerPlayer = managerAccount ? await this.coo.playerCooOf(managerAccount.id) : null;
        json(res, 200, {
          room: await roomSummary(this.db, room),
          owner: ownerRow ? { cooId: ownerRow.id, name: ownerRow.display_name } : null,
          members: await listRoomAccess(this.db, roomId),
          invitations: await pendingInvitationsForRoom(this.db, roomId, now),
          // 现在在厅里的人：公开厅没有 room_access 记录，成员列表是空的；
          // 这一份按活跃席位来，房主能看见来客并直接请出去。
          seats: (await activeSeats(this.db, roomId)).map((seat) => ({
            cooId: seat.cooId,
            seatId: seat.id,
            name: seat.name,
            kind: seat.kind,
            tier: seat.tier,
            joinedAt: seat.joinedAt,
            owner: seat.cooId === room.ownerCooId,
            self: seat.cooId === manager || seat.cooId === managerPlayer,
          })),
        });
        return;
      }
      if (what === 'access' && method === 'POST') {
        const body = await readJson(req);
        const action = typeof body.action === 'string' ? body.action : '';
        const target = typeof body.cooId === 'string' && body.cooId.trim()
          ? { cooId: body.cooId.trim(), name: await this.coo.cooDisplayName(body.cooId.trim()) || body.cooId.trim() }
          : await this.resolveInviteTarget(typeof body.to === 'string' ? body.to.trim() : '');
        if (action === 'grant') {
          if (await isRoomOwner(this.db, roomId, target.cooId)) throw new HttpError(400, '房主本来就能进');
          if (room.visibility !== 'private') {
            throw new HttpError(409, '只有私密客厅需要单独授权；公开/不列目录的厅有身份就能进');
          }
          await withTransaction(this.db, async () => {
            await grantRoomAccessTx(this.db, { roomId, cooId: target.cooId, source: 'owner', grantedBy: manager, now });
            await revokeInvitationsFor(this.db, roomId, target.cooId, now);
          });
          json(res, 200, { ok: true, cooId: target.cooId, name: target.name });
          return;
        }
        if (action === 'revoke') {
          if (await isRoomOwner(this.db, roomId, target.cooId)) throw new HttpError(400, '不能移除房主');
          const host = await this.host(roomId);
          let removedSeat = false;
          let tables: string[] = [];
          await withTransaction(this.db, async () => {
            await revokeRoomAccessTx(this.db, roomId, target.cooId, now, manager);
            await revokeInvitationsFor(this.db, roomId, target.cooId, now);
            // 开局前移除 = 退桌（开桌者收桌）；开局后交给脚本托管（结算仍归他）。
            try {
              if ((await host.tablePublic(undefined, target.cooId))?.status === 'open') {
                await host.leaveTable(target.cooId);
              }
            } catch { /* 牌局已开始/已结束：走托管 */ }
            tables = await host.markTableAuto(target.cooId);
            removedSeat = await host.remove(target.cooId, now) !== null;
          });
          // 席位一变、托管一开，下一拍就该重算（托管要按拍代打）。
          this.pokeClock();
          json(res, 200, { ok: true, cooId: target.cooId, name: target.name, removedSeat, tables });
          return;
        }
        throw new HttpError(400, 'action 只能是 grant 或 revoke');
      }
      if (what === 'visibility' && method === 'POST') {
        const body = await readJson(req);
        const visibility = body.visibility;
        if (visibility !== 'public' && visibility !== 'unlisted' && visibility !== 'private') {
          throw new HttpError(400, 'visibility 只能是 public / unlisted / private');
        }
        const keep = Array.isArray(body.keep)
          ? body.keep.filter((id): id is string => typeof id === 'string')
          : [];
        const host = await this.host(roomId);
        let kicked: string[] = [];
        await withTransaction(this.db, async () => {
          await this.db.prepare('UPDATE rooms SET visibility = ? WHERE id = ?').run(visibility, roomId);
          if (visibility !== 'public') await this.db.prepare(
            "UPDATE table_discovery SET match_open=0, recruit_text='' WHERE table_id IN (SELECT id FROM tables WHERE room_id=?)",
          ).run(roomId);
          if (visibility === 'private') {
            // 改成私密时不自动授权「来过的人」；只认房主确认保留的名单。
            const keepSet = new Set(keep);
            for (const cooId of keep) {
              const exists = await this.db.prepare('SELECT 1 FROM coos WHERE id = ?').get(cooId);
              if (!exists) continue;
              await grantRoomAccessTx(this.db, { roomId, cooId, source: 'owner', grantedBy: manager, now });
            }
            await revokeInvitationsFor(this.db, roomId, null, now);
            // 不在保留名单里的在场者当场请出去（牌局交给托管，结算仍归本人）。
            for (const seat of await activeSeats(this.db, roomId)) {
              if (seat.cooId === room.ownerCooId || keepSet.has(seat.cooId)) continue;
              try {
                if ((await host.tablePublic(undefined, seat.cooId))?.status === 'open') {
                  await host.leaveTable(seat.cooId);
                }
              } catch { /* 牌局已开始：走托管 */ }
              await host.markTableAuto(seat.cooId);
              if (await host.remove(seat.cooId, now)) kicked.push(seat.cooId);
            }
          }
        });
        json(res, 200, {
          ok: true,
          room: await roomSummary(this.db, (await getRoom(this.db, roomId))!),
          ...(kicked.length > 0 ? { removed: kicked } : {}),
        });
        return;
      }
      if (what === 'invite' && method === 'POST') {
        const body = await readJson(req);
        const target = await this.resolveInviteTarget(typeof body.to === 'string' ? body.to.trim() : '');
        if (target.cooId === manager) throw new HttpError(400, '不能邀请自己');
        if (room.visibility !== 'private') {
          throw new HttpError(409, '公开/不列目录的厅有平台身份就能进；不需要房主邀请');
        }
        if (await hasRoomAccess(this.db, roomId, target.cooId)) throw new HttpError(409, `「${target.name}」本来就能进`);
        const inviterName = await this.coo.cooDisplayName(manager) || '房主';
        let invitationId = '';
        await withTransaction(this.db, async () => {
          const invitation = await createRoomInvitationTx(this.db, {
            roomId, invitedBy: manager, targetCooId: target.cooId, now,
          });
          invitationId = invitation.id;
          const line = target.kind === 'human'
            ? `${inviterName} 邀请你加入私密客厅「${room.name}」。打开网页的「信箱」，点「接受并进去」。`
            : `${inviterName} 邀请你加入私密客厅「${room.name}」。用 parlor_room {op:"accept",params:{id:"${invitation.id}"}} 接受。`;
          await new MailDb(this.db, { now: this.now }).append({
            to: target.cooId,
            room: roomId,
            kind: 'invite',
            action: 'room_invite',
            fromName: inviterName,
            text: line,
            invitationId: invitation.id,
          });
          const seat = await activeSeatForCoo(this.db, target.cooId);
          if (seat) {
            await (await this.host(seat.roomId)).pingSeat(target.cooId, line, {
              room: roomId, roomName: room.name, invitationId: invitation.id, private: true,
            });
          }
        });
        json(res, 200, { ok: true, cooId: target.cooId, name: target.name, invitationId });
        return;
      }
      throw new HttpError(404, '没有这个地址');
    }

    // —— 邀请接受/拒绝（Coo 和网页玩家都能用） ——
    const invitation = url.pathname.match(/^\/v1\/invitations\/([^/]+)\/(accept|decline)$/);
    if (invitation && method === 'POST') {
      const cooId = await this.cooOrSeat(req);
      const id = invitation[1];
      const now = this.now();
      if (invitation[2] === 'accept') {
        let decision: 'ok' | 'not_found' | 'not_yours' | 'not_pending' | 'expired' = 'not_found';
        let roomId = '';
        await withTransaction(this.db, async () => {
          const accepted = await acceptInvitationTx(this.db, id, cooId, now);
          decision = accepted.decision;
          roomId = accepted.room?.id ?? '';
        });
        if (decision === 'not_found') throw new HttpError(404, '邀请不存在或已失效');
        if (decision === 'not_yours') throw new HttpError(403, '这个邀请不是给你的');
        if (decision === 'expired') throw new HttpError(409, '这个邀请已经过期（7 天）');
        if (decision === 'not_pending') throw new HttpError(409, '这个邀请已经处理过了');
        json(res, 200, { ok: true, room: roomId });
        return;
      }
      const decision = await withTransaction(this.db, () => declineInvitationTx(this.db, id, cooId, now));
      if (decision === 'not_found') throw new HttpError(404, '邀请不存在或已失效');
      if (decision === 'not_yours') throw new HttpError(403, '这个邀请不是给你的');
      if (decision === 'not_pending') throw new HttpError(409, '这个邀请已经处理过了');
      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/v1/me/invitations' && method === 'GET') {
      const cooId = await this.cooOrSeat(req);
      json(res, 200, { invitations: await pendingInvitationsForCoo(this.db, cooId, this.now()) });
      return;
    }

    if (url.pathname === '/v1/global/player/join' && method === 'POST') {
      const person = this.verifiedPeople.get(req);
      if (!person || person.kind !== 'human') throw new HttpError(401, '需要玩家的统一身份');
      const body = await readJson(req);
      const parent = body.parent === true ? (await this.parentSession(req)).account : null;
      if (!this.allowGuestJoin && !parent) throw new HttpError(403, '请用家长的下场玩链接');
      if (!parent) this.checkInvite(req, body);
      if (parent) {
        const previous = await this.coo.playerCooOf(parent.id);
        if (previous && previous !== person.cooId) throw new HttpError(409, '此家长已有另一份玩家身份；请保留旧记录，暂不能自动合并');
        await this.coo.bindPlayerCoo(parent.id, person.cooId);
      }
      const wanted = typeof body.room === 'string' ? body.room : (await this.ensureHall()).id;
      const target = await getRoom(this.db, wanted);
      if (!target) throw new HttpError(404, '客厅不存在');
      await this.assertRoomEntry(target.id, person.cooId);
      const current = await activeSeatForCoo(this.db, person.cooId);
      const joined = current ? current.roomId === target.id ? await (await this.host(target.id)).reissueSeatToken(person.cooId)
        : await (await this.host(current.roomId)).switchTo(person.cooId, target.id, { name: person.name })
        : await (await this.host(target.id)).join(person.cooId, { name: person.name, kind: 'human', tier: 'off' });
      json(res, 200, { room: target.id, token: joined.token, seat: await seatOfRow(this.db, target.id, joined.seat),
        identity: { cooId: person.cooId, cooSecret: 'seat-only' } }); return;
    }
    const route = url.pathname.match(/^\/v1\/rooms\/([^/]+)\/(join|leave|switch|room|table|games|gifts|history|action|mail|stream|replay|table-log)$/);
    if (route) {
      const roomId = route[1];
      const action = route[2];
      await this.roomRoute(req, res, url, roomId, action, method);
      return;
    }

    if (url.pathname === '/v1/join' && method === 'POST') {
      await this.roomRoute(req, res, url, this.defaultRoomId, 'join', method); return;
    }

    if (url.pathname === '/v1/player/join' && method === 'POST') {
      if (this.identityAuthority && this.identityAuthority !== 'self') throw new HttpError(409, '请通过网页的统一身份入口加入');
      if (!this.allowGuestJoin) {
        throw new HttpError(403, '这个入口已经关闭；请用带钥匙的「下场玩」链接');
      }
      const body = await readJson(req);
      this.checkInvite(req, body);
      const name = typeof body.name === 'string' ? body.name : '';
      const value = typeof body.room === 'string' && body.room.trim() ? body.room.trim() : this.defaultRoomId;
      const room = (await getRoom(this.db, value)) ?? (await resolveRoom(this.db, value));
      if (!room) throw new HttpError(404, `客厅不存在：${value}`);
      if (room.archivedAt !== null) throw new HttpError(409, '这个客厅已经归档了');
      const cooId = randomUUID();
      const secret = randomBytes(32).toString('base64url');
      await this.coo.registerCoo(cooId, secret, 'human', name);
      if (this.identityAuthority === 'self') await this.registry.enroll(cooId, secret, name, 'human');
      await this.assertRoomEntry(room.id, cooId);
      const host = await this.host(room.id);
      const joined = await host.join(cooId, { name, kind: 'human', tier: 'off' });
      json(res, 200, {
        room: room.id,
        roomName: room.name,
        seat: await seatOfRow(this.db, room.id, joined.seat),
        token: joined.token,
        maxSeats: room.capacity,
        identity: { cooId, cooSecret: secret },
      });
      return;
    }

    const alias = url.pathname.match(/^\/v1\/(room|table|games|history|action|mail|stream|replay)$/);
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
      const seat = await this.db.prepare(
        'SELECT room_id, coo_id FROM room_seats WHERE legacy_owner_token_hash = ? LIMIT 1',
      ).get(hash) as { room_id: string; coo_id: string } | undefined;
      if (!seat) throw new HttpError(410, '这个旧家长链接已经失效；请从扩展面板重新拿');
      const account = await this.coo.ensureAccount(seat.coo_id);
      const session = await this.coo.createSession(account.account.id);
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
  private async personInfo(
    cooId: string,
    fallbackName = '',
    viewer = '',
  ): Promise<{ cooId: string; name: string; online: boolean; room: string | null; handle: string }> {
    const seat = await activeSeatForCoo(this.db, cooId);
    const row = await this.db.prepare('SELECT display_name FROM coos WHERE id = ?').get(cooId) as { display_name?: string } | undefined;
    const name = seat?.name || (row?.display_name ?? '').trim() || fallbackName || '某人';
    // 私密厅的实时位置不给没有权限的人看。
    let room = seat?.roomId ?? null;
    if (room) {
      const info = await getRoom(this.db, room);
      if (info && info.visibility === 'private' && (!viewer || !await hasRoomAccess(this.db, room, viewer))) room = null;
    }
    return { cooId, name, online: this.isOnline(cooId), room, handle: await registeredHandle(this.db, cooId) };
  }

  /** 有没有正在连着的客户端（网页或 Coo）；不看席位在不在。 */
  private isOnline(cooId: string): boolean {
    for (const clients of this.sse.values()) {
      for (const client of clients) if (client.cooId === cooId) return true;
    }
    return false;
  }

  /**
   * 按短号找 cooId：# 后面可以是前 8 位，也可以是完整 id。
   * 前缀撞了不猜，列出完整 id 让调用方选（不建唯一约束）。
   */
  private async cooByHandle(handle: string): Promise<string> {
    const assigned = await this.db.prepare("SELECT h.coo_id FROM global_handles h JOIN coos c ON c.id=h.coo_id WHERE h.handle=? AND c.status='active'").get(handle) as { coo_id: string } | undefined;
    if (assigned) return assigned.coo_id;
    const exact = await this.db.prepare("SELECT id FROM coos WHERE status = 'active' AND id = ?").get(handle) as
      { id: string } | undefined;
    if (exact) return exact.id;
    // 全局短号是登记值；不能把别人的已分配短号当作本地某个 ID 的前缀。
    if (this.identityAuthority) throw new HttpError(404, `这台服务器尚不认识短号「#${handle}」`);
    const rows = await this.db.prepare(
      "SELECT id FROM coos WHERE status = 'active' AND id LIKE ? ESCAPE '\\' ORDER BY created_at, id LIMIT 6",
    ).all(`${likePrefix(handle)}%`) as { id: string }[];
    if (rows.length === 0) throw new HttpError(404, `没有找到号「#${handle}」`);
    if (rows.length > 1) {
      throw new HttpError(409, `这个号对上了 ${rows.length} 个人，用完整 id 再发一次：${rows.map((row) => row.id).join('、')}`);
    }
    return rows[0].id;
  }

  /** 找人：优先 cooId（搜索结果带的就是它），退一步按当前唯一同名席位。 */
  private async dmPeer(value: string, fromCooId: string): Promise<{ cooId: string; name: string; online: boolean; room: string | null }> {
    const needle = value.trim();
    if (!needle) throw new HttpError(400, '要写给谁？');
    const handle = parseHandleQuery(needle);
    if (handle !== null) {
      return this.personInfo(await this.cooByHandle(handle), '', fromCooId);
    }
    if (isCooId(needle)) {
      const row = await this.db.prepare("SELECT id FROM coos WHERE id = ? AND status = 'active'").get(needle);
      if (!row) throw new HttpError(404, '没有这个人');
      return this.personInfo(needle, '', fromCooId);
    }
    const bySeatId = await this.db.prepare(
      'SELECT coo_id FROM room_seats WHERE released_at IS NULL AND id = ?',
    ).get(needle) as { coo_id: string } | undefined;
    if (bySeatId) return this.personInfo(bySeatId.coo_id, '', fromCooId);
    // COLLATE NOCASE 只有 SQLite 有：改成 lower() 两边都对得上。
    const seats = await this.db.prepare(
      'SELECT coo_id FROM room_seats WHERE released_at IS NULL AND lower(name) = lower(?)',
    ).all(needle) as { coo_id: string }[];
    const ids = [...new Set(seats.map((row) => row.coo_id))].filter((id) => id !== fromCooId);
    if (this.identityAuthority && seats.length > 1) throw new HttpError(409, '有多个同名的人，请用 #短号');
    if (ids.length === 1) return this.personInfo(ids[0], '', fromCooId);
    if (ids.length > 1) throw new HttpError(409, '有多个同名的人，用搜索结果选一个');
    // 不在座的人：按 coo 显示名再找一次，这样 Coo 能回已经走开的私聊。
    const coos = await this.db.prepare(
      "SELECT id FROM coos WHERE status = 'active' AND lower(display_name) = lower(?)",
    ).all(needle) as { id: string }[];
    const names = [...new Set(coos.map((row) => row.id))].filter((id) => id !== fromCooId);
    if (this.identityAuthority && coos.length > 1) throw new HttpError(409, '有多个同名的人，请用 #短号');
    if (names.length === 1) return this.personInfo(names[0], '', fromCooId);
    if (names.length > 1) throw new HttpError(409, '有多个同名的人，用搜索结果选一个');
    throw new HttpError(404, `没有找到「${needle}」（离线的人要用搜索结果选）`);
  }

  /** 私聊：对方离线也照常投信箱；在线时顺手往他所在的客厅推一条事件。 */
  private async sendDm(cooId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const seat = await activeSeatForCoo(this.db, cooId);
    if (!seat) throw new HttpError(403, '你不在任何客厅里；先进一个客厅再发私聊');
    const peer = await this.dmPeer(typeof body.to === 'string' ? body.to : '', cooId);
    if (peer.cooId === cooId) throw new HttpError(400, '不能给自己发私聊');
    // 狼人杀进行中：同桌参与者之间不能私聊（防绕开单次发言与狼聊限制）。
    // 只拦「两端都在同一张进行中的狼人杀桌」；桌外人不受影响。
    // 只查已建好的 host（不在这里新建）；正在建的等它建完，别漏掉桌锁。
    const roomHost = this.hosts.get(seat.roomId) ?? await this.hostPending.get(seat.roomId);
    if (roomHost && await roomHost.chatLockedFor(cooId) && (await roomHost.lockedTablePeerCooIds(cooId)).has(peer.cooId)) {
      throw new HttpError(409, '狼人杀进行中，同桌的人之间不能私聊；想说的留到发言机会或局后再说');
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw new HttpError(400, '消息不能是空的');
    if (text.length > 2000) throw new HttpError(400, '一条最多 2000 字');
    this.checkDmRate(cooId);
    const letter = await withTransaction(this.db, async () => {
      await touchActivity(this.db, seat.roomId, cooId, this.now());
      return new MailDb(this.db, { now: this.now }).append({
      to: peer.cooId,
      fromCooId: cooId,
      room: seat.roomId,
      kind: 'whisper',
      fromName: seat.name,
      text,
    });
    });
    const target = await activeSeatForCoo(this.db, peer.cooId);
    if (target) {
      try {
        await (await this.host(target.roomId)).whisperNotice(cooId, seat.name, {
          cooId: target.cooId, id: target.id, name: target.name,
        }, text, { seq: letter.seq, ts: letter.ts, room: seat.roomId });
      } catch { /* 推事件失败不影响信 */ }
    }
    return {
      message: { seq: letter.seq, ts: letter.ts, text: letter.text, fromName: seat.name, fromMe: true, unread: false },
      peer,
    };
  }

  private async dmThreads(cooId: string): Promise<Record<string, unknown>> {
    const mail = new MailDb(this.db, { now: this.now });
    const threads = await Promise.all((await mail.threads(cooId)).map(async (thread) => {
      const info = await this.personInfo(thread.peer, '', cooId);
      return { ...thread, name: info.name, online: info.online, room: info.room, handle: info.handle };
    }));
    return { threads, unread: await mail.dmUnread(cooId) };
  }

  private async dmThreadPage(cooId: string, peer: string, before: number, limit: number): Promise<Record<string, unknown>> {
    if (!isCooId(peer)) throw new HttpError(400, '对方身份不对');
    const page = await new MailDb(this.db, { now: this.now }).thread(cooId, peer, before, limit);
    return { peer: await this.personInfo(peer, '', cooId), ...page };
  }

  /** 搜人：在线的人 + 我聊过的人；空查询就是全部候选；带 # 就是按号找。 */
  private async searchPeople(cooId: string, query: string): Promise<Record<string, unknown>> {
    const handle = parseHandleQuery(query);
    if (handle !== null) {
      // 按号找人：不看在线或聊过。拿到号就能找到，这正是号的意义。
      const assigned = await this.db.prepare("SELECT h.coo_id FROM global_handles h JOIN coos c ON c.id=h.coo_id WHERE h.handle=? AND c.status='active'").get(handle) as { coo_id: string } | undefined;
      if (assigned) return { people: assigned.coo_id === cooId ? [] : [await this.personInfo(assigned.coo_id)] };
      if (this.identityAuthority) {
        const exact = await this.db.prepare("SELECT id FROM coos WHERE id=? AND status='active'").get(handle) as { id: string } | undefined;
        return { people: exact && exact.id !== cooId ? [await this.personInfo(exact.id)] : [] };
      }
      const rows = await this.db.prepare(
        `SELECT id, display_name FROM coos
          WHERE status = 'active' AND id <> ? AND id LIKE ? ESCAPE '\\'
          ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at, id
          LIMIT 20`,
      ).all(cooId, `${likePrefix(handle)}%`, handle) as { id: string; display_name: string }[];
      return { people: await Promise.all(rows.map((row) => this.personInfo(row.id, row.display_name, cooId))) };
    }
    const needle = query.trim().toLowerCase();
    const rows = await this.db.prepare(
      "SELECT id, display_name FROM coos WHERE status = 'active' AND id <> ?",
    ).all(cooId) as { id: string; display_name: string }[];
    const past = new Set((await new MailDb(this.db, { now: this.now }).threads(cooId)).map((thread) => thread.peer));
    const people = (await Promise.all(rows.map((row) => this.personInfo(row.id, row.display_name, cooId))))
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
      // 全局登记只证明身份，入场仍需目标服务器的邀请码；换厅使用已入场的席位令牌。
      if (this.identityAuthority || await this.identify(req) === null) this.checkInvite(req, body);
      const cooId = await this.cooAuth(req, name);
      const relocation = await this.db.prepare('SELECT return_room_id FROM coo_sessions WHERE coo_id=?').get(cooId) as { return_room_id:string|null } | undefined;
      // Resolve the canonical target using the body already parsed above.
      // IncomingMessage is one-shot: recursively re-entering join would await a
      // second end event forever and lose body-based invite/name/kind/tier.
      roomId = relocation?.return_room_id || roomId;
      await this.assertRoomEntry(roomId, cooId);
      // 先建/取家长账户，再落座：账户表满时直接 503，**不留下一个没人认领的席位**
      // （老顺序是先落座后建账户，失败一次就多一排僵尸席位，客户端退避重连还会继续加）。
      // 建账户时席位还不存在，所以把「<席位名>的家长」直接算好传进去，默认名保持原样。
      const account = await this.coo.ensureAccount(cooId, name ? parentAccountName(name) : undefined);
      const host = await this.host(roomId);
      // 同一身份丢了令牌时续用原席位；身份认证与房间准入已在上面核过。
      const joined = await host.seatOf(cooId) ? await host.reissueSeatToken(cooId) : await host.join(cooId, {
        name,
        ...(typeof body.kind === 'string' ? { kind: body.kind as SeatKind } : {}),
        ...(typeof body.tier === 'string' ? { tier: body.tier as WakeTier } : {}),
      });
      await this.db.prepare('UPDATE coo_sessions SET return_room_id=NULL WHERE coo_id=?').run(cooId);
      this.pokeClock();
      json(res, 200, {
        room: roomId,
        ownerToken: '',
        seat: await seatOfRow(this.db, roomId, joined.seat),
        token: joined.token,
        maxSeats: (await host.room()).capacity,
        ...(account.created && account.ownerKey ? { ownerKey: account.ownerKey } : {}),
      });
      return;
    }

    if (action === 'switch' && method === 'POST') {
      const seat = await this.seatAuth(req, roomId);
      const body = await readJson(req);
      const value = typeof body.to === 'string' ? body.to : '';
      const target = (await getRoom(this.db, value)) ?? (await resolveRoom(this.db, value));
      if (!target) throw new HttpError(404, `目标客厅不存在：${value}`);
      await this.assertRoomEntry(target.id, seat.cooId);
      const moved = await (await this.host(roomId)).switchTo(seat.cooId, target.id, {
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
      });
      // 网页可在同一次往返取得目的地首屏；继续复用 /room 的本人权限投影。
      // 换席位已经提交，首屏读取失败仍须交还新令牌，让客户端单独补读。
      let snapshot: RoomSnapshot | undefined;
      if (body.includeSnapshot === true) {
        try {
          snapshot = await (await this.host(target.id)).snapshot(seat.cooId, { limit: 1 });
        } catch { /* 不把已成功换席位误报为失败，客户端可用新令牌重读。 */ }
      }
      json(res, 200, {
        ok: true,
        room: target.id,
        seat: await seatOfRow(this.db, target.id, moved.seat),
        token: moved.token,
        leaveSeq: moved.leaveEvent.seq,
        joinSeq: moved.joinEvent.seq,
        ...(snapshot ? { snapshot: { ...snapshot, online: this.onlineSeatIds(target.id) } } : {}),
      });
      return;
    }

    if (action === 'leave' && method === 'POST') {
      const seat = await this.seatAuth(req, roomId);
      const left = await (await this.host(roomId)).leave(seat.cooId);
      json(res, 200, {
        ok: true,
        seq: left.event.seq,
        at: serverClock(left.event.ts),
      });
      return;
    }

    if (action === 'room' && method === 'GET') {
      const seat = await this.seatAuth(req, roomId);
      const host = await this.host(roomId);
      await host.refreshClientVersion(seat.cooId, headerValue(req, 'x-parlor-client').trim());
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      const limit = Number(url.searchParams.get('limit') ?? 30) || 30;
      const snapshot: RoomSnapshot = await host.snapshot(seat.cooId, { since, limit });
      json(res, 200, { ...snapshot, online: this.onlineSeatIds(roomId) });
      return;
    }

    if (action === 'gifts' && method === 'GET') {
      // 茶单 + 本人存货：只读，任何登录席位都能看自己的。
      const seat = await this.seatAuth(req, roomId);
      const host = await this.host(roomId);
      const stock = await host.giftStock(seat.cooId);
      const mine = url.searchParams.get('mine') === '1';
      const items = mine ? stock.filter((item) => item.count > 0) : stock;
      json(res, 200, { items, at: serverClock(this.now()) });
      return;
    }

    if (action === 'games' && method === 'GET') {
      const seat = await this.seatAuth(req, roomId);
      const op = url.searchParams.get('op') || 'list';
      const base = { ok: true, protocol: 'parlor.game.v1', at: serverClock(this.now()) };
      if (op === 'list') {
        json(res, 200, { ...base, games: gameCatalog() });
        return;
      }
      if (op === 'describe') {
        const game = gameById(url.searchParams.get('game') || '');
        if (!game) throw new HttpError(404, '未知游戏；先查询游戏目录');
        json(res, 200, { ...base, game: describeGame(game) });
        return;
      }
      if (op !== 'state' && op !== 'history') throw new HttpError(400, 'op 只能是 list / describe / state / history');
      const host = await this.host(roomId);
      await host.refreshClientVersion(seat.cooId, headerValue(req, 'x-parlor-client').trim());
      const tableId = url.searchParams.get('table')?.trim() || undefined;
      if (op === 'history') {
        const log = await host.tableLog(seat.cooId, tableId, gameLogQuery(url.searchParams));
        boundedGameJson(res, { ...base, log });
        return;
      }
      const seq = await host.latest();
      const slice = await host.tableSlice(seat.cooId, tableId);
      if (tableId && !slice.table) throw new HttpError(404, '这个客厅里没有这张桌');
      const game = slice.table && gameById(slice.table.game);
      boundedGameJson(res, compactGameState({ ...base, seq, tables: slice.tables,
        ...(game && slice.table ? gameState(game, slice.table, slice.tablePrivate)
          : { table: null, tablePrivate: null, availableActions: [] }),
      }));
      return;
    }

    if (action === 'table' && method === 'GET') {
      // 牌桌增量：只补当前桌需要的三块。整份快照（含席位、事件、账本、信箱）仍走 /room。
      const seat = await this.seatAuth(req, roomId);
      const host = await this.host(roomId);
      await host.refreshClientVersion(seat.cooId, headerValue(req, 'x-parlor-client').trim());
      const tableId = url.searchParams.get('table')?.trim() || undefined;
      const slice = await host.tableSlice(seat.cooId, tableId);
      json(res, 200, { ok: true, ...slice });
      return;
    }

    if (action === 'history' && method === 'GET') {
      const seat = await this.seatAuth(req, roomId);
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      const limit = Number(url.searchParams.get('limit') ?? 30) || 30;
      const host = await this.host(roomId);
      json(res, 200, { latest: await host.latest(), events: await host.history(seat.cooId, { since, limit }) });
      return;
    }

    if (action === 'action' && method === 'POST') {
      const seat = await this.seatAuth(req, roomId);
      const body = await readJson(req);
      const type = typeof body.type === 'string' ? body.type : '';
      if (type === 'game_action') {
        try { validateParameters(GAME_ACTION_SCHEMA, body, 'body'); }
        catch (error) { throw new HttpError(400, (error as Error).message); }
      }
      const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
      // 牌桌修改一律要幂等键：旧客户端在这里拿到明确的升级提示，不会开出一张打不了的桌。
      // 玩法动作按注册表判断，加一个游戏不用再改这里。
      const tableMutation = type === 'table_open' || type === 'table_join' || type === 'table_leave'
        || type === 'table_start' || type === 'table_discovery'
        || type === 'game_action' || gameByActionType(type) !== null;
      if (tableMutation && !requestId) {
        throw new HttpError(400, '缺少 requestId：牌桌动作要带幂等键，请升级客厅扩展/刷新网页后再打牌');
      }
      const host = await this.host(roomId);
      const tableArg = typeof body.table === 'string' && body.table.trim() ? body.table.trim() : undefined;
      const revisionArg = typeof body.revision === 'number' ? body.revision : undefined;
      let delivered: unknown;
      let seats: unknown;
      let deadline: number | undefined;
      let turn: string | undefined;
      let tableId: string | undefined;
      let revision: number | undefined;
      let receiptSeq: number | undefined;
      let saidEvent: RoomEvent | undefined;
      let closed: boolean | undefined;
      /** 送礼/吃掉这类没有桌的动作，回执里带一句人话（运气文案走这里）。 */
      let notice: string | undefined;
      /** 这次动作碰到的桌（离桌也要：动之前先记下）。回执按它附桌视图。 */
      let touchedTable: string | undefined;
      /** 上/下桌、开桌这种会改桌列表的动作：回执连 tables 一起带。 */
      let tablesChanged = false;

      await host.refreshClientVersion(seat.cooId, headerValue(req, 'x-parlor-client').trim());

      if (type === 'say') {
        saidEvent = (await host.say(seat.cooId, typeof body.text === 'string' ? body.text : '')).event;
      } else if (type === 'table_say') {
        saidEvent = await host.tableSay(seat.cooId, typeof body.text === 'string' ? body.text : '', tableArg);
      } else if (type === 'whisper') {
        // 私聊走全局那条：对方在别的客厅或不在线也照样投信箱（Coo 也能跨厅回）。
        const result = await this.sendDm(seat.cooId, body);
        const message = result.message as { seq: number; ts: number };
        delivered = [{
          to: (result.peer as { name: string }).name,
          mailSeq: message.seq,
          ts: message.ts,
          at: serverClock(message.ts),
        }];
      } else if (type === 'set_tier') {
        if (typeof body.tier !== 'string') throw new HttpError(400, '挡位不对');
        await host.setTier(seat.cooId, body.tier as WakeTier);
      } else if (type === 'gift') {
        const result = await host.gift(
          seat.cooId,
          typeof body.to === 'string' ? body.to : '',
          body.item,
          typeof body.text === 'string' ? body.text : undefined,
        );
        delivered = result.delivered;
        notice = `送了 ${result.item.icon}${result.item.name} 给 ${result.toName}。`;
      } else if (type === 'gift_eat') {
        // 运气只是文案：不进牌局、不改概率、不写任何数值。
        const result = await host.consumeGift(seat.cooId, body.item);
        notice = `${result.luck.line}（还剩 ${result.remaining} 份）`;
      } else if (type === 'promise' || type === 'respond') {
        throw new HttpError(410, '承诺功能已停用。');
      } else if (type === 'table_open') {
        if (body.matchOpen !== undefined && typeof body.matchOpen !== 'boolean') throw new HttpError(400, 'matchOpen 必须是 true 或 false');
        if (body.requireHuman !== undefined && typeof body.requireHuman !== 'boolean') {
          throw new HttpError(400, 'requireHuman 必须是 true 或 false');
        }
        const opened = await host.openTable(seat.cooId, {
          game: typeof body.game === 'string' ? body.game : undefined,
          clientVersion: headerValue(req, 'x-parlor-client').trim() || undefined,
          ...(typeof body.matchOpen === 'boolean' ? { matchOpen: body.matchOpen } : {}),
          requireHuman: body.requireHuman,
          seatCount: body.seatCount,
        }, requestId);
        tableId = opened.tableId;
        revision = opened.receipt.revision;
        receiptSeq = opened.receipt.seq;
        deadline = opened.receipt.deadline;
        turn = opened.receipt.turn;
        touchedTable = opened.tableId;
        tablesChanged = true;
      } else if (type === 'table_discovery') {
        if (!tableArg) throw new HttpError(400, '需要指定桌号');
        if ((body.matchOpen !== undefined && typeof body.matchOpen !== 'boolean')
          || (body.text !== undefined && typeof body.text !== 'string')
          || (body.withdraw !== undefined && typeof body.withdraw !== 'boolean')
          || (body.matchOpen === undefined && body.text === undefined && body.withdraw !== true)
          || (body.text !== undefined && body.withdraw === true)) throw new HttpError(400, '请设置开放匹配、填写招募内容或撤回招募');
        const receipt = await host.tableDiscovery(seat.cooId, tableArg, {
          ...(typeof body.matchOpen === 'boolean' ? { matchOpen: body.matchOpen } : {}),
          ...(typeof body.text === 'string' ? { text: body.text } : {}),
          ...(body.withdraw === true ? { withdraw: true } : {}),
        }, requestId);
        tableId = receipt.tableId;
        revision = receipt.revision;
        receiptSeq = receipt.seq;
        touchedTable = tableArg;
        tablesChanged = true;
      } else if (type === 'table_join') {
        // 客户端自报协议能力版本（狼人杀开局前用它校验每只 Coo）；旧版不带 = 旧版。
        const clientVersion = headerValue(req, 'x-parlor-client').trim() || undefined;
        const joined = await host.joinTable(seat.cooId, tableArg, requestId, clientVersion);
        tableId = joined.tableId;
        revision = joined.receipt.revision;
        receiptSeq = joined.receipt.seq;
        deadline = joined.receipt.deadline;
        turn = joined.receipt.turn;
        touchedTable = joined.tableId;
        tablesChanged = true;
      } else if (type === 'table_leave') {
        // 离桌后这张桌可能就被收起来了；先记下桌号，回执照样能给出「那张桌已经不在了」。
        const before = await host.tablePublic(tableArg, seat.cooId);
        const left = await host.leaveTable(seat.cooId, tableArg, requestId);
        revision = left.receipt.revision;
        receiptSeq = left.receipt.seq;
        closed = left.closed;
        touchedTable = before ? (before.tableId ?? before.id) : undefined;
        tablesChanged = true;
      } else if (type === 'table_start') {
        const receipt = await host.startTable(seat.cooId, tableArg, requestId);
        tableId = receipt.tableId;
        revision = receipt.revision;
        receiptSeq = receipt.seq;
        seats = receipt.seats;
        deadline = receipt.deadline;
        turn = receipt.turn;
        touchedTable = receipt.tableId;
        tablesChanged = true;
      } else {
        // 牌桌动作按注册表分发：加一个游戏不用再改这里，只要它在 games/registry.ts 里登记过。
        const genericTarget = type === 'game_action' ? await host.tablePublic(tableArg, seat.cooId) : null;
        if (type === 'game_action' && !genericTarget) throw new HttpError(404, '这个客厅里没有这张桌');
        const game = genericTarget ? gameById(genericTarget.game) : gameByActionType(type);
        if (game) {
          const target = genericTarget ?? await host.tablePublic(tableArg, seat.cooId);
          // 不带桌号时，快照里那张「刚打完」的结果桌不能当成正在打的桌。
          if (!target || (!tableArg && target.status === 'ended')) {
            throw new HttpError(404, '你不在任何牌桌上');
          }
          if (target.game !== game.id) {
            throw new HttpError(400, `这张桌子不是${game.label}桌`);
          }
          let gameBody = body;
          if (type === 'game_action') {
            try { gameBody = gameActionBody(game, body.action as string, body.params); }
            catch (error) { throw new HttpError(400, (error as Error).message); }
          }
          const receipt = await host.tableAction(seat.cooId, game.toAction(gameBody), {
            ...(tableArg ? { tableId: tableArg } : { tableId: target.id ?? target.tableId }),
            ...(revisionArg !== undefined ? { revision: revisionArg } : {}),
            ...(requestId ? { requestId } : {}),
          });
          if (type === 'game_action') {
            this.pokeClock();
            const ts = receipt.ts ?? this.now();
            json(res, 200, {
              ok: true, protocol: 'parlor.game.v1', requestId, tableId: receipt.tableId,
              seq: receipt.seq ?? await host.latest(), revision: receipt.revision, ts, at: receipt.at ?? serverClock(ts),
              text: game.action.done(gameBody), deadline: receipt.deadline, deadlineAt: receipt.deadlineAt,
              turn: receipt.turn, windowId: receipt.windowId, inspection: receipt.inspection,
            });
            return;
          }
          tableId = receipt.tableId;
          revision = receipt.revision;
          receiptSeq = receipt.seq;
          deadline = receipt.deadline;
          turn = receipt.turn;
          touchedTable = receipt.tableId;
        } else if (type === 'monopoly') {
          throw new HttpError(400, '这台服务器只跑骰子与斗地主；大富翁请用旧服务器');
        } else {
          throw new HttpError(400, '未知动作');
        }
      }

      const ts = this.now();
      // 动作可能改了下一次截止（换手、进入下一段、结算）：叫时钟重算，别等满兜底那一拍。
      this.pokeClock();
      // 动作碰到桌就附一份增量：客户端拿回执直接重画，不必再拉整份快照。
      // 没有桌的动作（说话、送礼、私聊）不附，回执形状与旧版一致。
      const tablePatch = touchedTable !== undefined
        ? await (async () => {
          const slice = await host.tableSlice(seat.cooId, touchedTable);
          return {
            ...(tablesChanged ? { tables: slice.tables } : {}),
            table: slice.table,
            tablePrivate: slice.tablePrivate,
          };
        })()
        : {};
      json(res, 200, {
        ok: true,
        seq: receiptSeq ?? await host.latest(),
        ts,
        at: serverClock(ts),
        ...(saidEvent ? { event: saidEvent } : {}),
        ...(requestId ? { requestId } : {}),
        ...(tableId ? { tableId } : {}),
        ...(revision !== undefined ? { revision } : {}),
        ...(notice ? { notice } : {}),
        ...(delivered && Array.isArray(delivered) && delivered.length > 0 ? { delivered } : {}),
        ...(seats ? { seats } : {}),
        ...(deadline ? { deadline, deadlineAt: serverClock(deadline) } : {}),
        ...(turn ? { turn } : {}),
        ...(closed !== undefined ? { closed } : {}),
        ...tablePatch,
      });
      return;
    }

    if (action === 'table-log' && method === 'GET') {
      const seat = await this.seatAuth(req, roomId);
      const tableArg = url.searchParams.get('table')?.trim() || undefined;
      const log = await (await this.host(roomId)).tableLog(seat.cooId, tableArg, gameLogQuery(url.searchParams));
      boundedGameJson(res, { ok: true, at: serverClock(this.now()), log });
      return;
    }

    if (action === 'replay' && method === 'GET') {
      const seat = await this.seatAuth(req, roomId);
      const limit = Number(url.searchParams.get('limit') ?? 50) || 50;
      const before = Number(url.searchParams.get('before') ?? 0) || undefined;
      const host = await this.host(roomId);
      const page = await host.replay(seat.cooId, { limit, ...(before ? { before } : {}) });
      json(res, 200, {
        room: roomId,
        latest: await host.latest(),
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
      }, req);
      return;
    }

    if (action === 'mail' && method === 'GET') {
      const seat = await this.seatAuth(req, roomId);
      const room = url.searchParams.get('all') === '0' ? roomId : undefined;
      json(res, 200, await this.mailPage(seat.cooId, url.searchParams, room));
      return;
    }

    if (action === 'stream' && method === 'GET') {
      const token = url.searchParams.get('token') ?? bearer(req);
      await this.seatAuth(req, roomId, token);
      await this.stream(req, res, roomId, token, Number(url.searchParams.get('since') ?? 0) || 0);
      return;
    }

    throw new HttpError(405, '这个动作不支持这个 HTTP 方法');
  }

  private async mailPage(cooId: string, query: URLSearchParams, room?: string) {
    const mail = new MailDb(this.db, { now: this.now });
    const limit = Number(query.get('limit') ?? 10) || 10;
    if (query.get('recent') === '1') {
      const unread = await mail.unreadCount(cooId, room);
      return {
        unread,
        remaining: unread,
        items: await mail.recent(cooId, room, Math.min(50, limit)),
        marked: false,
      };
    }
    return mail.list(cooId, room, limit, query.get('peek') !== '1', query.get('newest') === '1');
  }

  private async stream(req: IncomingMessage, res: ServerResponse, roomId: string, token: string, since: number): Promise<void> {
    const host = await this.host(roomId);
    const seat = await host.seatByToken(token);
    const locationCapable = headerValue(req, 'x-parlor-capabilities').split(',').map(value => value.trim()).includes('seat-location-v1')
      || new URL(req.url ?? '/', 'http://localhost').searchParams.get('cap') === 'seat-location-v1';
    if (locationCapable) {
      await this.db.prepare('UPDATE room_seats SET location_capable=1 WHERE room_id=? AND id=? AND location_capable=0').run(roomId,seat.id);
    }
    const allClients = [...this.sse.values()].flatMap(set => [...set]);
    if (allClients.length >= 2000 || allClients.filter(client => client.cooId === seat.cooId).length >= 6) {
      throw new HttpError(429, '实时连接过多，请关闭多余页面后重试');
    }
    await host.refreshClientVersion(seat.cooId, headerValue(req, 'x-parlor-client').trim());
    // PG 查询会让出事件循环。发出 200 之前先完成在线登记，否则客户端已
    // 看到 SSE 建连成功时，离线清理仍可能把它当成没有连接的旧席位释放。
    const initial = await host.eventsSince(seat.cooId, since, 200);
    const now = this.now();
    await touchSeatSeen(this.db, roomId, seat.id, now);
    if (req.destroyed || res.destroyed) return;
    const cursor = initial.length > 0 ? initial[initial.length - 1]!.seq : since;
    const client: SseClient = {
      locationCapable,
      cooId: seat.cooId,
      seatId: seat.id,
      seatName: seat.name,
      since,
      lastPing: now,
      openedAt: now,
      closed: false,
      res,
    };
    let clients = this.sse.get(roomId);
    if (!clients) {
      clients = new Set();
      this.sse.set(roomId, clients);
    }
    const latestClients = [...this.sse.values()].flatMap(set => [...set]);
    if (latestClients.length >= 2000 || latestClients.filter(c => c.cooId === seat.cooId).length >= 6) throw new HttpError(429,'实时连接过多，请关闭多余页面后重试');
    clients.add(client);
    // 掉线排查用：一行开、一行关（谁断的、持续多久）。不带令牌。
    console.log(`parlor: SSE 打开 ${roomId}/${seat.name}（这一厅 ${clients.size} 条）`);
    req.on('close', () => {
      clients?.delete(client);
      if (clients?.size === 0) this.sse.delete(roomId);
      // 断连回调是同步的：写不进去（席位已释放/库关了）就算了，别抛未处理的拒绝。
      void touchSeatSeen(this.db, roomId, seat.id, this.now()).catch(() => { /* 席位已释放/库关了 */ });
      if (client.closed) return;
      client.closed = true;
      const ms = Math.max(0, this.now() - client.openedAt);
      console.log(`parlor: SSE 关闭 ${roomId}/${client.seatName} 持续 ${Math.round(ms / 1000)} 秒（${client.closeReason ?? '客户端断开'}）`);
    });
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');
    for (const event of initial) if (!this.writeEvent(roomId, client, event)) break;
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

  private async parentSession(req: IncomingMessage) {
    const token = cookieOf(req, 'parlor_parent');
    const session = token ? await this.coo.verifySession(token) : null;
    if (!session) throw new HttpError(401, '家长会话已失效，请重新打开家长链接');
    return session;
  }

  private async parentSeatView(cooId: string) {
    const seat = await activeSeatForCoo(this.db, cooId);
    if (!seat) return null;
    const room = await getRoom(this.db, seat.roomId);
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
   * 邀请/授权要送给谁：活跃席位（Coo id 或席位名）优先；找不到再按家长固定的
   * 下场身份找（人不在座也能邀请）。人类只认有家长账户的；没下过场的家长没有
   * 能收信的身份。
   */
  private async resolveInviteTarget(to: string): Promise<{ cooId: string; name: string; roomId: string | null; kind: string }> {
    const handle = parseHandleQuery(to);
    const key = handle !== null ? await this.cooByHandle(handle) : to;
    // COLLATE NOCASE 只有 SQLite 有：改成 lower() 两边都对得上。
    const rows = await this.db.prepare(
      `SELECT room_id, id, coo_id, name, kind FROM room_seats
        WHERE released_at IS NULL AND (coo_id = ? OR lower(name) = lower(?))`,
    ).all(key, key) as { room_id: string; id: string; coo_id: string; name: string; kind: string }[];
    const row = rows.find((entry) => entry.coo_id === key)
      ?? rows.find((entry) => entry.name.toLowerCase() === key.toLowerCase());
    if (handle === null && !rows.some((entry) => entry.coo_id === key) && rows.length > 1) {
      throw new HttpError(409, '有多个同名的人，请用 #短号');
    }
    let target: { cooId: string; name: string; roomId: string | null; kind: string };
    if (row) {
      target = { cooId: row.coo_id, name: row.name, roomId: row.room_id, kind: row.kind };
    } else {
      // 没在座的 Coo：按身份 id 找（房主管理页里列出的就是 cooId）。
      const coo = await this.db.prepare('SELECT id, kind, display_name FROM coos WHERE id = ?').get(key) as
        { id: string; kind: string; display_name: string } | undefined;
      if (coo) {
        return {
          cooId: coo.id,
          name: coo.display_name || coo.id,
          roomId: null,
          kind: coo.kind === 'human' ? 'human' : 'pet',
        };
      }
      const parents = await this.coo.findParentsByName(key);
      const ready = parents.filter(
        (entry): entry is { accountId: string; cooId: string; name: string } => entry.cooId !== null,
      );
      if (ready.length > 1) {
        throw new HttpError(409, `有 ${ready.length} 位家长叫「${to}」；换一个能分清的名字`);
      }
      const parent = ready[0];
      if (!parent) {
        if (parents.length) {
          throw new HttpError(409, `「${to}」还没下场玩过，没有能收信的身份；先让他点「下场玩」进来一次`);
        }
        throw new HttpError(404, `没有找到「${to}」这个席位或家长`);
      }
      target = { cooId: parent.cooId, name: parent.name, roomId: null, kind: 'human' };
    }
    if (target.kind === 'human' && !await this.coo.isPlayerCoo(target.cooId)) {
      throw new HttpError(403, `「${target.name}」没有家长账户；这个邀请只对家长开放`);
    }
    return target;
  }

  /**
   * 家长下场：用家长会话给自己领一个 human 席位。
   * 玩家身份固定在 `accounts.player_coo_id` 上——同一个家长链接在任何浏览器都是同一个人；
   * 账本与信箱跟孩子那份分开（孩子是 Coo 的 cooId，家长玩家是另一个 human coo）。
   */
  private async parentPlay(account: ParentAccount, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requested = typeof body.room === 'string' && body.room.trim() ? body.room.trim() : '';
    const childSeat = await activeSeatForCoo(this.db, account.cooId);
    const wanted = requested || childSeat?.roomId || this.defaultRoomId;
    const target = (await getRoom(this.db, wanted)) ?? (await resolveRoom(this.db, wanted));
    if (!target) throw new HttpError(404, `客厅不存在：${wanted}`);
    if (target.archivedAt !== null) throw new HttpError(409, '这个客厅已经归档了');

    if (this.identityAuthority && this.identityAuthority !== 'self') {
      return { globalEntry: this.authorityUrl(), room: target.id };
    }
    const player = await this.ensurePlayerCoo(account, typeof body.name === 'string' ? body.name : '');
    if (this.identityAuthority === 'self') await this.registry.enroll(player.cooId, player.secret, player.name, 'human');
    // 家长作为玩家也要按自己的身份准入（孩子被邀请不等于家长玩家也是成员）。
    await this.assertRoomEntry(target.id, player.cooId);
    let seat = await activeSeatForCoo(this.db, player.cooId);
    let token: string;
    if (!seat) {
      const joined = await (await this.host(target.id)).join(player.cooId, {
        name: player.name, kind: 'human', tier: 'off',
      });
      seat = joined.seat;
      token = joined.token;
    } else if (seat.roomId === target.id) {
      const reissued = await (await this.host(target.id)).reissueSeatToken(player.cooId);
      seat = reissued.seat;
      token = reissued.token;
    } else {
      const moved = await (await this.host(seat.roomId)).switchTo(player.cooId, target.id, { name: player.name });
      seat = moved.seat;
      token = moved.token;
    }
    return {
      room: target.id,
      roomName: target.name,
      seat: await seatOfRow(this.db, target.id, seat),
      token,
      identity: { cooId: player.cooId, cooSecret: this.identityAuthority ? 'seat-only' : player.secret },
      player: true,
    };
  }

  /**
   * 家长改名字：账户显示名 + 玩家身份名 + 当前席位名一次改完。
   * 还没下过场就顺手把玩家身份建出来，免得第一次下场又回到默认名。
   */
  private async parentRename(account: ParentAccount, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const raw = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    if (!raw) throw new HttpError(400, '名字不能为空');
    if (raw.length > 24) throw new HttpError(400, '名字最多 24 个字');

    const playerId = await this.coo.playerCooOf(account.id);
    let seat: { room: string; id: string; name: string } | null = null;
    if (playerId) {
      const active = await activeSeatForCoo(this.db, playerId);
      if (active) {
        // 同厅重名会抛 RoomSeatError('name_taken')，由 statusOf 转成 409。
        await renameSeat(this.db, active.roomId, active.id, raw);
        seat = { room: active.roomId, id: active.id, name: raw };
      }
      await this.coo.renameCooDisplay(playerId, raw);
    }
    const renamed = await this.coo.rename(account.id, raw);
    if (!renamed) throw new HttpError(409, '改不了名字');
    if (!playerId && (!this.identityAuthority || this.identityAuthority === 'self')) await this.ensurePlayerCoo(renamed, raw);
    return {
      account: { id: renamed.id, cooId: renamed.cooId, displayName: renamed.displayName },
      seat,
    };
  }

  /** 家长玩家的固定 human 身份；每次下场换一枚新 secret（库里只存哈希）。 */
  private async ensurePlayerCoo(account: ParentAccount, requested = ''): Promise<{ cooId: string; secret: string; name: string }> {
    const secret = randomBytes(32).toString('base64url');
    const existing = await this.coo.playerCooOf(account.id);
    if (existing) {
      const name = await this.coo.cooDisplayName(existing) || await this.defaultPlayerName(account);
      await this.coo.rotateSecret(existing, secret);
      return { cooId: existing, secret, name: name.slice(0, 24) };
    }
    const name = (requested.trim() || await this.defaultPlayerName(account)).slice(0, 24);
    const cooId = randomUUID();
    const created = await this.coo.registerCoo(cooId, secret, 'human', name);
    if (created !== 'ok') throw new HttpError(500, '建不了家长的游戏身份');
    await this.coo.bindPlayerCoo(account.id, cooId);
    return { cooId, secret, name };
  }

  /** 家长玩家的默认名「<孩子名>家的家长」；孩子不在座就退回孩子的显示名，最后退回「家长」。 */
  private async defaultPlayerName(account: ParentAccount): Promise<string> {
    const seat = await activeSeatForCoo(this.db, account.cooId);
    const child = (seat?.name || await this.coo.cooDisplayName(account.cooId) || '').trim();
    return child ? `${child}家的家长` : '家长';
  }

  /** 家长只读视图：跟孩子当前席位走，可见范围与孩子自己完全一致。 */
  private async parentView(cooId: string, since: number, limit: number): Promise<Record<string, unknown>> {
    const now = this.now();
    const seat = await activeSeatForCoo(this.db, cooId);
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
        mail: await mail.parentRecent(cooId, limit),
        mailUnread: await mail.unreadCount(cooId),
      };
    }
    const room = await getRoom(this.db, seat.roomId);
    const host = await this.host(seat.roomId);
    const snapshot = await host.snapshot(cooId, { since, limit });
    // 家长防偷看：桌上还有「真人」席位时，藏起孩子的暗牌与私牌事件。同桌的 Coo 不算真人。
    const liveTableId = snapshot.table && snapshot.table.status !== 'ended'
      ? snapshot.table.id ?? snapshot.table.tableId
      : undefined;
    let humanAtTable = false;
    if (liveTableId) {
      const row = await this.db.prepare(
        `SELECT 1 AS hit
           FROM table_seats ts
           JOIN room_seats rs ON rs.room_id = ts.room_id AND rs.id = ts.seat_id
          WHERE ts.table_id = ? AND ts.left_at IS NULL AND rs.kind = 'human'
          LIMIT 1`,
      ).get(liveTableId) as { hit?: number } | undefined;
      humanAtTable = !!row;
    }
    const ownerPrivateHidden = !!liveTableId && humanAtTable;
    return {
      seat: snapshot.seat,
      room: { id: seat.roomId, name: room?.name ?? seat.roomId, kind: room?.kind ?? 'room' },
      latest: snapshot.latest,
      now: snapshot.now,
      at: snapshot.at,
      events: ownerPrivateHidden
        ? snapshot.events.filter((event) => event.type !== 'parlor.table.turn')
        : snapshot.events,
      tables: snapshot.tables ?? [],
      ...(snapshot.table ? { table: snapshot.table } : {}),
      tablePrivate: ownerPrivateHidden ? null : snapshot.tablePrivate ?? null,
      ...(snapshot.ledger ? { ledger: snapshot.ledger } : {}),
      ledgerRoom: snapshot.ledgerRoom ?? [],
      mailUnread: snapshot.mailUnread ?? 0,
      mail: await mail.parentRecent(cooId, limit),
      ownerPrivateHidden,
    };
  }

  /** 回放是 7 天；事件表只增不减会一直长，所以每小时清一次。 */
  private async pruneEvents(now: number): Promise<void> {
    const before = now - 7 * 24 * 60 * 60_000;
    const rooms = await this.db.prepare('SELECT id FROM rooms').all() as { id: string }[];
    for (const room of rooms) {
      try {
        await new EventDb(this.db).prune(room.id, before, 500);
      } catch (error) {
        console.error(`parlor: 清理事件失败（${room.id}）`, error);
      }
    }
    // 牌桌的隐藏内容与动作回执也按同一保留期清；活动牌局不受影响。
    await this.db.prepare('DELETE FROM action_receipts WHERE created_at < ?').run(before);
    await this.db.prepare(
      `UPDATE tables SET state_json = NULL
        WHERE state_json IS NOT NULL AND status IN ('ended','abandoned')
          AND ended_at IS NOT NULL AND ended_at < ?`,
    ).run(before);
    await expireInvitations(this.db, now);
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
  private serveWeb(pathname: string, req: IncomingMessage, res: ServerResponse): boolean {
    if (pathname === '/support' || pathname === '/support/') {
      this.sendWeb('support.html', req, res, true); return true;
    }
    if (pathname === '/identity' && this.identityAuthority === 'self') {
      this.sendWeb('identity.html', req, res, true); return true;
    }
    if (pathname === '/play' || pathname === '/play/') {
      this.sendWeb('play.html', req, res, true);
      return true;
    }
    if (pathname === '/parent' || pathname === '/parent/') {
      this.sendWeb('parent.html', req, res, true);
      return true;
    }
    const prefix = pathname.startsWith('/parent/assets/') ? '/parent/assets/' : '/play/assets/';
    if (!pathname.startsWith(prefix)) return false;
    const rel = pathname.slice(prefix.length);
    if (!rel || rel.startsWith('/') || rel.includes('..') || rel.includes('\\')
      || !/^[A-Za-z0-9._/-]+$/.test(rel)) {
      throw new HttpError(404, '没有这个文件');
    }
    this.sendWeb(rel, req, res, false);
    return true;
  }

  private sendWeb(rel: string, req: IncomingMessage, res: ServerResponse, page: boolean): void {
    if (!sendWebAsset(rel, req, res, page)) throw new HttpError(404, '没有这个文件');
  }

  /**
   * 某个客厅刚提交了新事件：如果有人在订阅，下一轮事件循环就推。
   * 没有订阅者就不记，省得干净。
   */
  private markDirty(roomId: string): void {
    if (this.closing || !this.sse.has(roomId)) return;
    this.dirtyRooms.add(roomId);
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    setImmediate(() => {
      this.pumpScheduled = false;
      void this.pump().catch((error) => { console.error('parlor: 推送循环出错', error); });
    });
  }

  private writeEvent(room: string, client: SseClient, event: RoomEvent): boolean {
    const ready = client.res.write(`data: ${JSON.stringify(event)}\n\n`);
    client.since = event.seq; // write(false) has accepted this event into the bounded buffer
    if (!ready) {
      client.blockedAt = this.now();
      client.res.once('drain', () => { client.blockedAt = undefined; this.markDirty(room); });
    }
    return ready;
  }

  private async pump(): Promise<void> {
    if (this.closing) return;
    // 上一轮还没跑完就跳过这一轮：两条循环同时读 client.since 会把同一批事件推两遍。
    if (this.pumping) return;
    this.pumping = true;
    const now = this.now();
    // 有 dirty 就只推那些客厅；每 2 秒补一次全扫，兜住漏掉的通知与 ping。
    const fullSweep = now - this.lastSweepAt >= 2_000;
    if (fullSweep) this.lastSweepAt = now;
    const targets = fullSweep ? [...this.sse.keys()] : [...this.dirtyRooms];
    try {
      for (const roomId of targets) {
        this.dirtyRooms.delete(roomId);
        const clients = this.sse.get(roomId);
        if (!clients) continue;
        const seats = new Map((await activeSeats(this.db, roomId)).map(row => [row.cooId, row]));
        const eventsDb = new EventDb(this.db);
        const shared = new Map<string, RoomEvent[]>();
        for (const client of [...clients]) {
          try {
            if (client.res.writableLength > 1_048_576 || (client.blockedAt !== undefined && now - client.blockedAt > 30_000)) {
              clients.delete(client); client.closeReason = '客户端接收过慢'; client.res.destroy(); continue;
            }
            if (client.blockedAt !== undefined) continue;
            const seat = seats.get(client.cooId);
            if (!seat || seat.id !== client.seatId) {
              clients.delete(client);
              client.closeReason = '席位已经不在这个客厅';
              client.res.end();
              continue;
            }
            const key = JSON.stringify([client.cooId, client.since]);
            const events = shared.get(key) ?? await eventsDb.history(roomId, { cooId:client.cooId, since:client.since, limit:200,
              interval:{ visibleFromSeq:seat.visibleFromSeq, visibleUntilSeq:seat.visibleToSeq } });
            shared.set(key, events);
            for (const event of events) {
              if (!this.writeEvent(roomId, client, event)) break;
            }
            if (events.length === 0 && now - client.lastPing >= 15_000) {
              client.res.write(': ping\n\n');
              client.lastPing = now;
            }
          } catch (error) {
            clients.delete(client);
            client.closeReason = `写推送失败：${(error as Error)?.message ?? String(error)}`;
            try { client.res.end(); } catch { /* 已断开 */ }
          }
        }
        if (clients.size === 0) this.sse.delete(roomId);
      }
    } finally {
      this.pumping = false;
    }
  }
}
