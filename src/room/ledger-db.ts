/**
 * 全局账本的 store。
 *
 * 与旧的 LedgerStore（JSON）同一组语义：只追加条目，承诺状态由指向它的
 * accept/decline/cancel/settle/default 按 ord 现算，礼物存货由收到的 `gift`
 * 减去喝掉/吃掉的 `gift_used` 现算。区别只在于落库：不设 entryLimit。
 *
 * 事务交给调用方组合（进厅、送礼+账本+信箱），record 自己只在外层没有事务时
 * 才开一个。外层是否有事务由适配器按异步链判断（db.isTransaction）。
 *
 * 0.38.0 起筹码整条移除：`ledger_transfers` 表已删，余额不再存在。
 * `grant` / `ante` 只作为历史 kind 保留（能读、能展示），不再写。
 */
import { randomUUID } from 'node:crypto';
import { migrate, withTransaction, type Db } from './db.ts';
import {
  gameOf,
  type GameTally,
  type LedgerEntry,
  type LedgerEntryView,
  type LedgerKind,
  type LedgerSummary,
  type LedgerVisibility,
  type OpenLedgerItem,
  type PromiseStatus,
} from './ledger.ts';
import { jsonObject } from './storage/json.ts';

export type LedgerRecordInput = Omit<LedgerEntry, 'id' | 'ts'>;

export interface LedgerDbOptions {
  now?: () => number;
}

/** 兼容旧版摘要字段与 recent 的逐条流水语义；PG 已停用承诺，open 恒为空。 */
export type LedgerSummaryLite = LedgerSummary;

const STATUS_BY_KIND: Partial<Record<LedgerKind, PromiseStatus>> = {
  accept: 'accepted',
  decline: 'declined',
  cancel: 'cancelled',
  settle: 'settled',
  default: 'defaulted',
};

const parseData = (raw: unknown): Record<string, unknown> | undefined => jsonObject(raw);

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
  data_json: unknown;
  due_at: number | null;
  ref_entry_id: string | null;
  effect_id: string | null;
}

interface OpenRow {
  id: string;
  kind: string;
  from_coo_id: string | null;
  to_coo_id: string | null;
  text: string;
  due_at: number | null;
  data_json: unknown;
  status_kind: string | null;
}

interface GameRow {
  id: string;
  game: string | null;
  data_json: unknown;
  won: number;
}

const labelOf = (game: string, data: Record<string, unknown> | undefined): string => {
  const label = data?.gameLabel;
  if (typeof label === 'string' && label.length > 0) return label;
  return game === 'unknown' ? '其他' : game;
};

const viewOf = (entry: LedgerEntry): LedgerEntryView => ({
  id: entry.id,
  ts: entry.ts,
  room: entry.room,
  kind: entry.kind,
  text: entry.text,
  ...(entry.data ? { data: entry.data } : {}),
  ...(entry.kind === 'game' ? { game: gameOf(entry) } : {}),
});

export class LedgerDb {
  readonly db: Db;
  private readonly now: () => number;

  constructor(db: Db, options: LedgerDbOptions = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
  }

  /** 开一个库并建表；多客厅共用一个库时直接用 new LedgerDb(db)。 */
  static async open(file = ':memory:', options: LedgerDbOptions = {}): Promise<LedgerDb> {
    const { openDb } = await import('./storage/sqlite.ts');
    const db = openDb(file);
    await migrate(db);
    return new LedgerDb(db, options);
  }

  /**
   * 追加一条记录，写 entry + participants/winners，返回带 id/ts 的条目。
   * 同一个 effectId 只写一次：已有就原样返回旧的（长局重放/崩溃恢复）。
   */
  record(input: LedgerRecordInput): Promise<LedgerEntry> {
    return this.atomic(async () => {
      if (input.effectId) {
        const existing = await this.byEffectId(input.effectId);
        if (existing) return existing;
      }
      const entry: LedgerEntry = { ...input, id: randomUUID(), ts: this.now() };
      await this.insert(entry);
      return entry;
    });
  }

  async byId(id: string): Promise<LedgerEntry | undefined> {
    const row = await this.db.prepare('SELECT * FROM ledger_entries WHERE id = ?').get(id);
    return row ? this.entryOf(row as unknown as EntryRow) : undefined;
  }

  async byEffectId(effectId: string): Promise<LedgerEntry | undefined> {
    const row = await this.db.prepare('SELECT * FROM ledger_entries WHERE effect_id = ?').get(effectId);
    return row ? this.entryOf(row as unknown as EntryRow) : undefined;
  }

  /** 按完整 id 或唯一前缀找条目；前缀撞了就返回 undefined。 */
  async find(idOrPrefix: string): Promise<LedgerEntry | undefined> {
    const needle = idOrPrefix.trim().toLowerCase();
    if (!needle) return undefined;
    // SQLite 用 COLLATE NOCASE，PG 没有这个排序规则；两边都认的写法是 lower()。
    const exact = await this.db.prepare('SELECT * FROM ledger_entries WHERE lower(id) = ?').get(needle);
    if (exact) return this.entryOf(exact as unknown as EntryRow);
    const escaped = needle.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const hits = await this.db
      .prepare("SELECT * FROM ledger_entries WHERE LOWER(id) LIKE ? ESCAPE '\\' ORDER BY ord LIMIT 2")
      .all(`${escaped}%`);
    return hits.length === 1 ? this.entryOf(hits[0] as unknown as EntryRow) : undefined;
  }

  /**
   * 手上的礼物：收到的 `gift` 减去自己喝掉/吃掉的 `gift_used`，按 itemId 聚合。
   * 没有库存表——存货是条目现算的，和余额当初的写法同源。
   */
  async heldGifts(cooId: string): Promise<Record<string, number>> {
    const rows = await this.db.prepare(
      `SELECT kind, data_json FROM ledger_entries
        WHERE (kind = 'gift' AND to_coo_id = ?) OR (kind = 'gift_used' AND from_coo_id = ?)`,
    ).all(cooId, cooId) as Array<{ kind: string; data_json: unknown }>;
    const held: Record<string, number> = {};
    for (const row of rows) {
      const data = parseData(row.data_json);
      const itemId = data?.itemId;
      if (typeof itemId !== 'string' || !itemId) continue;
      held[itemId] = (held[itemId] ?? 0) + (row.kind === 'gift' ? 1 : -1);
    }
    for (const [itemId, count] of Object.entries(held)) if (count <= 0) delete held[itemId];
    return held;
  }

  /** 某一种礼物手上还有几份。 */
  async heldCount(cooId: string, itemId: string): Promise<number> {
    return (await this.heldGifts(cooId))[itemId] ?? 0;
  }

  /** 时间窗内已经喝掉/吃掉了几份（运气文案的过量判定用）。 */
  async usedSince(cooId: string, since: number): Promise<number> {
    const row = await this.db.prepare(
      `SELECT COUNT(*) AS n FROM ledger_entries
        WHERE kind = 'gift_used' AND from_coo_id = ? AND ts >= ?`,
    ).get(cooId, since) as { n: number };
    return row.n;
  }

  /** 一条 promise/debt 现在的状态：按 ord 取最后一条指向它的
   * accept/decline/cancel/settle/default；没有就是 pending。
   * 传入 id 也可以；不是 promise/debt 返回 null。
   */
  async promiseStatus(promise: LedgerEntry | string): Promise<PromiseStatus | null> {
    let id: string;
    let kind: string;
    if (typeof promise === 'string') {
      const row = await this.db
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
    const row = await this.db.prepare(
      `SELECT kind FROM ledger_entries
        WHERE ref_entry_id = ?
          AND kind IN ('accept','decline','cancel','settle','default')
        ORDER BY ord DESC LIMIT 1`,
    ).get(id) as { kind: LedgerKind } | undefined;
    if (!row) return 'pending';
    return STATUS_BY_KIND[row.kind] ?? 'pending';
  }

  /** 某人的未了结承诺（等对方回 / 已答应），按到期时间排，没期限的在后。 */
  async openFor(cooId: string): Promise<OpenLedgerItem[]> {
    const rows = await this.db.prepare(
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
      open.push({
        id: row.id,
        kind: row.kind as 'promise' | 'debt',
        status,
        direction,
        counterpart: typeof name === 'string' && name ? name : '某个席位',
        text: row.text,
        ...(typeof row.due_at === 'number' ? { due: row.due_at } : {}),
      });
    }
    return open;
  }

  async countOpenPromises(cooId: string): Promise<number> {
    return (await this.openFor(cooId)).length;
  }

  /** 这个 cooId 在 since 之后新写了多少条礼物 + 承诺（防刷屏用）。 */
  async socialCountSince(cooId: string, since: number): Promise<number> {
    const row = await this.db.prepare(
      `SELECT COUNT(*) AS n FROM ledger_entries
        WHERE from_coo_id = ? AND kind IN ('gift','promise') AND ts >= ?`,
    ).get(cooId, since) as { n: number };
    return row.n;
  }

  /**
   * 到期没结的承诺追加一条 default；只扫 room 指定的客厅（不给就扫全部），
   * 已经有 settle/decline/cancel/default 的不再重复记。
   */
  async expire(now = this.now(), room?: string): Promise<LedgerEntry[]> {
    return this.atomic(async () => {
      const rows = await this.db.prepare(
        `SELECT * FROM ledger_entries e
          WHERE e.kind = 'promise'
            AND e.due_at IS NOT NULL
            AND e.due_at <= ?
            AND (? = 0 OR e.room_id = ?)
            AND NOT EXISTS (
              SELECT 1 FROM ledger_entries s
               WHERE s.ref_entry_id = e.id
                 AND s.kind IN ('settle','decline','cancel','default')
            )
          ORDER BY e.ord`,
      ).all(now, room ? 1 : 0, room ?? null) as unknown as EntryRow[];

      const created: LedgerEntry[] = [];
      for (const row of rows) {
        const promise = await this.entryOf(row);
        if (await this.promiseStatus(promise) !== 'accepted') continue;
        created.push(await this.record({
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
  async summaryFor(cooId: string): Promise<LedgerSummary> {
    if (this.db.kind === 'postgres') {
      const groups = await this.db.prepare(`SELECT COALESCE(e.game,'unknown') AS game,
        MAX(NULLIF(e.data_json->>'gameLabel','')) AS label, COUNT(*) AS games,
        SUM(CASE WHEN w.coo_id IS NOT NULL AND COALESCE(e.data_json->>'tie','false')<>'true' THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN w.coo_id IS NOT NULL AND e.data_json->>'tie'='true' THEN 1 ELSE 0 END) AS draws,
        SUM(CASE WHEN w.coo_id IS NULL THEN 1 ELSE 0 END) AS losses
        FROM ledger_entries e LEFT JOIN ledger_winners w ON w.entry_id=e.id AND w.coo_id=?
        WHERE e.kind='game' AND (e.from_coo_id=? OR e.to_coo_id=? OR w.coo_id IS NOT NULL
          OR EXISTS(SELECT 1 FROM ledger_participants p WHERE p.entry_id=e.id AND p.coo_id=?))
        GROUP BY e.game ORDER BY COUNT(*) DESC, e.game`).all(cooId, cooId, cooId, cooId) as GameTally[];
      const byGame = groups.map(g => ({ game: g.game, label: labelOf(g.game, {gameLabel:g.label}), games: Number(g.games), wins: Number(g.wins), losses: Number(g.losses), draws: Number(g.draws) }));
      const total = byGame.reduce((a,g) => ({ games:a.games+g.games,wins:a.wins+g.wins,losses:a.losses+g.losses,draws:a.draws+g.draws }), { games:0,wins:0,losses:0,draws:0 });
      // Keep the existing summary contract: latest five entries of any kind.
      const recentRows = await this.db.prepare(`SELECT e.*
        FROM ledger_entries e WHERE e.from_coo_id=? OR e.to_coo_id=?
          OR EXISTS(SELECT 1 FROM ledger_participants p WHERE p.entry_id=e.id AND p.coo_id=?)
          OR EXISTS(SELECT 1 FROM ledger_winners w WHERE w.entry_id=e.id AND w.coo_id=?)
        ORDER BY e.ord DESC LIMIT 5`).all(cooId, cooId, cooId, cooId) as unknown as EntryRow[];
      const recent: LedgerEntryView[] = recentRows.map(row => {
        const data = parseData(row.data_json);
        return { id:row.id, ts:Number(row.ts), room:row.room_id ?? '', kind:row.kind as LedgerKind, text:row.text,
          ...(data ? {data} : {}), ...(row.kind === 'game' ? {game:row.game || (typeof data?.game === 'string' ? data.game : 'unknown')} : {}),
        };
      });
      return { cooId, ...total, byGame, open: [], recent };
    }
    const rows = await this.db.prepare(
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

    const recentRows = await this.db.prepare(
      `SELECT id FROM ledger_entries e
        WHERE e.from_coo_id = ? OR e.to_coo_id = ?
          OR EXISTS(SELECT 1 FROM ledger_participants p WHERE p.entry_id = e.id AND p.coo_id = ?)
          OR EXISTS(SELECT 1 FROM ledger_winners w WHERE w.entry_id = e.id AND w.coo_id = ?)
        ORDER BY e.ord DESC LIMIT 5`,
    ).all(cooId, cooId, cooId, cooId) as { id: string }[];
    const recent: LedgerEntryView[] = [];
    for (const row of recentRows) {
      const entry = await this.byId(row.id);
      if (entry) recent.push(viewOf(entry));
    }

    return {
      cooId,
      games,
      wins,
      losses,
      draws,
      byGame: [...byGame.values()].sort((left, right) => (
        right.games - left.games || left.game.localeCompare(right.game)
      )),
      open: await this.openFor(cooId),
      recent,
    };
  }

  /** 本房最近的公开条目，给房间里的所有人看；不含别人的 cooId。 */
  async publicInRoom(room: string, limit = 5): Promise<LedgerEntryView[]> {
    const rows = await this.db.prepare(
      `SELECT id FROM ledger_entries
        WHERE room_id = ? AND visibility = 'room'
        ORDER BY ord DESC LIMIT ?`,
    ).all(room, Math.max(1, Math.trunc(limit))) as { id: string }[];
    const items: LedgerEntryView[] = [];
    for (const row of rows) {
      const entry = await this.byId(row.id);
      if (entry) items.push(viewOf(entry));
    }
    return items;
  }

  async count(): Promise<number> {
    const row = await this.db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get() as { n: number };
    return row.n;
  }

  /** 外层已有事务（WorldServer 组合送礼+账本+信箱）时不再套一层 BEGIN。 */
  private atomic<T>(fn: () => Promise<T>): Promise<T> {
    return this.db.isTransaction ? fn() : withTransaction(this.db, fn);
  }

  private async insert(entry: LedgerEntry): Promise<void> {
    const fromKind = entry.from === 'room' ? 'room' : 'coo';
    const toKind = entry.to === undefined || entry.to === ''
      ? 'none'
      : entry.to === 'room' ? 'room' : 'coo';
    await this.db.prepare(
      `INSERT INTO ledger_entries(
         id, ts, room_id, kind, visibility, from_kind, from_coo_id, to_kind, to_coo_id,
         game, text, data_json, due_at, ref_entry_id, effect_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );

    const participants = new Set(entry.participants ?? []);
    if (participants.size > 0) {
      const statement = this.db.prepare(
        'INSERT INTO ledger_participants(entry_id, coo_id, position) VALUES (?, ?, ?)',
      );
      let position = 0;
      for (const cooId of participants) {
        if (typeof cooId !== 'string' || !cooId || cooId === 'room') continue;
        await statement.run(entry.id, cooId, position);
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
        await statement.run(entry.id, cooId);
      }
    }
  }

  private async entryOf(row: EntryRow): Promise<LedgerEntry> {
    const participants = (await this.db
      .prepare('SELECT coo_id FROM ledger_participants WHERE entry_id = ? ORDER BY position')
      .all(row.id) as { coo_id: string }[]).map((item) => item.coo_id);
    // SQLite 用 rowid 保插入顺序，PG 没有 rowid；赢家是无序集合，按 coo_id 排即可。
    const winners = (await this.db
      .prepare('SELECT coo_id FROM ledger_winners WHERE entry_id = ? ORDER BY coo_id')
      .all(row.id) as { coo_id: string }[]).map((item) => item.coo_id);
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
    if (data) entry.data = data;
    if (row.game) entry.game = row.game;
    if (row.ref_entry_id) entry.ref = row.ref_entry_id;
    if (typeof row.due_at === 'number') entry.due = row.due_at;
    if (row.effect_id) entry.effectId = row.effect_id;
    return entry;
  }
}
