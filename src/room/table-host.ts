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
import { EventDb } from './event-db.ts';
import { HostError } from './host-error.ts';
import { LedgerDb } from './ledger-db.ts';
import { MAX_CHIPS } from './ledger.ts';
import { MailDb } from './mail-db.ts';
import { serverClock } from './clock.ts';
import { gameById, gameIds, gameLabelOf } from './games/registry.ts';
import {
  TableError,
  type TableEngine,
  type TableEvent,
  type TablePrivateSummary,
  type TableStatus,
  type TableStep,
  type TableSummary,
} from './table-engine.ts';
import type { RoomEvent } from './protocol.ts';
import type { SeatRow } from './room-seat-db.ts';

const OPEN_MS = 10 * 60_000;
const MAX_TABLE_TEXT = 400;
/** 一房同时未结束的桌数上限（30 人分 10 桌斗地主）。 */
export const MAX_LIVE_TABLES = 10;
/** 停机超过这么久，已开局的桌作废、押注原路退回。 */
export const MAX_DOWNTIME_MS = 30 * 60_000;
/** 恢复后给真人的最短重连时间。 */
const MIN_HUMAN_RESUME_MS = 10_000;
/** 结束的桌子在内存里留几张给「刚打完」的页面看。 */
const KEEP_ENDED = 3;

export interface TableHostOptions {
  db: Db;
  roomId: string;
  now?: () => number;
  /** 每手时限（测试里调短）。 */
  turnMs?: number;
  /** 开桌后多久没开局自动收起。 */
  openMs?: number;
  /**
   * 启动恢复的基准：最后一次「服务还在正常推进」的时刻。
   * 没有值就用这些桌子自己的 updated_at 当基准（等同于「刚刚还在」）。
   */
  recovery?: { lastHealthyAt?: number; maxDowntimeMs?: number; minHumanMs?: number };
}

export interface TableSeatLookup {
  /** 这个 coo 在这个客厅的活跃席位；不在厅里返回 null。 */
  activeSeat(cooId: string): SeatRow | null;
  /** 客厅里所有活跃席位。 */
  seats(): SeatRow[];
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
  state_json: string | null;
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

  constructor(options: TableHostOptions & { seats: TableSeatLookup; ledger: LedgerDb; mail: MailDb }) {
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
    this.recoverLiveTables();
  }

  /**
   * 这个 coo 现在参与的那张**未结束**的桌（没有返回 null）。
   *
   * 结束的桌不算：牌局一结束人就已经离桌，只剩一张可以回看的结果桌。
   * 不这样区分的话，上一局的 ended 桌会一直被当成「我的桌」——不带桌号的
   * join/leave 都打到它身上，报「已经开始了/已经结束了」，人却退不出去。
   */
  tableOf(cooId: string): LiveTable | null {
    const row = this.db.prepare(
      'SELECT table_id FROM active_table_players WHERE coo_id = ?',
    ).get(cooId) as { table_id: string } | undefined;
    if (row) {
      const table = this.tables.get(row.table_id);
      if (table && isLive(table.engine.status)) return table;
    }
    // 兜底：看引擎里有没有这个 coo 的活跃席位（恢复失败/旧数据）。
    const seat = this.seats.activeSeat(cooId);
    if (!seat) return null;
    for (const table of this.tables.values()) {
      if (isLive(table.engine.status) && table.engine.has(seat.id)) return table;
    }
    return null;
  }

  /** 这个 coo 最近打完的那张桌；只给结果页用，不算「我的桌」。 */
  private lastEndedTableOf(cooId: string): LiveTable | null {
    const seat = this.seats.activeSeat(cooId);
    if (!seat) return null;
    const ended = [...this.tables.values()]
      .filter((table) => table.engine.status === 'ended' && table.engine.has(seat.id))
      .sort((left, right) => right.createdAt - left.createdAt);
    return ended[0] ?? null;
  }

  /** 这个 coo 是否被一张未结束的牌桌锁住。 */
  lockOf(cooId: string): TableLockInfo | null {
    const table = this.tableOf(cooId);
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
  public(cooId?: string): TableSummary | undefined {
    const mine = cooId ? this.tableOf(cooId) : null;
    if (mine) return this.summaryOf(mine);
    // 刚打完的那张：人已经离桌，但结果页还要看。
    const last = cooId ? this.lastEndedTableOf(cooId) : null;
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

  open(cooId: string, input: { game?: string; stake?: unknown } = {}, requestId?: string): TableOpenResult {
    const seat = this.requireSeat(cooId);
    if (seat.kind === 'observer') throw new HostError('forbidden', '观看者不能开桌');
    if (this.liveTables().length >= MAX_LIVE_TABLES) {
      throw new HostError('conflict', `这个客厅已经有 ${MAX_LIVE_TABLES} 张没结束的桌子了`);
    }
    const mine = this.tableOf(cooId);
    if (mine && isLive(mine.engine.status)) {
      throw new HostError('conflict', `你已经在一张${mine.engine.label}桌上了；一人同时只参与一张`);
    }
    const id = input.game ?? 'dice';
    const def = gameById(id);
    if (!def) throw new HostError('invalid', `不认识的桌子：现在有 ${gameIds().join(' / ')}`);
    const stake = stakeOf(input.stake);
    if (stake > 0 && this.ledger.balanceOf(cooId) < stake) {
      throw new HostError('invalid', `你只有 ${this.ledger.balanceOf(cooId)} 枚筹码，押不起 ${stake} 枚`);
    }
    const replay = this.replayReceipt(cooId, requestId, { type: 'table_open', game: id, stake });
    if (replay) {
      const at = this.now();
      return {
        tableId: replay.tableId,
        event: {
          seq: this.events.latest(this.roomId),
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
      host: { id: seat.id, name: seat.name },
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
    const event = withTransaction(this.db, () => {
      this.insertTableRow(table, 'open', now, stateJson);
      this.insertTableSeat(table.id, seat.id, cooId, 0, false, now);
      this.insertActivePlayer(cooId, table.id, now);
      const appended = this.events.append(this.roomId, {
        type: 'parlor.table.open',
        ts: now,
        from: 'system',
        scope: { kind: 'room' },
        text: `${seat.name} 开了一张${def.label}桌${stake > 0 ? `（每人押 ${stake} 枚筹码）` : ''}。`,
        data: { game: def.id, stake, tableId: table.id },
      });
      this.finishReceipt(receipt, engine);
      this.storeReceipt(cooId, requestId, table.id, { type: 'table_open', game: id, stake }, receipt, now);
      // 开桌这一刻就是「数据库还能写」的证据；刚开桌就崩，也不会把停机时长算错。
      this.markHealthy(now);
      return appended;
    });
    this.tables.set(table.id, table);
    this.pruneEnded();
    return { tableId: table.id, event, receipt };
  }

  join(cooId: string, tableId?: string, requestId?: string): TableJoinResult {
    const seat = this.requireSeat(cooId);
    if (seat.kind === 'observer') throw new HostError('forbidden', '观看者不能上桌');
    const mine = this.tableOf(cooId);
    if (mine && isLive(mine.engine.status)) {
      throw new HostError('conflict', `你已经在一张${mine.engine.label}桌上了；一人同时只参与一张`);
    }
    const table = this.resolveOpenTable(tableId);
    const replay = this.replayReceipt(cooId, requestId, { type: 'table_join', tableId: table.id });
    if (replay) {
      return {
        event: {
          seq: this.events.latest(this.roomId),
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
    if (table.stake > 0 && this.ledger.balanceOf(cooId) < table.stake) {
      throw new HostError('invalid', `这张桌子每人押 ${table.stake} 枚，你只有 ${this.ledger.balanceOf(cooId)} 枚`);
    }
    const now = this.now();
    const draft = this.draft(table);
    let event: TableEvent;
    try {
      event = draft.join({ id: seat.id, name: seat.name });
    } catch (error) {
      return asHostError(error);
    }
    const revision = table.revision + 1;
    const stateJson = JSON.stringify(draft.exportState());
    const receipt: TableReceipt = { tableId: table.id, revision };
    const appended = withTransaction(this.db, () => {
      this.insertTableSeat(table.id, seat.id, cooId, this.nextPosition(table.id), false, now);
      this.insertActivePlayer(cooId, table.id, now);
      const row = this.appendTableEvent(table, event, now);
      this.updateTableState(table.id, draft, revision, stateJson, now, {});
      this.finishReceipt(receipt, draft);
      this.storeReceipt(cooId, requestId, table.id, { type: 'table_join', tableId: table.id }, receipt, now);
      return row;
    });
    table.engine = draft;
    table.revision = revision;
    table.stateJson = stateJson;
    return { event: appended, tableId: table.id, receipt };
  }

  /** 未开局时离桌；开桌的人离桌等于收掉整张桌子。 */
  leave(cooId: string, tableId?: string, requestId?: string): TableLeaveResult {
    const seat = this.requireSeat(cooId);
    // 重试先查回执：上一次退桌已经成功的话，这时人已经不在桌上了。
    const earlier = this.replayReceipt(cooId, requestId, {
      type: 'table_leave', tableId: tableId ?? null,
    });
    if (earlier) {
      return {
        event: {
          seq: this.events.latest(this.roomId),
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
    const table = this.requireMyTable(cooId, tableId);
    if (table.engine.status === 'ended') throw new HostError('conflict', '这张桌子已经结束了');
    if (table.engine.status !== 'open') {
      throw new HostError('conflict', '牌局已经开始了，不能退桌');
    }
    const closing = seat.id === table.hostSeatId;
    const now = this.now();
    const draft = closing ? table.engine : this.draft(table);
    const receipt: TableReceipt = { tableId: table.id, revision: table.revision };
    let nextEngine: TableEngine | null = null;
    let nextRevision = table.revision;
    let nextState = table.stateJson;
    const event = withTransaction(this.db, () => {
      if (closing) {
        // 开桌的人退桌 = 收桌；没开局就没有押注要退。
        this.markTableSeatsLeft(table.id, now);
        this.clearActivePlayers(table.id);
        this.updateTableRow(table.id, 'abandoned', now, { endedAt: now, endReason: 'closed' });
        this.finishReceipt(receipt, table.engine);
        this.storeReceipt(cooId, requestId, table.id, { type: 'table_leave', tableId: tableId ?? null }, receipt, now);
        return this.appendTableEvent(table, {
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
      this.markTableSeatLeft(table.id, seat.id, now);
      this.removeActivePlayer(cooId);
      nextRevision = table.revision + 1;
      nextState = JSON.stringify(draft.exportState());
      const row = this.appendTableEvent(table, left, now);
      this.updateTableState(table.id, draft, nextRevision, nextState, now, {});
      this.finishReceipt(receipt, draft);
      this.storeReceipt(cooId, requestId, table.id, { type: 'table_leave', tableId: tableId ?? null }, receipt, now);
      nextEngine = draft;
      return row;
    });
    if (closing) {
      this.tables.delete(table.id);
    } else if (nextEngine) {
      table.engine = nextEngine;
      table.revision = nextRevision;
      table.stateJson = nextState;
    }
    return { event, closed: closing, receipt };
  }

  start(cooId: string, tableId?: string, requestId?: string): StartReceipt {
    const table = this.requireMyTable(cooId, tableId);
    const seat = this.requireSeat(cooId);
    if (table.frozen) throw new HostError('conflict', '这张桌子恢复失败，已经被隔离开了');
    if (seat.id !== table.hostSeatId) throw new HostError('forbidden', '只有开桌的人可以开始');
    const replay = this.replayReceipt(cooId, requestId, { type: 'table_start', tableId: table.id });
    if (replay) return { ...replay, seats: replay.seats ?? [] };
    const players = this.realPlayers(table);
    if (table.stake > 0) {
      if (players.length < 2) throw new HostError('invalid', '押注桌至少要两个真人；陪练不押注');
      for (const player of players) {
        const balance = this.ledger.balanceOf(player.cooId);
        if (balance < table.stake) {
          throw new HostError('invalid', `${player.name} 只有 ${balance} 枚筹码，押不起 ${table.stake} 枚`);
        }
      }
    }
    const now = this.now();
    const draft = this.draft(table);
    let step: TableStep;
    try {
      step = draft.start(seat.id, now);
    } catch (error) {
      return asHostError(error);
    }
    const revision = table.revision + 1;
    const stateJson = JSON.stringify(draft.exportState());
    const receipt: TableReceipt = { tableId: table.id, revision };
    withTransaction(this.db, () => {
      if (table.stake > 0) {
        const pot = table.stake * players.length;
        this.ledger.record({
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
      table.startedAt = now;
      this.insertBotSeats(table, draft, now);
      this.recordStep(table, draft, step, now);
      this.updateTableState(table.id, draft, revision, stateJson, now, { startedAt: now });
      this.finishReceipt(receipt, draft);
      this.storeReceipt(cooId, requestId, table.id, { type: 'table_start', tableId: table.id }, receipt, now);
    });
    table.engine = draft;
    table.revision = revision;
    table.stateJson = stateJson;
    return { ...receipt, seats: this.rosterOf(draft) };
  }

  act(cooId: string, action: unknown, options: TableActOptions = {}): TableReceipt {
    const table = this.requireMyTable(cooId, options.tableId);
    const seat = this.requireSeat(cooId);
    if (table.frozen) throw new HostError('conflict', '这张桌子恢复失败，已经被隔离开了');
    const requestId = options.requestId;
    const replay = this.replayReceipt(cooId, requestId, {
      type: 'table_act', tableId: table.id, action,
    });
    if (replay) return replay;
    if (!requestId) {
      throw new HostError('invalid', '缺少 requestId：牌桌动作要带幂等键，请升级客厅扩展后再打牌');
    }
    if (options.revision === undefined) {
      throw new HostError('invalid', '缺少牌桌版本：请刷新页面/升级客厅扩展后再打牌');
    }
    if (options.revision !== table.revision) {
      throw new HostError('conflict', '这一手已经过去了：你看到的是旧桌面，刷新后再来');
    }
    const now = this.now();
    const draft = this.draft(table);
    let step: TableStep;
    try {
      step = draft.act(seat.id, action, now);
    } catch (error) {
      return asHostError(error);
    }
    const revision = table.revision + 1;
    const stateJson = JSON.stringify(draft.exportState());
    const receipt: TableReceipt = { tableId: table.id, revision };
    withTransaction(this.db, () => {
      this.recordStep(table, draft, step, now);
      this.updateTableState(table.id, draft, revision, stateJson, now, step.ended ? { endedAt: now } : {});
      this.finishReceipt(receipt, draft);
      this.storeReceipt(cooId, requestId, table.id, { type: 'table_act', tableId: table.id, action }, receipt, now);
    });
    table.engine = draft;
    table.revision = revision;
    table.stateJson = stateJson;
    return receipt;
  }

  /** 每秒由网关调用：开桌超时收起；牌局超时代打/结算；托管席位立刻代打。 */
  tick(): void {
    for (const table of this.liveTables()) {
      if (table.frozen) continue;
      const now = this.now();
      if (table.engine.status === 'open') {
        if (now < table.openDeadlineAt) continue;
        this.abort(table, 'timeout', `${table.engine.label}桌 ${Math.round(this.openMs / 60_000)} 分钟没开局，已经收起来了。`);
        continue;
      }
      const draft = this.draft(table);
      const turnId = this.turnOf(draft);
      let step: TableStep | null;
      try {
        step = turnId && table.autoSeats.has(turnId)
          ? draft.autoPlay(turnId, now)
          : draft.tick(now);
      } catch (error) {
        // 长局里一次代打抛错不能把客厅锁死：整桌作废并退回押注，让人看得见。
        console.error('parlor: 牌桌超时代打失败', error);
        this.abort(table, 'error', `${table.engine.label}桌推进出错，这局作废。`);
        continue;
      }
      if (!step) continue;
      this.commitTick(table, draft, step, now);
    }
  }

  /** 桌内说话：只给那一刻坐在桌上的人（和回放）看。 */
  say(cooId: string, text: string, tableId?: string): RoomEvent {
    const table = this.requireMyTable(cooId, tableId);
    const seat = this.requireSeat(cooId);
    if (table.engine.status === 'ended') throw new HostError('invalid', '这张桌子已经结束了，回客厅说吧');
    if (!table.engine.has(seat.id)) throw new HostError('invalid', '你不在这一桌，回客厅说吧');
    const body = clampText(text);
    const seats = table.engine.seatIds().filter((seatId) => this.seatById(seatId) !== undefined);
    return this.events.append(this.roomId, {
      type: 'parlor.table.say',
      ts: this.now(),
      from: seat.id,
      scope: { kind: 'table', tableId: table.id, seats },
      text: body,
      data: { name: seat.name, tableId: table.id },
    });
  }

  // —— 移除/托管 ——

  /**
   * 把这个人从这一房所有未结束的桌里标成托管：他的回合由脚本代打，
   * 结算仍归他（筹码照算），一人一桌的锁保留到结算。
   */
  markAuto(cooId: string): string[] {
    const seat = this.seats.activeSeat(cooId);
    if (!seat) return [];
    const ids: string[] = [];
    for (const table of this.liveTables()) {
      if (!table.engine.has(seat.id)) continue;
      this.db.prepare(
        'UPDATE table_seats SET auto = 1 WHERE table_id = ? AND seat_id = ? AND left_at IS NULL',
      ).run(table.id, seat.id);
      table.autoSeats.add(seat.id);
      ids.push(table.id);
    }
    return ids;
  }

  /**
   * 运营命令：把一张隔离/卡住的桌作废并按开局明细退款（走与超时同一条事务）。
   * 返回 false = 这个客厅里没有这张桌（可能已经结束/在别的厅）。
   */
  voidTable(tableId: string, note = '运营者处理'): boolean {
    const table = this.tables.get(tableId);
    if (!table) return false;
    this.abort(table, 'error', `${table.engine.label}桌由运营者作废：${note}。`);
    return true;
  }

  /** 公开视图（给网关判断桌子类型/取桌号）。 */
  tableSummary(tableId?: string, cooId?: string): TableSummary | undefined {
    if (tableId) {
      const table = this.tables.get(tableId);
      return table ? this.summaryOf(table) : undefined;
    }
    return this.public(cooId);
  }

  // —— 内部：提交与事件 ——

  private commitTick(table: LiveTable, draft: TableEngine, step: TableStep, now: number): void {
    const revision = table.revision + 1;
    const stateJson = JSON.stringify(draft.exportState());
    withTransaction(this.db, () => {
      this.recordStep(table, draft, step, now);
      this.updateTableState(table.id, draft, revision, stateJson, now, step.ended ? { endedAt: now } : {});
    });
    table.engine = draft;
    table.revision = revision;
    table.stateJson = stateJson;
  }

  /** 把一步引擎结果写进事件流：公开事件 + 每个席位的私视图；结束时结算。 */
  private recordStep(table: LiveTable, engine: TableEngine, step: TableStep, now: number): void {
    let ended: TableEvent | undefined;
    for (const event of step.events) {
      this.appendTableEvent(table, event, now);
      if (event.type === 'parlor.table.end') ended = event;
    }
    for (const seatId of step.views) {
      // 脚本陪练不是房间席位：它们的视图不进事件流。
      if (!this.seatById(seatId)) continue;
      const view = engine.view(seatId);
      const text = engine.privateText(seatId, now);
      if (!view || !text) continue;
      this.events.append(this.roomId, {
        type: 'parlor.table.turn',
        ts: now,
        from: 'system',
        scope: { kind: 'seat', seatId },
        text,
        data: { table: view, tableId: table.id, game: engine.game },
      });
    }
    if (ended) this.settle(table, ended, now);
  }

  private appendTableEvent(table: LiveTable, event: TableEvent, now: number): RoomEvent {
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
  private settle(table: LiveTable, event: TableEvent, now: number): void {
    if (this.finalization(table.id)) return;
    const rows = this.tableSeatRows(table.id).filter((row) => row.left_at === null && row.coo_id !== null);
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
        const names = winners
          .map((cooId) => this.seatById(rows.find((row) => row.coo_id === cooId)!.seat_id)?.name ?? '席位')
          .join('、');
        chipText = ` 底池 ${pot} 枚归 ${names}。`;
      } else {
        transfers = participants.map((cooId) => ({ from: 'room', to: cooId, amount: stake }));
        chipText = ` 没人赢，底池 ${pot} 枚退回。`;
      }
    }
    const entry = this.ledger.record({
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
        ...(typeof data.landlord === 'string'
          ? { landlord: this.seatById(data.landlord)?.name }
          : {}),
      },
    });
    this.db.prepare(
      `INSERT INTO table_finalizations(table_id, kind, entry_id, at, payload_json)
       VALUES (?, 'result', ?, ?, ?)`,
    ).run(table.id, entry.id, now, JSON.stringify({ winners, participants, stake, pot }));
    // 一局结束 = 大家都下桌：席位记录标离桌，active_table_players 清空。
    // 引擎里的座位还留着给结果页看（谁打了这局），但不再算「人在桌上」。
    this.markTableSeatsLeft(table.id, now);
    this.clearActivePlayers(table.id);
  }

  /** 开桌超时/引擎出错/长停机：整桌作废；已经收过押注的按开局明细原路退回。 */
  private abort(table: LiveTable, reason: 'timeout' | 'error' | 'offline' | 'restart', text: string): void {
    const now = this.now();
    withTransaction(this.db, () => {
      if (table.engine.status !== 'open') this.refund(table, reason, now);
      this.markTableSeatsLeft(table.id, now);
      this.clearActivePlayers(table.id);
      this.updateTableRow(table.id, 'abandoned', now, { endedAt: now, endReason: reason });
      this.appendTableEvent(table, {
        type: 'parlor.table.cancel',
        scope: { kind: 'room' },
        text,
        data: { game: table.game, tableId: table.id, reason },
      }, now);
    });
    this.tables.delete(table.id);
  }

  /**
   * 押注原路退回：读开局那条 ante 的实际扣款明细（不是 stake×人数），
   * effectId 幂等，终态表挡住第二次退款。
   */
  private refund(table: { id: string; game: string; engine: TableEngine; stake: number }, reason: string, now: number): void {
    if (this.finalization(table.id)) return;
    const ante = this.ledger.byEffectId(`${table.id}/ante`);
    const rows = ante ? this.ledger.transfersOf(ante.id) : [];
    const byCoo = new Map<string, number>();
    for (const transfer of rows) {
      if (transfer.fromKind !== 'coo' || !transfer.fromCooId) continue;
      byCoo.set(transfer.fromCooId, (byCoo.get(transfer.fromCooId) ?? 0) + transfer.amount);
    }
    if (byCoo.size === 0) {
      // 没收到过押注的桌：也要留一个终态，避免以后被当成「还没结算」。
      this.db.prepare(
        `INSERT INTO table_finalizations(table_id, kind, entry_id, at, payload_json)
         VALUES (?, 'refund', NULL, ?, ?)`,
      ).run(table.id, now, JSON.stringify({ reason, refunded: [] }));
      return;
    }
    const participants = [...byCoo.keys()];
    let entry;
    try {
      entry = this.ledger.record({
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
    this.db.prepare(
      `INSERT INTO table_finalizations(table_id, kind, entry_id, at, payload_json)
       VALUES (?, 'refund', ?, ?, ?)`,
    ).run(table.id, entry.id, now, JSON.stringify({ reason, refunded: participants.map((cooId) => ({ cooId, amount: byCoo.get(cooId) })) }));
    for (const cooId of participants) {
      try {
        this.mail.appendOnce(`${table.id}/refund/${cooId}`, {
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
  private recoverLiveTables(): void {
    const now = this.now();
    // 最近结束的一桌也装回来：进程重启后网页还要看结果页。
    const ended = this.db.prepare(
      `SELECT * FROM tables WHERE room_id = ? AND status = 'ended' AND state_json IS NOT NULL
        ORDER BY ended_at DESC, created_at DESC LIMIT 1`,
    ).get(this.roomId) as TableRow | undefined;
    if (ended) {
      try {
        const engine = this.hydrate(ended);
        this.tables.set(ended.id, {
          id: ended.id,
          game: ended.game,
          engine,
          hostSeatId: ended.host_seat_id ?? engine.host,
          hostName: this.seatName(ended.host_seat_id ?? engine.host),
          stake: ended.stake,
          createdAt: ended.created_at,
          ...(ended.started_at !== null ? { startedAt: ended.started_at } : {}),
          openDeadlineAt: ended.deadline_at ?? ended.created_at + this.openMs,
          revision: ended.revision,
          stateJson: ended.state_json ?? 'null',
          frozen: false,
          autoSeats: new Set(),
        });
      } catch (error) {
        console.error('parlor: 最近结束的牌桌读不回来（只影响结果页）', error);
      }
    }
    const rows = this.db.prepare(
      `SELECT * FROM tables WHERE room_id = ? AND status IN ('open','bidding','playing') ORDER BY created_at`,
    ).all(this.roomId) as unknown as TableRow[];
    // 之前已经隔离的桌：照样列出来（标 frozen），但不推进、不接动作。
    for (const row of rows) {
      if (row.frozen_at === null) continue;
      this.tables.set(row.id, this.frozenTable(row));
    }
    if (rows.length === 0) return;
    const newest = rows.reduce((max, row) => Math.max(max, row.updated_at), 0);
    const lastHealthyAt = this.recovery.lastHealthyAt ?? newest;
    const downtime = Math.max(0, now - lastHealthyAt);
    for (const row of rows) {
      if (row.frozen_at !== null) continue;
      if (!row.state_json) {
        this.abortRow(row, row.status === 'open' ? 'closed' : 'restart',
          row.status === 'open' ? '没有开局就停机的旧桌子，已经收起来了。' : '升级前的旧牌局没有存档，这局作废、押注退回。', now);
        continue;
      }
      let engine: TableEngine;
      try {
        engine = this.hydrate(row);
      } catch (error) {
        this.freezeRow(row, error, now);
        this.tables.set(row.id, this.frozenTable(row));
        continue;
      }
      const live: LiveTable = {
        id: row.id,
        game: row.game,
        engine,
        hostSeatId: row.host_seat_id ?? engine.host,
        hostName: this.seatName(row.host_seat_id ?? engine.host),
        stake: row.stake,
        createdAt: row.created_at,
        ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
        openDeadlineAt: row.deadline_at ?? row.created_at + this.openMs,
        revision: row.revision,
        stateJson: row.state_json,
        frozen: false,
        autoSeats: new Set(
          (this.db.prepare(
            "SELECT seat_id FROM table_seats WHERE table_id = ? AND auto = 1 AND left_at IS NULL",
          ).all(row.id) as { seat_id: string }[]).map((entry) => entry.seat_id),
        ),
      };
      if (engine.status === 'open') {
        if (now >= live.openDeadlineAt) {
          this.abort(live, 'timeout', `${engine.label}桌 ${Math.round(this.openMs / 60_000)} 分钟没开局，已经收起来了。`);
          continue;
        }
        this.tables.set(live.id, live);
        continue;
      }
      if (downtime > this.recovery.maxDowntimeMs) {
        this.abort(live, 'offline',
          `${engine.label}桌因为服务停机超过 ${Math.round(this.recovery.maxDowntimeMs / 60_000)} 分钟，这局作废、押注退回。`);
        continue;
      }
      engine.rearm(now, downtime, this.recovery.minHumanMs);
      const revision = live.revision + 1;
      const stateJson = JSON.stringify(engine.exportState());
      live.revision = revision;
      live.stateJson = stateJson;
      this.tables.set(live.id, live);
      withTransaction(this.db, () => {
        this.db.prepare(
          `UPDATE tables SET revision = ?, state_json = ?, state_version = ?, engine_version = ?,
             deadline_at = ?, updated_at = ? WHERE id = ?`,
        ).run(
          revision, stateJson, engine.stateVersion, `${row.game}/${engine.stateVersion}`,
          this.deadlineOf(engine) ?? null, now, live.id,
        );
        this.appendTableEvent(live, {
          type: 'parlor.table.resume',
          scope: { kind: 'room' },
          text: `${engine.label}桌续上了：服务停了约 ${Math.max(1, Math.round(downtime / 1000))} 秒，牌和轮次都还在。`,
          data: { game: live.game, tableId: live.id, downtimeMs: downtime },
        }, now);
      });
    }
  }

  private abortRow(row: TableRow, reason: 'closed' | 'restart', text: string, now: number): void {
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
    withTransaction(this.db, () => {
      if (row.status !== 'open' && row.stake > 0) this.refund(stub, reason, now);
      this.markTableSeatsLeft(row.id, now);
      this.clearActivePlayers(row.id);
      this.updateTableRow(row.id, 'abandoned', now, { endedAt: now, endReason: reason });
      this.appendTableEvent(stub, {
        type: 'parlor.table.cancel',
        scope: { kind: 'room' },
        text,
        data: { game: row.game, tableId: row.id, reason },
      }, now);
    });
  }

  private freezeRow(row: TableRow, error: unknown, now: number): void {
    const message = (error as Error)?.message ?? String(error);
    console.error(`parlor: 牌桌 ${row.id} 恢复失败，已隔离`, message);
    withTransaction(this.db, () => {
      this.db.prepare('UPDATE tables SET frozen_at = ?, recovery_error = ? WHERE id = ?')
        .run(now, message.slice(0, 500), row.id);
      this.events.append(this.roomId, {
        type: 'parlor.table.frozen',
        ts: now,
        from: 'system',
        scope: { kind: 'room' },
        text: `${gameLabelOf(row.game)}桌的存档读不出来，已经被隔离；这副牌不会自动重发。`,
        data: { game: row.game, tableId: row.id },
      });
    });
  }

  private frozenTable(row: TableRow): LiveTable {
    return {
      id: row.id,
      game: row.game,
      engine: this.frozenStub(row),
      hostSeatId: row.host_seat_id ?? '',
      hostName: this.seatName(row.host_seat_id ?? ''),
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

  private hydrate(row: TableRow): TableEngine {
    const def = gameById(row.game);
    if (!def) throw new Error(`不认识的桌子类型：${row.game}`);
    const engine = def.create({
      host: { id: row.host_seat_id ?? '', name: this.seatName(row.host_seat_id ?? '') },
      now: row.created_at,
      ...(this.turnMs !== undefined ? { turnMs: this.turnMs } : {}),
    });
    if (row.state_version !== 0 && row.state_version !== engine.stateVersion) {
      throw new Error(`存档格式是 ${row.state_version}，这一版只认 ${engine.stateVersion}`);
    }
    engine.restoreState(JSON.parse(row.state_json ?? 'null'));
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

  private draft(table: LiveTable): TableEngine {
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

  private requireMyTable(cooId: string, tableId?: string): LiveTable {
    const mine = this.tableOf(cooId);
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

  private requireSeat(cooId: string): SeatRow {
    const seat = this.seats.activeSeat(cooId);
    if (!seat) throw new HostError('forbidden', '你不在这个客厅里');
    return seat;
  }

  private seatById(seatId: string): SeatRow | undefined {
    return this.seats.seats().find((seat) => seat.id === seatId);
  }

  private seatName(seatId: string): string {
    return this.seatById(seatId)?.name ?? '';
  }

  /** 开局那一刻的真人席位（脚本陪练不算；押注只收这些人）。 */
  private realPlayers(table: LiveTable): Array<{ seatId: string; cooId: string; name: string }> {
    const view = table.engine.public() as { seats?: Array<{ id?: unknown; name?: unknown }> };
    const names = new Map<string, string>();
    for (const seat of view.seats ?? []) {
      if (typeof seat.id === 'string' && typeof seat.name === 'string') names.set(seat.id, seat.name);
    }
    return this.tableSeatRows(table.id)
      .filter((row) => row.left_at === null && row.coo_id !== null)
      .map((row) => ({
        seatId: row.seat_id,
        cooId: row.coo_id!,
        name: names.get(row.seat_id) ?? this.seatById(row.seat_id)?.name ?? '席位',
      }));
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

  private finishReceipt(receipt: TableReceipt, engine: TableEngine): void {
    const deadline = this.deadlineOf(engine);
    const turnId = this.turnOf(engine);
    const publicView = engine.public() as { seats?: Array<{ id?: unknown; name?: unknown }> };
    const turnName = turnId ? publicView.seats?.find((seat) => seat.id === turnId)?.name : undefined;
    const seq = this.events.latest(this.roomId);
    receipt.seq = seq;
    receipt.ts = this.now();
    receipt.at = serverClock(receipt.ts);
    if (deadline) {
      receipt.deadline = deadline;
      receipt.deadlineAt = serverClock(deadline);
    }
    if (typeof turnName === 'string' && turnName) receipt.turn = turnName;
  }

  private replayReceipt(cooId: string, requestId: string | undefined, payload: unknown): TableReceipt | null {
    if (!requestId) return null;
    const row = this.db.prepare(
      'SELECT hash, receipt_json FROM action_receipts WHERE coo_id = ? AND request_id = ?',
    ).get(cooId, requestId) as { hash: string; receipt_json: string } | undefined;
    if (!row) return null;
    if (row.hash !== actionHash(payload)) {
      throw new HostError('conflict', '同一个 requestId 被用在了不同的动作上；换一个新的请求号');
    }
    return JSON.parse(row.receipt_json) as TableReceipt;
  }

  private storeReceipt(
    cooId: string,
    requestId: string | undefined,
    tableId: string | null,
    payload: unknown,
    receipt: TableReceipt,
    now: number,
  ): void {
    if (!requestId) return;
    this.db.prepare(
      `INSERT INTO action_receipts(coo_id, request_id, room_id, table_id, hash, receipt_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      cooId, requestId, this.roomId, tableId, actionHash(payload), JSON.stringify(receipt), now,
    );
  }

  private finalization(tableId: string): { kind: string } | undefined {
    return this.db.prepare('SELECT kind FROM table_finalizations WHERE table_id = ?')
      .get(tableId) as { kind: string } | undefined;
  }

  private insertBotSeats(table: LiveTable, engine: TableEngine, now: number): void {
    const view = engine.public() as { seats?: Array<{ id?: unknown; name?: unknown; bot?: unknown }> };
    let position = this.nextPosition(table.id);
    for (const seat of view.seats ?? []) {
      if (seat.bot !== true || typeof seat.id !== 'string') continue;
      this.db.prepare(
        `INSERT OR IGNORE INTO table_seats(table_id, room_id, seat_id, coo_id, position, is_bot, joined_at)
         VALUES (?, ?, ?, NULL, ?, 1, ?)`,
      ).run(table.id, this.roomId, seat.id, position, now);
      position += 1;
    }
  }

  private insertTableSeat(tableId: string, seatId: string, cooId: string, position: number, isBot: boolean, now: number): void {
    const exists = this.db.prepare(
      'SELECT 1 AS ok FROM table_seats WHERE table_id = ? AND seat_id = ?',
    ).get(tableId, seatId);
    if (exists) return;
    this.db.prepare(
      `INSERT INTO table_seats(table_id, room_id, seat_id, coo_id, position, is_bot, joined_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(tableId, this.roomId, seatId, cooId, position, isBot ? 1 : 0, now);
  }

  private nextPosition(tableId: string): number {
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(position), -1) AS top FROM table_seats WHERE table_id = ?',
    ).get(tableId) as { top: number };
    return row.top + 1;
  }

  private markTableSeatLeft(tableId: string, seatId: string, now: number): void {
    this.db.prepare(
      'UPDATE table_seats SET left_at = ? WHERE table_id = ? AND seat_id = ? AND left_at IS NULL',
    ).run(now, tableId, seatId);
  }

  private markTableSeatsLeft(tableId: string, now: number): void {
    this.db.prepare('UPDATE table_seats SET left_at = ? WHERE table_id = ? AND left_at IS NULL')
      .run(now, tableId);
  }

  private tableSeatRows(tableId: string): TableSeatRow[] {
    return this.db.prepare('SELECT * FROM table_seats WHERE table_id = ? ORDER BY position')
      .all(tableId) as unknown as TableSeatRow[];
  }

  private insertTableRow(table: LiveTable, status: string, now: number, stateJson: string): void {
    this.db.prepare(
      `INSERT INTO tables(id, room_id, room_epoch, game, status, host_seat_id, stake, state_json,
         engine_version, turn_seq, revision, state_version, deadline_at, created_at, started_at,
         ended_at, end_reason, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, NULL, NULL, NULL, ?)`,
    ).run(
      table.id,
      this.roomId,
      this.roomEpoch(),
      table.game,
      status,
      table.hostSeatId,
      table.stake,
      stateJson,
      `${table.game}/${table.engine.stateVersion}`,
      table.revision,
      table.engine.stateVersion,
      now,
      now,
    );
  }

  private updateTableState(
    tableId: string,
    engine: TableEngine,
    revision: number,
    stateJson: string,
    now: number,
    extra: { startedAt?: number; endedAt?: number },
  ): void {
    this.db.prepare(
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
      this.deadlineOf(engine) ?? null,
      now,
      extra.startedAt ?? null,
      extra.endedAt ?? null,
      tableId,
    );
  }

  private updateTableRow(
    tableId: string,
    status: string,
    now: number,
    extra: { startedAt?: number; endedAt?: number; endReason?: string } = {},
  ): void {
    this.db.prepare(
      `UPDATE tables SET status = ?, updated_at = ?,
         started_at = COALESCE(?, started_at),
         ended_at = COALESCE(?, ended_at),
         end_reason = COALESCE(?, end_reason)
       WHERE id = ?`,
    ).run(status, now, extra.startedAt ?? null, extra.endedAt ?? null, extra.endReason ?? null, tableId);
  }

  /** 健康心跳：只在开桌事务里写一次，避免「刚开桌就崩」被算成长停机。 */
  private markHealthy(now: number): void {
    this.db.prepare(
      `INSERT INTO meta(key, value) VALUES('last_healthy_at', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(now));
  }

  private insertActivePlayer(cooId: string, tableId: string, now: number): void {
    this.db.prepare(
      `INSERT INTO active_table_players(coo_id, table_id, room_id, joined_at)
       VALUES (?, ?, ?, ?)`,
    ).run(cooId, tableId, this.roomId, now);
  }

  private removeActivePlayer(cooId: string): void {
    this.db.prepare('DELETE FROM active_table_players WHERE coo_id = ?').run(cooId);
  }

  private clearActivePlayers(tableId: string): void {
    this.db.prepare('DELETE FROM active_table_players WHERE table_id = ?').run(tableId);
  }

  private roomEpoch(): string {
    const row = this.db.prepare('SELECT epoch FROM rooms WHERE id = ?').get(this.roomId) as { epoch: string } | undefined;
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
