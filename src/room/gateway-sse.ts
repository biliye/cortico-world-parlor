/** 多客厅网关的 SSE 实时推送中心：建连限额、背压保护、按厅脏推、流量统计与在线席位追踪。 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { EventDb } from './event-db.ts';
import { headerValue, HttpError } from './http.ts';
import type { RoomEvent } from './protocol.ts';
import type { RoomHost } from './room-host.ts';
import { activeSeats, touchSeatSeen } from './room-seat-db.ts';
import { isWebSeatToken, type WebPlayerDb } from './web-player-db.ts';

export interface SseClient {
  locationCapable: boolean;
  compactTableEvents: boolean;
  source: 'web' | 'coo' | 'other';
  cooId: string;
  seatId: string;
  tokenHash: string;
  webSeat: boolean;
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

const SSE_TRAFFIC_INTERVAL_MS = 60_000;

function sseSourceCounts() {
  return { web: 0, coo: 0, other: 0 };
}

function sseTrafficCounters() {
  return {
    bytes: 0,
    bytesBySource: sseSourceCounts(),
    // 补发与回合都是 bytes 的子集，同一帧可以同时计入两项。
    initialReplayBytes: 0,
    turnBytes: 0,
    turnBytesBySource: sseSourceCounts(),
    opened: 0,
    closed: 0,
  };
}

export class SseHub {
  private readonly rooms = new Map<string, Set<SseClient>>();
  private readonly dirtyRooms = new Set<string>();
  private pumping = false;
  private pumpScheduled = false;
  private closing = false;
  private lastSweepAt = 0;
  private trafficSince = Date.now();
  private traffic = sseTrafficCounters();

  constructor(
    private readonly db: Db,
    private readonly webPlayers: WebPlayerDb,
    private readonly now: () => number,
  ) {}

  get isPumping(): boolean {
    return this.pumping;
  }

  hasRoom(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  /** 有没有正在连着的客户端（网页或 Coo）；不看席位在不在。 */
  isOnline(cooId: string): boolean {
    for (const clients of this.rooms.values()) {
      for (const client of clients) if (client.cooId === cooId) return true;
    }
    return false;
  }

  onlineCooIds(): Set<string> {
    const online = new Set<string>();
    for (const clients of this.rooms.values()) {
      for (const client of clients) online.add(client.cooId);
    }
    return online;
  }

  /** 有推送连接的席位（快照里的在线标记）。 */
  onlineSeatIds(roomId: string): string[] {
    const clients = this.rooms.get(roomId);
    if (!clients) return [];
    return [...new Set([...clients].map((client) => client.seatId))];
  }

  /** 是否允许生命周期把该 Coo 闲置迁厅：只要还有不具备位置恢复能力的旧连接就暂缓。 */
  allowIdleMove(cooId: string): boolean {
    for (const clients of this.rooms.values()) {
      for (const client of clients) {
        if (client.cooId === cooId && !client.closed && !client.locationCapable) return false;
      }
    }
    return true;
  }

  beginClose(): void {
    this.closing = true;
  }

  closeAll(): void {
    for (const clients of this.rooms.values()) {
      for (const client of clients) {
        try { client.res.end(); } catch { /* 已断开 */ }
      }
    }
    this.rooms.clear();
  }

  /**
   * 某个客厅刚提交了新事件：如果有人在订阅，下一轮事件循环就推。
   * 没有订阅者就不记，省得干净。
   */
  markDirty(roomId: string): void {
    if (this.closing || !this.rooms.has(roomId)) return;
    this.dirtyRooms.add(roomId);
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    setImmediate(() => {
      this.pumpScheduled = false;
      void this.pump().catch((error) => { console.error('parlor: 推送循环出错', error); });
    });
  }

  async open(
    req: IncomingMessage,
    res: ServerResponse,
    roomId: string,
    host: RoomHost,
    token: string,
    since: number,
  ): Promise<void> {
    const seat = await host.seatByToken(token);
    const locationCapable = headerValue(req, 'x-parlor-capabilities').split(',').map(value => value.trim()).includes('seat-location-v1')
      || new URL(req.url ?? '/', 'http://localhost').searchParams.get('cap') === 'seat-location-v1';
    const compactTableEvents = headerValue(req, 'x-parlor-stream') === 'compact-table-v1';
    const clientVersion = headerValue(req, 'x-parlor-client').trim();
    const source = compactTableEvents ? 'web' : clientVersion ? 'coo' : 'other';
    if (locationCapable) {
      await this.db.prepare('UPDATE room_seats SET location_capable=1 WHERE room_id=? AND id=? AND location_capable=0').run(roomId, seat.id);
    }
    const allClients = [...this.rooms.values()].flatMap(set => [...set]);
    if (allClients.length >= 2000 || allClients.filter(client => client.cooId === seat.cooId).length >= 6) {
      throw new HttpError(429, '实时连接过多，请关闭多余页面后重试');
    }
    await host.refreshClientVersion(seat.cooId, clientVersion);
    // PG 查询会让出事件循环。发出 200 之前先完成在线登记，否则客户端已
    // 看到 SSE 建连成功时，离线清理仍可能把它当成没有连接的旧席位释放。
    const initial = await host.eventsSince(seat.cooId, since, 200);
    const now = this.now();
    await touchSeatSeen(this.db, roomId, seat.id, now);
    if (req.destroyed || res.destroyed) return;
    const client: SseClient = {
      locationCapable,
      compactTableEvents,
      source,
      cooId: seat.cooId,
      seatId: seat.id,
      tokenHash: seat.tokenHash,
      webSeat: isWebSeatToken(token),
      seatName: seat.name,
      since,
      lastPing: now,
      openedAt: now,
      closed: false,
      res,
    };
    let clients = this.rooms.get(roomId);
    if (!clients) {
      clients = new Set();
      this.rooms.set(roomId, clients);
    }
    const latestClients = [...this.rooms.values()].flatMap(set => [...set]);
    if (latestClients.length >= 2000 || latestClients.filter(c => c.cooId === seat.cooId).length >= 6) {
      throw new HttpError(429, '实时连接过多，请关闭多余页面后重试');
    }
    clients.add(client);
    this.traffic.opened += 1;
    // 掉线排查用：一行开、一行关（谁断的、持续多久）。不带令牌。
    console.log(`parlor: SSE 打开 ${roomId}/${seat.name}（这一厅 ${clients.size} 条） source=${client.source}`);
    req.on('close', () => {
      clients?.delete(client);
      if (clients?.size === 0) this.rooms.delete(roomId);
      // 断连回调是同步的：写不进去（席位已释放/库关了）就算了，别抛未处理的拒绝。
      void touchSeatSeen(this.db, roomId, seat.id, this.now()).catch(() => { /* 席位已释放/库关了 */ });
      if (client.closed) return;
      client.closed = true;
      this.traffic.closed += 1;
      const ms = Math.max(0, this.now() - client.openedAt);
      console.log(`parlor: SSE 关闭 ${roomId}/${client.seatName} 持续 ${Math.round(ms / 1000)} 秒（${client.closeReason ?? '客户端断开'}） source=${client.source}`);
    });
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();
    this.writeFrame(client, 'retry: 3000\n\n');
    for (const event of initial) if (!this.writeEvent(roomId, client, event, true)) break;
  }

  private writeFrame(client: SseClient, frame: string, replay = false, turn = false): boolean {
    const ready = client.res.write(frame);
    const bytes = Buffer.byteLength(frame);
    this.traffic.bytes += bytes;
    this.traffic.bytesBySource[client.source] += bytes;
    if (replay) this.traffic.initialReplayBytes += bytes;
    if (turn) {
      this.traffic.turnBytes += bytes;
      this.traffic.turnBytesBySource[client.source] += bytes;
    }
    return ready;
  }

  private writeEvent(room: string, client: SseClient, event: RoomEvent, replay = false): boolean {
    const turn = event.type === 'parlor.table.turn';
    const payload = client.compactTableEvents && turn ? { seq: event.seq, type: event.type } : event;
    const ready = this.writeFrame(client, `data: ${JSON.stringify(payload)}\n\n`, replay, turn);
    client.since = event.seq; // write(false) has accepted this event into the bounded buffer
    if (!ready) {
      client.blockedAt = this.now();
      client.res.once('drain', () => { client.blockedAt = undefined; this.markDirty(room); });
    }
    return ready;
  }

  async pump(): Promise<void> {
    if (this.closing) return;
    // 上一轮还没跑完就跳过这一轮：两条循环同时读 client.since 会把同一批事件推两遍。
    if (this.pumping) return;
    this.pumping = true;
    const now = this.now();
    const wallTime = Date.now();
    const elapsed = wallTime - this.trafficSince;
    if (elapsed >= SSE_TRAFFIC_INTERVAL_MS) {
      const activeBySource = sseSourceCounts();
      for (const clients of this.rooms.values()) {
        for (const client of clients) activeBySource[client.source] += 1;
      }
      const active = activeBySource.web + activeBySource.coo + activeBySource.other;
      const traffic = this.traffic;
      if (active || traffic.opened || traffic.closed || traffic.bytes) {
        console.log(`parlor: SSE 流量 ${JSON.stringify({ intervalMs: elapsed, active, activeBySource, ...traffic })}`);
      }
      this.trafficSince = wallTime;
      this.traffic = sseTrafficCounters();
    }
    // 有 dirty 就只推那些客厅；每 2 秒补一次全扫，兜住漏掉的通知与 ping。
    const fullSweep = now - this.lastSweepAt >= 2_000;
    if (fullSweep) this.lastSweepAt = now;
    const targets = fullSweep ? [...this.rooms.keys()] : [...this.dirtyRooms];
    try {
      for (const roomId of targets) {
        this.dirtyRooms.delete(roomId);
        const clients = this.rooms.get(roomId);
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
            if (!seat || seat.id !== client.seatId || seat.tokenHash !== client.tokenHash
              || (client.webSeat && !await this.webPlayers.seatSession(client.tokenHash))) {
              clients.delete(client);
              client.closeReason = '席位已经不在这个客厅';
              client.res.end();
              continue;
            }
            const key = JSON.stringify([client.cooId, client.since]);
            const events = shared.get(key) ?? await eventsDb.history(roomId, {
              cooId: client.cooId, since: client.since, limit: 200,
              interval: { visibleFromSeq: seat.visibleFromSeq, visibleUntilSeq: seat.visibleToSeq },
            });
            shared.set(key, events);
            for (const event of events) {
              if (!this.writeEvent(roomId, client, event)) break;
            }
            if (events.length === 0 && now - client.lastPing >= 15_000) {
              this.writeFrame(client, ': ping\n\n');
              client.lastPing = now;
            }
          } catch (error) {
            clients.delete(client);
            client.closeReason = `写推送失败：${(error as Error)?.message ?? String(error)}`;
            try { client.res.end(); } catch { /* 已断开 */ }
          }
        }
        if (clients.size === 0) this.rooms.delete(roomId);
      }
    } finally {
      this.pumping = false;
    }
  }
}
