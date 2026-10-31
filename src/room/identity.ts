/**
 * 账本身份：一个 Coo 跨房稳定的一份 cooId + 一个只在本机保存的 cooSecret。
 * 服务器只存 secret 的哈希；同一个 cooId 只有同一个 secret 能重入，防止别人冒名。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isCooId, isCooSecret } from './ledger.ts';

export interface CooIdentity {
  cooId: string;
  cooSecret: string;
  authority?: string;
  handle?: string;
}

export const IDENTITY_FILE = 'parlor-identity.json';
export const COO_HEADER = 'x-parlor-coo';
export const COO_SECRET_HEADER = 'x-parlor-coo-secret';

const isIdentity = (value: unknown): value is CooIdentity => {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Partial<CooIdentity>;
  return isCooId(identity.cooId) && isCooSecret(identity.cooSecret);
};

/** 读本机身份；没有或坏了就生成一份。写不进去时只在这个进程里有效。 */
export function loadOrCreateIdentity(file: string): CooIdentity {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (isIdentity(raw)) return raw;
  } catch { /* 新建 */ }
  const identity: CooIdentity = {
    cooId: randomUUID(),
    cooSecret: randomBytes(32).toString('base64url'),
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(identity)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* 假上下文或不可写：本次运行用它，重启会换 */ }
  return identity;
}

/** 身份升级后必须持久保存；写失败直接报告，避免悄悄换号。 */
export function saveIdentity(file: string, identity: CooIdentity): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(identity) + '\n', { encoding: 'utf8', mode: 0o600 });
}
