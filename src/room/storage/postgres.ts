/**
 * PostgreSQL 适配器（node-postgres）。
 *
 * 事务：每条事务拿池里的一條连接，BEGIN…COMMIT 全程在同一条连接上；
 * 事务内再开一层用 SAVEPOINT。事务上下文放在实例级 AsyncLocalStorage 里，
 * 所以 store 内部照旧可以「看到外层有事务就不要再开一层」。
 *
 * 结果归一化：
 * - int8（COUNT/SUM/BIGINT 列）默认返回字符串，这里转成安全整数；
 * - numeric 转数字（只用于 AVG/SUM 这类计数，不用于金额）；
 * - 布尔表达式压回 0/1，与 SQLite 的形状一致。
 *
 * 这里不做 SQL 方言改写，只把 `?` 换成 `$n`。`INSERT OR IGNORE`、标量
 * `MAX(a,b)`、`COLLATE NOCASE` 这类写法统一改成两种后端都认的写法，
 * 见 src/room 里的调用点与设计记录。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { Db, DbKind, PreparedStatement, RunResult, SqlParam } from './types.ts';
import { normalizeParams, normalizeRow } from './run.ts';
import { toPgPlaceholders } from './translate.ts';

export interface PgDbOptions {
  url: string;
  /** 连接池上限。首期 5～10；所有进程的池都要算进数据库连接预算。 */
  poolMax?: number;
  /** 取连接的等待上限；拿不到就报错，不无限排队。 */
  connectTimeoutMs?: number;
  /** 单条语句上限。迁移会临时调低/关闭，见 migrate。 */
  statementTimeoutMs?: number;
  applicationName?: string;
}

interface TxStore {
  client: PoolClient;
}

let savepointSeq = 0;
let parsersInstalled = false;

const safeInt = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`数据库返回的整数超出安全范围：${value}`);
  }
  return parsed;
};

const safeNumeric = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`数据库返回的数字无法解析：${value}`);
  return parsed;
};

class PgPrepared implements PreparedStatement {
  private readonly text: string;
  constructor(private readonly owner: PgDb, sql: string) {
    this.text = toPgPlaceholders(sql);
  }

  async get<T = Record<string, unknown>>(...params: SqlParam[]): Promise<T | undefined> {
    const result = await this.execute(() => this.owner.query(this.text, normalizeParams(params)));
    const row = result.rows[0];
    return row ? normalizeRow<T>(row as Record<string, unknown>) : undefined;
  }

  async all<T = Record<string, unknown>>(...params: SqlParam[]): Promise<T[]> {
    const result = await this.execute(() => this.owner.query(this.text, normalizeParams(params)));
    return result.rows.map((row) => normalizeRow<T>(row as Record<string, unknown>));
  }

  async run(...params: SqlParam[]): Promise<RunResult> {
    const result = await this.execute(() => this.owner.query(this.text, normalizeParams(params)));
    return { changes: result.rowCount ?? 0, lastInsertRowid: 0 };
  }

  /** 出 SQL 错误时，带 `PARLOR_PG_DEBUG_SQL=1` 跑会把出错位置附近打出来（不含参数值）。 */
  private async execute(
    run: () => Promise<QueryResult<QueryResultRow>>,
  ): Promise<QueryResult<QueryResultRow>> {
    try {
      return await run();
    } catch (error) {
      if (process.env.PARLOR_PG_DEBUG_SQL === '1') {
        const position = Number((error as { position?: string }).position ?? 0);
        const start = Math.max(0, position - 160);
        console.error('parlor: SQL 出错：', (error as Error).message,
          '\n', this.text.slice(start, position + 160));
      }
      throw error;
    }
  }
}

export class PgDb implements Db {
  readonly kind: DbKind = 'postgres';
  private readonly pool: Pool;
  private readonly als = new AsyncLocalStorage<TxStore>();
  private closed = false;

  private constructor(pool: Pool) {
    this.pool = pool;
  }

  static async open(options: PgDbOptions): Promise<PgDb> {
    const { Pool } = await import('pg');
    const { types } = await import('pg');
    if (!parsersInstalled) {
      // 只在本进程第一次开 PG 时装一次；这两个解析器影响整个进程里所有 pg 客户端。
      types.setTypeParser(20, safeInt);
      types.setTypeParser(1700, safeNumeric);
      parsersInstalled = true;
    }
    const timeout = options.statementTimeoutMs;
    const pool = new Pool({
      connectionString: options.url,
      max: options.poolMax ?? 8,
      connectionTimeoutMillis: options.connectTimeoutMs ?? 10_000,
      idleTimeoutMillis: 30_000,
      application_name: options.applicationName ?? 'cortico-world-parlor',
      ...(timeout ? { statement_timeout: timeout } : {}),
    });
    pool.on('error', () => {
      // 空闲连接被服务端断掉：池自己会淘汰它。这里吞掉是为了不让
      // 一个没人监听的事件把进程打死；真正需要知道的错误会在下一次查询时抛出。
    });
    const db = new PgDb(pool);
    // 连一次，让配置错误/数据库不可达在启动时就失败，而不是等第一个请求。
    const client = await pool.connect();
    client.release();
    return db;
  }

  get isTransaction(): boolean {
    return this.als.getStore() !== undefined;
  }

  prepare(sql: string): PreparedStatement {
    return new PgPrepared(this, sql);
  }

  async exec(sql: string): Promise<void> {
    const text = toPgPlaceholders(sql);
    const client = this.als.getStore()?.client;
    if (client) await client.query(text);
    else await this.pool.query(text);
  }

  async runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const current = this.als.getStore();
    if (current) return this.savepoint(current.client, fn);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const store: TxStore = { client };
      const value = await this.als.run(store, fn);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* 连接可能已经坏了 */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }

  /** 适配器内部与迁移器用：在当前事务连接上执行，否则从池里取。 */
  query(text: string, params?: SqlParam[]): Promise<QueryResult<QueryResultRow>> {
    const client = this.als.getStore()?.client;
    if (client) return client.query(text, params as unknown[]);
    return this.pool.query(text, params as unknown[]);
  }

  /** 给迁移器用：整段迁移拿一条连接、一个 advisory lock，期间不换连接。 */
  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  private async savepoint<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
    savepointSeq += 1;
    const name = `sp_${savepointSeq}`;
    await client.query(`SAVEPOINT ${name}`);
    try {
      const value = await fn();
      await client.query(`RELEASE SAVEPOINT ${name}`);
      return value;
    } catch (error) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        await client.query(`RELEASE SAVEPOINT ${name}`);
      } catch { /* 外层可能已经回滚 */ }
      throw error;
    }
  }
}
