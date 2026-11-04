import { withTransaction, type Db } from './db.ts';
import { lockCooRows, lockRoomRow } from './storage/locks.ts';
import { activeSeats, archive } from './room-seat-db.ts';
import { revokeInvitationsFor } from './room-access-db.ts';
import type { RoomHost } from './room-host.ts';

type HostFor = (room: string) => Promise<RoomHost>;
export class RoomLifecycle {
  private running = false;
  private db: Db;
  private hostFor: HostFor;
  private hall: () => string;
  private defaultRoom: string;
  private idleMs: number;
  private archiveMs: number;
  private allowIdleMove: (cooId: string) => boolean;
  constructor(db: Db, hostFor: HostFor, hall: () => string, defaultRoom: string,
    idleMs = 300 * 60_000, archiveMs = 48 * 3_600_000, allowIdleMove: (cooId: string) => boolean = () => true) {
    this.db = db; this.hostFor = hostFor; this.hall = hall; this.defaultRoom = defaultRoom;
    this.idleMs = idleMs; this.archiveMs = archiveMs;
    this.allowIdleMove = allowIdleMove;
  }

  async sweep(now: number): Promise<{ moved: number; archived: number }> {
    const result = { moved: 0, archived: 0 };
    if (this.running) return result;
    this.running = true;
    try {
      if (this.idleMs > 0) {
        const candidates = await this.db.prepare(`SELECT room_id,coo_id FROM room_seats s
          WHERE released_at IS NULL AND kind='pet' AND location_capable=1 AND room_id<>? AND business_active_at<=?
          AND NOT EXISTS(SELECT 1 FROM active_table_players a WHERE a.coo_id=s.coo_id)
          ORDER BY business_active_at LIMIT 50`).all(this.hall(), now - this.idleMs) as { room_id: string; coo_id: string }[];
        for (const item of candidates) {
          if (!this.allowIdleMove(item.coo_id)) continue;
          try {
            await (await this.hostFor(item.room_id)).switchTo(item.coo_id, this.hall(), {
              preserveToken: true, idleBefore: now - this.idleMs,
              allowIdleMove: () => this.allowIdleMove(item.coo_id),
            });
            result.moved++;
          } catch (error) {
            // Concurrent activity or a full hall leaves the original seat intact.
            if (!['conflict', 'full', 'not_found'].includes(String((error as { code?: string }).code))) throw error;
          }
        }
      }
      if (this.archiveMs > 0) {
        const rooms = await this.db.prepare(`SELECT id FROM rooms r WHERE kind='room' AND archived_at IS NULL
          AND id<>? AND owner_coo_id IS DISTINCT FROM 'system-owner' AND business_active_at<=?
          AND NOT EXISTS(SELECT 1 FROM tables t WHERE t.room_id=r.id AND t.status IN ('open','bidding','playing'))
          ORDER BY business_active_at LIMIT 20`).all(this.defaultRoom, now - this.archiveMs) as { id: string }[];
        for (const room of rooms) {
          try {
            const changed = await withTransaction(this.db, async () => {
              const seats = await activeSeats(this.db, room.id);
              await lockCooRows(this.db, seats.map(s => s.cooId));
              for (const id of [room.id, this.hall()].sort()) await lockRoomRow(this.db, id);
              const current = await this.db.prepare(`SELECT 1 FROM rooms WHERE id=? AND archived_at IS NULL AND business_active_at<=?
                AND NOT EXISTS(SELECT 1 FROM tables WHERE room_id=? AND status IN ('open','bidding','playing'))`)
                .get(room.id, now - this.archiveMs, room.id);
              if (!current) return false;
              const fresh = await activeSeats(this.db, room.id);
              // A join between the initial scan and the lock must not escape the identity lock order.
              if (fresh.some(s => !seats.some(old => old.id === s.id))) return false;
              if (fresh.length) {
                const host = await this.hostFor(room.id);
                for (const seat of fresh) await host.switchTo(seat.cooId, this.hall(), { preserveToken: true });
              }
              await revokeInvitationsFor(this.db, room.id, null, now);
              await archive(this.db, room.id, now);
              await this.db.prepare("UPDATE rooms SET archive_reason='inactive_room' WHERE id=?").run(room.id);
              return true;
            });
            if (changed) result.archived++;
          } catch (error) {
            if (!['conflict', 'full', 'not_found'].includes(String((error as { code?: string }).code))) throw error;
          }
        }
      }
      return result;
    } finally { this.running = false; }
  }
}
