/**
 * 一个客厅的牌桌运行时。
 *
 * 一房一桌；规则、发牌与隐藏信息都在 games/ 里，这一层负责：
 * - 开桌/坐下/开始/动作/超时/收桌，以及 `tables`/`table_seats` 的落库；
 * - 把引擎事件写进客厅事件流：公开事件走 room scope，私视图走 seat scope 的
 *   `parlor.table.turn`（`event_audience` 按 cooId 授权）；
 * - 押注与结算走全局账本（`LedgerDb`，effectId 幂等）；
 * - 游戏锁：坐在未结束的牌桌上时不能离厅/换房（调用方先问 `lockOf`）。
 *
 * 引擎只在内存里：进程重启后，还挂着的桌子由 `recoverStaleTables` 统一作废，
 * 已收的押注原路退回，并留一条公开事件与每人的信；不会悄悄把底池吃掉。
 */
import { randomUUID } from 'node:crypto';
import { withTransaction, type Db } from './db.ts';
import { EventDb } from './event-db.ts';
import { HostError } from './host-error.ts';
import { LedgerDb } from './ledger-db.ts';
import { MAX_CHIPS, type LedgerEntry } from './ledger.ts';
import { MailDb } from './mail-db.ts';
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

export interface TableHostOptions {
  db: Db;
  roomId: string;
  now?: () => number;
  /** 骰子每手时限（测试里调短）；斗地主一手固定 60 秒。 */
  turnMs?: number;
  /** 开桌后多久没开局自动收起。 */
  openMs?: number;
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
  stake: number;
  createdAt: number;
  startedAt?: number;
  openDeadlineAt: number;
}

interface TableRow {
  id: string;
  room_id: string;
  game: string;
  status: string;
  host_seat_id: string | null;
  stake: number;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
}

interface TableSeatRow {
  table_id: string;
  room_id: string;
  seat_id: string;
  coo_id: string | null;
  position: number;
  is_bot: number;
  joined_at: number;
  left_at: number | null;
}

export interface TableReceipt {
  deadline?: number;
  turn?: string;
}

export interface StartReceipt extends TableReceipt {
  seats: string[];
}

export interface TableOpenResult {
  tableId: string;
  event: RoomEvent;
}

export interface TableLeaveResult {
  event: RoomEvent;
  /** 开桌的人收桌：整张桌子一起结束。 */
  closed: boolean;
}

export interface TableLockInfo {
  tableId: string;
  game: string;
  label: string;
  status: TableStatus;
  hostSeatId: string;
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
  private live?: LiveTable;

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
    this.recoverStaleTables();
  }

  /** 当前这张桌子（含已经结束、还没开下一张的）。 */
  current(): LiveTable | undefined {
    return this.live;
  }

  /** 这个 coo 是否被一张未结束的牌桌锁住。 */
  lockOf(cooId: string): TableLockInfo | null {
    const table = this.live;
    if (!table || table.engine.status === 'ended') return null;
    const seat = this.seats.activeSeat(cooId);
    if (!seat || !table.engine.has(seat.id)) return null;
    return {
      tableId: table.id,
      game: table.engine.game,
      label: table.engine.label,
      status: table.engine.status,
      hostSeatId: table.hostSeatId,
    };
  }

  open(cooId: string, input: { game?: string; stake?: unknown }): TableOpenResult {
    const seat = this.requireSeat(cooId);
    if (seat.kind === 'observer') throw new HostError('forbidden', '观看者不能开桌');
    if (this.live && this.live.engine.status !== 'ended') {
      throw new HostError('conflict', '已经有一张桌子了');
    }
    const id = input.game ?? 'dice';
    const def = gameById(id);
    if (!def) {
      throw new HostError('invalid', `不认识的桌子：现在有 ${gameIds().join(' / ')}`);
    }
    const stake = stakeOf(input.stake);
    if (stake > 0 && this.ledger.balanceOf(cooId) < stake) {
      throw new HostError('invalid', `你只有 ${this.ledger.balanceOf(cooId)} 枚筹码，押不起 ${stake} 枚`);
    }
    const now = this.now();
    const engine = def.create({
      host: { id: seat.id, name: seat.name },
      now,
      ...(this.turnMs !== undefined ? { turnMs: this.turnMs } : {}),
    });
    const table: LiveTable = {
      id: `t-${randomUUID()}`,
      game: def.id,
      engine,
      hostSeatId: seat.id,
      stake,
      createdAt: now,
      openDeadlineAt: now + this.openMs,
    };

    const event = withTransaction(this.db, () => {
      this.insertTableRow(table, 'open', now);
      this.insertTableSeat(table.id, seat.id, cooId, 0, false, now);
      const appended = this.events.append(this.roomId, {
        type: 'parlor.table.open',
        ts: now,
        from: 'system',
        scope: { kind: 'room' },
        text: `${seat.name} 开了一张${def.label}桌${stake > 0 ? `（每人押 ${stake} 枚筹码）` : ''}。`,
        data: { game: def.id, stake, tableId: table.id },
      });
      return appended;
    });
    this.live = table;
    return { tableId: table.id, event };
  }

  join(cooId: string): RoomEvent {
    const table = this.requireLive();
    const seat = this.requireSeat(cooId);
    if (seat.kind === 'observer') throw new HostError('forbidden', '观看者不能上桌');
    if (table.stake > 0 && this.ledger.balanceOf(cooId) < table.stake) {
      throw new HostError('invalid', `这张桌子每人押 ${table.stake} 枚，你只有 ${this.ledger.balanceOf(cooId)} 枚`);
    }
    const now = this.now();
    return withTransaction(this.db, () => {
      let event: TableEvent;
      try {
        event = table.engine.join({ id: seat.id, name: seat.name });
      } catch (error) {
        return asHostError(error);
      }
      this.insertTableSeat(table.id, seat.id, cooId, this.nextPosition(table.id), false, now);
      this.touch(table);
      return this.events.append(this.roomId, {
        type: event.type,
        ts: now,
        from: 'system',
        scope: event.scope,
        text: event.text,
        ...(event.data ? { data: event.data } : {}),
      });
    });
  }

  /** 未开局时离桌；开桌的人离桌等于收掉整张桌子。 */
  leave(cooId: string): TableLeaveResult {
    const table = this.requireLive();
    const seat = this.requireSeat(cooId);
    if (table.engine.status !== 'open') {
      throw new HostError('conflict', '牌局已经开始了，不能退桌');
    }
    if (!table.engine.has(seat.id)) throw new HostError('forbidden', '你不在这一桌');
    const now = this.now();
    const closing = seat.id === table.hostSeatId;
    const event = withTransaction(this.db, () => {
      if (closing) {
        this.markTableSeatsLeft(table.id, now);
        this.updateTableRow(table.id, 'abandoned', now, { endedAt: now, endReason: 'closed' });
        this.live = undefined;
        return this.events.append(this.roomId, {
          type: 'parlor.table.cancel',
          ts: now,
          from: 'system',
          scope: { kind: 'room' },
          text: `${seat.name} 把${table.engine.label}桌收起来了。`,
          data: { game: table.game, tableId: table.id },
        });
      }
      let left: TableEvent;
      try {
        left = table.engine.leave(seat.id);
      } catch (error) {
        return asHostError(error);
      }
      this.markTableSeatLeft(table.id, seat.id, now);
      this.touch(table);
      return this.events.append(this.roomId, {
        type: left.type,
        ts: now,
        from: 'system',
        scope: left.scope,
        text: left.text,
        ...(left.data ? { data: left.data } : {}),
      });
    });
    return { event, closed: closing };
  }

  start(cooId: string): StartReceipt {
    const table = this.requireLive();
    const seat = this.requireSeat(cooId);
    if (seat.id !== table.hostSeatId) throw new HostError('forbidden', '只有开桌的人可以开始');
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
    return withTransaction(this.db, () => {
      let step: TableStep;
      try {
        step = table.engine.start(seat.id, now);
      } catch (error) {
        return asHostError(error);
      }
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
          transfers: players.map((player) => ({ from: player.cooId, to: 'room', amount: table.stake })),
          data: { game: table.engine.game, gameLabel: table.engine.label, stake: table.stake, pot },
        });
      }
      table.startedAt = now;
      this.insertBotSeats(table, now);
      this.recordStep(table, step, now);
      this.updateTableRow(table.id, table.engine.status, now, { startedAt: now, deadlineAt: this.deadlineOf(table) });
      return { seats: this.roster(table), ...this.receipt(table) };
    });
  }

  act(cooId: string, action: unknown): TableReceipt {
    const table = this.requireLive();
    const seat = this.requireSeat(cooId);
    const now = this.now();
    return withTransaction(this.db, () => {
      let step: TableStep;
      try {
        step = table.engine.act(seat.id, action, now);
      } catch (error) {
        return asHostError(error);
      }
      this.recordStep(table, step, now);
      this.updateTableRow(table.id, table.engine.status, now, {
        deadlineAt: this.deadlineOf(table),
        ...(step.ended ? { endedAt: now, endReason: 'finished' } : {}),
      });
      return this.receipt(table);
    });
  }

  /** 每秒由网关调用：开桌超时收起；牌局超时代打/结算。 */
  tick(): void {
    const table = this.live;
    if (!table) return;
    const now = this.now();
    if (table.engine.status === 'open') {
      if (now < table.openDeadlineAt) return;
      this.abort(table, 'timeout', `${table.engine.label}桌 ${Math.round(this.openMs / 60_000)} 分钟没开局，已经收起来了。`);
      return;
    }
    if (table.engine.status !== 'playing' && table.engine.status !== 'bidding') return;
    let step: TableStep | null;
    try {
      step = table.engine.tick(now);
    } catch (error) {
      // 长局里一次代打抛错不能把客厅锁死：整桌作废并退回押注，让人看得见。
      console.error('parlor: 牌桌超时代打失败', error);
      this.abort(table, 'error', `${table.engine.label}桌推进出错，这局作废。`);
      return;
    }
    if (!step) return;
    withTransaction(this.db, () => {
      this.recordStep(table, step, now);
      this.updateTableRow(table.id, table.engine.status, now, {
        deadlineAt: this.deadlineOf(table),
        ...(step.ended ? { endedAt: now, endReason: 'finished' } : {}),
      });
    });
  }

  /** 桌内说话：只给那一刻坐在桌上的人（和回放）看。 */
  say(cooId: string, text: string): RoomEvent {
    const table = this.requireLive();
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

  public(): TableSummary | undefined {
    const table = this.live;
    if (!table) return undefined;
    return {
      ...(table.engine.public() as Record<string, unknown>),
      game: table.engine.game,
      label: table.engine.label,
      status: table.engine.status,
      host: table.engine.host,
      ...(table.stake > 0 ? { stake: table.stake } : {}),
      text: table.engine.publicText(),
    } as TableSummary;
  }

  private(seatId: string): TablePrivateSummary | null {
    const table = this.live;
    if (!table) return null;
    const text = table.engine.privateText(seatId, this.now());
    if (!text) return null;
    return {
      ...(table.engine.view(seatId) as Record<string, unknown>),
      game: table.engine.game,
      seat: seatId,
      text,
    } as TablePrivateSummary;
  }

  private requireLive(): LiveTable {
    if (!this.live) throw new HostError('not_found', '现在没有桌子');
    return this.live;
  }

  private requireSeat(cooId: string): SeatRow {
    const seat = this.seats.activeSeat(cooId);
    if (!seat) throw new HostError('forbidden', '你不在这个客厅里');
    return seat;
  }

  private seatById(seatId: string): SeatRow | undefined {
    return this.seats.seats().find((seat) => seat.id === seatId);
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

  private roster(table: LiveTable): string[] {
    const view = table.engine.public() as { seats?: Array<{ name?: unknown; bot?: unknown }> };
    return (view.seats ?? []).map((seat) => (
      typeof seat.name === 'string' ? (seat.bot === true ? `${seat.name}（脚本）` : seat.name) : '？'
    ));
  }

  private receipt(table: LiveTable): TableReceipt {
    const view = table.engine.public() as {
      deadline?: unknown;
      turn?: unknown;
      seats?: Array<{ id?: unknown; name?: unknown }>;
    };
    const deadline = typeof view.deadline === 'number' && view.deadline > 0 ? view.deadline : undefined;
    const turnId = typeof view.turn === 'string' ? view.turn : undefined;
    const name = turnId ? view.seats?.find((seat) => seat.id === turnId)?.name : undefined;
    return {
      ...(deadline ? { deadline } : {}),
      ...(typeof name === 'string' && name ? { turn: name } : {}),
    };
  }

  private deadlineOf(table: LiveTable): number | undefined {
    const deadline = (table.engine.public() as { deadline?: unknown }).deadline;
    return typeof deadline === 'number' && deadline > 0 ? deadline : undefined;
  }

  /** 把一步引擎结果写进事件流：公开事件 + 每个席位的私视图；结束时结算。 */
  private recordStep(table: LiveTable, step: TableStep, now: number): void {
    let ended: TableEvent | undefined;
    for (const event of step.events) {
      this.events.append(this.roomId, {
        type: event.type,
        ts: now,
        from: 'system',
        scope: event.scope,
        text: event.text,
        ...(event.data ? { data: event.data } : {}),
      });
      if (event.type === 'parlor.table.end') ended = event;
    }
    for (const seatId of step.views) {
      // 脚本陪练不是房间席位：它们的视图不进事件流。
      if (!this.seatById(seatId)) continue;
      const view = table.engine.view(seatId);
      const text = table.engine.privateText(seatId, now);
      if (!view || !text) continue;
      this.events.append(this.roomId, {
        type: 'parlor.table.turn',
        ts: now,
        from: 'system',
        scope: { kind: 'seat', seatId },
        text,
        data: { table: view },
      });
    }
    if (ended) this.settle(table, ended, now);
    this.touch(table);
  }

  /**
   * 一局结束：按开局时记下的真人席位写一条公开战绩并分底池。
   * 机器人不进账本；没人赢（理论上骰子不会）就原路退回。
   */
  private settle(table: LiveTable, event: TableEvent, now: number): void {
    const rows = this.tableSeatRows(table.id).filter((row) => row.left_at === null && row.coo_id !== null);
    if (rows.length === 0) return;
    const seatToCoo = new Map(rows.map((row) => [row.seat_id, row.coo_id!]));
    const participants = [...new Set(rows.map((row) => row.coo_id!))];
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
    this.ledger.record({
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
    // 结束的桌子留着（快照/网页还要看结果）；下一次 open 会把它换掉。
    void now;
  }

  /** 开局后引擎可能补进脚本陪练；只写 table_seats，不写房间席位。 */
  private insertBotSeats(table: LiveTable, now: number): void {
    const view = table.engine.public() as { seats?: Array<{ id?: unknown; name?: unknown; bot?: unknown }> };
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

  /** 开桌/加入时记下席位；coo_id 是结算与退注的依据。 */
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

  private insertTableRow(table: LiveTable, status: string, now: number): void {
    this.db.prepare(
      `INSERT INTO tables(id, room_id, room_epoch, game, status, host_seat_id, stake, turn_seq,
         deadline_at, created_at, started_at, ended_at, end_reason, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL, NULL, NULL, ?)`,
    ).run(
      table.id,
      this.roomId,
      this.roomEpoch(),
      table.game,
      status,
      table.hostSeatId,
      table.stake,
      now,
      now,
    );
  }

  private updateTableRow(
    tableId: string,
    status: string,
    now: number,
    extra: { startedAt?: number; endedAt?: number; endReason?: string; deadlineAt?: number } = {},
  ): void {
    this.db.prepare(
      `UPDATE tables SET status = ?, updated_at = ?,
         started_at = COALESCE(?, started_at),
         ended_at = COALESCE(?, ended_at),
         end_reason = COALESCE(?, end_reason),
         deadline_at = ?
       WHERE id = ?`,
    ).run(
      status,
      now,
      extra.startedAt ?? null,
      extra.endedAt ?? null,
      extra.endReason ?? null,
      extra.deadlineAt ?? null,
      tableId,
    );
  }

  private touch(table: LiveTable): void {
    this.db.prepare('UPDATE tables SET updated_at = ? WHERE id = ?').run(this.now(), table.id);
  }

  private roomEpoch(): string {
    const row = this.db.prepare('SELECT epoch FROM rooms WHERE id = ?').get(this.roomId) as { epoch: string } | undefined;
    return row?.epoch ?? '';
  }

  /** 开桌超时/引擎出错：整桌作废；已经收过押注的原路退回。 */
  private abort(table: LiveTable, reason: 'timeout' | 'error', text: string): void {
    const now = this.now();
    withTransaction(this.db, () => {
      if (table.startedAt !== undefined && table.stake > 0) this.refund(table, reason, now);
      this.markTableSeatsLeft(table.id, now);
      this.updateTableRow(table.id, 'abandoned', now, { endedAt: now, endReason: reason });
      this.events.append(this.roomId, {
        type: 'parlor.table.cancel',
        ts: now,
        from: 'system',
        scope: { kind: 'room' },
        text,
        data: { game: table.game, tableId: table.id, reason },
      });
    });
    this.live = undefined;
  }

  /** 押注原路退回（effectId 幂等；重启后恢复也走这一条）。 */
  private refund(table: { id: string; game: string; engine: TableEngine; stake: number }, reason: string, now: number): void {
    const rows = this.db.prepare(
      'SELECT * FROM table_seats WHERE table_id = ? AND is_bot = 0 AND coo_id IS NOT NULL AND left_at IS NULL',
    ).all(table.id) as unknown as TableSeatRow[];
    const participants = [...new Set(rows.map((row) => row.coo_id!))];
    if (participants.length === 0 || table.stake <= 0) return;
    let entry: LedgerEntry;
    try {
      entry = this.ledger.record({
        kind: 'note',
        room: this.roomId,
        from: 'room',
        effectId: `${table.id}/refund`,
        participants,
        text: `牌桌作废，每人退回 ${table.stake} 枚筹码。`,
        visibility: 'room',
        transfers: participants.map((cooId) => ({ from: 'room', to: cooId, amount: table.stake })),
        data: { game: table.game, gameLabel: table.engine.label, stake: table.stake, reason },
      });
    } catch (error) {
      console.error('parlor: 押注退回失败', error);
      return;
    }
    for (const cooId of participants) {
      try {
        this.mail.appendOnce(`${table.id}/refund/${cooId}`, {
          room: this.roomId,
          to: cooId,
          kind: 'ledger',
          action: 'refund',
          fromName: '客厅',
          text: `${table.engine.label}桌作废了，押的 ${table.stake} 枚筹码已经退回。`,
          ...(entry.id ? { entryId: entry.id } : {}),
        });
      } catch (error) {
        console.error('parlor: 退注通知没写进信箱', error);
      }
    }
    void now;
  }

  /**
   * 进程重启后还挂着 open/bidding/playing 的桌子：这一进程已经没有引擎，
   * 一律作废；开过局的退押注。只在这个客厅第一次被访问时跑一次。
   */
  private recoverStaleTables(): void {
    const rows = this.db.prepare(
      `SELECT * FROM tables WHERE room_id = ? AND status IN ('open','bidding','playing') ORDER BY created_at`,
    ).all(this.roomId) as unknown as TableRow[];
    if (rows.length === 0) return;
    const now = this.now();
    for (const row of rows) {
      try {
        withTransaction(this.db, () => {
          if (row.status !== 'open' && row.stake > 0) {
            const stub = {
              id: row.id,
              game: row.game,
              stake: row.stake,
              engine: { label: gameLabelOf(row.game) } as TableEngine,
            };
            this.refund(stub, 'restart', now);
          }
          this.markTableSeatsLeft(row.id, now);
          this.updateTableRow(row.id, 'abandoned', now, { endedAt: now, endReason: 'restart' });
          this.events.append(this.roomId, {
            type: 'parlor.table.cancel',
            ts: now,
            from: 'system',
            scope: { kind: 'room' },
            text: '服务重启了，上一局牌桌作废。',
            data: { game: row.game, tableId: row.id, reason: 'restart' },
          });
        });
      } catch (error) {
        console.error('parlor: 作废旧牌桌失败', error);
      }
    }
  }
}
