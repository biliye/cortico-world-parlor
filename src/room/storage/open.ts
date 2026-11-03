/** PostgreSQL-only 网关存储入口。SQLite 只留本机档案及显式离线迁移工具。 */

import type { Db } from './types.ts';
import { PgDb } from './postgres.ts';

export type StorageKind = 'postgres';

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
  if (!value || value === 'postgres' || value === 'postgresql' || value === 'pg') return 'postgres';
  throw new Error(`服务端只支持 PostgreSQL，收到：${raw}；SQLite 仅供本机消息档案和旧数据导入。`);
};

export const openStorage = async (options: StorageOptions = {}): Promise<Db> => {
  const kind = parseStorageKind(options.storage);
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
  throw new Error('服务端只支持 PostgreSQL');
};
