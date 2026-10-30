/**
 * 全局 Coo 身份 + 家长账户的 SQLite store。
 *
 * 一个 Coo 一个家长账户（1:1）：Coo 第一次注册身份时自动建账户，服务器生成一把
 * 全局 ownerKey，明文只在创建/轮换时交给调用方一次；库里只存 SHA-256 哈希。
 * 账户视图（views()/publicAccount）不包含 ownerKeyHash。
 *
 * 与 accounts.ts（JSON 原型）语义一致，但唯一真相在 coos/accounts 两张表：
 * - accounts.coo_id 的 UNIQUE 管住「一个 Coo 一个账户」；
 * - accounts.owner_key_hash 的 UNIQUE 管住「一把 key 只对应一个账户」；
 * - session_version 在轮换 key / 退出所有设备时 +1，旧会话按版本失效。
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { migrate, openDb, withTransaction, type Db } from './db.ts';
import { isCooId, isCooSecret, type ClaimResult } from './ledger.ts';

export const DEFAULT_ACCOUNT_LIMIT = 500;
export const MAX_DISPLAY_NAME = 24;
/** ownerKey 是 24 字节随机；SHA-256 足够，不拿它当低熵密码。 */
export const OWNER_KEY_BYTES = 24;

export const COO_KINDS = ['pet', 'human', 'legacy', 'system'] as const;
export type CooKind = (typeof COO_KINDS)[number];
export type CooStatus = 'active' | 'disabled';

export const isCooKind = (value: unknown): value is CooKind => (
  typeof value === 'string' && (COO_KINDS as readonly string[]).includes(value)
);

export interface ParentAccount {
  id: string;
  cooId: string;
  displayName: string;
  createdAt: number;
  ownerKeyHash: string;
  /** 轮换 key / 退出所有设备时 +1；会话拿旧版本就失效。 */
  sessionVersion: number;
  lastLoginAt: number | null;
  status: CooStatus;
}

/** 发给网页/World 的账户视图：不带 ownerKeyHash。 */
export interface AccountView {
  id: string;
  cooId: string;
  displayName: string;
  createdAt: number;
}

export interface CooRecord {
  id: string;
  kind: CooKind;
  displayName: string;
  createdAt: number;
  lastSeenAt: number | null;
  status: CooStatus;
  /** coos.secret_hash 是否存在；哈希本身不往外给。 */
  hasSecret: boolean;
}

/** 家长门户的会话：只存 token 哈希，明文只在 Set-Cookie 时出现一次。 */
export interface ParentSession {
  id: string;
  accountId: string;
  token: string;
  createdAt: number;
  expiresAt: number;
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

export interface CooAccountDbOptions {
  now?: () => number;
  limit?: number;
}

export interface EnsureAccountResult {
  account: ParentAccount;
  /** 只在这次新建时返回；之后只能从 Coo 部署的 .env 拿，或显式轮换。 */
  ownerKey?: string;
  created: boolean;
}

interface AccountRow {
  id: string;
  coo_id: string;
  display_name: string;
  owner_key_hash: string;
  session_version: number;
  created_at: number;
  last_login_at: number | null;
  status: string;
}

interface CooRow {
  id: string;
  kind: string;
  display_name: string;
  secret_hash: string | null;
  created_at: number;
  last_seen_at: number | null;
  status: string;
}

const ACCOUNT_COLUMNS = 'id, coo_id, display_name, owner_key_hash, session_version, created_at, last_login_at, status';
const ACCOUNT_COLUMNS_A = 'a.id, a.coo_id, a.display_name, a.owner_key_hash, a.session_version, a.created_at, a.last_login_at, a.status';
const COO_COLUMNS = 'id, kind, display_name, secret_hash, created_at, last_seen_at, status';
const HEX64 = /^[0-9a-f]{64}$/;
const OWNER_KEY_SHAPE = /^[A-Za-z0-9_-]{32}$/;

const cleanName = (value: unknown): string => (
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, MAX_DISPLAY_NAME) : ''
);

const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');

const sameHash = (a: string, b: string): boolean => {
  if (!HEX64.test(a) || !HEX64.test(b)) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
};

const makeOwnerKey = (): string => randomBytes(OWNER_KEY_BYTES).toString('base64url');

const toParentAccount = (row: AccountRow): ParentAccount => ({
  id: row.id,
  cooId: row.coo_id,
  displayName: row.display_name,
  createdAt: Number(row.created_at),
  ownerKeyHash: row.owner_key_hash,
  sessionVersion: Number(row.session_version),
  lastLoginAt: row.last_login_at === null ? null : Number(row.last_login_at),
  status: row.status === 'disabled' ? 'disabled' : 'active',
});

/** 默认的账户视图：永远不带 ownerKeyHash。 */
export const publicAccount = (account: ParentAccount): AccountView => ({
  id: account.id,
  cooId: account.cooId,
  displayName: account.displayName,
  createdAt: account.createdAt,
});

let savepointSeq = 0;

/**
 * 一段写入要原子生效。外层没有事务时用 withTransaction（BEGIN IMMEDIATE）；
 * 已经被调用方包在事务里时改用 SAVEPOINT，只回滚这一段，不拆外层事务。
 */
const atomically = <T>(db: Db, fn: () => T): T => {
  const flag = (db as Db & { isTransaction?: boolean }).isTransaction;
  if (flag === false) return withTransaction(db, fn);
  savepointSeq += 1;
  const name = `coo_account_sp_${savepointSeq}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const value = fn();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return value;
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      db.exec(`RELEASE SAVEPOINT ${name}`);
    } catch { /* 连接已经坏了；保留原始错误 */ }
    throw error;
  }
};

export class CooAccountDb {
  readonly db: Db;
  private readonly now: () => number;
  private readonly limit: number;

  constructor(db: Db, options: CooAccountDbOptions = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
    const limit = options.limit ?? DEFAULT_ACCOUNT_LIMIT;
    this.limit = Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_ACCOUNT_LIMIT;
  }

  get size(): number {
    return this.count();
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number };
    return Number(row.n);
  }

  /**
   * 注册/认领一份全局 Coo 身份。第一次带 secret 注册就建 coos 行；
   * 已存在且 secret 对得上返回 ok（只更新 last_seen_at），对不上返回 mismatch。
   * 同一个 secret 不能绑到第二个 coo（secret_hash 的唯一索引兜底）。
   */
  registerCoo(cooId: string, secret: string, kind: CooKind = 'pet', displayName = ''): ClaimResult {    if (!isCooId(cooId) || !isCooSecret(secret) || !isCooKind(kind)) return 'invalid';
    const hash = hashKey(secret);
    return atomically(this.db, () => {
      const row = this.cooRow(cooId);
      const now = this.now();
      const holder = this.db.prepare('SELECT id FROM coos WHERE secret_hash = ?').get(hash) as { id: string } | undefined;
      if (holder && holder.id !== cooId) return 'invalid';

      if (!row) {
        this.db.prepare(
          `INSERT INTO coos(id, kind, display_name, secret_hash, created_at, last_seen_at, status)
           VALUES (?, ?, ?, ?, ?, ?, 'active')`,
        ).run(cooId, kind, cleanName(displayName), hash, now, now);
        return 'ok';
      }
      if (row.status !== 'active') return 'invalid';
      if (!row.secret_hash) {
        // 先由 ensureAccount 建的占位身份：第一次带 secret 注册时认领它。
        const name = cleanName(displayName);
        this.db.prepare(
          `UPDATE coos SET secret_hash = ?, kind = ?,
             display_name = CASE WHEN ? <> '' THEN ? ELSE display_name END,
             last_seen_at = ?
           WHERE id = ?`,
        ).run(hash, kind, name, name, now, cooId);
        return 'ok';
      }
      if (!sameHash(row.secret_hash, hash)) return 'mismatch';
      this.db.prepare('UPDATE coos SET last_seen_at = ? WHERE id = ?').run(now, cooId);
      return 'ok';
    });
  }

  /**
   * 只校验，不自动注册。未知 coo、没注册过 secret、被禁用都算 invalid；
   * 已注册但 secret 不同是 mismatch。
   */
  claimIdentity(cooId: string, secret: string): ClaimResult {
    if (!isCooId(cooId) || !isCooSecret(secret)) return 'invalid';
    return atomically(this.db, () => {
      const row = this.cooRow(cooId);
      if (!row || row.status !== 'active' || !row.secret_hash) return 'invalid';
      if (!sameHash(row.secret_hash, hashKey(secret))) return 'mismatch';
      this.db.prepare('UPDATE coos SET last_seen_at = ? WHERE id = ?').run(this.now(), cooId);
      return 'ok';
    });
  }

  /** 家长自己下场用的固定玩家身份（human coo）；第一次下场时才建。 */
  playerCooOf(accountId: string): string | null {
    const row = this.db.prepare('SELECT player_coo_id FROM accounts WHERE id = ?')
      .get(accountId) as { player_coo_id: string | null } | undefined;
    return row?.player_coo_id ?? null;
  }

  /** 这个 coo 的显示名（家长玩家席位沿用它，换房不丢名字）。 */
  cooDisplayName(cooId: string): string {
    const row = this.cooRow(cooId);
    return row ? row.display_name : '';
  }

  /** 改 coo 的显示名（不动 secret、不动身份）。 */
  renameCooDisplay(cooId: string, displayName: string): boolean {
    const name = cleanName(displayName);
    if (!name) return false;
    const result = this.db.prepare('UPDATE coos SET display_name = ? WHERE id = ?').run(name, cooId);
    return Number(result.changes) > 0;
  }

  bindPlayerCoo(accountId: string, cooId: string): void {
    this.db.prepare('UPDATE accounts SET player_coo_id = ? WHERE id = ?').run(cooId, accountId);
  }

  /**
   * 给已存在的 coo 换一个新 secret（旧 secret 立即失效）。
   * 家长每次下场玩都会拿一枚新的；数据库仍然只存哈希。
   */
  rotateSecret(cooId: string, secret: string): void {
    const row = this.cooRow(cooId);
    if (!row) throw new Error('这个 Coo 身份不存在');
    this.db.prepare('UPDATE coos SET secret_hash = ?, last_seen_at = ? WHERE id = ?')
      .run(hashKey(secret), this.now(), cooId);
  }

  /**
   * 自动注册：一个 cooId 只建一个账户。已存在时原样返回，不改名字（改名走 rename）。
   * 新建时返回一次 ownerKey；之后只能从部署的 .env 拿，或轮换。
   * 若 coo 还没注册身份，会在 coos 里先建一个占位（没 secret），之后可由 registerCoo 认领。
   */
  ensureAccount(cooId: string, displayName?: string): EnsureAccountResult {
    if (!isCooId(cooId)) throw new Error('cooId 格式不对');
    return atomically(this.db, () => {
      const existing = this.byCooId(cooId);
      if (existing) return { account: existing, created: false };
      if (this.count() >= this.limit) throw new Error('家长账户表满了');

      const name = cleanName(displayName) || this.defaultAccountName(cooId);
      const now = this.now();
      if (!this.cooRow(cooId)) {
        this.db.prepare(
          `INSERT INTO coos(id, kind, display_name, secret_hash, created_at, last_seen_at, status)
           VALUES (?, 'pet', ?, NULL, ?, ?, 'active')`,
        ).run(cooId, name, now, now);
      }

      const ownerKey = makeOwnerKey();
      const account: ParentAccount = {
        id: randomUUID(),
        cooId,
        displayName: name || '家长',
        createdAt: now,
        ownerKeyHash: hashKey(ownerKey),
        sessionVersion: 1,
        lastLoginAt: null,
        status: 'active',
      };
      this.insertAccount(account);
      return { account, ownerKey, created: true };
    });
  }

  /** 家长账户的默认显示名：「<孩子名>的家长」；孩子不在座就退回 coo 显示名，最后「家长」。 */
  private defaultAccountName(cooId: string): string {
    const seat = this.db.prepare(
      'SELECT name FROM room_seats WHERE coo_id = ? AND released_at IS NULL ORDER BY joined_at DESC LIMIT 1',
    ).get(cooId) as { name: string } | undefined;
    const child = (seat?.name || this.cooRow(cooId)?.display_name || '').trim();
    return child ? cleanName(`${child}的家长`) : '家长';
  }

  /** 用 ownerKey 找账户；找不到/格式不对/账户或 coo 被禁用返回 null。 */
  verifyOwnerKey(key: string): ParentAccount | null {
    if (typeof key !== 'string' || key.length < 16 || key.length > 128) return null;
    const row = this.db.prepare(
      `SELECT ${ACCOUNT_COLUMNS_A}
         FROM accounts a JOIN coos c ON c.id = a.coo_id
        WHERE a.owner_key_hash = ? AND a.status = 'active' AND c.status = 'active'`,
    ).get(hashKey(key)) as AccountRow | undefined;
    return row ? toParentAccount(row) : null;
  }

  /** 换一把 ownerKey；旧 key 立即失效，session_version +1，所有旧会话也失效。 */
  rotateOwnerKey(cooId: string): string | null {
    if (!isCooId(cooId)) return null;
    return atomically(this.db, () => {
      const account = this.byCooId(cooId);
      const coo = this.cooRow(cooId);
      if (!account || account.status !== 'active' || !coo || coo.status !== 'active') return null;
      const ownerKey = makeOwnerKey();
      this.db.prepare(
        'UPDATE accounts SET owner_key_hash = ?, session_version = session_version + 1 WHERE id = ?',
      ).run(hashKey(ownerKey), account.id);
      return ownerKey;
    });
  }

  /** 登录后改显示名；空名字拒绝。 */
  rename(accountId: string, displayName: string): ParentAccount | null {
    if (typeof accountId !== 'string' || accountId.length === 0) return null;
    const name = cleanName(displayName);
    if (!name) return null;
    return atomically(this.db, () => {
      const result = this.db.prepare('UPDATE accounts SET display_name = ? WHERE id = ?').run(name, accountId);
      if (Number(result.changes) === 0) return null;
      return this.byId(accountId) ?? null;
    });
  }

  /** 退出所有设备；不动 ownerKey，session_version +1。 */
  bumpSession(accountId: string): boolean {
    if (typeof accountId !== 'string' || accountId.length === 0) return false;
    const result = this.db.prepare(
      'UPDATE accounts SET session_version = session_version + 1 WHERE id = ?',
    ).run(accountId);
    return Number(result.changes) > 0;
  }

  byCooId(cooId: string): ParentAccount | undefined {
    const row = this.db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE coo_id = ?`)
      .get(cooId) as AccountRow | undefined;
    return row ? toParentAccount(row) : undefined;
  }

  byId(accountId: string): ParentAccount | undefined {
    const row = this.db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`)
      .get(accountId) as AccountRow | undefined;
    return row ? toParentAccount(row) : undefined;
  }

  /** 全局 Coo 身份；不含 secret 哈希。 */
  findCoo(cooId: string): CooRecord | undefined {
    const row = this.cooRow(cooId);
    if (!row) return undefined;
    return {
      id: row.id,
      kind: isCooKind(row.kind) ? row.kind : 'legacy',
      displayName: row.display_name,
      createdAt: Number(row.created_at),
      lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at),
      status: row.status === 'disabled' ? 'disabled' : 'active',
      hasSecret: row.secret_hash !== null && row.secret_hash !== '',
    };
  }

  view(account: ParentAccount): AccountView {
    return publicAccount(account);
  }

  /** 所有账户的对外视图；不带 ownerKeyHash。 */
  views(): AccountView[] {
    return this.all().map(publicAccount);
  }

  /** 所有账户（含哈希，仅供服务端内部用）。 */
  all(): ParentAccount[] {
    const rows = this.db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY created_at, id`)
      .all() as unknown as AccountRow[];
    return rows.map(toParentAccount);
  }

  /** 给家长门户开一个会话；调用方先用 verifyOwnerKey 认过人。 */
  createSession(accountId: string, ttlMs = SESSION_TTL_MS): ParentSession | null {
    const account = this.byId(accountId);
    if (!account || account.status !== 'active') return null;
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const now = this.now();
    const expiresAt = now + Math.max(60_000, ttlMs);
    this.db.prepare(
      `INSERT INTO account_sessions(id, account_id, token_hash, session_version, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, accountId, hashKey(token), account.sessionVersion, now, now, expiresAt);
    return { id, accountId, token, createdAt: now, expiresAt };
  }

  /** 认会话：过期、被撤销、版本变了（轮换 key/退出所有设备）都不认。 */
  verifySession(token: string): { account: ParentAccount; sessionId: string; expiresAt: number } | null {
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
    const row = this.db.prepare(
      `SELECT s.id AS session_id, s.session_version AS session_version, s.expires_at AS expires_at,
              ${ACCOUNT_COLUMNS_A}
         FROM account_sessions s
         JOIN accounts a ON a.id = s.account_id
         JOIN coos c ON c.id = a.coo_id
        WHERE s.token_hash = ? AND s.revoked_at IS NULL
          AND s.expires_at > ?
          AND a.status = 'active' AND c.status = 'active'`,
    ).get(hashKey(token), this.now()) as (AccountRow & {
      session_id: string; session_version: number; expires_at: number;
    }) | undefined;
    if (!row) return null;
    const account = toParentAccount(row);
    if (Number(row.session_version) !== account.sessionVersion) return null;
    this.db.prepare('UPDATE account_sessions SET last_seen_at = ? WHERE id = ?')
      .run(this.now(), row.session_id);
    return { account, sessionId: row.session_id, expiresAt: Number(row.expires_at) };
  }

  revokeSession(token: string): boolean {
    const result = this.db.prepare(
      'UPDATE account_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
    ).run(this.now(), hashKey(token));
    return Number(result.changes) > 0;
  }

  /** 轮换 key / 退出所有设备时顺手撤掉所有会话。 */
  revokeAllSessions(accountId: string): void {
    this.db.prepare('UPDATE account_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL')
      .run(this.now(), accountId);
  }

  private cooRow(cooId: string): CooRow | undefined {
    return this.db.prepare(`SELECT ${COO_COLUMNS} FROM coos WHERE id = ?`).get(cooId) as CooRow | undefined;
  }

  private insertAccount(account: ParentAccount): void {
    this.db.prepare(
      `INSERT INTO accounts(id, coo_id, display_name, owner_key_hash, session_version, created_at, last_login_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      account.id,
      account.cooId,
      account.displayName,
      account.ownerKeyHash,
      account.sessionVersion,
      account.createdAt,
      account.lastLoginAt,
      account.status,
    );
  }
}

/** 打开（或新建）一个库并建表，返回 store；用完由调用方关闭 `store.db`。 */
export const openCooAccountDb = (
  file = ':memory:',
  options: CooAccountDbOptions = {},
): CooAccountDb => {
  const db = openDb(file);
  migrate(db);
  return new CooAccountDb(db, options);
};

/** 只给测试/诊断用：判断字符串是不是本模块生成的 ownerKey 形状。 */
export const isOwnerKeyShape = (value: unknown): value is string => (
  typeof value === 'string' && OWNER_KEY_SHAPE.test(value)
);
