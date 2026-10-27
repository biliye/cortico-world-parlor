/**
 * 客厅账本：只追加的事实记录 + 从记录现算的摘要。
 * 账本按 cooId（跨房稳定的身份）索引，不是按席位；房间只是记录发生的场所。
 *
 * 两条原则：
 * 1. 不存状态，只存条目。承诺的状态（等回/已答应/已了结/已失约）由指向它的
 *    转移条目（accept/decline/cancel/settle/default）按时间现算。
 * 2. 筹码也只是条目上的转移：余额 = 所有 transfers 里进出这个 cooId 的和。
 *    没有余额字段，也就没有两处数字对不上的问题。
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type LedgerKind =
  | 'game' | 'ante' | 'gift' | 'promise' | 'debt' | 'settle' | 'default' | 'note'
  | 'accept' | 'decline' | 'cancel' | 'grant';
export type LedgerVisibility = 'room' | 'private';
export type PromiseStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'settled' | 'defaulted';

/** 一次筹码移动；`from: 'room'` 表示房间（发行/回收），不是任何人。 */
export interface ChipTransfer {
  from: string;
  to: string;
  amount: number;
}

/** 存盘与内核之间用的完整条目；对外的视图会去掉 cooId 列表与转移明细。 */
export interface LedgerEntry {
  id: string;
  ts: number;
  room: string;
  kind: LedgerKind;
  /** 记录的人：cooId，或 `room`（牌局结算、失约由房间记）。 */
  from: string;
  to?: string;
  participants?: string[];
  winners?: string[];
  text: string;
  visibility: LedgerVisibility;
  data?: Record<string, unknown>;
  /**
   * 牌局属于哪种游戏（`dice` / `ddz` / 以后游戏自己的 id）。账本只把它当标签，
   * 不认任何具体游戏名。老账本没有这一层，读的时候回落到 `data.game`。
   */
  game?: string;
  /** accept/decline/cancel/settle/default 指向的那条 promise。 */
  ref?: string;
  /** promise 的到期时间（epoch ms）。没有期限的承诺不会自动失约。 */
  due?: number;
  /** 这条记录涉及的筹码转移；只在存盘/内核里用，视图不带。 */
  transfers?: ChipTransfer[];
}

/** 发给 World / 家长页的条目：不带别人的 cooId，也不带转移明细。 */
export interface LedgerEntryView {
  id: string;
  ts: number;
  room: string;
  kind: LedgerKind;
  text: string;
  data?: Record<string, unknown>;
  game?: string;
  /** 只看自己的时候，这一条让自己增减了多少筹码。 */
  chips?: number;
}

/** 单种游戏的战绩；账本按条目里的 game 现算，不存计数器。 */
export interface GameTally {
  /** 游戏 id，如 `dice`、`ddz`；老条目/缺字段的是 `unknown`。 */
  game: string;
  /** 显示名，由游戏自己给（`data.gameLabel`）；没有就用 id。 */
  label: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
}

/** 未了结的承诺/欠账（pending = 等对方回，accepted = 已答应）。 */
export interface OpenLedgerItem {
  id: string;
  kind: 'promise' | 'debt';
  status: 'pending' | 'accepted';
  /** `in` = 对方欠我；`out` = 我欠对方。 */
  direction: 'in' | 'out';
  counterpart: string;
  text: string;
  due?: number;
  chips?: number;
}

export interface LedgerSummary {
  cooId: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  /** 按游戏拆开的战绩，局数多的在前。 */
  byGame: GameTally[];
  /** 当前筹码余额（所有条目上的转移现算）。 */
  chips: number;
  /** 未了结的承诺；没有期限、没人答应的也在里面。 */
  open: OpenLedgerItem[];
  recent: LedgerEntryView[];
}

export interface LedgerStoreOptions {
  file?: string;
  now?: () => number;
  entryLimit?: number;
  identityLimit?: number;
}

export type ClaimResult = 'ok' | 'mismatch' | 'invalid';

interface Identity {
  secretHash: string;
  createdAt: number;
}

interface LedgerState {
  version: 1;
  identities: Record<string, Identity>;
  entries: LedgerEntry[];
}

const KINDS: readonly LedgerKind[] = [
  'game', 'ante', 'gift', 'promise', 'debt', 'settle', 'default', 'note',
  'accept', 'decline', 'cancel', 'grant',
];
const DEFAULT_ENTRY_LIMIT = 5000;
const DEFAULT_IDENTITY_LIMIT = 500;
const COO_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SECRET_HASH = /^[0-9a-f]{64}$/;

/** 新身份第一次进房间发的筹码。 */
export const START_CHIPS = 1000;
/** 余额低于这个数才补，补到这个数，两次之间至少隔一段。 */
export const REFILL_BELOW = 100;
export const REFILL_TO = 300;
export const REFILL_GAP_MS = 6 * 60 * 60 * 1000;
/** 防刷屏：未了结承诺、每小时新社交条目、单条字数、单笔筹码。 */
export const MAX_OPEN_PROMISES = 5;
export const MAX_SOCIAL_PER_HOUR = 10;
export const MAX_SOCIAL_TEXT = 200;
export const MAX_CHIPS = 1_000_000;
export const MAX_DUE_MS = 90 * 24 * 60 * 60 * 1000;

export const UNKNOWN_GAME = 'unknown';

export const isCooId = (value: unknown): value is string => typeof value === 'string' && COO_ID.test(value);

export const isCooSecret = (value: unknown): value is string => (
  typeof value === 'string' && value.length >= 16 && value.length <= 128
);

const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex');

const isTransfer = (value: unknown): value is ChipTransfer => {
  if (!value || typeof value !== 'object') return false;
  const transfer = value as Partial<ChipTransfer>;
  return typeof transfer.from === 'string' && typeof transfer.to === 'string'
    && Number.isSafeInteger(transfer.amount) && (transfer.amount ?? 0) > 0;
};

const isEntry = (value: unknown): value is LedgerEntry => {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<LedgerEntry>;
  if (typeof entry.id !== 'string' || typeof entry.ts !== 'number') return false;
  if (typeof entry.room !== 'string' || typeof entry.from !== 'string') return false;
  if (!KINDS.includes(entry.kind as LedgerKind)) return false;
  if (entry.visibility !== 'room' && entry.visibility !== 'private') return false;
  return typeof entry.text === 'string';
};

/** 条目属于哪种游戏：顶层字段优先，老账本回落到 `data.game`。 */
export function gameOf(entry: LedgerEntry): string {
  if (typeof entry.game === 'string' && entry.game.length > 0) return entry.game;
  const legacy = entry.data?.game;
  if (typeof legacy === 'string' && legacy.length > 0) return legacy;
  return UNKNOWN_GAME;
}

/** 显示名：游戏在结束事件里给的 `gameLabel`；没有就用 id（unknown 写成「其他」）。 */
function labelOf(entry: LedgerEntry): string {
  const label = entry.data?.gameLabel;
  if (typeof label === 'string' && label.length > 0) return label;
  const game = gameOf(entry);
  return game === UNKNOWN_GAME ? '其他' : game;
}

/** 这条记录让某个 cooId 增减了多少筹码。 */
function netFor(entry: LedgerEntry, cooId: string): number {
  let net = 0;
  for (const transfer of entry.transfers ?? []) {
    if (transfer.to === cooId) net += transfer.amount;
    if (transfer.from === cooId) net -= transfer.amount;
  }
  return net;
}

const view = (entry: LedgerEntry, cooId?: string): LedgerEntryView => ({
  id: entry.id,
  ts: entry.ts,
  room: entry.room,
  kind: entry.kind,
  text: entry.text,
  ...(entry.data ? { data: entry.data } : {}),
  ...(entry.kind === 'game' ? { game: gameOf(entry) } : {}),
  ...(cooId && netFor(entry, cooId) !== 0 ? { chips: netFor(entry, cooId) } : {}),
});

/** 一条 promise 的状态。按追加顺序取最后一条指向它的转移。 */
const STATUS_BY_KIND: Partial<Record<LedgerKind, PromiseStatus>> = {
  accept: 'accepted',
  decline: 'declined',
  cancel: 'cancelled',
  settle: 'settled',
  default: 'defaulted',
};

export class LedgerStore {
  private entries: LedgerEntry[] = [];
  private readonly identities = new Map<string, Identity>();
  private readonly file?: string;
  private readonly now: () => number;
  private readonly entryLimit: number;
  private readonly identityLimit: number;

  constructor(options: LedgerStoreOptions = {}) {
    this.file = options.file;
    this.now = options.now ?? Date.now;
    this.entryLimit = options.entryLimit ?? DEFAULT_ENTRY_LIMIT;
    this.identityLimit = options.identityLimit ?? DEFAULT_IDENTITY_LIMIT;
  }

  static load(options: LedgerStoreOptions = {}): LedgerStore {
    const store = new LedgerStore(options);
    if (!options.file || !existsSync(options.file)) return store;
    try {
      const raw = JSON.parse(readFileSync(options.file, 'utf8')) as Partial<LedgerState>;
      if (raw.version !== 1) return store;
      if (Array.isArray(raw.entries)) {
        store.entries = raw.entries
          .filter(isEntry)
          .slice(-store.entryLimit)
          .map((entry) => ({
            ...entry,
            participants: Array.isArray(entry.participants) ? entry.participants.filter((id) => typeof id === 'string') : undefined,
            winners: Array.isArray(entry.winners) ? entry.winners.filter((id) => typeof id === 'string') : undefined,
            ...(Number.isFinite(entry.due) ? { due: Number(entry.due) } : { due: undefined }),
            ...(Array.isArray(entry.transfers) ? { transfers: entry.transfers.filter(isTransfer) } : { transfers: undefined }),
          }));
      }
      if (raw.identities && typeof raw.identities === 'object') {
        for (const [cooId, identity] of Object.entries(raw.identities)) {
          if (!isCooId(cooId) || !identity || typeof identity.secretHash !== 'string') continue;
          if (!SECRET_HASH.test(identity.secretHash)) continue;
          store.identities.set(cooId, {
            secretHash: identity.secretHash,
            createdAt: Number(identity.createdAt) || 0,
          });
        }
      }
    } catch { /* 坏文件从空账本开始，不阻断房间 */ }
    return store;
  }

  /** 绑定或校验跨房身份。同一个 cooId 只有同一个 secret 能重入。 */
  claimIdentity(cooId: string, secret: string): ClaimResult {
    if (!isCooId(cooId) || !isCooSecret(secret)) return 'invalid';
    const hash = hashSecret(secret);
    const existing = this.identities.get(cooId);
    if (existing) {
      const left = Buffer.from(existing.secretHash, 'hex');
      const right = Buffer.from(hash, 'hex');
      return left.length === right.length && timingSafeEqual(left, right) ? 'ok' : 'mismatch';
    }
    if (this.identities.size >= this.identityLimit) return 'invalid';
    this.identities.set(cooId, { secretHash: hash, createdAt: this.now() });
    this.save();
    return 'ok';
  }

  record(input: Omit<LedgerEntry, 'id' | 'ts'>): LedgerEntry {
    const entry: LedgerEntry = { id: randomUUID(), ts: this.now(), ...input };
    this.entries.push(entry);
    if (this.entries.length > this.entryLimit) {
      this.entries.splice(0, this.entries.length - this.entryLimit);
    }
    this.save();
    return entry;
  }

  byId(id: string): LedgerEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  /** 按完整 id 或唯一前缀找条目；前缀撞了就返回 undefined。 */
  find(idOrPrefix: string): LedgerEntry | undefined {
    const needle = idOrPrefix.trim().toLowerCase();
    if (!needle) return undefined;
    const exact = this.entries.find((entry) => entry.id.toLowerCase() === needle);
    if (exact) return exact;
    const hits = this.entries.filter((entry) => entry.id.toLowerCase().startsWith(needle));
    return hits.length === 1 ? hits[0] : undefined;
  }

  /** 一条 promise 现在的状态；不是 promise 返回 null。 */
  promiseStatus(promise: LedgerEntry): PromiseStatus | null {
    if (promise.kind !== 'promise' && promise.kind !== 'debt') return null;
    let status: PromiseStatus = 'pending';
    for (const entry of this.entries) {
      if (entry.ref !== promise.id) continue;
      const mapped = STATUS_BY_KIND[entry.kind];
      if (mapped) status = mapped;
    }
    return status;
  }

  /** 某人的未了结承诺（等对方回 / 已答应）。 */
  openFor(cooId: string): OpenLedgerItem[] {
    const open: OpenLedgerItem[] = [];
    for (const entry of this.entries) {
      if (entry.kind !== 'promise' && entry.kind !== 'debt') continue;
      if (entry.from !== cooId && entry.to !== cooId) continue;
      const status = this.promiseStatus(entry);
      if (status !== 'pending' && status !== 'accepted') continue;
      const direction = entry.from === cooId ? 'out' : 'in';
      const name = direction === 'out' ? entry.data?.toName : entry.data?.fromName;
      const chips = entry.data?.chips;
      open.push({
        id: entry.id,
        kind: entry.kind,
        status,
        direction,
        counterpart: typeof name === 'string' && name ? name : '某个席位',
        text: entry.text,
        ...(typeof entry.due === 'number' ? { due: entry.due } : {}),
        ...(typeof chips === 'number' && chips > 0 ? { chips } : {}),
      });
    }
    return open.sort((left, right) => (left.due ?? Number.MAX_SAFE_INTEGER) - (right.due ?? Number.MAX_SAFE_INTEGER));
  }

  countOpenPromises(cooId: string): number {
    return this.openFor(cooId).length;
  }

  /** 这个 cooId 在某时刻之后新写了多少条社交条目（礼物 + 承诺）。 */
  socialCountSince(cooId: string, since: number): number {
    return this.entries.filter((entry) => (
      entry.from === cooId
      && (entry.kind === 'gift' || entry.kind === 'promise')
      && entry.ts >= since
    )).length;
  }

  /** 筹码余额：所有条目上的转移现算；`room` 是发行方，不计余额。 */
  balanceOf(cooId: string): number {
    let total = 0;
    for (const entry of this.entries) total += netFor(entry, cooId);
    return total;
  }

  /** 新身份第一次进房间时发筹码；已经发过就返回 null。 */
  ensureGrant(cooId: string, room: string): LedgerEntry | null {
    if (!cooId) return null;
    if (this.entries.some((entry) => entry.kind === 'grant' && entry.to === cooId)) return null;
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
  }

  /** 余额见底时补一点，隔一段时间最多一次；返回新发的条目。 */
  maybeRefill(cooId: string, room: string, now = this.now()): LedgerEntry | null {
    if (this.balanceOf(cooId) >= REFILL_BELOW) return null;
    const last = this.entries
      .filter((entry) => entry.kind === 'grant' && entry.to === cooId && entry.data?.refill === true)
      .at(-1);
    if (last && now - last.ts < REFILL_GAP_MS) return null;
    const amount = Math.max(0, REFILL_TO - this.balanceOf(cooId));
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
  }

  /** 到期没结的承诺由服务器追加一条 default；已经有 default 的不会再写。 */
  expire(now = this.now()): LedgerEntry[] {
    // 已经收尾的（了结/拒绝/撤回/失约）不再看；到期扫描每秒都会跑，别重复翻旧账。
    const closed = new Set<string>();
    for (const entry of this.entries) {
      if (entry.ref && (entry.kind === 'settle' || entry.kind === 'decline' || entry.kind === 'cancel' || entry.kind === 'default')) {
        closed.add(entry.ref);
      }
    }
    const due = this.entries.filter((entry) => (
      entry.kind === 'promise'
      && typeof entry.due === 'number'
      && entry.due <= now
      && !closed.has(entry.id)
    ));
    const created: LedgerEntry[] = [];
    for (const promise of due) {
      if (this.promiseStatus(promise) !== 'accepted') continue;
      created.push(this.record({
        kind: 'default',
        ref: promise.id,
        room: promise.room,
        from: 'room',
        to: promise.to,
        participants: [promise.from, promise.to].filter((id): id is string => !!id),
        text: promise.text,
        visibility: 'private',
        data: { fromName: '房间', toName: promise.data?.fromName ?? '' },
      }));
    }
    return created;
  }

  summaryFor(cooId: string): LedgerSummary {
    const mine = this.entries.filter((entry) => (
      entry.from === cooId
      || entry.to === cooId
      || entry.participants?.includes(cooId)
    ));
    let games = 0;
    let wins = 0;
    let losses = 0;
    let draws = 0;
    const byGame = new Map<string, GameTally>();
    for (const entry of mine) {
      if (entry.kind !== 'game') continue;
      games += 1;
      const game = gameOf(entry);
      let tally = byGame.get(game);
      if (!tally) {
        tally = { game, label: labelOf(entry), games: 0, wins: 0, losses: 0, draws: 0 };
        byGame.set(game, tally);
      } else if (tally.label === game || tally.label === '其他') {
        // 老条目没带显示名，后来的条目带了就用后者的。
        tally.label = labelOf(entry);
      }
      tally.games += 1;
      if (!entry.winners?.includes(cooId)) {
        losses += 1;
        tally.losses += 1;
      } else if (entry.data?.tie === true) {
        draws += 1;
        tally.draws += 1;
      } else {
        wins += 1;
        tally.wins += 1;
      }
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
      chips: this.balanceOf(cooId),
      open: this.openFor(cooId),
      recent: mine.slice(-5).reverse().map((entry) => view(entry, cooId)),
    };
  }

  /** 本房最近的公开条目，给房间里的所有人看；不含别人的 cooId。 */
  publicInRoom(room: string, limit = 5): LedgerEntryView[] {
    return this.entries
      .filter((entry) => entry.room === room && entry.visibility === 'room')
      .slice(-Math.max(1, limit))
      .reverse()
      .map((entry) => view(entry));
  }

  count(): number {
    return this.entries.length;
  }

  flush(): void {
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const state: LedgerState = {
        version: 1,
        identities: Object.fromEntries(this.identities),
        entries: this.entries,
      };
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.file);
      chmodSync(this.file, 0o600);
    } catch { /* 账本写不进去不阻断牌局 */ }
  }
}
