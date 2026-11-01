/**
 * 按配置挑后端。
 *
 * 规则（与方案 §4.1 一致）：
 * - 不设 PARLOR_STORAGE 时是 sqlite，老部署零改动；
 * - PARLOR_STORAGE=postgres 必须有 PARLOR_DATABASE_URL，缺了直接抛，绝不悄悄
 *   退回 SQLite 或建一个空库；
 * - `--db <文件>` 只属于 sqlite 路径，和 postgres 同时出现要报错；
 * - 只在选择 postgres 时才加载 pg 驱动——只连远程茶室的 Coo 不该因为迁库
 *   而多背一个用不上的依赖初始化。
 */

import type { Db } from './types.ts';
import { openDb } from './sqlite.ts';
import { PgDb } from './postgres.ts';

export type StorageKind = 'sqlite' | 'postgres';

export interface StorageOptions {
  storage?: StorageKind;
  file?: string;
  url?: string;
  poolMax?: number;
  connectTimeoutMs?: number;
  statementTimeoutMs?: number;
}

export const parseStorageKind = (raw: string | undefined): StorageKind => {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return 'sqlite';
  if (value === 'sqlite' || value === 'postgres' || value === 'postgresql' || value === 'pg') {
    return value === 'sqlite' ? 'sqlite' : 'postgres';
  }
  throw new Error(`PARLOR_STORAGE 只认 sqlite 或 postgres，收到：${raw}`);
};

export const openStorage = async (options: StorageOptions = {}): Promise<Db> => {
  const kind = options.storage ?? 'sqlite';
  if (kind === 'postgres') {
    const url = (options.url ?? '').trim();
    if (!url) {
      throw new Error(
        'PARLOR_STORAGE=postgres 时必须配 PARLOR_DATABASE_URL（形如 postgres://用户:密码@主机:5432/库名）。'
        + '不配不会退回 SQLite，也不会新建空库。',
      );
    }
    if (options.file) {
      throw new Error('--db 只用于 SQLite；PostgreSQL 用 PARLOR_DATABASE_URL 指定目标。');
    }
    return PgDb.open({
      url,
      poolMax: options.poolMax,
      connectTimeoutMs: options.connectTimeoutMs,
      statementTimeoutMs: options.statementTimeoutMs,
    });
  }
  return openDb(options.file ?? ':memory:');
};
