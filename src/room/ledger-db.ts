/**
 * 全局账本的 SQLite store。
 *
 * 与旧的 LedgerStore（JSON）同一组语义：只追加条目，余额由 ledger_transfers
 * 现算，承诺状态由指向它的 accept/decline/cancel/settle/default 按 ord 现算。
 * 区别只在于落库：不设 entryLimit（裁掉一条 grant/transfer 会直接改余额），
 * 并把 participants/winners/transfers 拆到各自的表。
 *
 * 事务交给调用方组合（进厅/送礼+账本+信箱），record 自己只在外层没有事务时
 * 才开一个；`db.isTransaction` 在 Node >= 22.13 可用。
 */
import { randomUUID } from 'node:crypto';
import { migrate, openDb, withTransaction, type Db } from './db.ts';
import {
  REFILL_BELOW,
  REFILL_GAP_MS,
  REFILL_TO,
  START_CHIPS,
  gameOf,
  type ChipTransfer,
  type GameTally,
  type LedgerEntry,
  type LedgerEntryView,
  type LedgerKind,
  type LedgerSummary,
  type LedgerVisibility,
  type OpenLedgerItem,
  type PromiseStatus,
} from './ledger.ts';

export type LedgerRecordInput = Omit<LedgerEntry, 'id' | 'ts'> & {
  /** 显式标成补发；默认看 `data.refill === true`。 */
  isRefill?: boolean;
};

export interface LedgerDbOptions {
  now?: () => number;
}

/** 给旧版 World/网页用的完整摘要；字段与旧 LedgerStore.summaryFor 一致。 */
export type LedgerSummaryLite = LedgerSummary;

const STATUS_BY_KIND: Partial<Record<LedgerKind, PromiseStatus>> = {
  accept: 'accepted',
  decline: 'declined',
  cancel: 'cancelled',
  settle: 'settled',
  default: 'defaulted',
};

const isUniqueViolation = (error: unknown): boolean => (
  error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
);

const parseData = (raw: string | null): Record<string, unknown> | undefined => {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

interface EntryRow {
  ord: number;
  id: string;
  ts: number;
  room_id: string | null;
  kind: string;
  visibility: string;
  from_kind: string;
  from_coo_id: string | null;
  to_kind: string;
  to_coo_id: string | null;
  game: string | null;
  text: string;
  data_json: string | null;
  due_at: number | null;
  ref_entry_id: string | null;
  effect_id: string | null;
  is_refill: number;
}

interface TransferRow {
  from_kind: string;
  from_coo_id: string | null;
  to_kind: string;
  to_coo_id: string | null;
  amount: number;
}

interface OpenRow {
  id: string;
  kind: string;
  from_coo_id: string | null;
  to_coo_id: string | null;
  text: string;
  due_at: number | null;
  data_json: string | null;
  status_kind: string | null;
}

interface GameRow {
  id: string;
  game: string | null;
  data_json: string | null;
  won: number;
}

const labelOf = (game: string, data: Record<string, unknown> | undefined): string => {
  const label = data?.gameLabel;
  if (typeof label === 'string' && label.length > 0) return label;
  return game === 'unknown' ? '其他' : game;
};

/** 这条记录让某个 cooId 增减了多少筹码。 */
const netOf = (entry: LedgerEntry, cooId: string): number => {
  let net = 0;
  for (const transfer of entry.transfers ?? []) {
    if (transfer.to === cooId) net += transfer.amount;
    if (transfer.from === cooId) net -= transfer.amount;
  }
  return net;
};

const viewOf = (entry: LedgerEntry, cooId?: string): LedgerEntryView => {
  const net = cooId ? netOf(entry, cooId) : 0;
  return {
    id: entry.id,
    ts: entry.ts,
    room: entry.room,
    kind: entry.kind,
    text: entry.text,
    ...(entry.data ? { data: entry.data } : {}),
    ...(entry.kind === 'game' ? { game: gameOf(entry) } : {}),
    ...(net !== 0 ? { chips: net } : {}),
  };
};

export class LedgerDb {
  readonly db: Db;
  private readonly now: () => number;

  constructor(db: Db, options: LedgerDbOptions = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
  }

  /** 开一个库并建表；多客厅共用一个库时直接用 new LedgerDb(db)。 */
  static open(file = ':memory:', options: LedgerDbOptions = {}): LedgerDb {
    const db = openDb(file);
    migrate(db);
    return new LedgerDb(db, options);
  }

  /**
   * 追加一条记录，写 entry + participants/winners/transfers，返回带 id/ts 的条目。
   * 同一个 effectId 只写一次：已有就原样返回旧的（长局重放/崩溃恢复）。
   */
  record(input: LedgerRecordInput): LedgerEntry {
    const { isRefill, ...fields } = input;
    return this.atomic(() => {
      if (fields.effectId) {
        const existing = this.byEffectId(fields.effectId);
        if (existing) return existing;
      }
      const entry: LedgerEntry = { ...fields, id: randomUUID(), ts: this.now() };
      this.insert(entry, isRefill ?? entry.data?.refill === true);
      return entry;
    });
  }

  byId(id: string): LedgerEntry | undefined {
    const row = this.db.prepare('SELECT * FROM ledger_entries WHERE id = ?').get(id);
    return row ? this.entryOf(row as unknown as EntryRow) : undefined;
  }

  byEffectId(effectId: string): LedgerEntry | undefined {
    const row = this.db.prepare('SELECT * FROM ledger_entries WHERE effect_id = ?').get(effectId);
    return row ? this.entryOf(row as unknown as EntryRow) : undefined;
  }

  /** 按完整 id 或唯一前缀找条目；前缀撞了就返回 undefined。 */
  find(idOrPrefix: string): LedgerEntry | undefined {
    const needle = idOrPrefix.trim().toLowerCase();
    if (!needle) return undefined;
    const exact = this.db.prepare('SELECT * FROM ledger_entries WHERE id = ? COLLATE NOCASE').get(needle);
    if (exact) return this.entryOf(exact as unknown as EntryRow);
    const escaped = needle.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const hits = this.db
      .prepare("SELECT * FROM ledger_entries WHERE LOWER(id) LIKE ? ESCAPE '\\' ORDER BY ord LIMIT 2")
      .all(`${escaped}%`);
    return hits.length === 1 ? this.entryOf(hits[0] as unknown as EntryRow) : undefined;
  }

  /** 余额：所有 transfers 里进出这个 cooId 的和；`room` 只发行，不计余额。 */
  balanceOf(cooId: string): number {
    const row = this.db.prepare(
      `SELECT
         (SELECT COALESCE(SUM(amount), 0) FROM ledger_transfers WHERE to_coo_id = ?) -
         (SELECT COALESCE(SUM(amount), 0) FROM ledger_transfers WHERE from_coo_id = ?) AS balance`,
    ).get(cooId, cooId) as { balance: number };
    return row.balance;
  }

  /**
   * 一条 promise/debt 现在的状态：按 ord 取最后一条指向它的
   * accept/decline/cancel/settle/default；没有就是 pending。
   * 传入 id 也可以；不是 promise/debt 返回 null。
   */
  promiseStatus(promise: LedgerEntry | string): PromiseStatus | null {
    let id: string;
    let kind: string;
    if (typeof promise === 'string') {
      const row = this.db
        .prepare('SELECT id, kind FROM ledger_entries WHERE id = ?')
        .get(promise) as { id: string; kind: string } | undefined;
      if (!row) return null;
      id = row.id;
      kind = row.kind;
    } else {
      id = promise.id;
      kind = promise.kind;
    }
    if (kind !== 'promise' && kind !== 'debt') return null;
    const row = this.db.prepare(
      `SELECT kind FROM ledger_entries
        WHERE ref_entry_id = ?
          AND kind IN ('accept','decline','cancel','settle','default')
        ORDER BY ord DESC LIMIT 1`,
    ).get(id) as { kind: LedgerKind } | undefined;
    if (!row) return 'pending';
    return STATUS_BY_KIND[row.kind] ?? 'pending';
  }

  /** 某人的未了结承诺（等对方回 / 已答应），按到期时间排，没期限的在后。 */
  openFor(cooId: string): OpenLedgerItem[] {
    const rows = this.db.prepare(
      `SELECT e.id, e.kind, e.from_coo_id, e.to_coo_id, e.text, e.due_at, e.data_json,
         (SELECT s.kind FROM ledger_entries s
           WHERE s.ref_entry_id = e.id
             AND s.kind IN ('accept','decline','cancel','settle','default')
           ORDER BY s.ord DESC LIMIT 1) AS status_kind
       FROM ledger_entries e
       WHERE e.kind IN ('promise','debt')
         AND (e.from_coo_id = ? OR e.to_coo_id = ?)
       ORDER BY (e.due_at IS NULL), e.due_at, e.ord`,
    ).all(cooId, cooId) as unknown as OpenRow[];

    const open: OpenLedgerItem[] = [];
    for (const row of rows) {
      const status = (row.status_kind ? STATUS_BY_KIND[row.status_kind as LedgerKind] : undefined) ?? 'pending';
      if (status !== 'pending' && status !== 'accepted') continue;
      const data = parseData(row.data_json);
      const direction = row.from_coo_id === cooId ? 'out' : 'in';
      const name = direction === 'out' ? data?.toName : data?.fromName;
      const chips = data?.chips;
      open.push({
        id: row.id,
        kind: row.kind as 'promise' | 'debt',
        status,
        direction,
        counterpart: typeof name === 'string' && name ? name : '某个席位',
        text: row.text,
        ...(typeof row.due_at === 'number' ? { due: row.due_at } : {}),
        ...(typeof chips === 'number' && chips > 0 ? { chips } : {}),
      });
    }
    return open;
  }

  countOpenPromises(cooId: string): number {
    return this.openFor(cooId).length;
  }

  /** 这个 cooId 在 since 之后新写了多少条礼物 + 承诺（防刷屏用）。 */
  socialCountSince(cooId: string, since: number): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM ledger_entries
        WHERE from_coo_id = ? AND kind IN ('gift','promise') AND ts >= ?`,
    ).get(cooId, since) as { n: number };
    return row.n;
  }

  /** 新身份第一次进房间发筹码；唯一索引保证一个 coo 只有一条非 refill grant。 */
  ensureGrant(cooId: string, room: string): LedgerEntry | null {
    if (!cooId) return null;
    return this.atomic(() => {
      const existing = this.db.prepare(
        "SELECT 1 AS hit FROM ledger_entries WHERE kind = 'grant' AND to_coo_id = ? AND is_refill = 0 LIMIT 1",
      ).get(cooId);
      if (existing) return null;
      try {
        return this.record({
          kind: 'grant',
          room,
          from: 'room',
          to: cooId,
          text: `房间给了 ${START_CHIPS} 枚筹码。`,
          visibility: 'private',
          transfers: [{ from: 'room', to: cooId, amount: START_CHIPS }],
          data: { fromName: '房间', chips: START_CHIPS },
        });
      } catch (error) {
        // 并发兜底：唯一索引顶掉时按「已经发过」处理。
        if (isUniqueViolation(error)) return null;
        throw error;
      }
    });
  }

  /** 余额见底时补一点，两次之间至少隔 REFILL_GAP_MS；返回新发的条目。 */
  maybeRefill(cooId: string, room: string, now = this.now()): LedgerEntry | null {
    if (!cooId) return null;
    return this.atomic(() => {
      const balance = this.balanceOf(cooId);
      if (balance >= REFILL_BELOW) return null;
      const last = this.db.prepare(
        `SELECT ts FROM ledger_entries
          WHERE kind = 'grant' AND to_coo_id = ? AND is_refill = 1
          ORDER BY ord DESC LIMIT 1`,
      ).get(cooId) as { ts: number } | undefined;
      if (last && now - last.ts < REFILL_GAP_MS) return null;
      const amount = Math.max(0, REFILL_TO - balance);
      if (amount === 0) return null;
      return this.record({
        kind: 'grant',
        room,
        from: 'room',
        to: cooId,
        text: `房间给你补了 ${amount} 枚筹码（余额不足 ${REFILL_BELOW}）。`,
        visibility: 'private',
        transfers: [{ from: 'room', to: cooId, amount }],
        data: { fromName: '房间', chips: amount, refill: true },
      });
    });
  }

  /**
   * 到期没结的承诺追加一条 default；只扫 room 指定的客厅（不给就扫全部），
   * 已经有 settle/decline/cancel/default 的不再重复记。
   */
  expire(now = this.now(), room?: string): LedgerEntry[] {
    return this.atomic(() => {
      const rows = this.db.prepare(
        `SELECT * FROM ledger_entries e
          WHERE e.kind = 'promise'
            AND e.due_at IS NOT NULL
            AND e.due_at <= ?
            AND (? IS NULL OR e.room_id = ?)
            AND NOT EXISTS (
              SELECT 1 FROM ledger_entries s
               WHERE s.ref_entry_id = e.id
                 AND s.kind IN ('settle','decline','cancel','default')
            )
          ORDER BY e.ord`,
      ).all(now, room ?? null, room ?? null) as unknown as EntryRow[];

      const created: LedgerEntry[] = [];
      for (const row of rows) {
        const promise = this.entryOf(row);
        if (this.promiseStatus(promise) !== 'accepted') continue;
        created.push(this.record({
          kind: 'default',
          ref: promise.id,
          room: promise.room,
          from: 'room',
          ...(promise.to ? { to: promise.to } : {}),
          participants: [promise.from, promise.to].filter(
            (id): id is string => typeof id === 'string' && id !== 'room',
          ),
          text: `到期没结：${promise.text}`,
          visibility: 'private',
          data: {
            fromName: '房间',
            toName: typeof promise.data?.fromName === 'string' ? promise.data.fromName : '',
            promiseText: promise.text,
          },
        }));
      }
      return created;
    });
  }

  /**
   * 局数/胜负平/余额/未了结 + 按游戏拆分 + 最近 5 条。
   * 平局只算赢的人平，没赢的人算负；与旧 LedgerStore.summaryFor 一致。
   */
  summaryFor(cooId: string): LedgerSummary {
    const rows = this.db.prepare(
      `SELECT e.id, e.game, e.data_json,
         EXISTS(SELECT 1 FROM ledger_winners w WHERE w.entry_id = e.id AND w.coo_id = ?) AS won
       FROM ledger_entries e
       WHERE e.kind = 'game'
         AND (
           e.from_coo_id = ? OR e.to_coo_id = ?
           OR EXISTS(SELECT 1 FROM ledger_participants p WHERE p.entry_id = e.id AND p.coo_id = ?)
           OR EXISTS(SELECT 1 FROM ledger_winners w2 WHERE w2.entry_id = e.id AND w2.coo_id = ?)
         )
       ORDER BY e.ord`,
    ).all(cooId, cooId, cooId, cooId, cooId) as unknown as GameRow[];

    let games = 0;
    let wins = 0;
    let losses = 0;
    let draws = 0;
    const byGame = new Map<string, GameTally>();
    for (const row of rows) {
      games += 1;
      const data = parseData(row.data_json);
      const game = typeof row.game === 'string' && row.game.length > 0
        ? row.game
        : typeof data?.game === 'string' && data.game.length > 0 ? data.game : 'unknown';
      let tally = byGame.get(game);
      if (!tally) {
        tally = { game, label: labelOf(game, data), games: 0, wins: 0, losses: 0, draws: 0 };
        byGame.set(game, tally);
      } else if (tally.label === game || tally.label === '其他') {
        tally.label = labelOf(game, data);
      }
      tally.games += 1;
      if (!row.won) {
        losses += 1;
        tally.losses += 1;
      } else if (data?.tie === true) {
        draws += 1;
        tally.draws += 1;
      } else {
        wins += 1;
        tally.wins += 1;
      }
    }

    const recent = (this.db.prepare(
      `SELECT id FROM ledger_entries e
        WHERE e.from_coo_id = ? OR e.to_coo_id = ?
          OR EXISTS(SELECT 1 FROM ledger_participants p WHERE p.entry_id = e.id AND p.coo_id = ?)
          OR EXISTS(SELECT 1 FROM ledger_winners w WHERE w.entry_id = e.id AND w.coo_id = ?)
        ORDER BY e.ord DESC LIMIT 5`,
    ).all(cooId, cooId, cooId, cooId) as { id: string }[])
      .map((row) => this.byId(row.id))
      .filter((entry): entry is LedgerEntry => !!entry)
      .map((entry) => viewOf(entry, cooId));

    return {
      cooId,
      games,
      wins,
      losses,
      draws,
      byGame: [...byGame.values()].sort((left, right) => (
        right.games - left.games || left.game.localeCompare(right.game)
      )),
      chips: this.balanceOf(cooId),
      open: this.openFor(cooId),
      recent,
    };
  }

  /** 本房最近的公开条目，给房间里的所有人看；不含别人的 cooId。 */
  publicInRoom(room: string, limit = 5): LedgerEntryView[] {
    return (this.db.prepare(
      `SELECT id FROM ledger_entries
        WHERE room_id = ? AND visibility = 'room'
        ORDER BY ord DESC LIMIT ?`,
    ).all(room, Math.max(1, Math.trunc(limit))) as { id: string }[])
      .map((row) => this.byId(row.id))
      .filter((entry): entry is LedgerEntry => !!entry)
      .map((entry) => viewOf(entry));
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get() as { n: number };
    return row.n;
  }

  /** 外层已有事务（WorldServer 组合送礼+账本+信箱）时不再套一层 BEGIN。 */
  private atomic<T>(fn: () => T): T {
    return this.db.isTransaction ? fn() : withTransaction(this.db, fn);
  }

  private insert(entry: LedgerEntry, isRefill: boolean): void {
    const fromKind = entry.from === 'room' ? 'room' : 'coo';
    const toKind = entry.to === undefined || entry.to === ''
      ? 'none'
      : entry.to === 'room' ? 'room' : 'coo';
    this.db.prepare(
      `INSERT INTO ledger_entries(
         id, ts, room_id, kind, visibility, from_kind, from_coo_id, to_kind, to_coo_id,
         game, text, data_json, due_at, ref_entry_id, effect_id, is_refill
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.id,
      entry.ts,
      entry.room,
      entry.kind,
      entry.visibility,
      fromKind,
      fromKind === 'coo' ? entry.from : null,
      toKind,
      toKind === 'coo' ? entry.to ?? null : null,
      entry.game ?? null,
      entry.text,
      entry.data === undefined ? null : JSON.stringify(entry.data),
      typeof entry.due === 'number' && Number.isFinite(entry.due) ? entry.due : null,
      entry.ref ?? null,
      entry.effectId || null,
      isRefill ? 1 : 0,
    );

    const participants = new Set(entry.participants ?? []);
    if (participants.size > 0) {
      const statement = this.db.prepare(
        'INSERT INTO ledger_participants(entry_id, coo_id, position) VALUES (?, ?, ?)',
      );
      let position = 0;
      for (const cooId of participants) {
        if (typeof cooId !== 'string' || !cooId || cooId === 'room') continue;
        statement.run(entry.id, cooId, position);
        position += 1;
      }
    }

    const winners = new Set(entry.winners ?? []);
    if (winners.size > 0) {
      const statement = this.db.prepare(
        'INSERT INTO ledger_winners(entry_id, coo_id) VALUES (?, ?)',
      );
      for (const cooId of winners) {
        if (typeof cooId !== 'string' || !cooId || cooId === 'room') continue;
        statement.run(entry.id, cooId);
      }
    }

    for (const transfer of entry.transfers ?? []) this.insertTransfer(entry.id, transfer);
  }

  private insertTransfer(entryId: string, transfer: ChipTransfer): void {
    if (!Number.isSafeInteger(transfer.amount) || transfer.amount <= 0) {
      throw new Error(`筹码转移的数额必须是正整数：${String(transfer.amount)}`);
    }
    if (!transfer.to) {
      throw new Error('筹码转移必须有一个目标');
    }
    const fromKind = transfer.from === 'room' ? 'room' : 'coo';
    const toKind = transfer.to === 'room' ? 'room' : 'coo';
    this.db.prepare(
      `INSERT INTO ledger_transfers(entry_id, from_kind, from_coo_id, to_kind, to_coo_id, amount)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      entryId,
      fromKind,
      fromKind === 'coo' ? transfer.from : null,
      toKind,
      toKind === 'coo' ? transfer.to : null,
      transfer.amount,
    );
  }

  private entryOf(row: EntryRow): LedgerEntry {
    const participants = (this.db
      .prepare('SELECT coo_id FROM ledger_participants WHERE entry_id = ? ORDER BY position')
      .all(row.id) as { coo_id: string }[]).map((item) => item.coo_id);
    const winners = (this.db
      .prepare('SELECT coo_id FROM ledger_winners WHERE entry_id = ? ORDER BY rowid')
      .all(row.id) as { coo_id: string }[]).map((item) => item.coo_id);
    const transfers = (this.db
      .prepare('SELECT from_kind, from_coo_id, to_kind, to_coo_id, amount FROM ledger_transfers WHERE entry_id = ? ORDER BY id')
      .all(row.id) as unknown as TransferRow[]).map((item) => ({
      from: item.from_kind === 'room' ? 'room' : item.from_coo_id ?? '',
      to: item.to_kind === 'room' ? 'room' : item.to_coo_id ?? '',
      amount: item.amount,
    }));
    const data = parseData(row.data_json);

    const entry: LedgerEntry = {
      id: row.id,
      ts: row.ts,
      room: row.room_id ?? '',
      kind: row.kind as LedgerKind,
      from: row.from_kind === 'room' ? 'room' : row.from_coo_id ?? '',
      text: row.text,
      visibility: row.visibility as LedgerVisibility,
    };
    if (row.to_kind === 'room') entry.to = 'room';
    else if (row.to_kind === 'coo' && row.to_coo_id) entry.to = row.to_coo_id;
    if (participants.length > 0) entry.participants = participants;
    if (winners.length > 0) entry.winners = winners;
    if (transfers.length > 0) entry.transfers = transfers;
    if (data) entry.data = data;
    if (row.game) entry.game = row.game;
    if (row.ref_entry_id) entry.ref = row.ref_entry_id;
    if (typeof row.due_at === 'number') entry.due = row.due_at;
    if (row.effect_id) entry.effectId = row.effect_id;
    return entry;
  }
}
