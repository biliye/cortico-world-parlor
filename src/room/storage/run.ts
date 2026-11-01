/**
 * 两个适配器共用的参数归一化与结果归一化。
 *
 * - undefined 统一成 NULL：node:sqlite 不认 undefined，pg 会静默当 null，
 *   两边先归一，避免同一条语句在两种后端行为不同。
 * - 布尔统一成 0/1：库里的布尔列全是 INTEGER 型（is_refill/is_bot/auto），
 *   PG 里也是 SMALLINT，所以不能把 true 直接绑进去。
 */

import type { SqlParam } from './types.ts';

export const normalizeParams = (params: SqlParam[]): SqlParam[] => params.map((value) => {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
});

/**
 * PG 会把布尔表达式（`x IS NULL`、`EXISTS(...)`）返回成 true/false，
 * SQLite 返回 0/1。业务代码按 0/1 写的，这里把结果里的布尔压回 0/1，
 * 让两边读出来的形状一致。
 */
export const normalizeRow = <T>(row: Record<string, unknown>): T => {
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (typeof value === 'boolean') row[key] = value ? 1 : 0;
  }
  return row as T;
};
