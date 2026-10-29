/**
 * 家长账户与全局 ownerKey。
 *
 * 一个 Coo 一个家长账户（1:1），没有用户名/密码：Coo 第一次注册身份时自动建账户，
 * 服务器生成一把全局 ownerKey，明文只交给 Coo 部署（.env），服务器只存哈希。
 * 扩展面板的家长链接用这把 key 换会话；轮换 key 会踢掉旧会话。
 *
 * 这把 key 是“这一个 Coo 的家长钥匙”，不是每个客厅一份，也不是整个服务器一份。
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isCooId } from './ledger.ts';

export const ACCOUNT_FILE = 'accounts.json';
export const DEFAULT_ACCOUNT_LIMIT = 500;
export const MAX_DISPLAY_NAME = 24;

const OWNER_KEY_BYTES = 24;
const OWNER_KEY_HASH = /^[0-9a-f]{64}$/;

export interface ParentAccount {
  id: string;
  cooId: string;
  displayName: string;
  createdAt: number;
  ownerKeyHash: string;
  /** 轮换 key / 退出所有设备时 +1；会话拿旧版本就失效。 */
  sessionVersion: number;
}

/** 发给网页/World 的账户视图：不带 ownerKeyHash。 */
export interface AccountView {
  id: string;
  cooId: string;
  displayName: string;
  createdAt: number;
}

export interface AccountStoreOptions {
  file?: string;
  now?: () => number;
  limit?: number;
}

export interface EnsureAccountResult {
  account: ParentAccount;
  /** 只在这次新建时返回；之后只能从 Coo 部署的 .env 拿，或显式轮换。 */
  ownerKey?: string;
  created: boolean;
}

interface AccountState {
  version: 1;
  accounts: ParentAccount[];
}

const cleanName = (value: unknown): string => (
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, MAX_DISPLAY_NAME) : ''
);

/** ownerKey 是 24 字节随机；SHA-256 足够，不拿它当低熵密码。 */
const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');

const sameHash = (a: string, b: string): boolean => {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
};

const makeOwnerKey = (): string => randomBytes(OWNER_KEY_BYTES).toString('base64url');

const isAccount = (value: unknown): value is ParentAccount => {
  if (!value || typeof value !== 'object') return false;
  const account = value as Partial<ParentAccount>;
  return typeof account.id === 'string' && account.id.length > 0
    && isCooId(account.cooId)
    && typeof account.displayName === 'string'
    && typeof account.ownerKeyHash === 'string' && OWNER_KEY_HASH.test(account.ownerKeyHash)
    && Number.isFinite(account.createdAt)
    && Number.isSafeInteger(account.sessionVersion) && (account.sessionVersion ?? 0) >= 1;
};

export const publicAccount = (account: ParentAccount): AccountView => ({
  id: account.id,
  cooId: account.cooId,
  displayName: account.displayName,
  createdAt: account.createdAt,
});

export class AccountStore {
  private accounts: ParentAccount[] = [];
  private readonly file?: string;
  private readonly now: () => number;
  private readonly limit: number;

  constructor(options: AccountStoreOptions = {}) {
    this.file = options.file;
    this.now = options.now ?? Date.now;
    this.limit = options.limit ?? DEFAULT_ACCOUNT_LIMIT;
  }

  static load(options: AccountStoreOptions = {}): AccountStore {
    const store = new AccountStore(options);
    if (!options.file) return store;
    try {
      const raw = JSON.parse(readFileSync(options.file, 'utf8')) as Partial<AccountState>;
      if (raw.version !== 1 || !Array.isArray(raw.accounts)) return store;
      const seenCoo = new Set<string>();
      const seenId = new Set<string>();
      for (const entry of raw.accounts) {
        if (!isAccount(entry)) continue;
        if (seenCoo.has(entry.cooId) || seenId.has(entry.id)) continue;
        seenCoo.add(entry.cooId);
        seenId.add(entry.id);
        store.accounts.push({
          id: entry.id,
          cooId: entry.cooId,
          displayName: cleanName(entry.displayName) || '家长',
          createdAt: Number(entry.createdAt) || 0,
          ownerKeyHash: entry.ownerKeyHash,
          sessionVersion: Number(entry.sessionVersion) || 1,
        });
        if (store.accounts.length >= store.limit) break;
      }
    } catch { /* 坏文件从空账户表开始，不阻断客厅 */ }
    return store;
  }

  get size(): number {
    return this.accounts.length;
  }

  byCooId(cooId: string): ParentAccount | undefined {
    return this.accounts.find((account) => account.cooId === cooId);
  }

  byId(id: string): ParentAccount | undefined {
    return this.accounts.find((account) => account.id === id);
  }

  /**
   * 自动注册：一个 cooId 只建一个账户。已存在时原样返回，不改名字（改名走 rename）。
   * 新建时返回一次 ownerKey；之后只能从部署的 .env 拿，或轮换。
   */
  ensureAccount(cooId: string, displayName?: string): EnsureAccountResult {
    if (!isCooId(cooId)) throw new Error('cooId 格式不对');
    const existing = this.byCooId(cooId);
    if (existing) return { account: existing, created: false };
    if (this.accounts.length >= this.limit) throw new Error('家长账户表满了');

    const ownerKey = makeOwnerKey();
    const account: ParentAccount = {
      id: randomUUID(),
      cooId,
      displayName: cleanName(displayName) || '家长',
      createdAt: this.now(),
      ownerKeyHash: hashKey(ownerKey),
      sessionVersion: 1,
    };
    this.accounts.push(account);
    this.save();
    return { account, ownerKey, created: true };
  }

  /** 用 ownerKey 找账户；找不到或格式不对返回 null。 */
  verifyOwnerKey(key: string): ParentAccount | null {
    if (typeof key !== 'string' || key.length < 16 || key.length > 128) return null;
    const hash = hashKey(key);
    for (const account of this.accounts) {
      if (sameHash(account.ownerKeyHash, hash)) return account;
    }
    return null;
  }

  /** 换一把 ownerKey；旧 key 立即失效，所有旧会话也失效。 */
  rotateOwnerKey(cooId: string): string | null {
    const account = this.byCooId(cooId);
    if (!account) return null;
    const ownerKey = makeOwnerKey();
    account.ownerKeyHash = hashKey(ownerKey);
    account.sessionVersion += 1;
    this.save();
    return ownerKey;
  }

  /** 登录后改显示名；空名字拒绝。 */
  rename(accountId: string, displayName: string): ParentAccount | null {
    const account = this.byId(accountId);
    const name = cleanName(displayName);
    if (!account || !name) return null;
    account.displayName = name;
    this.save();
    return account;
  }

  /** 退出所有设备；不动 ownerKey。 */
  bumpSession(accountId: string): boolean {
    const account = this.byId(accountId);
    if (!account) return false;
    account.sessionVersion += 1;
    this.save();
    return true;
  }

  view(account: ParentAccount): AccountView {
    return publicAccount(account);
  }

  views(): AccountView[] {
    return this.accounts.map(publicAccount);
  }

  all(): ParentAccount[] {
    return [...this.accounts];
  }

  toJSON(): AccountState {
    return { version: 1, accounts: this.accounts };
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.toJSON())}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, this.file);
    chmodSync(this.file, 0o600);
  }
}
