/**
 * JSON 列的统一读写。
 *
 * SQLite 里 *_json 是 TEXT，读出来是字符串；PostgreSQL 里是 JSONB，
 * 驱动直接给对象/数组。这里把两种形状收敛成「都当 JSON 值」：
 * 写入一律 JSON.stringify（PG 的 text → jsonb 参数会隐式转型），
 * 读取用 jsonValue()——字符串就解析，已经是对象就直接用。
 *
 * 注意：SQL NULL 读出来是 null/undefined；JSON 里的 null 也可能是 null。
 * 现有业务把它们一律当「没有」，与迁移前一致。
 */

export const jsonText = (value: unknown): string | null => (
  value === undefined ? null : JSON.stringify(value)
);

export const jsonValue = <T>(raw: unknown, fallback: T): T => {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'string') {
    if (raw === '') return fallback;
    try { return JSON.parse(raw) as T; } catch { return fallback; }
  }
  return raw as T;
};

/** 只要对象的场景（data_json 这类）：数组/标量一律当没有。 */
export const jsonObject = <T extends Record<string, unknown>>(raw: unknown): T | undefined => {
  const value = jsonValue<unknown>(raw, undefined);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as T;
};
