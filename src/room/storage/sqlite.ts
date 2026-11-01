/**
 * SQLite 适配器：把 node:sqlite 的同步调用包成异步接口。
 *
 * 一个 Db 实例只有一条连接。异步化之后，别的请求的语句完全可能在
 * 「BEGIN…COMMIT」之间插进来，所以这里做两件事：
 *
 * 1. 连接互斥：不在事务里时，每条语句、每次 exec 都排队独占连接；
 * 2. 事务上下文：用一个实例级 AsyncLocalStorage 记住这条异步链开着事务，
 *    事务持有连接直到提交，链内再调 store 不再排队（同一连接、同一事务）。
 *
 * 行为与异步化之前一致：SQLite 本来就是单写者，这里只是把「同步代码天然不会
 * 交错」换成「显式串行」。代价是全库串行，可接受——SQLite 只作迁移源与过渡
 * 兼容路径，正式负载走 PostgreSQL。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { SQLInputValue } from 'node:sqlite';
import type { Db, DbKind, PreparedStatement, RunResult, SqlParam } from './types.ts';
import { normalizeParams } from './run.ts';

// Vite 5 的 builtin 列表还不认识 node:sqlite，静态 import 会被当成名为 sqlite 的包。
// process.getBuiltinModule 在运行时直接拿内置模块，绕过打包器解析。
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

export type SqliteHandle = InstanceType<typeof DatabaseSync>;
type SqliteStatement = ReturnType<SqliteHandle['prepare']>;

interface TxStore {
  db: SqliteDb;
  /** 提交后要跑的回调；回滚时整段丢掉。 */
  afterCommit: Array<() => void>;
}

let savepointSeq = 0;

/** 提交成功后依次跑登记的回调；回调自己的错不影响已经提交的事务。 */
const runAfterCommit = (store: TxStore): void => {
  const callbacks = store.afterCommit.splice(0);
  for (const callback of callbacks) {
    try { callback(); } catch { /* 忽略 */ }
  }
};

class SqlitePrepared implements PreparedStatement {
  constructor(private readonly owner: SqliteDb, private readonly stmt: SqliteStatement) {}

  get<T = Record<string, unknown>>(...params: SqlParam[]): Promise<T | undefined> {
    return this.owner.read(() => this.stmt.get(...(normalizeParams(params) as SQLInputValue[])) as T | undefined);
  }

  all<T = Record<string, unknown>>(...params: SqlParam[]): Promise<T[]> {
    return this.owner.read(() => this.stmt.all(...(normalizeParams(params) as SQLInputValue[])) as T[]);
  }

  run(...params: SqlParam[]): Promise<RunResult> {
    return this.owner.read(() => {
      const result = this.stmt.run(...(normalizeParams(params) as SQLInputValue[]));
      return {
        changes: Number(result.changes),
        lastInsertRowid: Number(result.lastInsertRowid),
      };
    });
  }
}

export class SqliteDb implements Db {
  readonly kind: DbKind = 'sqlite';
  private readonly handle: SqliteHandle;
  private readonly als = new AsyncLocalStorage<TxStore>();
  /** 连接互斥：队尾。每条不在事务里的操作接在它后面。 */
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(file = ':memory:') {
    this.handle = new DatabaseSync(file);
    this.handle.exec('PRAGMA journal_mode = WAL');
    this.handle.exec('PRAGMA synchronous = FULL');
    this.handle.exec('PRAGMA foreign_keys = ON');
    this.handle.exec('PRAGMA busy_timeout = 5000');
  }

  /** 直接拿同步句柄：只给 SQLite 专用的建表/迁移代码用。 */
  get raw(): SqliteHandle {
    return this.handle;
  }

  get isTransaction(): boolean {
    return this.als.getStore()?.db === this;
  }

  afterCommit(fn: () => void): void {
    const store = this.als.getStore();
    if (store?.db === this) {
      store.afterCommit.push(fn);
      return;
    }
    fn();
  }

  prepare(sql: string): PreparedStatement {
    // 这里同步 prepare：SQL 有错在 prepare 时就炸，和以前一样，不拖到执行时才报。
    return new SqlitePrepared(this, this.handle.prepare(sql));
  }

  exec(sql: string): Promise<void> {
    return this.read(() => {
      this.handle.exec(sql);
    });
  }

  async runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isTransaction) return this.savepoint(fn);
    return this.acquire(async () => {
      this.handle.exec('BEGIN IMMEDIATE');
      const store: TxStore = { db: this, afterCommit: [] };
      try {
        const value = await this.als.run(store, fn);
        this.handle.exec('COMMIT');
        runAfterCommit(store);
        return value;
      } catch (error) {
        try { this.handle.exec('ROLLBACK'); } catch { /* 连接可能已经坏了 */ }
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.acquire(() => {
      this.handle.close();
    });
  }

  /**
   * 不在事务里：独占连接执行；在事务里：直接用连接（事务已经独占了）。
   * 只给适配器自己用。
   */
  read<T>(fn: () => T): Promise<T> {
    if (this.isTransaction) {
      return Promise.resolve().then(fn);
    }
    return this.acquire(fn);
  }

  private acquire<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(() => fn(), () => fn());
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async savepoint<T>(fn: () => Promise<T>): Promise<T> {
    savepointSeq += 1;
    const name = `sp_${savepointSeq}`;
    const store = this.als.getStore();
    const mark = store?.afterCommit.length ?? 0;
    this.handle.exec(`SAVEPOINT ${name}`);
    try {
      const value = await fn();
      this.handle.exec(`RELEASE SAVEPOINT ${name}`);
      return value;
    } catch (error) {
      // 这一段回滚了：它登记过的「提交后回调」也不能跑。
      if (store) store.afterCommit.length = mark;
      try {
        this.handle.exec(`ROLLBACK TO SAVEPOINT ${name}`);
        this.handle.exec(`RELEASE SAVEPOINT ${name}`);
      } catch { /* 外层可能已经回滚 */ }
      throw error;
    }
  }
}

/**
 * 打开/新建一个 SQLite 库。同步：只建连接并设 PRAGMA，不做建表。
 * 建表走 migrate()（异步）。
 */
export const openDb = (file = ':memory:'): SqliteDb => new SqliteDb(file);
