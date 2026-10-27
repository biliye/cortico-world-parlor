/**
 * 客厅账本：只追加的事实记录 + 从记录现算的摘要。
 * 账本按 cooId（跨房稳定的身份）索引，不是按席位；房间只是记录发生的场所。
 * 目前只自动记牌局结果；礼物/承诺/欠账在这一层留好字段，下一版再接。
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type LedgerKind = 'game' | 'gift' | 'promise' | 'debt' | 'settle' | 'default' | 'note';
export type LedgerVisibility = 'room' | 'private';

/** 存盘与内核之间用的完整条目；对外的视图会去掉 cooId 列表。 */
export interface LedgerEntry {
  id: string;
  ts: number;
  room: string;
  kind: LedgerKind;
  /** 记录的人：cooId，或 `room`（牌局结算由房间记）。 */
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
}

/** 发给 World / 家长页的条目：不带别人的 cooId。 */
export interface LedgerEntryView {
  id: string;
  ts: number;
  room: string;
  kind: LedgerKind;
  text: string;
  data?: Record<string, unknown>;
  game?: string;
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

export interface LedgerSummary {
  cooId: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  /** 按游戏拆开的战绩，局数多的在前。 */
  byGame: GameTally[];
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

const KINDS: readonly LedgerKind[] = ['game', 'gift', 'promise', 'debt', 'settle', 'default', 'note'];
const DEFAULT_ENTRY_LIMIT = 5000;
const DEFAULT_IDENTITY_LIMIT = 500;
const COO_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SECRET_HASH = /^[0-9a-f]{64}$/;

export const isCooId = (value: unknown): value is string => typeof value === 'string' && COO_ID.test(value);

export const isCooSecret = (value: unknown): value is string => (
  typeof value === 'string' && value.length >= 16 && value.length <= 128
);

const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex');

const isEntry = (value: unknown): value is LedgerEntry => {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<LedgerEntry>;
  if (typeof entry.id !== 'string' || typeof entry.ts !== 'number') return false;
  if (typeof entry.room !== 'string' || typeof entry.from !== 'string') return false;
  if (!KINDS.includes(entry.kind as LedgerKind)) return false;
  if (entry.visibility !== 'room' && entry.visibility !== 'private') return false;
  return typeof entry.text === 'string';
};

const view = (entry: LedgerEntry): LedgerEntryView => ({
  id: entry.id,
  ts: entry.ts,
  room: entry.room,
  kind: entry.kind,
  text: entry.text,
  ...(entry.data ? { data: entry.data } : {}),
  ...(entry.kind === 'game' ? { game: gameOf(entry) } : {}),
});

export const UNKNOWN_GAME = 'unknown';

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
      recent: mine.slice(-5).reverse().map(view),
    };
  }

  /** 本房最近的公开条目，给房间里的所有人看；不含别人的 cooId。 */
  publicInRoom(room: string, limit = 5): LedgerEntryView[] {
    return this.entries
      .filter((entry) => entry.room === room && entry.visibility === 'room')
      .slice(-Math.max(1, limit))
      .reverse()
      .map(view);
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
