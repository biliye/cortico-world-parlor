/**
 * 约束冲突的跨后端识别。
 *
 * SQLite 抛的是 `UNIQUE constraint failed: x.y`，PostgreSQL 抛的是
 * SQLSTATE 23505（duplicate key value violates unique constraint）。
 * 业务里靠这个判断「已经发过/已经写过」的地方必须两边都认。
 */

interface PgLikeError {
  code?: string;
  constraint?: string;
  detail?: string;
  message?: string;
}

export const errorCodeOf = (error: unknown): string | undefined => (
  (error as PgLikeError | undefined)?.code
);

/** 唯一键冲突。 */
export const isUniqueViolation = (error: unknown): boolean => {
  if (errorCodeOf(error) === '23505') return true;
  return error instanceof Error && /UNIQUE constraint failed|duplicate key value/i.test(error.message);
};

/** 外键冲突（PG 23503）。 */
export const isForeignKeyViolation = (error: unknown): boolean => errorCodeOf(error) === '23503';

/** 序列化失败 / 死锁：整笔回滚后可以有限重试。 */
export const isRetryableTransactionError = (error: unknown): boolean => {
  const code = errorCodeOf(error);
  return code === '40001' || code === '40P01';
};

/**
 * 业务错误（触发器 RAISE EXCEPTION）在 PG 里是 P0001，消息原样带出来；
 * SQLite 的 RAISE(ABORT, 'x') 消息也是 x。统一按消息判断。
 */
export const messageOf = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);
