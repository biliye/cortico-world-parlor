/** 牌桌结算、作废与终态幂等记录：从 table-host.ts 拆出的终局账本与清理逻辑。 */
import { withTransaction, type Db } from './db.ts';
import { gameById } from './games/registry.ts';
import type { LedgerDb } from './ledger-db.ts';
import type { MailDb } from './mail-db.ts';
import type { RoomEvent } from './protocol.ts';
import type { SeatRow } from './room-seat-db.ts';
import type { TableEngine, TableEvent, TableSeatResult } from './table-engine.ts';
import { validSeatResults, writeSeatResults } from './table-results.ts';

export interface LiveTable {
  id: string;
  game: string;
  engine: TableEngine;
  hostSeatId: string;
  hostName: string;
  createdAt: number;
  startedAt?: number;
  openDeadlineAt: number;
  revision: number;
  stateJson: string;
  frozen: boolean;
  /** 被托管（移除/掉线）的席位：轮到他们时脚本代打，不占他们的截止时间。 */
  autoSeats: Set<string>;
}

export interface TableRow {
  id: string;
  room_id: string;
  game: string;
  status: string;
  host_seat_id: string | null;
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

export interface TableSeatRow {
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

export interface TableSettlementDeps {
  db: Db;
  roomId: string;
  ledger: LedgerDb;
  mail: MailDb;
  now: () => number;
  onTableResult?: (game: string) => void;
  finalization(tableId: string): Promise<{ kind: string } | undefined>;
  tableSeatRows(tableId: string): Promise<TableSeatRow[]>;
  seatById(seatId: string): Promise<SeatRow | undefined>;
  markTableSeatsLeft(tableId: string, now: number): Promise<void>;
  clearActivePlayers(tableId: string): Promise<void>;
  updateTableRow(tableId: string, status: string, now: number, extra?: { startedAt?: number; endedAt?: number; endReason?: string }): Promise<void>;
  appendTableEvent(table: LiveTable, event: TableEvent, now: number): Promise<RoomEvent>;
  removeTableFromCache(tableId: string): void;
}

/**
 * 一局结束：写公开战绩，并按本局引擎保留的参赛席位落逐席结果。
 * 终态只写一次（`table_finalizations`），正常结算与作废退款互斥。
 */
export async function settleTable(
  deps: TableSettlementDeps,
  table: LiveTable,
  engine: TableEngine,
  event: TableEvent,
  seatResults: readonly TableSeatResult[] | null | undefined,
  now: number,
): Promise<void> {
  if (await deps.finalization(table.id)) return;
  const allSeats = await deps.tableSeatRows(table.id);
  const rows = allSeats.filter((row) => row.left_at === null && row.coo_id !== null);
  const participants = [...new Set(rows.map((row) => row.coo_id!))];
  const seatToCoo = new Map(rows.map((row) => [row.seat_id, row.coo_id!]));
  const data = event.data ?? {};
  const winnerSeatIds = Array.isArray(data.winners)
    ? data.winners.filter((id): id is string => typeof id === 'string')
    : [];
  const winners = [...new Set(winnerSeatIds.map((id) => seatToCoo.get(id)).filter((id): id is string => !!id))];
  const landlordId = typeof data.landlord === 'string' ? data.landlord : undefined;
  const landlordName = landlordId === undefined ? undefined : (await deps.seatById(landlordId))?.name;
  const entry = await deps.ledger.record({
    kind: 'game',
    room: deps.roomId,
    from: 'room',
    effectId: `${table.id}/result`,
    game: table.engine.game,
    participants,
    winners,
    text: event.text,
    visibility: 'room',
    data: {
      game: table.engine.game,
      gameLabel: table.engine.label,
      tableId: table.id,
      tie: data.tie === true,
      ...(typeof data.multiplier === 'number' ? { multiplier: data.multiplier } : {}),
      ...(data.spring === true ? { spring: true } : {}),
      ...(data.antiSpring === true ? { antiSpring: true } : {}),
      ...(landlordId !== undefined ? { landlord: landlordName } : {}),
    },
  });
  const game = gameById(table.game);
  const eligibleForRating = game?.rated === true && !event.ratingExcluded;
  const rankedSeats = eligibleForRating && validSeatResults(seatResults, engine.seatIds(), winnerSeatIds, data.tie === true, game.ratingOrder)
    ? seatResults : null;
  const ratingSkipped = eligibleForRating && !rankedSeats
    ? (seatResults?.length ? 'invalid_seat_results' : 'missing_seat_results') : undefined;
  // 终态表靠主键挡第二次结算；写入保持普通 INSERT，冲突就是要它抛。
  await deps.db.prepare(
    `INSERT INTO table_finalizations(table_id, kind, entry_id, at, payload_json)
     VALUES (?, 'result', ?, ?, ?)`,
  ).run(table.id, entry.id, now, JSON.stringify({
    winners, participants,
    ...(event.ratingExcluded ? { ratingExcluded: true } : {}),
    ...(ratingSkipped ? { ratingSkipped } : {}),
  }));
  if (rankedSeats) {
    await writeSeatResults(deps.db, table.id, table.game, allSeats, rankedSeats, now);
    deps.db.afterCommit(() => deps.onTableResult?.(table.game));
  } else if (ratingSkipped) {
    deps.db.afterCommit(() => console.error('parlor: 等级分赛果缺失或不一致', table.game, table.id));
  }
  if (deps.db.kind === 'postgres') {
    await deps.db.prepare(`UPDATE room_seats SET business_active_at=? WHERE room_id=? AND coo_id IN
      (SELECT coo_id FROM table_seats WHERE table_id=? AND coo_id IS NOT NULL) AND released_at IS NULL`).run(now, deps.roomId, table.id);
  }
  if (table.engine.offlineReminder) await deps.mail.readAllTableReminders(deps.roomId, table.id, now);
  await deps.markTableSeatsLeft(table.id, now);
  await deps.clearActivePlayers(table.id);
}

/** 开桌超时/引擎出错/长停机：整桌作废，只留一条终态。 */
export async function abortTable(
  deps: TableSettlementDeps,
  table: LiveTable,
  reason: 'timeout' | 'error' | 'offline' | 'restart',
  text: string,
): Promise<void> {
  const now = deps.now();
  await withTransaction(deps.db, async () => {
    if (table.engine.status !== 'open') await recordTableRefund(deps, table, reason, now);
    if (table.engine.offlineReminder) await deps.mail.readAllTableReminders(deps.roomId, table.id, now);
    await deps.markTableSeatsLeft(table.id, now);
    await deps.clearActivePlayers(table.id);
    await deps.updateTableRow(table.id, 'abandoned', now, { endedAt: now, endReason: reason });
    await deps.appendTableEvent(table, {
      type: 'parlor.table.cancel',
      scope: { kind: 'room' },
      text,
      data: { game: table.game, tableId: table.id, reason },
    }, now);
  });
  deps.db.afterCommit(() => { deps.removeTableFromCache(table.id); });
}

/**
 * 牌桌作废：只留一个终态标记，免得以后被当成「还没结算」。
 * 0.38.0 起没有押注，也就不再有退款与退注通知——作废只是这局不算数。
 */
export async function recordTableRefund(
  deps: Pick<TableSettlementDeps, 'db' | 'finalization'>,
  table: { id: string },
  reason: string,
  now: number,
): Promise<void> {
  if (await deps.finalization(table.id)) return;
  await deps.db.prepare(
    `INSERT INTO table_finalizations(table_id, kind, entry_id, at, payload_json)
     VALUES (?, 'refund', NULL, ?, ?)`,
  ).run(table.id, now, JSON.stringify({ reason }));
}
