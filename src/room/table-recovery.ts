/** 牌桌启动恢复、快照水化与坏存档隔离：从 table-host.ts 拆出的恢复逻辑。 */
import { withTransaction, type Db } from './db.ts';
import type { EventDb } from './event-db.ts';
import { gameById, gameLabelOf } from './games/registry.ts';
import type { MailDb } from './mail-db.ts';
import type { RoomEvent } from './protocol.ts';
import { jsonValue } from './storage/json.ts';
import type { TableEngine, TableEvent, TableStatus } from './table-engine.ts';
import { recordTableRefund, type LiveTable, type TableRow, type TableSettlementDeps } from './table-settlement.ts';

/**
 * 快照列的统一形状：SQLite 的 TEXT 读出来是字符串，PostgreSQL 的 JSONB 读出来是对象。
 * 内存缓存按旧约定一律存文本，两种后端写回时都认。
 */
export const stateTextOf = (raw: unknown): string => (
  typeof raw === 'string' ? raw : JSON.stringify(jsonValue<unknown>(raw, null))
);

export interface TableRecoveryDeps extends TableSettlementDeps {
  events: EventDb;
  tables: Map<string, LiveTable>;
  openMs: number;
  turnMs?: number;
  recovery: { lastHealthyAt?: number; maxDowntimeMs: number; minHumanMs: number };
  seatName(seatId: string): Promise<string>;
  withCurrentNames(engine: TableEngine): Promise<TableEngine>;
  deadlineOf(engine: TableEngine): number | undefined;
  abort(table: LiveTable, reason: 'timeout' | 'error' | 'offline' | 'restart', text: string): Promise<void>;
}

/** 已隔离的桌：只用来列出来给人看，任何动作都拒绝。 */
export function createFrozenStub(row: TableRow): TableEngine {
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

export async function hydrateTableRow(
  deps: Pick<TableRecoveryDeps, 'turnMs' | 'seatName' | 'withCurrentNames'>,
  row: TableRow,
): Promise<TableEngine> {
  const def = gameById(row.game);
  if (!def) throw new Error(`不认识的桌子类型：${row.game}`);
  const engine = def.create({
    host: { id: row.host_seat_id ?? '', name: await deps.seatName(row.host_seat_id ?? '') },
    now: row.created_at,
    ...(deps.turnMs !== undefined ? { turnMs: deps.turnMs } : {}),
  });
  if (row.state_version !== 0 && row.state_version !== engine.stateVersion) {
    throw new Error(`存档格式是 ${row.state_version}，这一版只认 ${engine.stateVersion}`);
  }
  engine.restoreState(jsonValue(row.state_json, null));
  return deps.withCurrentNames(engine);
}

async function buildFrozenTable(deps: Pick<TableRecoveryDeps, 'seatName'>, row: TableRow): Promise<LiveTable> {
  return {
    id: row.id,
    game: row.game,
    engine: createFrozenStub(row),
    hostSeatId: row.host_seat_id ?? '',
    hostName: await deps.seatName(row.host_seat_id ?? ''),
    createdAt: row.created_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    openDeadlineAt: 0,
    revision: row.revision,
    stateJson: '',
    frozen: true,
    autoSeats: new Set(),
  };
}

async function abortUnrecoverableRow(
  deps: TableRecoveryDeps,
  row: TableRow,
  reason: 'closed' | 'restart',
  text: string,
  now: number,
): Promise<void> {
  const stub: LiveTable = {
    id: row.id,
    game: row.game,
    engine: { label: gameLabelOf(row.game) } as TableEngine,
    hostSeatId: row.host_seat_id ?? '',
    hostName: '',
    createdAt: row.created_at,
    openDeadlineAt: 0,
    revision: row.revision,
    stateJson: '',
    frozen: false,
    autoSeats: new Set(),
  };
  await withTransaction(deps.db, async () => {
    if (row.status !== 'open') await recordTableRefund(deps, stub, reason, now);
    if (row.status !== 'open') await deps.mail.readAllTableReminders(deps.roomId, row.id, now);
    await deps.markTableSeatsLeft(row.id, now);
    await deps.clearActivePlayers(row.id);
    await deps.updateTableRow(row.id, 'abandoned', now, { endedAt: now, endReason: reason });
    await deps.appendTableEvent(stub, {
      type: 'parlor.table.cancel',
      scope: { kind: 'room' },
      text,
      data: { game: row.game, tableId: row.id, reason },
    }, now);
  });
}

async function freezeCorruptRow(
  deps: Pick<TableRecoveryDeps, 'db' | 'roomId' | 'mail' | 'events'>,
  row: TableRow,
  error: unknown,
  now: number,
): Promise<void> {
  const message = (error as Error)?.message ?? String(error);
  console.error(`parlor: 牌桌 ${row.id} 恢复失败，已隔离`, message);
  await withTransaction(deps.db, async () => {
    await deps.db.prepare('UPDATE tables SET frozen_at = ?, recovery_error = ? WHERE id = ?')
      .run(now, message.slice(0, 500), row.id);
    await deps.mail.readAllTableReminders(deps.roomId, row.id, now);
    await deps.events.append(deps.roomId, {
      type: 'parlor.table.frozen',
      ts: now,
      from: 'system',
      scope: { kind: 'room' },
      text: `${gameLabelOf(row.game)}桌的存档读不出来，已经被隔离；这副牌不会自动重发。`,
      data: { game: row.game, tableId: row.id },
    });
  });
}

/**
 * 进程启动后还挂着 open/bidding/playing 的桌子：
 * - 读得懂快照：短停机把截止时刻搬到现在；超过 30 分钟作废退款；
 * - 读不懂/版本不认识：只隔离这一桌，不猜、不重发牌；
 * - 第一版（0.25.0）的旧桌没有快照：作废退款（升级时要先排空旧牌局）。
 */
export async function recoverRoomTables(deps: TableRecoveryDeps): Promise<void> {
  const now = deps.now();
  // 最近结束的一桌也装回来：进程重启后网页还要看结果页。
  const ended = await deps.db.prepare(
    `SELECT * FROM tables WHERE room_id = ? AND status = 'ended' AND state_json IS NOT NULL
      ORDER BY ended_at DESC NULLS LAST, created_at DESC LIMIT 1`,
  ).get(deps.roomId) as TableRow | undefined;
  if (ended) {
    try {
      const engine = await hydrateTableRow(deps, ended);
      deps.tables.set(ended.id, {
        id: ended.id,
        game: ended.game,
        engine,
        hostSeatId: ended.host_seat_id ?? engine.host,
        hostName: await deps.seatName(ended.host_seat_id ?? engine.host),
        createdAt: ended.created_at,
        ...(ended.started_at !== null ? { startedAt: ended.started_at } : {}),
        openDeadlineAt: ended.deadline_at ?? ended.created_at + deps.openMs,
        revision: ended.revision,
        stateJson: stateTextOf(ended.state_json),
        frozen: false,
        autoSeats: new Set(),
      });
    } catch (error) {
      console.error('parlor: 最近结束的牌桌读不回来（只影响结果页）', error);
    }
  }
  const rows = await deps.db.prepare(
    `SELECT * FROM tables WHERE room_id = ? AND status IN ('open','bidding','playing') ORDER BY created_at`,
  ).all(deps.roomId) as unknown as TableRow[];
  for (const row of rows) {
    if (row.frozen_at === null) continue;
    deps.tables.set(row.id, await buildFrozenTable(deps, row));
  }
  if (rows.length === 0) return;
  const newest = rows.reduce((max, row) => Math.max(max, row.updated_at), 0);
  const lastHealthyAt = deps.recovery.lastHealthyAt ?? newest;
  const downtime = Math.max(0, now - lastHealthyAt);
  for (const row of rows) {
    if (row.frozen_at !== null) continue;
    if (!row.state_json) {
      await abortUnrecoverableRow(
        deps, row, row.status === 'open' ? 'closed' : 'restart',
        row.status === 'open' ? '没有开局就停机的旧桌子，已经收起来了。' : '升级前的旧牌局没有存档，这局作废。',
        now,
      );
      continue;
    }
    let engine: TableEngine;
    try {
      engine = await hydrateTableRow(deps, row);
    } catch (error) {
      await freezeCorruptRow(deps, row, error, now);
      deps.tables.set(row.id, await buildFrozenTable(deps, row));
      continue;
    }
    const autoRows = await deps.db.prepare(
      'SELECT seat_id FROM table_seats WHERE table_id = ? AND auto = 1 AND left_at IS NULL',
    ).all(row.id) as unknown as Array<{ seat_id: string }>;
    const live: LiveTable = {
      id: row.id,
      game: row.game,
      engine,
      hostSeatId: row.host_seat_id ?? engine.host,
      hostName: await deps.seatName(row.host_seat_id ?? engine.host),
      createdAt: row.created_at,
      ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
      openDeadlineAt: row.deadline_at ?? row.updated_at + deps.openMs,
      revision: row.revision,
      stateJson: stateTextOf(row.state_json),
      frozen: false,
      autoSeats: new Set(autoRows.map((entry) => entry.seat_id)),
    };
    if (engine.status === 'open') {
      if (now >= live.openDeadlineAt) {
        await deps.abort(live, 'timeout', `${engine.label}桌连续 ${Math.round(deps.openMs / 60_000)} 分钟没有活动，已经收起来了。`);
        continue;
      }
      deps.tables.set(live.id, live);
      continue;
    }
    if (downtime > deps.recovery.maxDowntimeMs) {
      await deps.abort(
        live, 'offline',
        `${engine.label}桌因为服务停机超过 ${Math.round(deps.recovery.maxDowntimeMs / 60_000)} 分钟，这局作废。`,
      );
      continue;
    }
    engine.rearm(now, downtime, deps.recovery.minHumanMs);
    const revision = live.revision + 1;
    const stateJson = JSON.stringify(engine.exportState());
    live.revision = revision;
    live.stateJson = stateJson;
    deps.tables.set(live.id, live);
    await withTransaction(deps.db, async () => {
      await deps.db.prepare(
        `UPDATE tables SET revision = ?, state_json = ?, state_version = ?, engine_version = ?,
           deadline_at = ?, updated_at = ? WHERE id = ?`,
      ).run(
        revision, stateJson, engine.stateVersion, `${row.game}/${engine.stateVersion}`,
        deps.deadlineOf(engine) ?? null, now, live.id,
      );
      await deps.appendTableEvent(live, {
        type: 'parlor.table.resume',
        scope: { kind: 'room' },
        text: `${engine.label}桌续上了：服务停了约 ${Math.max(1, Math.round(downtime / 1000))} 秒，牌和轮次都还在。`,
        data: { game: live.game, tableId: live.id, downtimeMs: downtime },
      }, now);
    });
  }
}
