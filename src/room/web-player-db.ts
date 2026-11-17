import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { withTransaction, type Db } from './db.ts';
import { HttpError } from './http.ts';

const DAY = 86_400_000;
export const WEB_LOGIN_TTL = 30 * DAY;
const REDEEM_TTL = 7 * DAY;
const GUEST_TTL = DAY;
const DEFAULT_SALT = Buffer.alloc(16);
const PASSWORD_WORKERS = 3;
const PASSWORD_QUEUE_LIMIT = 12;
const PASSWORD_WAIT_MS = 2_000;
export const webHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const isWebSeatToken = (token: string) => /^web_[A-Za-z0-9_-]{43}$/.test(token);

type SessionRow = { token_hash: string; coo_id: string; account_id: string | null; expires_at: string | number; guest_room_id: string | null };
type Credentials = {
  account_id: string; player_coo_id: string; session_version: number; login_name: string; password_hash: string;
};
type Invite = {
  id: string; issuer_account_id: string; created_at: string; redeem_by: string;
  guest_coo_id: string | null; redeemed_at: string | null; access_until: string | null; revoked_at: string | null;
  issuer_name: string; guest_name: string | null; guest_handle: string | null; room_id: string; room_name: string;
};
const sessionSelect = `
  SELECT s.token_hash, s.coo_id, s.account_id, s.expires_at, i.room_id AS guest_room_id
    FROM web_player_sessions s JOIN coos p ON p.id=s.coo_id AND p.status='active'
    LEFT JOIN accounts a ON a.id=s.account_id AND a.player_coo_id=p.id AND a.status='active'
    LEFT JOIN coos c ON c.id=a.coo_id AND c.status='active'
    LEFT JOIN web_guest_invites i ON i.guest_coo_id=p.id
   WHERE s.expires_at>?
     AND ((c.id IS NOT NULL AND a.session_version=s.account_version)
       OR (s.account_id IS NULL AND i.revoked_at IS NULL AND i.access_until>?))`;
const credentialSelect = `
  SELECT a.id AS account_id, a.player_coo_id, a.session_version, w.login_name, w.password_hash
    FROM web_player_credentials w JOIN accounts a ON a.id=w.account_id AND a.status='active'
    JOIN coos c ON c.id=a.coo_id AND c.status='active'
    JOIN coos p ON p.id=a.player_coo_id AND p.status='active'`;

function loginName(input: unknown): string {
  const name = typeof input === 'string' ? input.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > 48 || /\p{C}/u.test(name)) throw new HttpError(400, '登录名须为 1～48 个可见字符');
  return name;
}

export class WebPlayerDb {
  private readonly db: Db;
  private readonly now: () => number;
  private passwordChecks = 0;
  private readonly passwordQueue: Array<() => void> = [];

  constructor(db: Db, now: () => number) {
    this.db = db;
    this.now = now;
  }

  private async waitForPasswordWorker(): Promise<void> {
    if (this.passwordChecks < PASSWORD_WORKERS) {
      this.passwordChecks++;
      return;
    }
    const busy = () => new HttpError(429, '密码验证繁忙，请稍后重试');
    if (this.passwordQueue.length >= PASSWORD_QUEUE_LIMIT) throw busy();
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.passwordQueue.splice(this.passwordQueue.indexOf(start), 1);
        reject(busy());
      }, PASSWORD_WAIT_MS);
      this.passwordQueue.push(start);
    });
  }

  private async derive(password: string, salt: Buffer): Promise<Buffer> {
    await this.waitForPasswordWorker();
    try {
      // OWASP scrypt profile for runtimes without Argon2id.
      return await new Promise<Buffer>((resolve, reject) => {
        scrypt(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
          (error, key) => error ? reject(error) : resolve(key));
      });
    } finally {
      const next = this.passwordQueue.shift();
      if (next) next();
      else this.passwordChecks--;
    }
  }

  async credentialName(accountId: string): Promise<string | null> {
    const row = await this.db.prepare('SELECT login_name FROM web_player_credentials WHERE account_id=?')
      .get(accountId) as { login_name: string } | undefined;
    return row?.login_name ?? null;
  }

  async setCredentials(accountId: string, input: Record<string, unknown>, ensurePlayer: () => Promise<string>) {
    const name = loginName(input.loginName);
    const password = typeof input.password === 'string' ? input.password : '';
    if ([...password].length < 12 || Buffer.byteLength(password) > 512) {
      throw new HttpError(400, '密码至少 12 个字符，最多 512 字节');
    }
    const salt = randomBytes(16);
    const key = await this.derive(password, salt);
    await withTransaction(this.db, async () => {
      await ensurePlayer();
      try {
        await this.db.prepare(`
          INSERT INTO web_player_credentials(account_id,login_name,login_key,password_hash) VALUES (?,?,?,?)
          ON CONFLICT(account_id) DO UPDATE
            SET login_name=excluded.login_name, login_key=excluded.login_key, password_hash=excluded.password_hash
        `).run(accountId, name, name.toLowerCase(), 'scrypt:' + salt.toString('hex') + ':' + key.toString('hex'));
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new HttpError(409, '登录名已被使用，请换一个');
        throw error;
      }
      await this.expireAccountSessions(accountId);
    });
    return name;
  }

  async login(input: Record<string, unknown>) {
    const name = loginName(input.loginName).toLowerCase();
    const password = typeof input.password === 'string' ? input.password : '';
    if (!password || Buffer.byteLength(password) > 512) throw new HttpError(401, '登录名或密码不对');
    const candidate = await this.db.prepare(credentialSelect + ' WHERE w.login_key=?').get(name) as Credentials | undefined;
    const stored = /^scrypt:([0-9a-f]{32}):([0-9a-f]{64})$/.exec(candidate?.password_hash ?? '');
    const derived = await this.derive(password, stored ? Buffer.from(stored[1]!, 'hex') : DEFAULT_SALT);
    if (!stored || !timingSafeEqual(derived, Buffer.from(stored[2]!, 'hex'))) {
      throw new HttpError(401, '登录名或密码不对');
    }
    return withTransaction(this.db, async () => {
      if (!candidate) throw new HttpError(401, '登录名或密码不对');
      // Match the credential writer's lock order before inserting the session FK.
      await this.db.prepare('SELECT id FROM accounts WHERE id=? FOR KEY SHARE').get(candidate.account_id);
      const current = await this.db.prepare(credentialSelect + ' WHERE w.login_key=? FOR UPDATE OF w')
        .get(name) as Credentials | undefined;
      if (!current || current.account_id !== candidate.account_id || current.password_hash !== candidate.password_hash) {
        throw new HttpError(401, '登录名或密码不对');
      }
      return this.createSession(current.player_coo_id, this.now() + WEB_LOGIN_TTL, current);
    });
  }

  private async createSession(cooId: string, expiresAt: number, member?: Credentials) {
    const token = randomBytes(32).toString('base64url');
    const hash = webHash(token);
    await this.db.prepare(`
      INSERT INTO web_player_sessions(token_hash,coo_id,account_id,account_version,expires_at) VALUES (?,?,?,?,?)
    `).run(hash, cooId, member?.account_id ?? null, member?.session_version ?? null, expiresAt);
    return { token, expiresAt };
  }

  async session(token: string, lock = false): Promise<SessionRow | undefined> {
    if (!/^[\w-]{43}$/.test(token)) return undefined;
    const now = this.now();
    return await this.db.prepare(sessionSelect + ' AND s.token_hash=?' + (lock ? ' FOR UPDATE OF s' : ''))
      .get(now, now, webHash(token)) as SessionRow | undefined;
  }

  async seatSession(hash: string): Promise<SessionRow | undefined> {
    const now = this.now();
    return await this.db.prepare(sessionSelect + ' AND s.seat_token_hash=?').get(now, now, hash) as SessionRow | undefined;
  }

  async bindSeat(session: SessionRow, token: string) {
    await this.db.prepare('UPDATE web_player_sessions SET seat_token_hash=? WHERE token_hash=?')
      .run(webHash(token), session.token_hash);
  }

  async expireAccountSessions(accountId: string, staleOnly = false) {
    const now = this.now();
    const stale = staleOnly ? ' AND account_version<>(SELECT session_version FROM accounts WHERE id=account_id)' : '';
    await this.db.prepare('UPDATE web_player_sessions SET expires_at=? WHERE account_id=? AND expires_at>?' + stale)
      .run(now, accountId, now);
  }

  async logout(token: string): Promise<string | undefined> {
    if (!/^[\w-]{43}$/.test(token)) return undefined;
    const now = this.now();
    const row = await this.db.prepare(`
      WITH ended AS (
        UPDATE web_player_sessions SET expires_at=LEAST(expires_at,?) WHERE token_hash=?
        RETURNING coo_id, account_id
      ), finished_trial AS (
        UPDATE web_guest_invites i SET access_until=LEAST(i.access_until,?)
        FROM ended e WHERE e.account_id IS NULL AND i.guest_coo_id=e.coo_id
      )
      SELECT coo_id FROM ended
    `).get(now, webHash(token), now) as { coo_id: string } | undefined;
    return row?.coo_id;
  }

  async invitations(issuer?: string, target = '') {
    const filter = issuer ? 'WHERE i.issuer_account_id=?'
      : target ? 'WHERE i.id=? OR i.issuer_account_id=? OR i.guest_coo_id=? OR h.handle=? OR lower(g.display_name)=lower(?)' : '';
    const params = issuer ? [issuer] : target ? [target, target, target, target.toLowerCase(), target] : [];
    const rows = await this.db.prepare(`
      SELECT i.*, r.name AS room_name, a.display_name AS issuer_name, g.display_name AS guest_name, h.handle AS guest_handle
      FROM web_guest_invites i JOIN accounts a ON a.id=i.issuer_account_id
      JOIN rooms r ON r.id=i.room_id
      LEFT JOIN coos g ON g.id=i.guest_coo_id LEFT JOIN global_handles h ON h.coo_id=g.id
      ${filter} ORDER BY i.created_at DESC, i.id LIMIT 100
    `).all(...params) as Invite[];
    return rows.map(row => ({
      id: row.id, issuerId: row.issuer_account_id, createdAt: Number(row.created_at), redeemBy: Number(row.redeem_by),
      room: row.room_id, roomName: row.room_name,
      issuerName: row.issuer_name, guestName: row.guest_name, guestHandle: row.guest_handle ?? row.guest_coo_id?.slice(0, 8) ?? null,
      guestId: row.guest_coo_id, redeemedAt: row.redeemed_at === null ? null : Number(row.redeemed_at),
      accessUntil: row.access_until === null ? null : Number(row.access_until), revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    }));
  }

  async issue(issuer: string, room: string) {
    const id = randomUUID();
    const code = randomBytes(16).toString('base64url');
    const now = this.now();
    const redeemBy = now + REDEEM_TTL;
    await withTransaction(this.db, async () => {
      await this.db.prepare('SELECT id FROM accounts WHERE id=? FOR UPDATE').get(issuer);
      const count = await this.db.prepare('SELECT count(*) AS n FROM web_guest_invites WHERE issuer_account_id=? AND created_at>?')
        .get(issuer, now - DAY) as { n: string };
      if (Number(count.n) >= 5) throw new HttpError(429, '每天可以发 5 张游客邀请');
      await this.db.prepare('INSERT INTO web_guest_invites(id,code_hash,issuer_account_id,room_id,created_at,redeem_by) VALUES (?,?,?,?,?,?)')
        .run(id, webHash(code), issuer, room, now, redeemBy);
    });
    return { id, code, redeemBy };
  }

  guestName(value: unknown): string {
    const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > 24 || /\p{C}/u.test(name)) throw new HttpError(400, '请填写 1～24 个字符的游客昵称');
    return name;
  }

  async redeem(input: Record<string, unknown>, register: (cooId: string, name: string) => Promise<void>) {
    const code = typeof input.code === 'string' ? input.code.trim() : '';
    const name = this.guestName(input.name);
    if (!/^[\w-]{22}$/.test(code)) throw new HttpError(403, '邀请码无效、已使用或已过期');
    return withTransaction(this.db, async () => {
      const invite = await this.db.prepare('SELECT * FROM web_guest_invites WHERE code_hash=? FOR UPDATE')
        .get(webHash(code)) as Invite | undefined;
      const now = this.now();
      if (!invite || invite.guest_coo_id || invite.revoked_at !== null || Number(invite.redeem_by) <= now) {
        throw new HttpError(403, '邀请码无效、已使用或已过期');
      }
      const cooId = randomUUID();
      await register(cooId, name);
      const until = now + GUEST_TTL;
      await this.db.prepare('UPDATE web_guest_invites SET guest_coo_id=?, redeemed_at=?, access_until=? WHERE id=?')
        .run(cooId, now, until, invite.id);
      return this.createSession(cooId, until);
    });
  }

  async revoke(id: string, issuer?: string): Promise<void> {
    const sql = 'UPDATE web_guest_invites SET revoked_at=COALESCE(revoked_at,?) WHERE id=?';
    const result = issuer
      ? await this.db.prepare(sql + ' AND issuer_account_id=?').run(this.now(), id, issuer)
      : await this.db.prepare(sql).run(this.now(), id);
    if (!result.changes) throw new HttpError(404, '没有这张邀请');
  }

  async isGuest(cooId: string): Promise<boolean> {
    return !!await this.db.prepare('SELECT 1 FROM web_guest_invites WHERE guest_coo_id=?').get(cooId);
  }

  async endedSeats(now: number, player?: string) {
    return await this.db.prepare(`
      SELECT r.room_id, r.coo_id, r.token_hash, (i.guest_coo_id IS NOT NULL) AS guest
      FROM room_seats r
      LEFT JOIN web_guest_invites i ON i.guest_coo_id=r.coo_id
      LEFT JOIN web_player_sessions s ON s.seat_token_hash=r.token_hash AND s.coo_id=r.coo_id AND s.account_id IS NOT NULL
      WHERE r.released_at IS NULL
        AND (LEAST(i.revoked_at,i.access_until)<=?
          OR (s.expires_at<=? AND NOT EXISTS (SELECT 1 FROM active_table_players t WHERE t.coo_id=r.coo_id)))
        ${player ? 'AND r.coo_id=?' : ''}
      ORDER BY LEAST(i.revoked_at,i.access_until,s.expires_at), r.coo_id LIMIT 50
    `).all(now, now, ...(player ? [player] : [])) as { room_id: string; coo_id: string; token_hash: string; guest: boolean }[];
  }

  async pruneSessions(now: number) {
    await this.db.prepare(`
      DELETE FROM web_player_sessions s WHERE s.expires_at<=?
        AND NOT EXISTS (SELECT 1 FROM room_seats r WHERE r.token_hash=s.seat_token_hash AND r.released_at IS NULL)
    `).run(now);
  }
}
