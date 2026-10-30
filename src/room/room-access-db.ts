/**
 * 私密厅的准入与邀请。
 *
 * 三种可见性各是一个意思：
 * - public：公开目录，有平台身份就能进；
 * - unlisted：不进目录，但知道房间 id 的人照样能进（不列目录 ≠ 私密）；
 * - private：只有房主和 `room_access` 里 active 的人能进。
 *
 * 进过房间本身不产生授权（`room_members` 只是访问记录）；只有接受私密厅邀请
 * 才写 `room_access`。邀请 7 天过期；转发的 invitationId 不会把权限给别的账号。
 */
import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import { getRoom, type RoomRow } from './room-seat-db.ts';

export const INVITE_TTL_MS = 7 * 24 * 3_600_000;

export interface AccessView {
  cooId: string;
  name: string;
  status: 'active' | 'revoked';
  source: 'owner' | 'invite' | 'admin';
  grantedAt: number;
  revokedAt: number | null;
}

export interface InvitationView {
  id: string;
  roomId: string;
  roomName: string;
  invitedBy: string;
  invitedByName: string;
  targetCooId: string;
  targetName: string;
  status: 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';
  createdAt: number;
  expiresAt: number;
  handledAt: number | null;
}

interface AccessRow {
  room_id: string;
  coo_id: string;
  status: 'active' | 'revoked';
  source: 'owner' | 'invite' | 'admin';
  granted_at: number;
  revoked_at: number | null;
  name?: string;
}

interface InvitationRow {
  id: string;
  room_id: string;
  invited_by: string;
  target_coo_id: string;
  status: InvitationView['status'];
  created_at: number;
  expires_at: number;
  handled_at: number | null;
  room_name?: string;
  inviter_name?: string;
  target_name?: string;
}

export const isRoomOwner = (db: Db, roomId: string, cooId: string): boolean => {
  if (!cooId) return false;
  const room = getRoom(db, roomId);
  return room !== null && room.ownerCooId === cooId;
};

/** 房主或 room_access 里 active 的人。 */
export const hasRoomAccess = (db: Db, roomId: string, cooId: string): boolean => {
  if (!cooId) return false;
  if (isRoomOwner(db, roomId, cooId)) return true;
  // 房主自己的家长玩家（accounts.player_coo_id）也算房主这边的人：
  // 它是「同一个家长的另一个身份」，不是被孩子邀请的第三方。
  const family = db.prepare(
    `SELECT 1 AS hit FROM accounts a
       JOIN rooms r ON r.owner_coo_id = a.coo_id
      WHERE r.id = ? AND a.player_coo_id = ? AND a.status = 'active' LIMIT 1`,
  ).get(roomId, cooId) as { hit: number } | undefined;
  if (family) return true;
  const row = db.prepare(
    `SELECT 1 AS hit FROM room_access
      WHERE room_id = ? AND coo_id = ? AND status = 'active' LIMIT 1`,
  ).get(roomId, cooId) as { hit: number } | undefined;
  return row !== undefined;
};

/**
 * 统一准入判定：所有入口（初次加入、换房、家长下场、邀请跳转、重发令牌）都走它。
 * 返回 null 表示可以进；否则是给人看的原因。
 */
export const roomEntryRefusal = (db: Db, roomId: string, cooId: string): string | null => {
  const room = getRoom(db, roomId);
  if (!room) return '目标客厅不存在';
  if (room.archivedAt !== null) return '这个客厅已经归档';
  if (room.visibility !== 'private') return null;
  if (hasRoomAccess(db, roomId, cooId)) return null;
  return '这是私密客厅：要房主邀请并接受之后才能进';
};

/** 房主才能管理成员与可见性；家长代管由网关从账户关系推导，不在这里认。 */
export const canManageRoom = (db: Db, roomId: string, cooId: string): boolean => (
  isRoomOwner(db, roomId, cooId)
);

export const grantRoomAccessTx = (
  db: Db,
  input: {
    roomId: string;
    cooId: string;
    source: 'owner' | 'invite' | 'admin';
    grantedBy?: string;
    now: number;
  },
): void => {
  db.prepare(
    `INSERT INTO room_access(room_id, coo_id, status, source, granted_by, granted_at, revoked_at)
     VALUES (?, ?, 'active', ?, ?, ?, NULL)
     ON CONFLICT(room_id, coo_id) DO UPDATE SET
       status = 'active', source = excluded.source, granted_by = excluded.granted_by,
       granted_at = excluded.granted_at, revoked_at = NULL`,
  ).run(input.roomId, input.cooId, input.source, input.grantedBy ?? null, input.now);
};

export const revokeRoomAccessTx = (db: Db, roomId: string, cooId: string, now: number, by?: string): void => {
  db.prepare(
    `INSERT INTO room_access(room_id, coo_id, status, source, granted_by, granted_at, revoked_at)
     VALUES (?, ?, 'revoked', 'admin', ?, ?, ?)
     ON CONFLICT(room_id, coo_id) DO UPDATE SET
       status = 'revoked', granted_by = excluded.granted_by, revoked_at = excluded.revoked_at`,
  ).run(roomId, cooId, by ?? null, now, now);
};

export const listRoomAccess = (db: Db, roomId: string): AccessView[] => {
  const rows = db.prepare(
    `SELECT r.room_id, r.coo_id, r.status, r.source, r.granted_at, r.revoked_at,
            COALESCE(c.display_name, '') AS name
       FROM room_access r LEFT JOIN coos c ON c.id = r.coo_id
      WHERE r.room_id = ?
      ORDER BY r.status, r.granted_at, r.coo_id`,
  ).all(roomId) as unknown as AccessRow[];
  return rows.map((row) => ({
    cooId: row.coo_id,
    name: row.name ?? '',
    status: row.status,
    source: row.source,
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at,
  }));
};

/** 建一条待接受邀请；同一房间对同一人只保留最新一条 pending。 */
export const createRoomInvitationTx = (
  db: Db,
  input: {
    roomId: string;
    invitedBy: string;
    targetCooId: string;
    now: number;
    ttlMs?: number;
  },
): InvitationView => {
  db.prepare(
    `UPDATE room_invitations SET status = 'revoked', handled_at = ?
      WHERE room_id = ? AND target_coo_id = ? AND status = 'pending'`,
  ).run(input.now, input.roomId, input.targetCooId);
  const id = randomUUID();
  const expiresAt = input.now + (input.ttlMs ?? INVITE_TTL_MS);
  db.prepare(
    `INSERT INTO room_invitations(id, room_id, invited_by, target_coo_id, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(id, input.roomId, input.invitedBy, input.targetCooId, input.now, expiresAt);
  return findInvitation(db, id)!;
};

const invitationRow = (db: Db, id: string): InvitationRow | undefined => db.prepare(
  `SELECT i.*, r.name AS room_name, COALESCE(inv.display_name, '') AS inviter_name,
          COALESCE(tgt.display_name, '') AS target_name
     FROM room_invitations i
     LEFT JOIN rooms r ON r.id = i.room_id
     LEFT JOIN coos inv ON inv.id = i.invited_by
     LEFT JOIN coos tgt ON tgt.id = i.target_coo_id
    WHERE i.id = ?`,
).get(id) as InvitationRow | undefined;

const toInvitationView = (row: InvitationRow): InvitationView => ({
  id: row.id,
  roomId: row.room_id,
  roomName: row.room_name ?? row.room_id,
  invitedBy: row.invited_by,
  invitedByName: row.inviter_name ?? '',
  targetCooId: row.target_coo_id,
  targetName: row.target_name ?? '',
  status: row.status,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  handledAt: row.handled_at,
});

export const findInvitation = (db: Db, id: string): InvitationView | null => {
  const row = invitationRow(db, id);
  return row ? toInvitationView(row) : null;
};

/** 把过期但还挂着的邀请标成 expired；读列表前顺手清一遍。 */
export const expireInvitations = (db: Db, now: number): number => {
  const result = db.prepare(
    `UPDATE room_invitations SET status = 'expired', handled_at = ?
      WHERE status = 'pending' AND expires_at <= ?`,
  ).run(now, now);
  return Number(result.changes);
};

export const pendingInvitationsForRoom = (db: Db, roomId: string, now: number): InvitationView[] => {
  expireInvitations(db, now);
  const rows = db.prepare(
    `SELECT i.*, r.name AS room_name, COALESCE(inv.display_name, '') AS inviter_name,
            COALESCE(tgt.display_name, '') AS target_name
       FROM room_invitations i
       LEFT JOIN rooms r ON r.id = i.room_id
       LEFT JOIN coos inv ON inv.id = i.invited_by
       LEFT JOIN coos tgt ON tgt.id = i.target_coo_id
      WHERE i.room_id = ? AND i.status = 'pending'
      ORDER BY i.created_at`,
  ).all(roomId) as unknown as InvitationRow[];
  return rows.map(toInvitationView);
};

export const pendingInvitationsForCoo = (db: Db, cooId: string, now: number): InvitationView[] => {
  expireInvitations(db, now);
  const rows = db.prepare(
    `SELECT i.*, r.name AS room_name, COALESCE(inv.display_name, '') AS inviter_name,
            COALESCE(tgt.display_name, '') AS target_name
       FROM room_invitations i
       LEFT JOIN rooms r ON r.id = i.room_id
       LEFT JOIN coos inv ON inv.id = i.invited_by
       LEFT JOIN coos tgt ON tgt.id = i.target_coo_id
      WHERE i.target_coo_id = ? AND i.status = 'pending'
      ORDER BY i.created_at`,
  ).all(cooId) as unknown as InvitationRow[];
  return rows.map(toInvitationView);
};

export type InvitationDecision = 'ok' | 'not_found' | 'not_yours' | 'not_pending' | 'expired';

/** 接受邀请：核对本人、目标、有效期、撤销状态，然后写长期授权（幂等）。 */
export const acceptInvitationTx = (
  db: Db,
  id: string,
  cooId: string,
  now: number,
): { decision: InvitationDecision; invitation?: InvitationView; room?: RoomRow } => {
  const row = invitationRow(db, id);
  if (!row) return { decision: 'not_found' };
  if (row.target_coo_id !== cooId) return { decision: 'not_yours' };
  if (row.status === 'pending' && row.expires_at <= now) {
    db.prepare("UPDATE room_invitations SET status = 'expired', handled_at = ? WHERE id = ?").run(now, id);
    return { decision: 'expired' };
  }
  if (row.status !== 'pending') {
    // 已经接受过的再点一次：当成功处理（幂等），但不再重复授权。
    if (row.status === 'accepted') {
      return { decision: 'ok', invitation: toInvitationView(row), room: getRoom(db, row.room_id) ?? undefined };
    }
    return { decision: 'not_pending' };
  }
  const room = getRoom(db, row.room_id);
  if (!room) return { decision: 'not_found' };
  grantRoomAccessTx(db, { roomId: row.room_id, cooId, source: 'invite', grantedBy: row.invited_by, now });
  db.prepare("UPDATE room_invitations SET status = 'accepted', handled_at = ? WHERE id = ?").run(now, id);
  return { decision: 'ok', invitation: { ...toInvitationView(row), status: 'accepted', handledAt: now }, room };
};

export const declineInvitationTx = (
  db: Db,
  id: string,
  cooId: string,
  now: number,
): InvitationDecision => {
  const row = invitationRow(db, id);
  if (!row) return 'not_found';
  if (row.target_coo_id !== cooId) return 'not_yours';
  if (row.status !== 'pending') return 'not_pending';
  db.prepare("UPDATE room_invitations SET status = 'declined', handled_at = ? WHERE id = ?").run(now, id);
  return 'ok';
};

/** 撤销某人在这间厅所有还挂着的邀请（移除成员/归档/改可见性时用）。 */
export const revokeInvitationsFor = (db: Db, roomId: string, cooId: string | null, now: number): void => {
  if (cooId) {
    db.prepare(
      `UPDATE room_invitations SET status = 'revoked', handled_at = ?
        WHERE room_id = ? AND target_coo_id = ? AND status = 'pending'`,
    ).run(now, roomId, cooId);
    return;
  }
  db.prepare(
    `UPDATE room_invitations SET status = 'revoked', handled_at = ?
      WHERE room_id = ? AND status = 'pending'`,
  ).run(now, roomId);
};
