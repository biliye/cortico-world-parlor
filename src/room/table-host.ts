/**
 * 一个客厅的牌桌运行时：多桌、可靠存档与动作回执。
 *
 * 一房多桌（默认最多 10 张未结束）；每个真人同一时刻只参与一张（`active_table_players`）。
 * 内存里的引擎只是「已提交状态」的缓存：每个动作先在恢复出的临时副本上执行，
 * 再把新快照、事件、账本、席位、回执放进同一个 SQLite 事务提交；提交成功才替换缓存。
 * 事务失败时内存不前进，临时副本丢掉。
 *
 * 恢复：进程启动时按 `meta.last_healthy_at` 算停机时长。短停机把截止时刻搬到现在续局，
 * 超过 30 分钟的作废并按开局的实际扣款原路退回；读不懂的快照只隔离那一桌。
 */
import { createHash, randomUUID } from 'node:crypto';
import { withTransaction, type Db } from './db.ts';
import { lockCooRows, lockTableRow } from './storage/locks.ts';
import { EventDb } from './event-db.ts';
import { HostError } from './host-error.ts';
import { LedgerDb } from './ledger-db.ts';
import { MAX_CHIPS } from './ledger.ts';
import { MailDb } from './mail-db.ts';
import { serverClock } from './clock.ts';
import { gameById, gameIds, gameLabelOf } from './games/registry.ts';
import { jsonValue } from './storage/json.ts';
import { isUniqueViolation } from './storage/errors.ts';
import {
  TableError,
  type TableEngine,
  type TableEvent,
  type TableLogQuery,
  type TablePrivateSummary,
  type TableStatus,
  type TableStep,
  type TableSummary,
} from './table-engine.ts';
import type { RoomEvent } from './protocol.ts';
import type { SeatRow } from './room-seat-db.ts';

const OPEN_MS = 30 * 60_000;
/** 托管席位（Coo 掉线/被移出）由脚本代打的节拍：一秒一拍，与旧的每秒 tick 一致。 */
const AUTO_TICK_MS = 1_000;
const MAX_TABLE_TEXT = 400;
/** 一房同时未结束的桌数上限（30 人分 10 桌斗地主）。 */
export const MAX_LIVE_TABLES = 10;
/** 停机超过这么久，已开局的桌作废、押注原路退回。 */
export const MAX_DOWNTIME_MS = 30 * 60_000;
/** 恢复后给真人的最短重连时间。 */
const MIN_HUMAN_RESUME_MS = 10_000;
/** 结束的桌子在内存里留几张给「刚打完」的页面看。 */
const KEEP_ENDED = 3;
/** 席位最近活跃晚于这个阈值才算「在线」；离线决策留无秘密的提醒信。 */
const OFFLINE_REMINDER_MS = 90_000;

export interface TableHostOptions {
  db: Db;
  roomId: string;
  now?: () => number;
  /** 每手时限（测试里调短）。 */
  turnMs?: number;
  /** 等人桌连续多久没有入座、退座或桌聊才收起。 */
  openMs?: number;
  /**
   * 启动恢复的基准：最后一次「服务还在正常推进」的时刻。
   * 没有值就用这些桌子自己的 updated_at 当基准（等同于「刚刚还在」）。
   */
  recovery?: { lastHealthyAt?: number; maxDowntimeMs?: number; minHumanMs?: number };
}

export interface TableSeatLookup {
  /** 这个 coo 在这个客厅的活跃席位；不在厅里返回 null。 */
  activeSeat(cooId: string): Promise<SeatRow | null>;
  /** 客厅里所有活跃席位。 */
  seats(): Promise<SeatRow[]>;
}

interface LiveTable {
  id: string;
  game: string;
  engine: TableEngine;
  hostSeatId: string;
  hostName: string;
  stake: number;
  createdAt: number;
  startedAt?: number;
  openDeadlineAt: number;
  revision: number;
  stateJson: string;
  frozen: boolean;
  /** 被托管（移除/掉线）的席位：轮到他们时脚本代打，不占他们的截止时间。 */
  autoSeats: Set<string>;
}

interface TableRow {
  id: string;
  room_id: string;
  game: string;
  status: string;
  host_seat_id: string | null;
  stake: number;
  /** SQLite 的 TEXT 是字符串，PostgreSQL 的 JSONB 读出来是对象；统一走 jsonValue。 */
  state_json: unknown;
  engine_version: string | null;
  revision: number;
  state_version: number;
  deadline_at: number | null;
  frozen_at: number | null;
  recovery_error: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
  updated_at: number;
}

interface TableSeatRow {
  table_id: string;
  room_id: string;
  seat_id: string;
  coo_id: string | null;
  position: number;
  is_bot: number;
  auto: number;
  joined_at: number;
  left_at: number | null;
}

export interface TableReceipt {
  tableId: string;
  revision: number;
  seq?: number;
  ts?: number;
  at?: string;
  deadline?: number;
  deadlineAt?: string;
  turn?: string;
  seats?: string[];
  text?: string;
}

export interface StartReceipt extends TableReceipt {
  seats: string[];
}

export interface TableOpenResult {
  tableId: string;
  event: RoomEvent;
  receipt: TableReceipt;
}

export interface TableLeaveResult {
  event: RoomEvent;
  closed: boolean;
  receipt: TableReceipt;
}

export interface TableJoinResult {
  event: RoomEvent;
  tableId: string;
  receipt: TableReceipt;
}

export interface TableLockInfo {
  tableId: string;
  game: string;
  label: string;
  status: TableStatus;
  hostSeatId: string;
}

export interface TableActOptions {
  tableId?: string;
  /** 动作基于哪一版桌面；对不上就是视图过期。 */
  revision?: number;
  /** 客户端生成的幂等键；重试必须复用。 */
  requestId?: string;
}

const clampText = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new HostError('invalid', '消息不能为空');
  if (text.length > MAX_TABLE_TEXT) throw new HostError('invalid', `一句话最多 ${MAX_TABLE_TEXT} 个字`);
  return text;
};

const stakeOf = (value: unknown): number => {
  if (value === undefined || value === null || value === '') return 0;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_CHIPS) {
    throw new HostError('invalid', `押注要是 0 到 ${MAX_CHIPS} 之间的整数`);
  }
  return amount;
};

const statusLabel = (status: TableStatus): string => ({
  open: '还没开局', bidding: '叫地主中', playing: '进行中', ended: '已经结束',
} as Record<TableStatus, string>)[status] ?? status;

/** 引擎错误 → 网关错误码；与旧服务器一致（403/409/400）。 */
const asHostError = (error: unknown): never => {
  if (error instanceof HostError) throw error;
  if (error instanceof TableError) {
    const code = error.code === 'not_seated' || error.code === 'not_host' || error.code === 'not_turn'
      ? 'forbidden'
      : error.code === 'full' || error.code === 'seated' || error.code === 'expired' ? 'conflict'
        : 'invalid';
    throw new HostError(code, error.message);
  }
  throw error;
};

const isLive = (status: TableStatus): boolean => status === 'open' || status === 'bidding' || status === 'playing';

const actionHash = (value: unknown): string => createHash('sha256')
  .update(JSON.stringify(value))
  .digest('hex');

/**
 * 快照列的统一形状：SQLite 的 TEXT 读出来是字符串，PostgreSQL 的 JSONB 读出来是对象。
 * 内存缓存按旧约定一律存文本，两种后端写回时都认。
 */
const stateTextOf = (raw: unknown): string => (
  typeof raw === 'string' ? raw : JSON.stringify(jsonValue<unknown>(raw, null))
);

export class TableHost {
  readonly roomId: string;
  private readonly db: Db;
  private readonly events: EventDb;
  private readonly ledger: LedgerDb;
  private readonly mail: MailDb;
  private readonly now: () => number;
  private readonly seats: TableSeatLookup;
  private readonly turnMs?: number;
  private readonly openMs: number;
  private readonly recovery: { lastHealthyAt?: number; maxDowntimeMs: number; minHumanMs: number };
  /** 未结束的桌 + 最近结束的几张（给结果页看）。 */
  private readonly tables = new Map<string, LiveTable>();
  /** 每张桌一条排队链：同一张桌的写操作串行，不同桌各走各的。 */
  private readonly tableChains = new Map<string, Promise<unknown>>();
  /** 启动恢复只跑一次：重复 init 会再算一遍停机时长、重发续局事件。 */
  private started = false;

  private constructor(options: TableHostOptions & { seats: TableSeatLookup; ledger: LedgerDb; mail: MailDb }) {
    this.db = options.db;
    this.roomId = options.roomId;
    this.events = new EventDb(options.db);
    this.ledger = options.ledger;
    this.mail = new MailDb(options.db, { now: options.now ?? Date.now });
    this.now = options.now ?? Date.now;
    this.seats = options.seats;
    this.turnMs = options.turnMs;
    this.openMs = options.openMs ?? OPEN_MS;
    this.recovery = {
      ...(options.recovery?.lastHealthyAt !== undefined ? { lastHealthyAt: options.recovery.lastHealthyAt } : {}),
      maxDowntimeMs: options.recovery?.maxDowntimeMs ?? MAX_DOWNTIME_MS,
      minHumanMs: options.recovery?.minHumanMs ?? MIN_HUMAN_RESUME_MS,
    };
  }

  /**
   * 建一个牌桌运行时：构造之后等启动恢复跑完再返回。
   * 恢复会写库（作废、退款、隔离坏存档），必须在开始接请求之前完成，所以构造是私有的。
   */
  static async create(
    options: TableHostOptions & { seats: TableSeatLookup; ledger: LedgerDb; mail: MailDb },
  ): Promise<TableHost> {
    const host = new TableHost(options);
    await host.init();
    return host;
  }

  /** 启动恢复：把本房还挂着的牌局装回内存（可能作废/退款/隔离）。 */
  /**
   * 同一张桌的写操作排队（读草稿 → 写库 → 发布内存是一整段）。
   * 不同桌互不等待。返回 release，调用方必须在 finally 里放掉。
   */
  private async lockTable(key: string): Promise<() => void> {
    // 外层管理事务可能已持有房间行锁；不能再等正在等该行的牌桌队列。
    if (this.db.isTransaction && this.tableChains.has(key)) {
      throw new HostError('conflict', '牌桌正在处理另一项操作，请稍后重试');
    }
    const tail = this.tableChains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const queued = tail.then(() => held, () => held);
    this.tableChains.set(key, queued);
    await tail.catch(() => undefined);
    return () => {
      release();
      if (this.tableChains.get(key) === queued) this.tableChains.delete(key);
    };
  }

  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.recoverLiveTables();
  }

  /**
   * 这个 coo 现在参与的那张**未结束**的桌（没有返回 null）。
   *
   * 结束的桌不算：牌局一结束人就已经离桌，只剩一张可以回看的结果桌。
   * 不这样区分的话，上一局的 ended 桌会一直被当成「我的桌」——不带桌号的
   * join/leave 都打到它身上，报「已经开始了/已经结束了」，人却退不出去。
   */
  async tableOf(cooId: string): Promise<LiveTable | null> {
    const row = await this.db.prepare(
      'SELECT table_id FROM active_table_players WHERE coo_id = ?',
    ).get(cooId) as { table_id: string } | undefined;
    if (row) {
      const table = this.tables.get(row.table_id);
      if (table && isLive(table.engine.status)) return table;
    }
    // 兜底：看引擎里有没有这个 coo 的活跃席位（恢复失败/旧数据）。
    const seat = await this.seats.activeSeat(cooId);
    if (!seat) return null;
    for (const table of this.tables.values()) {
      if (isLive(table.engine.status) && table.engine.has(seat.id)) return table;
    }
    return null;
  }

  /** 这个 coo 最近打完的那张桌；只给结果页用，不算「我的桌」。 */
  private async lastEndedTableOf(cooId: string): Promise<LiveTable | null> {
    const seat = await this.seats.activeSeat(cooId);
    if (!seat) return null;
    const ended = [...this.tables.values()]
      .filter((table) => table.engine.status === 'ended' && table.engine.has(seat.id))
      .sort((left, right) => right.createdAt - left.createdAt);
    return ended[0] ?? null;
  }

  /** 这个 coo 是否被一张未结束的牌桌锁住。 */
  async lockOf(cooId: string): Promise<TableLockInfo | null> {
    const table = await this.tableOf(cooId);
    if (!table || !isLive(table.engine.status)) return null;
    return {
      tableId: table.id,
      game: table.engine.game,
      label: table.engine.label,
      status: table.engine.status,
      hostSeatId: table.hostSeatId,
    };
  }

  /** 未结束的桌（按开桌顺序）。 */
  private liveTables(): LiveTable[] {
    return [...this.tables.values()]
      .filter((table) => isLive(table.engine.status))
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  /** 给快照的桌列表：未结束的 + 最近结束的几张。 */
  list(): TableSummary[] {
    const live = this.liveTables();
    const ended = [...this.tables.values()]
      .filter((table) => table.engine.status === 'ended')
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, KEEP_ENDED);
    return [...live, ...ended].map((table) => this.summaryOf(table));
  }

  /** 我的桌；不传 cooId 时退回「只有一张未结束的桌」。 */
  async public(cooId?: string): Promise<TableSummary | undefined> {
    const mine = cooId ? await this.tableOf(cooId) : null;
    if (mine) return this.summaryOf(mine);
    // 刚打完的那张：人已经离桌，但结果页还要看。
    const last = cooId ? await this.lastEndedTableOf(cooId) : null;
    if (last) return this.summaryOf(last);
    const live = this.liveTables();
    if (live.length === 1) return this.summaryOf(live[0]);
    if (live.length > 1) return undefined;
    const ended = [...this.tables.values()]
      .filter((table) => table.engine.status === 'ended')
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    return ended ? this.summaryOf(ended) : undefined;
  }

  private(seatId: string): TablePrivateSummary | null {
    for (const table of this.tables.values()) {
      // 结束的桌不再给私视图：否则「我还在桌上」、旧桌还会盖住新桌的手牌。
      if (!isLive(table.engine.status)) continue;
      if (!table.engine.has(seatId)) continue;
      const text = table.engine.privateText(seatId, this.now());
      if (!text) continue;
      return {
        ...(table.engine.view(seatId) as Record<string, unknown>),
        game: table.engine.game,
        seat: seatId,
        tableId: table.id,
        revision: table.revision,
        text,
      } as TablePrivateSummary;
    }
    return null;
  }

  // —— 开桌 / 坐下 / 开始 / 动作 / 收桌 ——

  async open(cooId: string, input: { game?: string; stake?: unknown; clientVersion?: string } = {}, requestId?: string): Promise<TableOpenResult> {
    // 开桌还没有 tableId，用房间级键；开桌与「数桌上限」要串行。
    const releaseOpen = await this.lockTable('#room');
    try {
    const seat = await this.requireSeat(cooId);
    if (seat.kind === 'observer') throw new HostError('forbidden', '观看者不能开桌');
    if (this.liveTables().length >= MAX_LIVE_TABLES) {
      throw new HostError('conflict', `这个客厅已经有 ${MAX_LIVE_TABLES} 张没结束的桌子了`);
    }
    const mine = await this.tableOf(cooId);
    if (mine && isLive(mine.engine.status)) {
      throw new HostError('conflict', `你已经在一张${mine.engine.label}桌上了；一人同时只参与一张`);
    }
    const id = input.game ?? 'dice';
    const def = gameById(id);
    if (!def) throw new HostError('invalid', `不认识的桌子：现在有 ${gameIds().join(' / ')}`);
    const stake = stakeOf(input.stake);
    if (stake > 0) {
      const balance = await this.ledger.balanceOf(cooId);
      if (balance < stake) {
        throw new HostError('invalid', `你只有 ${balance} 枚筹码，押不起 ${stake} 枚`);
      }
    }
    const replay = await this.replayReceipt(cooId, requestId, { type: 'table_open', game: id, stake });
    if (replay) {
      const at = this.now();
      return {
        tableId: replay.tableId,
        event: {
          seq: await this.events.latest(this.roomId),
          ts: at,
          type: 'parlor.table.open',
          from: 'system',
          scope: { kind: 'room' },
          text: '（同一次开桌请求已经处理过）',
          data: { tableId: replay.tableId, replayed: true },
        },
        receipt: replay,
      };
    }
    const now = this.now();
    const engine = def.create({
      host: {
        id: seat.id,
        name: seat.name,
        kind: seat.kind === 'human' ? 'human' : 'pet',
        ...(typeof input.clientVersion === 'string' && input.clientVersion ? { clientVersion: input.clientVersion } : {}),
      },
      now,
      ...(this.turnMs !== undefined ? { turnMs: this.turnMs } : {}),
    });
    const stateJson = JSON.stringify(engine.exportState());
    const table: LiveTable = {
      id: `t-${randomUUID()}`,
      game: def.id,
      engine,
      hostSeatId: seat.id,
      hostName: seat.name,
      stake,
      createdAt: now,
      openDeadlineAt: now + this.openMs,
      revision: 1,
      stateJson,
      frozen: false,
      autoSeats: new Set(),
    };
    const receipt: TableReceipt = { tableId: table.id, revision: table.revision };
    const event = await withTransaction(this.db, async () => {
      await this.insertTableRow(table, 'open', now, stateJson);
      await this.insertTableSeat(table.id, seat.id, cooId, 0, false, now);
      await this.insertActivePlayer(cooId, table.id, now);
      const appended = await this.events.append(this.roomId, {
        type: 'parlor.table.open',
        ts: now,
        from: 'system',
        scope: { kind: 'room' },
        text: `${seat.name} 开了一张${def.label}桌${stake > 0 ? `（每人押 ${stake} 枚筹码）` : ''}。`,
        data: { game: def.id, stake, tableId: table.id },
      });
      await this.finishReceipt(receipt, engine);
      await this.storeReceipt(cooId, requestId, table.id, { type: 'table_open', game: id, stake }, receipt, now);
      // 开桌这一刻就是「数据库还能写」的证据；刚开桌就崩，也不会把停机时长算错。
      await this.markHealthy(now);
      return appended;
    });
    this.db.afterCommit(() => {
      this.tables.set(table.id, table);
      this.pruneEnded();
    });
    return { tableId: table.id, event, receipt };
    } finally {
      releaseOpen();
    }
  }

  async join(cooId: string, tableId?: string, requestId?: string, clientVersion?: string): Promise<TableJoinResult> {
    const seat = await this.requireSeat(cooId);
    if (seat.kind === 'observer') throw new HostError('forbidden', '观看者不能上桌');
    const mine = await this.tableOf(cooId);
    if (mine && isLive(mine.engine.status)) {
      throw new HostError('conflict', `你已经在一张${mine.engine.label}桌上了；一人同时只参与一张`);
    }
    const table = this.resolveOpenTable(tableId);
    const releaseTable = await this.lockTable(table.id);
    try {
    const replay = await this.replayReceipt(cooId, requestId, { type: 'table_join', tableId: table.id });
    if (replay) {
      return {
        event: {
          seq: await this.events.latest(this.roomId),
          ts: this.now(),
          type: 'parlor.table.join',
          from: 'system',
          scope: { kind: 'room' },
          text: '（同一次入桌请求已经处理过）',
          data: { tableId: table.id, replayed: true },
        },
        tableId: table.id,
        receipt: replay,
      };
    }
    if (table.frozen) throw new HostError('conflict', '这张桌子恢复失败，已经被隔离开了');
    if (table.stake > 0) {
      const balance = await this.ledger.balanceOf(cooId);
      if (balance < table.stake) {
        throw new HostError('invalid', `这张桌子每人押 ${table.stake} 枚，你只有 ${balance} 枚`);
      }
    }
    const now = this.now();
    const draft = await this.draft(table);
    let event: TableEvent;
    try {
      event = draft.join({
        id: seat.id,
        name: seat.name,
        // 玩家类型从服务端席位行来，不信客户端自报；版本由 World 连接头带来。
        kind: seat.kind === 'human' ? 'human' : 'pet',
        ...(clientVersion ? { clientVersion } : {}),
      });
    } catch (error) {
      return asHostError(error);
    }
    const revision = table.revision + 1;
    const stateJson = JSON.stringify(draft.exportState());
    const receipt: TableReceipt = { tableId: table.id, revision };
    const appended = await withTransaction(this.db, async () => {
      await this.insertTableSeat(table.id, seat.id, cooId, await this.nextPosition(table.id), false, now);
      await this.insertActivePlayer(cooId, table.id, now);
      const row = await this.appendTableEvent(table, event, now);
      await this.updateTableState(table.id, draft, revision, stateJson, now, {});
      await this.finishReceipt(receipt, draft);
      await this.storeReceipt(cooId, requestId, table.id, { type: 'table_join', tableId: table.id }, receipt, now);
      return row;
    });
    this.publishState(table, draft, revision, stateJson);
    return { event: appended, tableId: table.id, receipt };
    } finally {
      releaseTable();
    }
  }

  /** 未开局时离桌；开桌的人离桌等于收掉整张桌子。 */
  async leave(cooId: string, tableId?: string, requestId?: string): Promise<TableLeaveResult> {
    const seat = await this.requireSeat(cooId);
    // 重试先查回执：上一次退桌已经成功的话，这时人已经不在桌上了。
    const earlier = await this.replayReceipt(cooId, requestId, {
      type: 'table_leave', tableId: tableId ?? null,
    });
    if (earlier) {
      return {
        event: {
          seq: await this.events.latest(this.roomId),
          ts: this.now(),
          type: 'parlor.table.cancel',
          from: 'system',
          scope: { kind: 'room' },
          text: '（同一次退桌请求已经处理过）',
          data: { tableId: earlier.tableId, replayed: true },
        },
        closed: false,
        receipt: earlier,
      };
    }
    const table = await this.requireMyTable(cooId, tableId);
    // 退桌与开局/动作共用同一张桌的排队，避免把正在推进的引擎改坏。
    const releaseTable = await this.lockTable(table.id);
    try {
    if (table.engine.status === 'ended') throw new HostError('conflict', '这张桌子已经结束了');
    if (table.engine.status !== 'open') {
      throw new HostError('conflict', '牌局已经开始了，不能退桌');
    }
    const closing = seat.id === table.hostSeatId;
    const now = this.now();
    const draft = closing ? table.engine : await this.draft(table);
    const receipt: TableReceipt = { tableId: table.id, revision: table.revision };
    let nextEngine: TableEngine | null = null;
    let nextRevision = table.revision;
    let nextState = table.stateJson;
    const event = await withTransaction(this.db, async () => {
      const revisionInDb = await lockTableRow(this.db, table.id);
      if (revisionInDb !== undefined && revisionInDb !== table.revision) {
        throw new HostError('conflict', '这一桌已经被推进过；刷新后再来');
      }
      if (closing) {
        // 开桌的人退桌 = 收桌；没开局就没有押注要退。
        await this.markTableSeatsLeft(table.id, now);
        await this.clearActivePlayers(table.id);
        await this.updateTableRow(table.id, 'abandoned', now, { endedAt: now, endReason: 'closed' });
        await this.finishReceipt(receipt, table.engine);
        await this.storeReceipt(cooId, requestId, table.id, { type: 'table_leave', tableId: tableId ?? null }, receipt, now);
        return await this.appendTableEvent(table, {
          type: 'parlor.table.cancel',
          scope: { kind: 'room' },
          text: `${seat.name} 把${table.engine.label}桌收起来了。`,
          data: { game: table.game, tableId: table.id },
        }, now);
      }
      let left: TableEvent;
      try {
        left = draft.leave(seat.id);
      } catch (error) {
        return asHostError(error);
      }
      await this.markTableSeatLeft(table.id, seat.id, now);
      await this.removeActivePlayer(cooId);
      nextRevision = table.revision + 1;
      nextState = JSON.stringify(draft.exportState());
      const row = await this.appendTableEvent(table, left, now);
      await this.updateTableState(table.id, draft, nextRevision, nextState, now, {});
      await this.finishReceipt(receipt, draft);
      await this.storeReceipt(cooId, requestId, table.id, { type: 'table_leave', tableId: tableId ?? null }, receipt, now);
      nextEngine = draft;
      return row;
    });
    this.db.afterCommit(() => {
      if (closing) {
        this.tables.delete(table.id);
      } else if (nextEngine) {
        table.engine = nextEngine;
        table.revision = nextRevision;
        table.stateJson = nextState;
        table.openDeadlineAt = now + this.openMs;
      }
    });
    return { event, closed: closing, receipt };
    } finally {
      releaseTable();
    }
  }

  async start(cooId: string, tableId?: string, requestId?: string): Promise<StartReceipt> {
    const table = await this.requireMyTable(cooId, tableId);
    const releaseTable = await this.lockTable(table.id);
    try {
    const seat = await this.requireSeat(cooId);
    if (table.frozen) throw new HostError('conflict', '这张桌子恢复失败，已经被隔离开了');
    if (seat.id !== table.hostSeatId) throw new HostError('forbidden', '只有开桌的人可以开始');
    const replay = await this.replayReceipt(cooId, requestId, { type: 'table_start', tableId: table.id });
    if (replay) return { ...replay, seats: replay.seats ?? [] };
    const players = await this.realPlayers(table);
    if (table.stake > 0 && players.length < 2) {
      throw new HostError('invalid', '押注桌至少要两个真人；陪练不押注');
    }
    const now = this.now();
    const draft = await this.draft(table);
    let step: TableStep;
    try {
      step = draft.start(seat.id, now);
    } catch (error) {
      return asHostError(error);
    }
    const revision = table.revision + 1;
    const stateJson = JSON.stringify(draft.exportState());
    const receipt: TableReceipt = { tableId: table.id, revision };
    const duplicateStart = await withTransaction(this.db, async () => {
      const revisionInDb = await lockTableRow(this.db, table.id);
      if (revisionInDb !== undefined && revisionInDb !== table.revision) {
        throw new HostError('conflict', '这一桌已经被推进过；刷新后再来');
      }
      if (table.stake > 0) {
        // 查余额与扣押注在同一个事务里，并锁住所有付款的身份行。
        await lockCooRows(this.db, players.map((player) => player.cooId));
        for (const player of players) {
          const balance = await this.ledger.balanceOf(player.cooId);
          if (balance < table.stake) {
            throw new HostError('invalid', `${player.name} 只有 ${balance} 枚筹码，押不起 ${table.stake} 枚`);
          }
        }
        const pot = table.stake * players.length;
        await this.ledger.record({
          kind: 'ante',
          room: this.roomId,
          from: 'room',
          effectId: `${table.id}/ante`,
          participants: players.map((player) => player.cooId),
          text: `开局：${players.map((player) => player.name).join('、')} 各押 ${table.stake} 枚筹码（底池 ${pot} 枚）。`,
          visibility: 'room',
          transfers: players.map((player) => ({ from: player.cooId as string, to: 'room' as const, amount: table.stake })),
          data: { game: draft.game, gameLabel: draft.label, stake: table.stake, pot, tableId: table.id },
        });
      }
      await this.insertBotSeats(table, draft, now);
      await this.recordStep(table, draft, step, now);
      await this.updateTableState(table.id, draft, revision, stateJson, now, { startedAt: now });
      await this.finishReceipt(receipt, draft);
      await this.storeReceipt(cooId, requestId, table.id, { type: 'table_start', tableId: table.id }, receipt, now);
    }).catch(async (error: unknown) => {
      if (requestId && isUniqueViolation(error)) {
        const existing = await this.replayReceipt(cooId, requestId, { type: 'table_start', tableId: table.id });
        if (existing) return { ...existing, seats: existing.seats ?? [] };
      }
      throw error;
    });
    if (duplicateStart) return duplicateStart;
    this.publishState(table, draft, revision, stateJson, now);
    return { ...receipt, seats: this.rosterOf(draft) };
    } finally {
      releaseTable();
    }
  }

  async act(cooId: string, action: unknown, options: TableActOptions = {}): Promise<TableReceipt> {
    const table = await this.requireMyTable(cooId, options.tableId);
    const releaseTable = await this.lockTable(table.id);
    try {
    const seat = await this.requireSeat(cooId);
    if (table.frozen) throw new HostError('conflict', '这张桌子恢复失败，已经被隔离开了');
    const requestId = options.requestId;
    const replay = await this.replayReceipt(cooId, requestId, {
      type: 'table_act', tableId: table.id, action,
    });
    if (replay) return replay;
    if (!requestId) {
      throw new HostError('invalid', '缺少 requestId：牌桌动作要带幂等键，请升级客厅扩展后再打牌');
    }
    // 并发策略按游戏注册：骰子/斗地主仍是整桌 revision 乐观锁；狼人杀是窗口制——
    // 同一窗口多人各自有动作槽，revision 只当参考，windowId 与槽位由引擎在
    // 事务内对「最新已提交快照」校验，先交的人不会把别人的票顶成 409。
    const definition = gameById(table.game);
    if (definition?.revisionMode !== 'window') {
      if (options.revision === undefined) {
        throw new HostError('invalid', '缺少牌桌版本：请刷新页面/升级客厅扩展后再打牌');
      }
      if (options.revision !== table.revision) {
        throw new HostError('conflict', '这一手已经过去了：你看到的是旧桌面，刷新后再来');
      }
    }
    const now = this.now();
    const draft = await this.draft(table);
    let step: TableStep;
    try {
      step = draft.act(seat.id, action, now);
    } catch (error) {
      return asHostError(error);
    }
    const revision = table.revision + 1;
    const stateJson = JSON.stringify(draft.exportState());
    const receipt: TableReceipt = { tableId: table.id, revision };
    const duplicateAct = await withTransaction(this.db, async () => {
      // 库里的 revision 必须还是我们手里这一版；不一致说明有别的写者推进过。
      const revisionInDb = await lockTableRow(this.db, table.id);
      if (revisionInDb !== undefined && revisionInDb !== table.revision) {
        throw new HostError('conflict', '这一手已经过去了：刷新后再来');
      }
      await this.recordStep(table, draft, step, now);
      await this.updateTableState(table.id, draft, revision, stateJson, now, step.ended ? { endedAt: now } : {});
      await this.finishReceipt(receipt, draft);
      await this.storeReceipt(cooId, requestId, table.id, { type: 'table_act', tableId: table.id, action }, receipt, now);
    }).catch(async (error: unknown) => {
      // 并发重试撞到回执主键：这笔已经回滚，回读原回执返回给调用方。
      if (requestId && isUniqueViolation(error)) {
        const existing = await this.replayReceipt(cooId, requestId, { type: 'table_act', tableId: table.id, action });
        if (existing) return existing;
      }
      throw error;
    });
    if (duplicateAct) return duplicateAct;
    this.publishState(table, draft, revision, stateJson);
    return receipt;
    } finally {
      releaseTable();
    }
  }

  /** 每秒由网关调用：开桌超时收起；牌局超时代打/结算；托管席位立刻代打。 */
  async tick(): Promise<void> {
    for (const table of this.liveTables()) {
      if (table.frozen) continue;
      // 没到点的桌直接跳过：不 hydrate、不查库——这是「按需调度」省下来的主要开销。
      if (!this.tableDue(table, this.now())) continue;
      // 一轮 tick 对一张桌的推进与玩家动作互斥。
      const releaseTable = await this.lockTable(table.id);
      try {
      const now = this.now();
      if (table.engine.status === 'open') {
        if (now < table.openDeadlineAt) continue;
        await this.abort(table, 'timeout', `${table.engine.label}桌连续 ${Math.round(this.openMs / 60_000)} 分钟没有入座、退座或桌聊，已经收起来了。`);
        continue;
      }
      const draft = await this.draft(table);
      const turnId = this.turnOf(draft);
      let step: TableStep | null;
      try {
        step = turnId && table.autoSeats.has(turnId)
          ? draft.autoPlay(turnId, now)
          : draft.tick(now);
      } catch (error) {
        // 长局里一次代打抛错不能把客厅锁死：整桌作废并退回押注，让人看得见。
        console.error('parlor: 牌桌超时代打失败', error);
        await this.abort(table, 'error', `${table.engine.label}桌推进出错，这局作废。`);
        continue;
      }
      if (!step) continue;
      await this.commitTick(table, draft, step, now);
      } finally {
        releaseTable();
      }
    }
  }

  /** 这张桌现在到点了吗；没到点的桌 tick 直接跳过。 */
  private tableDue(table: LiveTable, now: number): boolean {
    if (table.engine.status === 'open') return now >= table.openDeadlineAt;
    // 托管席位要「轮到就代打」：tick 被叫到就跑；叫醒的节奏由 nextWakeAt 控制（每秒一拍）。
    if (table.autoSeats.size > 0) return true;
    const wake = table.engine.nextWakeAt;
    // 引擎没实现查询：退回每秒 tick，语义与以前完全一致。
    if (typeof wake !== 'function') return true;
    const at = wake.call(table.engine, now);
    return at === undefined || at <= now;
  }

  /**
   * 下一次需要推进这张客厅里任何一张桌的时刻。没有桌、或桌上的引擎都说不用再推进
   * 就是 undefined。只看内存里的引擎，不查库、不 hydrate。
   */
  nextWakeAt(now = this.now()): number | undefined {
    let next: number | undefined;
    for (const table of this.liveTables()) {
      if (table.frozen) continue;
      let at: number | undefined;
      if (table.engine.status === 'open') {
        at = table.openDeadlineAt;
      } else if (table.autoSeats.size > 0) {
        // 托管席位是「按拍代打」：给下一拍，绝不给「现在」，否则网关会空转。
        at = now + AUTO_TICK_MS;
      } else {
        const wake = table.engine.nextWakeAt;
        at = typeof wake === 'function' ? wake.call(table.engine, now) : now;
      }
      if (at === undefined) continue;
      if (next === undefined || at < next) next = at;
    }
    return next;
  }

  /** 桌内说话：只给那一刻坐在桌上的人（和回放）看。 */
  async say(cooId: string, text: string, tableId?: string, mentions: string[] = []): Promise<RoomEvent> {
    const table = await this.requireMyTable(cooId, tableId);
    const releaseTable = await this.lockTable(table.id);
    try {
      const seat = await this.requireSeat(cooId);
      if (table.engine.status === 'ended') throw new HostError('invalid', '这张桌子已经结束了，回客厅说吧');
      if (!table.engine.has(seat.id)) throw new HostError('invalid', '你不在这一桌，回客厅说吧');
      // 狼人杀进行中锁普通桌聊：发言次数/狼聊限制走游戏动作，不能从桌聊绕过去。
      if (table.engine.chatLocked?.()) {
        throw new HostError('conflict', `${table.engine.label}进行中，桌上的发言走游戏动作（发言机会只有一次），不能用普通桌聊`);
      }
      const body = clampText(text);
      const seats: string[] = [];
      for (const seatId of table.engine.seatIds()) {
        if (await this.seatById(seatId)) seats.push(seatId);
      }
      const now = this.now();
      return await withTransaction(this.db, async () => {
        const event = await this.events.append(this.roomId, {
          type: 'parlor.table.say',
          ts: now,
          from: seat.id,
          scope: { kind: 'table', tableId: table.id, seats },
          text: body,
          mentions: mentions.filter((id) => seats.includes(id)),
          data: { name: seat.name, tableId: table.id },
        });
        if (table.engine.status === 'open') {
          const deadline = now + this.openMs;
          await this.db.prepare('UPDATE tables SET deadline_at = ?, updated_at = ? WHERE id = ?').run(deadline, now, table.id);
          this.db.afterCommit(() => { table.openDeadlineAt = deadline; });
        }
        return event;
      });
    } finally { releaseTable(); }
  }

  // —— 移除/托管 ——

  /**
   * 把这个人从这一房所有未结束的桌里标成托管：他的回合由脚本代打，
   * 结算仍归他（筹码照算），一人一桌的锁保留到结算。
   */
  async markAuto(cooId: string): Promise<string[]> {
    const seat = await this.seats.activeSeat(cooId);
    if (!seat) return [];
    const ids: string[] = [];
    for (const table of this.liveTables()) {
      if (!table.engine.has(seat.id)) continue;
      const updated = await this.db.prepare(
        'UPDATE table_seats SET auto = 1 WHERE table_id = ? AND seat_id = ? AND left_at IS NULL',
      ).run(table.id, seat.id);
      if (updated.changes > 0) {
        this.db.afterCommit(() => { table.autoSeats.add(seat.id); });
        ids.push(table.id);
      }
    }
    return ids;
  }

  /**
   * 运营命令：把一张隔离/卡住的桌作废并按开局明细退款（走与超时同一条事务）。
   * 返回 false = 这个客厅里没有这张桌（可能已经结束/在别的厅）。
   */
  async voidTable(tableId: string, note = '运营者处理'): Promise<boolean> {
    const table = this.tables.get(tableId);
    if (!table) return false;
    await this.abort(table, 'error', `${table.engine.label}桌由运营者作废：${note}。`);
    return true;
  }

  /** 这个 coo 是否被一张进行中的游戏锁了普通聊天（狼人杀发言走游戏动作）。 */
  async chatLockedFor(cooId: string): Promise<boolean> {
    const table = await this.tableOf(cooId);
    if (!table || table.frozen) return false;
    return table.engine.chatLocked?.() === true;
  }

  /**
   * 同一张锁聊游戏桌上的全部真实身份（含本人）。
   * 私聊封堵用：两端都在这张桌上才拦，桌外人不受影响。
   */
  async lockedTablePeerCooIds(cooId: string): Promise<Set<string>> {
    const ids = new Set<string>();
    const table = await this.tableOf(cooId);
    if (!table || table.frozen || table.engine.chatLocked?.() !== true) return ids;
    for (const row of await this.tableSeatRows(table.id)) {
      if (row.left_at === null && row.coo_id) ids.add(row.coo_id);
    }
    return ids;
  }

  /**
   * 游戏历史查询（狼人杀的按天/按人回看与终局复盘）。
   * 公开部分任何房间成员可读；`review`（夜间内部记录）只给本局参与者、且已终局。
   */
  async tableLog(cooId: string, tableId: string | undefined, query: TableLogQuery): Promise<unknown> {
    const table = tableId ? this.tables.get(tableId) : await this.tableOf(cooId);
    if (!table) throw new HostError('not_found', '没有这张桌子（刚打完的桌用带桌号的方式查）');
    if (table.frozen) throw new HostError('conflict', '这张桌子已经被隔离');
    const seatId = (await this.seats.activeSeat(cooId))?.id ?? '';
    const onTable = seatId !== '' && table.engine.has(seatId);
    if (query.review && !onTable) {
      throw new HostError('forbidden', '夜间复盘只给这局的参与者看');
    }
    if (!table.engine.tableLog) throw new HostError('invalid', '这张桌子没有历史记录可查');
    return table.engine.tableLog(query, { seatId, onTable });
  }

  /** 公开视图（给网关判断桌子类型/取桌号）。 */
  async tableSummary(tableId?: string, cooId?: string): Promise<TableSummary | undefined> {
    if (tableId) {
      const table = this.tables.get(tableId);
      return table ? this.summaryOf(table) : undefined;
    }
    return this.public(cooId);
  }

  // —— 内部：提交与事件 ——

  /** 嵌套宿主操作可能只释放 SAVEPOINT；内存只跟随最外层 COMMIT。 */
  private publishState(table: LiveTable, engine: TableEngine, revision: number, stateJson: string, startedAt?: number): void {
    const openDeadlineAt = this.now() + this.openMs;
    this.db.afterCommit(() => {
      table.engine = engine;
      table.revision = revision;
      table.stateJson = stateJson;
      if (engine.status === 'open') table.openDeadlineAt = openDeadlineAt;
      if (startedAt !== undefined) table.startedAt = startedAt;
    });
  }

  private async commitTick(table: LiveTable, draft: TableEngine, step: TableStep, now: number): Promise<void> {
    const revision = table.revision + 1;
    const stateJson = JSON.stringify(draft.exportState());
    await withTransaction(this.db, async () => {
      await this.recordStep(table, draft, step, now);
      await this.updateTableState(table.id, draft, revision, stateJson, now, step.ended ? { endedAt: now } : {});
    });
    this.publishState(table, draft, revision, stateJson);
  }

  /** 把一步引擎结果写进事件流：公开事件 + 每个席位的私视图；结束时结算。 */
  private async recordStep(table: LiveTable, engine: TableEngine, step: TableStep, now: number): Promise<void> {
    let ended: TableEvent | undefined;
    for (const event of step.events) {
      await this.appendTableEvent(table, event, now);
      if (event.type === 'parlor.table.end') ended = event;
    }
    const writeTurn = async (seatId: string, decision: boolean): Promise<void> => {
      // 脚本陪练不是房间席位：它们的视图不进事件流。
      if (!(await this.seatById(seatId))) return;
      const view = engine.view(seatId) as Record<string, unknown> | null;
      const text = engine.privateText(seatId, now);
      if (!view || !text) return;
      await this.events.append(this.roomId, {
        type: 'parlor.table.turn',
        ts: now,
        from: 'system',
        scope: { kind: 'seat', seatId },
        text,
        data: {
          // recordStep 写的是本次提交后的引擎状态；通知与快照必须用同一版，
          // 否则 Coo 已被叫醒、后台快照还没返回时会拿上一手的 revision 出牌。
          table: { ...view, tableId: table.id, revision: table.revision + 1 },
          tableId: table.id,
          game: engine.game,
          // decision:false = 只是桌面更新（队友交了刀票/发言），不当成新的行动请求；
          // World 侧据此跳过叫醒，只刷新快照。
          ...(decision ? {} : { decision: false }),
        },
      });
      // 决策唤醒才考虑离线提醒；正文不带任何角色/阵营/目标信息。
      if (decision) await this.mailOfflineReminder(table, seatId, String(view.windowId ?? ''));
    };
    for (const seatId of step.views) await writeTurn(seatId, true);
    for (const seatId of step.refreshViews ?? []) await writeTurn(seatId, false);
    if (ended) await this.settle(table, ended, now);
  }

  /**
   * 决策窗口开始时，人不在的席位留一封无秘密的信：「你的牌桌需要操作」。
   * 幂等键带窗口号：同一窗口只提醒一次；在线判断用席位最近活跃时刻。
   */
  private async mailOfflineReminder(table: LiveTable, seatId: string, windowId: string): Promise<void> {
    if (!windowId) return;
    const seat = await this.seatById(seatId);
    if (!seat) return;
    const lastSeen = seat.lastSeenAt ?? 0;
    if (lastSeen > this.now() - OFFLINE_REMINDER_MS) return;
    try {
      await this.mail.appendOnce(`${table.id}/${windowId}/${seatId}`, {
        room: this.roomId,
        to: seat.cooId,
        kind: 'ledger',
        action: 'table',
        fromName: '客厅',
        text: '你的牌桌需要操作；回来看一眼（parlor_table_view）。这封信不含任何身份或目标信息。',
      });
    } catch (error) {
      console.error('parlor: 牌桌离线提醒没写进信箱', error);
    }
  }

  private appendTableEvent(table: LiveTable, event: TableEvent, now: number): Promise<RoomEvent> {
    return this.events.append(this.roomId, {
      type: event.type,
      ts: now,
      from: 'system',
      scope: event.scope,
      text: event.text,
      ...(event.data ? { data: { ...event.data, tableId: table.id } } : { data: { tableId: table.id } }),
    });
  }

  /**
   * 一局结束：按开局时记下的真人席位写一条公开战绩并分底池。
   * 终态只写一次（`table_finalizations`），正常结算与作废退款互斥。
   */
  private async settle(table: LiveTable, event: TableEvent, now: number): Promise<void> {
    if (await this.finalization(table.id)) return;
    const rows = (await this.tableSeatRows(table.id)).filter((row) => row.left_at === null && row.coo_id !== null);
    const participants = [...new Set(rows.map((row) => row.coo_id!))];
    const seatToCoo = new Map(rows.map((row) => [row.seat_id, row.coo_id!]));
    const data = event.data ?? {};
    const winnerSeatIds = Array.isArray(data.winners)
      ? data.winners.filter((id): id is string => typeof id === 'string')
      : [];
    const winners = [...new Set(winnerSeatIds.map((id) => seatToCoo.get(id)).filter((id): id is string => !!id))];
    const stake = table.stake;
    const pot = stake > 0 ? stake * participants.length : 0;
    let transfers: Array<{ from: string; to: string; amount: number }> | undefined;
    let chipText = '';
    if (pot > 0) {
      if (winners.length > 0) {
        const share = Math.floor(pot / winners.length);
        const rest = pot - share * winners.length;
        transfers = winners
          .map((cooId, index) => ({ from: 'room', to: cooId, amount: share + (index === 0 ? rest : 0) }))
          .filter((transfer) => transfer.amount > 0);
        const names: string[] = [];
        for (const cooId of winners) {
          const seatId = rows.find((row) => row.coo_id === cooId)!.seat_id;
          names.push((await this.seatById(seatId))?.name ?? '席位');
        }
        chipText = ` 底池 ${pot} 枚归 ${names.join('、')}。`;
      } else {
        transfers = participants.map((cooId) => ({ from: 'room', to: cooId, amount: stake }));
        chipText = ` 没人赢，底池 ${pot} 枚退回。`;
      }
    }
    const landlordId = typeof data.landlord === 'string' ? data.landlord : undefined;
    const landlordName = landlordId === undefined ? undefined : (await this.seatById(landlordId))?.name;
    const entry = await this.ledger.record({
      kind: 'game',
      room: this.roomId,
      from: 'room',
      effectId: `${table.id}/result`,
      game: table.engine.game,
      participants,
      winners,
      text: `${event.text}${chipText}`,
      visibility: 'room',
      ...(transfers && transfers.length > 0 ? { transfers } : {}),
      data: {
        game: table.engine.game,
        gameLabel: table.engine.label,
        tableId: table.id,
        tie: data.tie === true,
        ...(stake > 0 ? { stake, pot } : {}),
        ...(typeof data.multiplier === 'number' ? { multiplier: data.multiplier } : {}),
        ...(data.spring === true ? { spring: true } : {}),
        ...(data.antiSpring === true ? { antiSpring: true } : {}),
        ...(landlordId !== undefined
          ? { landlord: landlordName }
          : {}),
      },
    });
    // 终态表靠主键挡第二次结算；写入保持普通 INSERT，冲突就是要它抛。
    await this.db.prepare(
      `INSERT INTO table_finalizations(table_id, kind, entry_id, at, payload_json)
       VALUES (?, 'result', ?, ?, ?)`,
    ).run(table.id, entry.id, now, JSON.stringify({ winners, participants, stake, pot }));
    // 一局结束 = 大家都下桌：席位记录标离桌，active_table_players 清空。
    // 引擎里的座位还留着给结果页看（谁打了这局），但不再算「人在桌上」。
    await this.markTableSeatsLeft(table.id, now);
    await this.clearActivePlayers(table.id);
  }

  /** 开桌超时/引擎出错/长停机：整桌作废；已经收过押注的按开局明细原路退回。 */
  private async abort(table: LiveTable, reason: 'timeout' | 'error' | 'offline' | 'restart', text: string): Promise<void> {
    const now = this.now();
    await withTransaction(this.db, async () => {
      if (table.engine.status !== 'open') await this.refund(table, reason, now);
      await this.markTableSeatsLeft(table.id, now);
      await this.clearActivePlayers(table.id);
      await this.updateTableRow(table.id, 'abandoned', now, { endedAt: now, endReason: reason });
      await this.appendTableEvent(table, {
        type: 'parlor.table.cancel',
        scope: { kind: 'room' },
        text,
        data: { game: table.game, tableId: table.id, reason },
      }, now);
    });
    this.db.afterCommit(() => { this.tables.delete(table.id); });
  }

  /**
   * 押注原路退回：读开局那条 ante 的实际扣款明细（不是 stake×人数），
   * effectId 幂等，终态表挡住第二次退款。
   */
  private async refund(table: { id: string; game: string; engine: TableEngine; stake: number }, reason: string, now: number): Promise<void> {
    if (await this.finalization(table.id)) return;
    const ante = await this.ledger.byEffectId(`${table.id}/ante`);
    const rows = ante ? await this.ledger.transfersOf(ante.id) : [];
    const byCoo = new Map<string, number>();
    for (const transfer of rows) {
      if (transfer.fromKind !== 'coo' || !transfer.fromCooId) continue;
      byCoo.set(transfer.fromCooId, (byCoo.get(transfer.fromCooId) ?? 0) + transfer.amount);
    }
    if (byCoo.size === 0) {
      // 没收到过押注的桌：也要留一个终态，避免以后被当成「还没结算」。
      await this.db.prepare(
        `INSERT INTO table_finalizations(table_id, kind, entry_id, at, payload_json)
         VALUES (?, 'refund', NULL, ?, ?)`,
      ).run(table.id, now, JSON.stringify({ reason, refunded: [] }));
      return;
    }
    const participants = [...byCoo.keys()];
    let entry;
    try {
      entry = await this.ledger.record({
        kind: 'note',
        room: this.roomId,
        from: 'room',
        effectId: `${table.id}/refund`,
        participants,
        text: '牌桌作废，押的筹码按开局明细原路退回。',
        visibility: 'room',
        transfers: participants.map((cooId) => ({ from: 'room' as const, to: cooId, amount: byCoo.get(cooId)! })),
        data: { game: table.game, gameLabel: table.engine.label, stake: table.stake, reason, tableId: table.id },
      });
    } catch (error) {
      // 退款失败必须让整个事务回滚，不能把桌子标成「已退款」。
      throw new HostError('conflict', `押注退回失败：${(error as Error).message}`);
    }
    await this.db.prepare(
      `INSERT INTO table_finalizations(table_id, kind, entry_id, at, payload_json)
       VALUES (?, 'refund', ?, ?, ?)`,
    ).run(table.id, entry.id, now, JSON.stringify({ reason, refunded: participants.map((cooId) => ({ cooId, amount: byCoo.get(cooId) })) }));
    for (const cooId of participants) {
      try {
        await this.mail.appendOnce(`${table.id}/refund/${cooId}`, {
          room: this.roomId,
          to: cooId,
          kind: 'ledger',
          action: 'refund',
          fromName: '客厅',
          text: `${table.engine.label}桌作废了，押的 ${byCoo.get(cooId)} 枚筹码已经退回。`,
          ...(entry.id ? { entryId: entry.id } : {}),
        });
      } catch (error) {
        console.error('parlor: 退注通知没写进信箱', error);
      }
    }
  }

  // —— 恢复 ——

  /**
   * 进程启动后还挂着 open/bidding/playing 的桌子：
   * - 读得懂快照：短停机把截止时刻搬到现在；超过 30 分钟作废退款；
   * - 读不懂/版本不认识：只隔离这一桌，不猜、不重发牌；
   * - 第一版（0.25.0）的旧桌没有快照：作废退款（升级时要先排空旧牌局）。
   */
  private async recoverLiveTables(): Promise<void> {
    const now = this.now();
    // 最近结束的一桌也装回来：进程重启后网页还要看结果页。
    // NULLS LAST 写死：SQLite 的 DESC 把 NULL 放最后，PostgreSQL 默认放最前；
    // 老库里可能有 ended_at 为空的 ended 行，不写清楚两边会挑到不同的桌。
    const ended = await this.db.prepare(
      `SELECT * FROM tables WHERE room_id = ? AND status = 'ended' AND state_json IS NOT NULL
        ORDER BY ended_at DESC NULLS LAST, created_at DESC LIMIT 1`,
    ).get(this.roomId) as TableRow | undefined;
    if (ended) {
      try {
        const engine = await this.hydrate(ended);
        this.tables.set(ended.id, {
          id: ended.id,
          game: ended.game,
          engine,
          hostSeatId: ended.host_seat_id ?? engine.host,
          hostName: await this.seatName(ended.host_seat_id ?? engine.host),
          stake: ended.stake,
          createdAt: ended.created_at,
          ...(ended.started_at !== null ? { startedAt: ended.started_at } : {}),
          openDeadlineAt: ended.deadline_at ?? ended.created_at + this.openMs,
          revision: ended.revision,
          stateJson: stateTextOf(ended.state_json),
          frozen: false,
          autoSeats: new Set(),
        });
      } catch (error) {
        console.error('parlor: 最近结束的牌桌读不回来（只影响结果页）', error);
      }
    }
    const rows = await this.db.prepare(
      `SELECT * FROM tables WHERE room_id = ? AND status IN ('open','bidding','playing') ORDER BY created_at`,
    ).all(this.roomId) as unknown as TableRow[];
    // 之前已经隔离的桌：照样列出来（标 frozen），但不推进、不接动作。
    for (const row of rows) {
      if (row.frozen_at === null) continue;
      this.tables.set(row.id, await this.frozenTable(row));
    }
    if (rows.length === 0) return;
    const newest = rows.reduce((max, row) => Math.max(max, row.updated_at), 0);
    const lastHealthyAt = this.recovery.lastHealthyAt ?? newest;
    const downtime = Math.max(0, now - lastHealthyAt);
    for (const row of rows) {
      if (row.frozen_at !== null) continue;
      if (!row.state_json) {
        await this.abortRow(row, row.status === 'open' ? 'closed' : 'restart',
          row.status === 'open' ? '没有开局就停机的旧桌子，已经收起来了。' : '升级前的旧牌局没有存档，这局作废、押注退回。', now);
        continue;
      }
      let engine: TableEngine;
      try {
        engine = await this.hydrate(row);
      } catch (error) {
        await this.freezeRow(row, error, now);
        this.tables.set(row.id, await this.frozenTable(row));
        continue;
      }
      const autoRows = await this.db.prepare(
        "SELECT seat_id FROM table_seats WHERE table_id = ? AND auto = 1 AND left_at IS NULL",
      ).all(row.id) as unknown as Array<{ seat_id: string }>;
      const live: LiveTable = {
        id: row.id,
        game: row.game,
        engine,
        hostSeatId: row.host_seat_id ?? engine.host,
        hostName: await this.seatName(row.host_seat_id ?? engine.host),
        stake: row.stake,
        createdAt: row.created_at,
        ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
        openDeadlineAt: row.deadline_at ?? row.updated_at + this.openMs,
        revision: row.revision,
        stateJson: stateTextOf(row.state_json),
        frozen: false,
        autoSeats: new Set(autoRows.map((entry) => entry.seat_id)),
      };
      if (engine.status === 'open') {
        if (now >= live.openDeadlineAt) {
          await this.abort(live, 'timeout', `${engine.label}桌连续 ${Math.round(this.openMs / 60_000)} 分钟没有活动，已经收起来了。`);
          continue;
        }
        this.tables.set(live.id, live);
        continue;
      }
      if (downtime > this.recovery.maxDowntimeMs) {
        await this.abort(live, 'offline',
          `${engine.label}桌因为服务停机超过 ${Math.round(this.recovery.maxDowntimeMs / 60_000)} 分钟，这局作废、押注退回。`);
        continue;
      }
      engine.rearm(now, downtime, this.recovery.minHumanMs);
      const revision = live.revision + 1;
      const stateJson = JSON.stringify(engine.exportState());
      live.revision = revision;
      live.stateJson = stateJson;
      this.tables.set(live.id, live);
      await withTransaction(this.db, async () => {
        await this.db.prepare(
          `UPDATE tables SET revision = ?, state_json = ?, state_version = ?, engine_version = ?,
             deadline_at = ?, updated_at = ? WHERE id = ?`,
        ).run(
          revision, stateJson, engine.stateVersion, `${row.game}/${engine.stateVersion}`,
          this.deadlineOf(engine) ?? null, now, live.id,
        );
        await this.appendTableEvent(live, {
          type: 'parlor.table.resume',
          scope: { kind: 'room' },
          text: `${engine.label}桌续上了：服务停了约 ${Math.max(1, Math.round(downtime / 1000))} 秒，牌和轮次都还在。`,
          data: { game: live.game, tableId: live.id, downtimeMs: downtime },
        }, now);
      });
    }
  }

  private async abortRow(row: TableRow, reason: 'closed' | 'restart', text: string, now: number): Promise<void> {
    const stub: LiveTable = {
      id: row.id,
      game: row.game,
      engine: { label: gameLabelOf(row.game) } as TableEngine,
      hostSeatId: row.host_seat_id ?? '',
      hostName: '',
      stake: row.stake,
      createdAt: row.created_at,
      openDeadlineAt: 0,
      revision: row.revision,
      stateJson: '',
      frozen: false,
      autoSeats: new Set(),
    };
    await withTransaction(this.db, async () => {
      if (row.status !== 'open' && row.stake > 0) await this.refund(stub, reason, now);
      await this.markTableSeatsLeft(row.id, now);
      await this.clearActivePlayers(row.id);
      await this.updateTableRow(row.id, 'abandoned', now, { endedAt: now, endReason: reason });
      await this.appendTableEvent(stub, {
        type: 'parlor.table.cancel',
        scope: { kind: 'room' },
        text,
        data: { game: row.game, tableId: row.id, reason },
      }, now);
    });
  }

  private async freezeRow(row: TableRow, error: unknown, now: number): Promise<void> {
    const message = (error as Error)?.message ?? String(error);
    console.error(`parlor: 牌桌 ${row.id} 恢复失败，已隔离`, message);
    await withTransaction(this.db, async () => {
      await this.db.prepare('UPDATE tables SET frozen_at = ?, recovery_error = ? WHERE id = ?')
        .run(now, message.slice(0, 500), row.id);
      await this.events.append(this.roomId, {
        type: 'parlor.table.frozen',
        ts: now,
        from: 'system',
        scope: { kind: 'room' },
        text: `${gameLabelOf(row.game)}桌的存档读不出来，已经被隔离；这副牌不会自动重发。`,
        data: { game: row.game, tableId: row.id },
      });
    });
  }

  private async frozenTable(row: TableRow): Promise<LiveTable> {
    return {
      id: row.id,
      game: row.game,
      engine: this.frozenStub(row),
      hostSeatId: row.host_seat_id ?? '',
      hostName: await this.seatName(row.host_seat_id ?? ''),
      stake: row.stake,
      createdAt: row.created_at,
      ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
      openDeadlineAt: 0,
      revision: row.revision,
      stateJson: '',
      frozen: true,
      autoSeats: new Set(),
    };
  }

  /** 已隔离的桌：只用来列出来给人看，任何动作都拒绝。 */
  private frozenStub(row: TableRow): TableEngine {
    const label = gameLabelOf(row.game);
    const stub = {
      game: row.game,
      label,
      status: 'playing' as TableStatus,
      host: row.host_seat_id ?? '',
      stateVersion: 0,
      has: () => false,
      seatIds: () => [],
      join: () => { throw new Error('这张桌子已经隔离'); },
      leave: () => { throw new Error('这张桌子已经隔离'); },
      start: () => { throw new Error('这张桌子已经隔离'); },
      act: () => { throw new Error('这张桌子已经隔离'); },
      tick: () => null,
      view: () => null,
      public: () => ({ game: row.game, status: 'playing', host: row.host_seat_id ?? '' }),
      privateText: () => null,
      publicText: () => `${label}桌的存档读不出来，已经隔离；这副牌不会自动重发。`,
      exportState: () => { throw new Error('这张桌子已经隔离'); },
      restoreState: () => { throw new Error('这张桌子已经隔离'); },
      rearm: () => { /* 隔离桌不推进 */ },
      autoPlay: () => null,
    };
    return stub as unknown as TableEngine;
  }

  private async hydrate(row: TableRow): Promise<TableEngine> {
    const def = gameById(row.game);
    if (!def) throw new Error(`不认识的桌子类型：${row.game}`);
    const engine = def.create({
      host: { id: row.host_seat_id ?? '', name: await this.seatName(row.host_seat_id ?? '') },
      now: row.created_at,
      ...(this.turnMs !== undefined ? { turnMs: this.turnMs } : {}),
    });
    if (row.state_version !== 0 && row.state_version !== engine.stateVersion) {
      throw new Error(`存档格式是 ${row.state_version}，这一版只认 ${engine.stateVersion}`);
    }
    engine.restoreState(jsonValue(row.state_json, null));
    return engine;
  }

  // —— 小工具 ——

  private summaryOf(table: LiveTable): TableSummary {
    return {
      ...(table.engine.public() as Record<string, unknown>),
      id: table.id,
      tableId: table.id,
      game: table.engine.game,
      label: table.engine.label,
      status: table.engine.status,
      host: table.engine.host,
      revision: table.revision,
      ...(table.frozen ? { frozen: true } : {}),
      ...(table.stake > 0 ? { stake: table.stake } : {}),
      text: table.frozen
        ? `${table.engine.label}桌恢复失败，已经隔离；等运营者处理。`
        : table.engine.publicText(),
    } as TableSummary;
  }

  private async draft(table: LiveTable): Promise<TableEngine> {
    return this.hydrate({
      id: table.id,
      room_id: this.roomId,
      game: table.game,
      status: table.engine.status,
      host_seat_id: table.hostSeatId,
      stake: table.stake,
      state_json: table.stateJson,
      engine_version: `${table.game}/${table.engine.stateVersion}`,
      revision: table.revision,
      state_version: table.engine.stateVersion,
      deadline_at: this.deadlineOf(table.engine) ?? null,
      frozen_at: null,
      recovery_error: null,
      created_at: table.createdAt,
      started_at: table.startedAt ?? null,
      ended_at: null,
      end_reason: null,
      updated_at: table.createdAt,
    });
  }

  private async requireMyTable(cooId: string, tableId?: string): Promise<LiveTable> {
    const mine = await this.tableOf(cooId);
    if (tableId) {
      if (mine && mine.id !== tableId && isLive(mine.engine.status)) {
        throw new HostError('conflict', `你已经在这张${mine.engine.label}桌上了；先打完再换桌`);
      }
      const table = this.tables.get(tableId);
      if (!table) throw new HostError('not_found', '这张桌子不存在，可能已经收起来了');
      return table;
    }
    if (!mine) throw new HostError('invalid', '你不在任何牌桌上');
    return mine;
  }

  private resolveOpenTable(tableId?: string): LiveTable {
    if (tableId) {
      const table = this.tables.get(tableId);
      if (!table) throw new HostError('not_found', '这张桌子不存在，可能已经收起来了');
      if (table.engine.status !== 'open') throw new HostError('conflict', '这张桌子已经开始了');
      return table;
    }
    const open = this.liveTables().filter((table) => table.engine.status === 'open');
    if (open.length === 0) throw new HostError('not_found', '现在没有可以坐下的桌子');
    if (open.length > 1) {
      throw new HostError('invalid', `现在有 ${open.length} 张桌子；用 table 选一张（先 parlor_look 看桌号）`);
    }
    return open[0];
  }

  private async requireSeat(cooId: string): Promise<SeatRow> {
    const seat = await this.seats.activeSeat(cooId);
    if (!seat) throw new HostError('forbidden', '你不在这个客厅里');
    return seat;
  }

  private async seatById(seatId: string): Promise<SeatRow | undefined> {
    return (await this.seats.seats()).find((seat) => seat.id === seatId);
  }

  private async seatName(seatId: string): Promise<string> {
    return (await this.seatById(seatId))?.name ?? '';
  }

  /** 开局那一刻的真人席位（脚本陪练不算；押注只收这些人）。 */
  private async realPlayers(table: LiveTable): Promise<Array<{ seatId: string; cooId: string; name: string }>> {
    const view = table.engine.public() as { seats?: Array<{ id?: unknown; name?: unknown }> };
    const names = new Map<string, string>();
    for (const seat of view.seats ?? []) {
      if (typeof seat.id === 'string' && typeof seat.name === 'string') names.set(seat.id, seat.name);
    }
    const players: Array<{ seatId: string; cooId: string; name: string }> = [];
    for (const row of await this.tableSeatRows(table.id)) {
      if (row.left_at !== null || row.coo_id === null) continue;
      players.push({
        seatId: row.seat_id,
        cooId: row.coo_id,
        name: names.get(row.seat_id) ?? (await this.seatById(row.seat_id))?.name ?? '席位',
      });
    }
    return players;
  }

  private rosterOf(engine: TableEngine): string[] {
    const view = engine.public() as { seats?: Array<{ name?: unknown; bot?: unknown }> };
    return (view.seats ?? []).map((seat) => (
      typeof seat.name === 'string' ? (seat.bot === true ? `${seat.name}（脚本）` : seat.name) : '？'
    ));
  }

  private turnOf(engine: TableEngine): string | undefined {
    const turn = (engine.public() as { turn?: unknown }).turn;
    return typeof turn === 'string' ? turn : undefined;
  }

  private deadlineOf(engine: TableEngine): number | undefined {
    const deadline = (engine.public() as { deadline?: unknown }).deadline;
    return typeof deadline === 'number' && deadline > 0 ? deadline : undefined;
  }

  private async finishReceipt(receipt: TableReceipt, engine: TableEngine): Promise<void> {
    const deadline = this.deadlineOf(engine);
    const turnId = this.turnOf(engine);
    const publicView = engine.public() as { seats?: Array<{ id?: unknown; name?: unknown }> };
    const turnName = turnId ? publicView.seats?.find((seat) => seat.id === turnId)?.name : undefined;
    const seq = await this.events.latest(this.roomId);
    receipt.seq = seq;
    receipt.ts = this.now();
    receipt.at = serverClock(receipt.ts);
    if (deadline) {
      receipt.deadline = deadline;
      receipt.deadlineAt = serverClock(deadline);
    }
    if (typeof turnName === 'string' && turnName) receipt.turn = turnName;
  }

  private async replayReceipt(cooId: string, requestId: string | undefined, payload: unknown): Promise<TableReceipt | null> {
    if (!requestId) return null;
    const row = await this.db.prepare(
      'SELECT hash, receipt_json FROM action_receipts WHERE coo_id = ? AND request_id = ?',
    ).get(cooId, requestId) as { hash: string; receipt_json: unknown } | undefined;
    if (!row) return null;
    if (row.hash !== actionHash(payload)) {
      throw new HostError('conflict', '同一个 requestId 被用在了不同的动作上；换一个新的请求号');
    }
    return jsonValue<TableReceipt | null>(row.receipt_json, null);
  }

  private async storeReceipt(
    cooId: string,
    requestId: string | undefined,
    tableId: string | null,
    payload: unknown,
    receipt: TableReceipt,
    now: number,
  ): Promise<void> {
    if (!requestId) return;
    // 幂等键靠主键挡第二次写；冲突就是要它抛，不做 ON CONFLICT 吞掉。
    await this.db.prepare(
      `INSERT INTO action_receipts(coo_id, request_id, room_id, table_id, hash, receipt_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      cooId, requestId, this.roomId, tableId, actionHash(payload), JSON.stringify(receipt), now,
    );
  }

  private async finalization(tableId: string): Promise<{ kind: string } | undefined> {
    const row = await this.db.prepare('SELECT kind FROM table_finalizations WHERE table_id = ?')
      .get(tableId) as { kind: string } | undefined;
    return row;
  }

  private async insertBotSeats(table: LiveTable, engine: TableEngine, now: number): Promise<void> {
    const view = engine.public() as { seats?: Array<{ id?: unknown; name?: unknown; bot?: unknown }> };
    let position = await this.nextPosition(table.id);
    for (const seat of view.seats ?? []) {
      if (seat.bot !== true || typeof seat.id !== 'string') continue;
      // 原先的 INSERT OR IGNORE 是 SQLite 方言；ON CONFLICT DO NOTHING 两边都认。
      await this.db.prepare(
        `INSERT INTO table_seats(table_id, room_id, seat_id, coo_id, position, is_bot, joined_at)
         VALUES (?, ?, ?, NULL, ?, 1, ?)
         ON CONFLICT DO NOTHING`,
      ).run(table.id, this.roomId, seat.id, position, now);
      position += 1;
    }
  }

  private async insertTableSeat(tableId: string, seatId: string, cooId: string, position: number, isBot: boolean, now: number): Promise<void> {
    const exists = await this.db.prepare(
      'SELECT 1 AS ok FROM table_seats WHERE table_id = ? AND seat_id = ?',
    ).get(tableId, seatId);
    if (exists) return;
    await this.db.prepare(
      `INSERT INTO table_seats(table_id, room_id, seat_id, coo_id, position, is_bot, joined_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(tableId, this.roomId, seatId, cooId, position, isBot ? 1 : 0, now);
  }

  private async nextPosition(tableId: string): Promise<number> {
    const row = await this.db.prepare(
      'SELECT COALESCE(MAX(position), -1) AS top FROM table_seats WHERE table_id = ?',
    ).get(tableId) as { top: number };
    return row.top + 1;
  }

  private async markTableSeatLeft(tableId: string, seatId: string, now: number): Promise<void> {
    await this.db.prepare(
      'UPDATE table_seats SET left_at = ? WHERE table_id = ? AND seat_id = ? AND left_at IS NULL',
    ).run(now, tableId, seatId);
  }

  private async markTableSeatsLeft(tableId: string, now: number): Promise<void> {
    await this.db.prepare('UPDATE table_seats SET left_at = ? WHERE table_id = ? AND left_at IS NULL')
      .run(now, tableId);
  }

  private async tableSeatRows(tableId: string): Promise<TableSeatRow[]> {
    return await this.db.prepare('SELECT * FROM table_seats WHERE table_id = ? ORDER BY position')
      .all(tableId) as unknown as TableSeatRow[];
  }

  private async insertTableRow(table: LiveTable, status: string, now: number, stateJson: string): Promise<void> {
    const epoch = await this.roomEpoch();
    await this.db.prepare(
      `INSERT INTO tables(id, room_id, room_epoch, game, status, host_seat_id, stake, state_json,
         engine_version, turn_seq, revision, state_version, deadline_at, created_at, started_at,
         ended_at, end_reason, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    ).run(
      table.id,
      this.roomId,
      epoch,
      table.game,
      status,
      table.hostSeatId,
      table.stake,
      stateJson,
      `${table.game}/${table.engine.stateVersion}`,
      table.revision,
      table.engine.stateVersion,
      table.openDeadlineAt,
      now,
      now,
    );
  }

  private async updateTableState(
    tableId: string,
    engine: TableEngine,
    revision: number,
    stateJson: string,
    now: number,
    extra: { startedAt?: number; endedAt?: number },
  ): Promise<void> {
    await this.db.prepare(
      `UPDATE tables SET status = ?, state_json = ?, state_version = ?, engine_version = ?,
         revision = ?, turn_seq = ?, deadline_at = ?, updated_at = ?,
         started_at = COALESCE(?, started_at), ended_at = COALESCE(?, ended_at)
       WHERE id = ?`,
    ).run(
      engine.status,
      stateJson,
      engine.stateVersion,
      `${engine.game}/${engine.stateVersion}`,
      revision,
      revision,
      engine.status === 'open' ? now + this.openMs : this.deadlineOf(engine) ?? null,
      now,
      extra.startedAt ?? null,
      extra.endedAt ?? null,
      tableId,
    );
  }

  private async updateTableRow(
    tableId: string,
    status: string,
    now: number,
    extra: { startedAt?: number; endedAt?: number; endReason?: string } = {},
  ): Promise<void> {
    await this.db.prepare(
      `UPDATE tables SET status = ?, updated_at = ?,
         started_at = COALESCE(?, started_at),
         ended_at = COALESCE(?, ended_at),
         end_reason = COALESCE(?, end_reason)
       WHERE id = ?`,
    ).run(status, now, extra.startedAt ?? null, extra.endedAt ?? null, extra.endReason ?? null, tableId);
  }

  /** 健康心跳：只在开桌事务里写一次，避免「刚开桌就崩」被算成长停机。 */
  private async markHealthy(now: number): Promise<void> {
    await this.db.prepare(
      `INSERT INTO meta(key, value) VALUES('last_healthy_at', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(now));
  }

  private async insertActivePlayer(cooId: string, tableId: string, now: number): Promise<void> {
    // 并发重复入桌靠主键抛错，由调用方回滚整笔事务；这里不加 ON CONFLICT。
    await this.db.prepare(
      `INSERT INTO active_table_players(coo_id, table_id, room_id, joined_at)
       VALUES (?, ?, ?, ?)`,
    ).run(cooId, tableId, this.roomId, now);
  }

  private async removeActivePlayer(cooId: string): Promise<void> {
    await this.db.prepare('DELETE FROM active_table_players WHERE coo_id = ?').run(cooId);
  }

  private async clearActivePlayers(tableId: string): Promise<void> {
    await this.db.prepare('DELETE FROM active_table_players WHERE table_id = ?').run(tableId);
  }

  private async roomEpoch(): Promise<string> {
    const row = await this.db.prepare('SELECT epoch FROM rooms WHERE id = ?').get(this.roomId) as { epoch: string } | undefined;
    return row?.epoch ?? '';
  }

  /** 内存里只留少量结束的桌；它们的完整记录还在数据库里。 */
  private pruneEnded(): void {
    const ended = [...this.tables.values()]
      .filter((table) => table.engine.status === 'ended')
      .sort((left, right) => right.createdAt - left.createdAt);
    for (const table of ended.slice(KEEP_ENDED)) this.tables.delete(table.id);
  }
}
