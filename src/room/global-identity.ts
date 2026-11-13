/** 统一身份登记与按目标服务器签发的临时通行证。长期 secret 只交给身份服务。 */
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import { withTransaction } from './db.ts';
import { CooAccountDb } from './coo-account-db.ts';
import { isCooId, isCooSecret } from './ledger.ts';
import { identityOrigin, type GlobalPerson, type IdentityTicket } from './identity-protocol.ts';

export const IDENTITY_TTL = 30 * 60_000;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

export async function enableGlobalIdentity(db: Db): Promise<void> {
  await db.prepare("INSERT INTO meta(key,value) VALUES ('global_identity','1') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
  await db.exec('DROP INDEX IF EXISTS ux_active_seat_name');
}
export const globalIdentityEnabled = async (db: Db): Promise<boolean> => !!(await db.prepare("SELECT 1 FROM meta WHERE key='global_identity' AND value='1'").get());

export const registeredHandle = async (db: Db, cooId: string): Promise<string> => {
  const row = await db.prepare('SELECT handle FROM global_handles WHERE coo_id=?').get(cooId) as { handle: string } | undefined;
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
  async enroll(cooId: string, secret: string, name: string, kind: 'pet' | 'human' = 'pet'): Promise<GlobalPerson> {
    if (!isCooId(cooId) || !isCooSecret(secret)) throw new Error('身份格式不对');
    return await withTransaction(this.db, async () => {
      const store = new CooAccountDb(this.db, { now: this.now });
      const existing = await store.findCoo(cooId);
      if (existing && !['pet', 'human'].includes(existing.kind)) throw new Error('系统或历史占位身份不能注册');
      if ((await store.registerCoo(cooId, secret, kind, name)) !== 'ok') throw new Error('身份凭证不匹配或身份已停用');
      const old = await this.db.prepare('SELECT handle FROM global_handles WHERE coo_id=?').get(cooId) as { handle: string } | undefined;
      if (!old) {
        const id = cooId.toLowerCase();
        let handle = '';
        for (let length = 8; length <= id.length; length += 1) {
          const candidate = id.slice(0, length);
          if (!(await this.db.prepare('SELECT 1 FROM global_handles WHERE handle=?').get(candidate))) { handle = candidate; break; }
        }
        if (!handle) throw new Error('无法分配唯一短号');
        await this.db.prepare('INSERT INTO global_handles(coo_id,handle) VALUES (?,?)').run(cooId, handle);
      }
      if (name.trim()) await store.renameCooDisplay(cooId, name);
      const record = (await store.findCoo(cooId))!;
      return { cooId, handle: await registeredHandle(this.db, cooId), name: record.displayName, kind: record.kind === 'human' ? 'human' : 'pet' };
    });
  }

  async issue(person: GlobalPerson, audience: string): Promise<IdentityTicket> {
    audience = identityOrigin(audience);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + IDENTITY_TTL;
    await this.db.prepare('DELETE FROM identity_tickets WHERE expires_at<=?').run(this.now());
    await this.db.prepare('INSERT INTO identity_tickets(token_hash,coo_id,audience,expires_at) VALUES (?,?,?,?)')
      .run(hash(token), person.cooId, audience, expiresAt);
    return { token, expiresAt, person };
  }

  async verify(token: string, audience: string): Promise<GlobalPerson | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = await this.db.prepare(`SELECT c.id,c.display_name,c.kind,h.handle FROM identity_tickets t
      JOIN coos c ON c.id=t.coo_id JOIN global_handles h ON h.coo_id=c.id
      WHERE t.token_hash=? AND t.audience=? AND t.expires_at>? AND c.status='active'`)
      .get(hash(token), identityOrigin(audience), this.now()) as { id: string; display_name: string; kind: string; handle: string } | undefined;
    return row ? { cooId: row.id, name: row.display_name, handle: row.handle, kind: row.kind === 'human' ? 'human' : 'pet' } : null;
  }
}
