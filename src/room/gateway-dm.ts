/** 网关私聊、短号解析与搜人服务（/v1/dm/* 与 /v1/people）。 */
import { touchActivity } from './activity.ts';
import { withTransaction, type Db } from './db.ts';
import type { DivinationDb } from './divination-db.ts';
import { registeredHandle } from './global-identity.ts';
import { likePrefix, parseHandleQuery } from './handles.ts';
import { HttpError } from './http.ts';
import { isCooId } from './ledger.ts';
import { MailDb } from './mail-db.ts';
import { hasRoomAccess } from './room-access-db.ts';
import type { RoomHost } from './room-host.ts';
import { activeSeatForCoo, getRoom } from './room-seat-db.ts';
import type { WebPlayerDb } from './web-player-db.ts';

const PEOPLE_LIMIT = 20;

export interface GatewayDmContext {
  db: Db;
  now: () => number;
  webPlayers: WebPlayerDb;
  divination: DivinationDb;
  identityAuthority?: string;
  isOnline(cooId: string): boolean;
  onlineCooIds(): Set<string>;
  existingHost(roomId: string): Promise<RoomHost | undefined>;
  host(roomId: string): Promise<RoomHost>;
  checkDmRate(cooId: string): void;
}

export class GatewayDm {
  constructor(private readonly ctx: GatewayDmContext) {}

  /**
   * 一个人的展示信息：当前席位名优先，其次 coo 显示名。
   * online 只认正在连着的客户端（SSE），不认库里有没有旧席位。
   */
  async personInfo(
    cooId: string,
    fallbackName = '',
    viewer = '',
  ): Promise<{ cooId: string; name: string; online: boolean; room: string | null; handle: string }> {
    const seat = await activeSeatForCoo(this.ctx.db, cooId);
    const row = await this.ctx.db.prepare('SELECT display_name FROM coos WHERE id = ?').get(cooId) as { display_name?: string } | undefined;
    const name = seat?.name || (row?.display_name ?? '').trim() || fallbackName || '某人';
    // 私密厅的实时位置不给没有权限的人看。
    let room = seat?.roomId ?? null;
    if (room) {
      const info = await getRoom(this.ctx.db, room);
      if (info && info.visibility === 'private' && (!viewer || !await hasRoomAccess(this.ctx.db, room, viewer))) room = null;
    }
    return { cooId, name, online: this.ctx.isOnline(cooId), room, handle: await registeredHandle(this.ctx.db, cooId) };
  }

  /**
   * 按短号找 cooId：# 后面可以是前 8 位，也可以是完整 id。
   * 前缀撞了不猜，列出完整 id 让调用方选（不建唯一约束）。
   */
  async cooByHandle(handle: string): Promise<string> {
    const assigned = await this.ctx.db.prepare("SELECT h.coo_id FROM global_handles h JOIN coos c ON c.id=h.coo_id WHERE h.handle=? AND c.status='active'").get(handle) as { coo_id: string } | undefined;
    if (assigned) return assigned.coo_id;
    const exact = await this.ctx.db.prepare("SELECT id FROM coos WHERE status = 'active' AND id = ?").get(handle) as
      { id: string } | undefined;
    if (exact) return exact.id;
    // 全局短号是登记值；不能把别人的已分配短号当作本地某个 ID 的前缀。
    if (this.ctx.identityAuthority) throw new HttpError(404, `这台服务器尚不认识短号「#${handle}」`);
    const rows = await this.ctx.db.prepare(
      "SELECT id FROM coos WHERE status = 'active' AND id LIKE ? ESCAPE '\\' ORDER BY created_at, id LIMIT 6",
    ).all(`${likePrefix(handle)}%`) as { id: string }[];
    if (rows.length === 0) throw new HttpError(404, `没有找到号「#${handle}」`);
    if (rows.length > 1) {
      throw new HttpError(409, `这个号对上了 ${rows.length} 个人，用完整 id 再发一次：${rows.map((row) => row.id).join('、')}`);
    }
    return rows[0].id;
  }

  /** 找人：优先 cooId（搜索结果带的就是它），退一步按当前唯一同名席位。 */
  async dmPeer(value: string, fromCooId: string): Promise<{ cooId: string; name: string; online: boolean; room: string | null }> {
    const needle = value.trim();
    if (!needle) throw new HttpError(400, '要写给谁？');
    const handle = parseHandleQuery(needle);
    if (handle !== null) {
      return this.personInfo(await this.cooByHandle(handle), '', fromCooId);
    }
    if (isCooId(needle)) {
      const row = await this.ctx.db.prepare("SELECT id FROM coos WHERE id = ? AND status = 'active'").get(needle);
      if (!row) throw new HttpError(404, '没有这个人');
      return this.personInfo(needle, '', fromCooId);
    }
    const bySeatId = await this.ctx.db.prepare(
      'SELECT coo_id FROM room_seats WHERE released_at IS NULL AND id = ?',
    ).get(needle) as { coo_id: string } | undefined;
    if (bySeatId) return this.personInfo(bySeatId.coo_id, '', fromCooId);
    const seats = await this.ctx.db.prepare(
      'SELECT coo_id FROM room_seats WHERE released_at IS NULL AND lower(name) = lower(?)',
    ).all(needle) as { coo_id: string }[];
    const ids = [...new Set(seats.map((row) => row.coo_id))].filter((id) => id !== fromCooId);
    if (this.ctx.identityAuthority && seats.length > 1) throw new HttpError(409, '有多个同名的人，请用 #短号');
    if (ids.length === 1) return this.personInfo(ids[0], '', fromCooId);
    if (ids.length > 1) throw new HttpError(409, '有多个同名的人，用搜索结果选一个');
    const coos = await this.ctx.db.prepare(
      "SELECT id FROM coos WHERE status = 'active' AND lower(display_name) = lower(?)",
    ).all(needle) as { id: string }[];
    const names = [...new Set(coos.map((row) => row.id))].filter((id) => id !== fromCooId);
    if (this.ctx.identityAuthority && coos.length > 1) throw new HttpError(409, '有多个同名的人，请用 #短号');
    if (names.length === 1) return this.personInfo(names[0], '', fromCooId);
    if (names.length > 1) throw new HttpError(409, '有多个同名的人，用搜索结果选一个');
    throw new HttpError(404, `没有找到「${needle}」（离线的人要用搜索结果选）`);
  }

  /** 私聊：对方离线也照常投信箱；在线时顺手往他所在的客厅推一条事件。 */
  async sendDm(cooId: string, body: Record<string, unknown>) {
    if (await this.ctx.webPlayers.isGuest(cooId)) throw new HttpError(403, '试玩期间暂不能发送私聊');
    const seat = await activeSeatForCoo(this.ctx.db, cooId);
    if (!seat) throw new HttpError(403, '你不在任何客厅里；先进一个客厅再发私聊');
    const peer = await this.dmPeer(typeof body.to === 'string' ? body.to : '', cooId);
    if (peer.cooId === cooId) throw new HttpError(400, '不能给自己发私聊');
    // 狼人杀进行中：同桌参与者之间不能私聊（防绕开单次发言与狼聊限制）。
    const roomHost = await this.ctx.existingHost(seat.roomId);
    if (roomHost && await roomHost.chatLockedFor(cooId) && (await roomHost.lockedTablePeerCooIds(cooId)).has(peer.cooId)) {
      throw new HttpError(409, '狼人杀进行中，同桌的人之间不能私聊；想说的留到发言机会或局后再说');
    }
    const raw = typeof body.text === 'string' ? body.text.trim() : '';
    const interpretation = /^【解签[ \t]+([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})】([\s\S]*)/im.exec(raw);
    const text = interpretation ? interpretation[2].trim() : raw;
    if (!text) throw new HttpError(400, '消息不能是空的');
    if (text.length > 2000) throw new HttpError(400, '一条最多 2000 字');
    this.ctx.checkDmRate(cooId);
    const { letter, expired } = await withTransaction(this.ctx.db, async () => {
      const expired = !!interpretation && await this.ctx.divination.interpret(cooId, peer.cooId, interpretation[1].toLowerCase(), text) === 'expired';
      await touchActivity(this.ctx.db, seat.roomId, cooId, this.ctx.now());
      const letter = await new MailDb(this.ctx.db, { now: this.ctx.now }).append({
        to: peer.cooId, fromCooId: cooId, room: seat.roomId, kind: 'whisper', fromName: seat.name, text,
      });
      return { letter, expired };
    });
    const target = await activeSeatForCoo(this.ctx.db, peer.cooId);
    if (target) {
      try {
        await (await this.ctx.host(target.roomId)).whisperNotice(cooId, seat.name, {
          cooId: target.cooId, id: target.id, name: target.name,
        }, text, { seq: letter.seq, ts: letter.ts, room: seat.roomId });
      } catch { /* 推事件失败不影响信 */ }
    }
    let notice: string | undefined;
    if (expired) {
      notice = '这支签已过 24 小时解签期，正文已作为普通私信寄给家长。';
    } else if (!interpretation && /【解签|解签[ \t]*【/.test(raw)) {
      notice = '已作为普通私信寄出。要在问卦阁记为解读，请把来信里的「【解签 编号】」原样放在解读开头。';
    }
    return {
      message: { seq: letter.seq, ts: letter.ts, text: letter.text, fromName: seat.name, fromMe: true, unread: false },
      peer,
      ...(notice ? { notice } : {}),
    };
  }

  async dmThreads(cooId: string): Promise<Record<string, unknown>> {
    const mail = new MailDb(this.ctx.db, { now: this.ctx.now });
    const threads = await Promise.all((await mail.threads(cooId)).map(async (thread) => {
      const info = await this.personInfo(thread.peer, '', cooId);
      return { ...thread, name: info.name, online: info.online, room: info.room, handle: info.handle };
    }));
    return { threads, unread: await mail.dmUnread(cooId) };
  }

  async dmThreadPage(cooId: string, peer: string, before: number, limit: number): Promise<Record<string, unknown>> {
    if (!isCooId(peer)) throw new HttpError(400, '对方身份不对');
    const page = await new MailDb(this.ctx.db, { now: this.ctx.now }).thread(cooId, peer, before, limit);
    return { peer: await this.personInfo(peer, '', cooId), ...page };
  }

  /** 搜人：在线的人 + 我聊过的人；空查询就是全部候选；带 # 就是按号找。 */
  async searchPeople(cooId: string, query: string): Promise<Record<string, unknown>> {
    const handle = parseHandleQuery(query);
    if (handle !== null) {
      const assigned = await this.ctx.db.prepare("SELECT h.coo_id FROM global_handles h JOIN coos c ON c.id=h.coo_id WHERE h.handle=? AND c.status='active'").get(handle) as { coo_id: string } | undefined;
      if (assigned) return { people: assigned.coo_id === cooId ? [] : [await this.personInfo(assigned.coo_id)] };
      if (this.ctx.identityAuthority) {
        const exact = await this.ctx.db.prepare("SELECT id FROM coos WHERE id=? AND status='active'").get(handle) as { id: string } | undefined;
        return { people: exact && exact.id !== cooId ? [await this.personInfo(exact.id)] : [] };
      }
      const rows = await this.ctx.db.prepare(
        `SELECT id FROM coos
          WHERE status = 'active' AND id <> ? AND id LIKE ? ESCAPE '\\'
          ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at, id
          LIMIT ?`,
      ).all<{ id: string }>(cooId, `${likePrefix(handle)}%`, handle, PEOPLE_LIMIT);
      return { people: await this.peopleById(rows.map(row => row.id), cooId, this.ctx.onlineCooIds()) };
    }
    const needle = query.trim().toLowerCase();
    const recent = await this.ctx.db.prepare(`
      WITH recent AS (
        SELECT id
          FROM (
            (SELECT seq, from_coo_id AS id FROM mail
              WHERE coo_id = ? AND from_coo_id IS NOT NULL ORDER BY seq DESC LIMIT 500)
            UNION ALL
            (SELECT seq, coo_id AS id FROM mail
              WHERE from_coo_id = ? AND coo_id <> ? ORDER BY seq DESC LIMIT 500)
          ) AS messages
         ORDER BY seq DESC LIMIT 500
      )
      SELECT DISTINCT id FROM recent
    `).all<{ id: string }>(cooId, cooId, cooId);
    const online = this.ctx.onlineCooIds();
    const candidates = new Set([...online, ...recent.map(row => row.id)]);
    candidates.delete(cooId);
    const people = (await this.peopleById(candidates, cooId, online))
      .filter(person => !needle || person.name.toLowerCase().includes(needle))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, 'zh'))
      .slice(0, PEOPLE_LIMIT);
    return { people };
  }

  private async peopleById(ids: Iterable<string>, viewer: string, online: ReadonlySet<string>) {
    const candidates = [...ids];
    if (candidates.length === 0) return [];
    const rows = await this.ctx.db.prepare(`
      SELECT c.id, c.display_name, s.name AS seat_name, h.handle,
             CASE WHEN r.visibility = 'private' AND r.owner_coo_id IS DISTINCT FROM ?
                    AND family.id IS NULL AND access.coo_id IS NULL
                  THEN NULL ELSE s.room_id END AS room_id
        FROM jsonb_array_elements_text(CAST(? AS jsonb)) WITH ORDINALITY AS p(id, position)
        JOIN coos c ON c.id = p.id
        LEFT JOIN room_seats s ON s.coo_id = c.id AND s.released_at IS NULL
        LEFT JOIN global_handles h ON h.coo_id = c.id
        LEFT JOIN rooms r ON r.id = s.room_id
        LEFT JOIN accounts family ON family.coo_id = r.owner_coo_id AND family.player_coo_id = ? AND family.status = 'active'
        LEFT JOIN room_access access ON access.room_id = r.id AND access.coo_id = ? AND access.status = 'active'
       WHERE c.status = 'active'
       ORDER BY p.position
    `).all<{ id: string; display_name: string; seat_name: string | null; handle: string | null; room_id: string | null }>(
      viewer, JSON.stringify(candidates), viewer, viewer,
    );
    return rows.map(row => ({
      cooId: row.id,
      name: row.seat_name || row.display_name.trim() || row.display_name || '某人',
      online: online.has(row.id),
      room: row.room_id,
      handle: row.handle ?? row.id.slice(0, 8).toLowerCase(),
    }));
  }
}
