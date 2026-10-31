/** 统一身份登记与按目标服务器签发的临时通行证。长期 secret 只交给身份服务。 */
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import { withTransaction } from './db.ts';
import { CooAccountDb } from './coo-account-db.ts';
import { isCooId, isCooSecret } from './ledger.ts';

export const GLOBAL_HEADER = 'x-parlor-identity';
export const IDENTITY_TTL = 30 * 60_000;
export interface GlobalPerson { cooId: string; handle: string; name: string; kind: 'pet' | 'human' }
export interface IdentityTicket { token: string; expiresAt: number; person: GlobalPerson }
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** 只接受 HTTPS；本机联调允许 HTTP。禁止凭证随重定向流向其他地址。 */
export function identityOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('身份服务/服务器地址必须是源地址');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('全局身份需要 HTTPS（本机测试除外）');
  }
  return url.origin;
}

export function enableGlobalIdentity(db: Db): void {
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('global_identity','1')").run();
  db.exec('DROP INDEX IF EXISTS ux_active_seat_name');
}
export const globalIdentityEnabled = (db: Db): boolean => !!db.prepare("SELECT 1 FROM meta WHERE key='global_identity' AND value='1'").get();

export const registeredHandle = (db: Db, cooId: string): string => {
  const row = db.prepare('SELECT handle FROM global_handles WHERE coo_id=?').get(cooId) as { handle: string } | undefined;
  return row?.handle ?? cooId.slice(0, 8).toLowerCase();
};

export class IdentityRegistry {
  private readonly db: Db;
  private readonly now: () => number;

  // 不用 TS 参数属性：serve:world 走 node 的 strip-only 模式，那种语法起不来。
  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  /** 同一事务内分配并固定短号；旧身份用原 secret 接入，绝不重发 cooId。 */
  enroll(cooId: string, secret: string, name: string, kind: 'pet' | 'human' = 'pet'): GlobalPerson {
    if (!isCooId(cooId) || !isCooSecret(secret)) throw new Error('身份格式不对');
    return withTransaction(this.db, () => {
      const store = new CooAccountDb(this.db, { now: this.now });
      const existing = store.findCoo(cooId);
      if (existing && !['pet', 'human'].includes(existing.kind)) throw new Error('系统或历史占位身份不能注册');
      if (store.registerCoo(cooId, secret, kind, name) !== 'ok') throw new Error('身份凭证不匹配或身份已停用');
      const old = this.db.prepare('SELECT handle FROM global_handles WHERE coo_id=?').get(cooId) as { handle: string } | undefined;
      if (!old) {
        const id = cooId.toLowerCase();
        let handle = '';
        for (let length = 8; length <= id.length; length += 1) {
          const candidate = id.slice(0, length);
          if (!this.db.prepare('SELECT 1 FROM global_handles WHERE handle=?').get(candidate)) { handle = candidate; break; }
        }
        if (!handle) throw new Error('无法分配唯一短号');
        this.db.prepare('INSERT INTO global_handles(coo_id,handle) VALUES (?,?)').run(cooId, handle);
      }
      if (name.trim()) store.renameCooDisplay(cooId, name);
      const record = store.findCoo(cooId)!;
      return { cooId, handle: registeredHandle(this.db, cooId), name: record.displayName, kind: record.kind === 'human' ? 'human' : 'pet' };
    });
  }

  issue(person: GlobalPerson, audience: string): IdentityTicket {
    audience = identityOrigin(audience);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + IDENTITY_TTL;
    this.db.prepare('DELETE FROM identity_tickets WHERE expires_at<=?').run(this.now());
    this.db.prepare('INSERT INTO identity_tickets(token_hash,coo_id,audience,expires_at) VALUES (?,?,?,?)')
      .run(hash(token), person.cooId, audience, expiresAt);
    return { token, expiresAt, person };
  }

  verify(token: string, audience: string): GlobalPerson | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.db.prepare(`SELECT c.id,c.display_name,c.kind,h.handle FROM identity_tickets t
      JOIN coos c ON c.id=t.coo_id JOIN global_handles h ON h.coo_id=c.id
      WHERE t.token_hash=? AND t.audience=? AND t.expires_at>? AND c.status='active'`)
      .get(hash(token), identityOrigin(audience), this.now()) as { id: string; display_name: string; kind: string; handle: string } | undefined;
    return row ? { cooId: row.id, name: row.display_name, handle: row.handle, kind: row.kind === 'human' ? 'human' : 'pet' } : null;
  }
}

export async function identityRequest<T>(origin: string, path: string, body: unknown, token?: string): Promise<T> {
  const url = `${identityOrigin(origin)}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', ...(token ? { [GLOBAL_HEADER]: token } : {}) },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new Error('身份服务暂时无法连接，请稍后重试；新的身份验证或入座需要等它恢复。', { cause });
  }
  if (response.status >= 500) throw new Error(`身份服务暂时不可用（HTTP ${response.status}），请稍后重试。`);
  if (!response.ok) throw new Error(`身份服务 HTTP ${response.status}`);
  return await response.json() as T;
}
