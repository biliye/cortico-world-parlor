/**
 * 数据访问的公共接口。
 *
 * 接口是异步的：PostgreSQL 驱动只有异步一条路。SQLite 适配器把同步调用包成
 * 已完成的 Promise，所以老的 `:memory:` 测试与本地单厅模式照旧能跑，
 * 只是调用方要多一个 await。
 *
 * 事务上下文不通过参数层层传：适配器用 AsyncLocalStorage 记住「这条异步链上
 * 开着哪个事务」，`withTransaction` 内再调用 store 自然拿到同一个连接。
 * 这不是全局深度计数——两条并发请求各自有各自的链。
 */

export type DbKind = 'sqlite' | 'postgres';

/** 能直接绑进 SQL 的值。undefined 在两种后端都当 NULL。 */
export type SqlParam = string | number | bigint | boolean | null | undefined;

export interface RunResult {
  /** 影响行数。PG 用 rowCount；SQLite 用 changes。 */
  changes: number;
  /**
   * SQLite 的 last_insert_rowid；PG 路径恒为 0。
   * PG 要拿新插入的列值请在 SQL 里写 RETURNING，用 get() 取。
   */
  lastInsertRowid: number;
}

export interface PreparedStatement {
  get<T = Record<string, unknown>>(...params: SqlParam[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(...params: SqlParam[]): Promise<T[]>;
  run(...params: SqlParam[]): Promise<RunResult>;
}

export interface Db {
  readonly kind: DbKind;
  /**
   * 当前异步链上是否开着事务。保留这个属性是为了让 store 里现有的
   * 「已经在事务里就不要再开一层」判断继续成立；它读的是 AsyncLocalStorage，
   * 不是共享计数器。
   */
  readonly isTransaction: boolean;
  prepare(sql: string): PreparedStatement;
  /** 执行不带参数的 SQL（DDL、PRAGMA、批量语句）。PG 走简单查询，可多条。 */
  exec(sql: string): Promise<void>;
  /** 开一层事务；已在事务里时用 SAVEPOINT 嵌套。 */
  runInTransaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
