import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDb, type Db } from '../src/room/db.ts';
import {
  RoomSeatError, activeSeatForCoo, activeSeats, archive, createRoom, getRoom, hashSeatToken,
  joinSeat, listRooms, memberOf, membersOf, releaseSeat, resolveRoom, seatByTokenHash, seatInterval,
  switchSeat, touch, unarchive, upsertMember, type RoomSeatErrorCode,
} from '../src/room/room-seat-db.ts';

const COO = 'coo-aaaaaaaa';
const COO2 = 'coo-bbbbbbbb';
const COO3 = 'coo-cccccccc';
const COO4 = 'coo-dddddddd';
const COO5 = 'coo-eeeeeeee';

let db: Db;
let dir: string | undefined;

const seedCoo = (target: Db, id: string, kind = 'pet'): void => {
  target.prepare('INSERT INTO coos(id, kind, created_at) VALUES (?, ?, ?)').run(id, kind, 1);
};

const sessionOf = (target: Db, cooId: string): { current_room_id: string | null; current_seat_id: string | null } | undefined => (
  target.prepare('SELECT current_room_id, current_seat_id FROM coo_sessions WHERE coo_id = ?')
    .get(cooId) as unknown as { current_room_id: string | null; current_seat_id: string | null } | undefined
);

const expectCode = (run: () => unknown, code: RoomSeatErrorCode): void => {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RoomSeatError);
  expect((caught as RoomSeatError).code).toBe(code);
};

beforeEach(() => {
  db = openDb();
  migrate(db);
  seedCoo(db, COO);
  seedCoo(db, COO2);
  seedCoo(db, COO3);
  seedCoo(db, COO4);
  seedCoo(db, COO5);
});

afterEach(() => {
  try { db.close(); } catch { /* 已关闭 */ }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('客厅 store', () => {
  it('建房：id 生成、默认值、固定 30 席与旧参数兼容、主题与非法输入', () => {
    const room = createRoom(db, {
      name: '  可可   厅 ',
      ownerCooId: COO,
      visibility: 'public',
      capacity: 6,
      topic: '  一起   打牌 ',
    }, 1_000);

    expect(room.id).toMatch(/^r-[A-Za-z0-9_-]+$/);
    expect(room).toMatchObject({
      kind: 'room',
      name: '可可 厅',
      ownerCooId: COO,
      visibility: 'public',
      capacity: 30,
      topic: '一起 打牌',
      seq: 0,
      createdAt: 1_000,
      lastActiveAt: 1_000,
      archivedAt: null,
    });
    expect(room.epoch.length).toBeGreaterThan(0);
    expect(createRoom(db, { name: '两人厅', ownerCooId: COO, capacity: 2 }, 1_001).capacity).toBe(30);
    expect(createRoom(db, { name: '十二人厅', ownerCooId: COO, capacity: 12 }, 1_002).capacity).toBe(30);
    expect(createRoom(db, { name: '三十人厅', ownerCooId: COO, capacity: 30 }, 1_003).capacity).toBe(30);

    expectCode(() => createRoom(db, { name: '太小', ownerCooId: COO, capacity: 1 }), 'invalid');
    expectCode(() => createRoom(db, { name: '太大', ownerCooId: COO, capacity: 31 }), 'invalid');
    expectCode(() => createRoom(db, { name: 'x', ownerCooId: COO }), 'invalid');
    expectCode(() => createRoom(db, { name: '好厅', ownerCooId: 'coo-zzzzzzzz' }), 'unknown_coo');
    expectCode(() => createRoom(db, { name: '好厅', ownerCooId: COO, visibility: 'secret' as never }), 'invalid');

    const custom = createRoom(db, { id: 'lobby', name: '默认厅', ownerCooId: COO }, 1_003);
    expect(custom.id).toBe('lobby');
    expectCode(() => createRoom(db, { id: 'lobby', name: '另一个', ownerCooId: COO }), 'room_exists');
  });

  it('目录：默认不含归档、可按可见性过滤；resolve、touch、归档幂等', () => {
    const pub = createRoom(db, { name: '公开厅', ownerCooId: COO, visibility: 'public', capacity: 4 }, 100);
    const priv = createRoom(db, { name: '私密厅', ownerCooId: COO, visibility: 'private', capacity: 4 }, 200);
    const old = createRoom(db, { name: '旧厅', ownerCooId: COO, visibility: 'public', capacity: 4 }, 300);

    expect(listRooms(db).map((room) => room.id)).toEqual([old.id, priv.id, pub.id]);
    expect(archive(db, old.id, 400)?.archivedAt).toBe(400);
    expect(listRooms(db).map((room) => room.id)).toEqual([priv.id, pub.id]);
    expect(listRooms(db, { visibility: 'public' }).map((room) => room.id)).toEqual([pub.id]);
    expect(listRooms(db, { includeArchived: true })).toHaveLength(3);
    expect(listRooms(db, { includeArchived: true }).find((room) => room.id === old.id)?.archivedAt).toBe(400);

    expect(getRoom(db, old.id)?.archivedAt).toBe(400);
    expect(resolveRoom(db, pub.id)?.id).toBe(pub.id);
    expect(resolveRoom(db, ' 公开厅 ')?.id).toBe(pub.id);
    expect(resolveRoom(db, '没有厅')).toBeNull();

    expect(touch(db, pub.id, 500)).toBe(true);
    expect(getRoom(db, pub.id)?.lastActiveAt).toBe(500);
    expect(touch(db, 'r-missing', 500)).toBe(false);

    expect(archive(db, old.id, 600)?.archivedAt).toBe(400);
    const revived = unarchive(db, old.id, 700);
    expect(revived?.archivedAt).toBeNull();
    expect(revived?.lastActiveAt).toBe(700);
    expect(listRooms(db)).toHaveLength(3);
    expect(archive(db, 'r-missing')).toBeNull();
    expect(unarchive(db, 'r-missing')).toBeNull();

    createRoom(db, { name: 'Cocoa', ownerCooId: COO, capacity: 4 }, 800);
    expect(resolveRoom(db, 'cocoa')?.name).toBe('Cocoa');
  });

  it('容量：只算活跃非 observer；绕过 store 直插也被 trigger 拦住', () => {
    const room = createRoom(db, { name: '两人厅', ownerCooId: COO, capacity: 2 }, 100);
    // 人为设置库内边界，保留底层满员保护的验证。
    db.prepare('UPDATE rooms SET capacity = 2 WHERE id = ?').run(room.id);
    const first = joinSeat(db, { roomId: room.id, cooId: COO, name: '甲', token: 'token-cap-1', visibleFromSeq: 0 });
    joinSeat(db, { roomId: room.id, cooId: COO2, name: '乙', token: 'token-cap-2', visibleFromSeq: 0 });
    expectCode(() => joinSeat(db, { roomId: room.id, cooId: COO3, name: '丙', token: 'token-cap-3', visibleFromSeq: 0 }), 'room_full');

    releaseSeat(db, room.id, first.id, 5, 200);
    const third = joinSeat(db, { roomId: room.id, cooId: COO3, name: '丙', token: 'token-cap-3', visibleFromSeq: 0 });
    expect(third.name).toBe('丙');

    const watcher = joinSeat(db, {
      roomId: room.id, cooId: COO4, name: '看客', token: 'token-cap-4', kind: 'observer', visibleFromSeq: 0,
    });
    expect(watcher.kind).toBe('observer');
    expect(activeSeats(db, room.id)).toHaveLength(3);

    expect(() => db.prepare(
      `INSERT INTO room_seats(room_id, id, coo_id, kind, name, tier, token_hash, joined_at, visible_from_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(room.id, 's-direct', COO5, 'pet', '直插', 'digest', 'direct-token-hash', 1, 0)).toThrow(/room_full/);
  });

  it('一个 Coo 同时只有一个活跃席位；释放后才能去别的客厅', () => {
    const a = createRoom(db, { name: '甲厅', ownerCooId: COO }, 100);
    const b = createRoom(db, { name: '乙厅', ownerCooId: COO }, 200);
    const seatA = joinSeat(db, { roomId: a.id, cooId: COO, name: '阿岚', token: 'token-one-seat-1', visibleFromSeq: 0 });

    expect(activeSeatForCoo(db, COO)?.id).toBe(seatA.id);
    expectCode(() => joinSeat(db, { roomId: b.id, cooId: COO, name: '阿岚', token: 'token-one-seat-2', visibleFromSeq: 0 }), 'already_seated');

    releaseSeat(db, a.id, seatA.id, 9, 300);
    expect(activeSeatForCoo(db, COO)).toBeNull();
    const seatB = joinSeat(db, { roomId: b.id, cooId: COO, name: '阿岚', token: 'token-one-seat-2', visibleFromSeq: 0 });
    expect(activeSeatForCoo(db, COO)?.roomId).toBe(b.id);
    expect(activeSeatForCoo(db, COO)?.id).toBe(seatB.id);

    const active = db.prepare('SELECT COUNT(*) AS n FROM room_seats WHERE coo_id = ? AND released_at IS NULL')
      .get(COO) as unknown as { n: number };
    expect(active.n).toBe(1);
  });

  it('真人同名活跃席位拒绝（大小写不敏感），释放后可用；令牌只存哈希', () => {
    const a = createRoom(db, { name: '甲厅', ownerCooId: COO }, 100);
    const b = createRoom(db, { name: '乙厅', ownerCooId: COO }, 200);
    const seat1 = joinSeat(db, {
      roomId: a.id, cooId: COO, kind: 'human', name: 'Cocoa', token: 'token-name-1', visibleFromSeq: 0,
    });

    expectCode(() => joinSeat(db, {
      roomId: a.id, cooId: COO2, kind: 'human', name: 'cocoa', token: 'token-name-2', visibleFromSeq: 0,
    }), 'name_taken');
    expect(joinSeat(db, {
      roomId: b.id, cooId: COO2, kind: 'human', name: 'cocoa', token: 'token-name-3', visibleFromSeq: 0,
    }).name).toBe('cocoa');

    releaseSeat(db, a.id, seat1.id, 3, 300);
    const seat3 = joinSeat(db, {
      roomId: a.id, cooId: COO3, kind: 'human', name: 'COCOA', token: 'token-name-4', visibleFromSeq: 0,
    });
    expect(seat3.name).toBe('COCOA');

    const stored = db.prepare('SELECT token_hash FROM room_seats WHERE room_id = ? AND id = ?')
      .get(a.id, seat3.id) as unknown as { token_hash: string };
    expect(stored.token_hash).toBe(hashSeatToken('token-name-4'));
    expect(stored.token_hash).not.toBe('token-name-4');
    expect(seatByTokenHash(db, hashSeatToken('token-name-4'))?.id).toBe(seat3.id);
    expect(seatByTokenHash(db, 'token-name-4')).toBeNull();
    expect(seatByTokenHash(db, hashSeatToken('token-name-1'))).toBeNull();
  });

  it('Coo 同名自动加序号，大小写不敏感；序号名也占坑，释放后回到原名', () => {
    const room = createRoom(db, { name: '同名厅', ownerCooId: COO }, 100);
    const first = joinSeat(db, { roomId: room.id, cooId: COO, name: 'Cocoa', token: 'token-suffix-1', visibleFromSeq: 0 });
    expect(first.name).toBe('Cocoa');

    const second = joinSeat(db, { roomId: room.id, cooId: COO2, name: 'cocoa', token: 'token-suffix-2', visibleFromSeq: 0 });
    expect(second.name).toBe('cocoa 2');
    const third = joinSeat(db, { roomId: room.id, cooId: COO3, name: 'COCOA', token: 'token-suffix-3', visibleFromSeq: 0 });
    expect(third.name).toBe('COCOA 3');

    // 「cocoa 2」已经被占了，再撞名要跳到 4。
    const fourth = joinSeat(db, { roomId: room.id, cooId: COO4, name: 'cocoa', token: 'token-suffix-4', visibleFromSeq: 0 });
    expect(fourth.name).toBe('cocoa 4');
    expectCode(() => joinSeat(db, {
      roomId: room.id, cooId: COO5, kind: 'human', name: 'cocoa', token: 'token-suffix-5', visibleFromSeq: 0,
    }), 'name_taken');

    releaseSeat(db, room.id, first.id, 9, 900);
    const reused = joinSeat(db, { roomId: room.id, cooId: COO5, name: 'Cocoa', token: 'token-suffix-6', visibleFromSeq: 0 });
    expect(reused.name).toBe('Cocoa');
  });

  it('同名自动加序号不会超过 24 字', () => {
    const room = createRoom(db, { name: '长名厅', ownerCooId: COO }, 100);
    const base = '一二三四五六七八九十一二三四五六七八九十一二三四';
    expect(Array.from(base)).toHaveLength(24);
    joinSeat(db, { roomId: room.id, cooId: COO, name: base, token: 'token-long-1', visibleFromSeq: 0 });
    const second = joinSeat(db, { roomId: room.id, cooId: COO2, name: base, token: 'token-long-2', visibleFromSeq: 0 });
    expect(Array.from(second.name)).toHaveLength(24);
    expect(second.name.endsWith(' 2')).toBe(true);
    expect(second.name.slice(0, -2)).toBe(Array.from(base).slice(0, 22).join(''));
  });

  it('离开只释放席位，成员保留；可见区间封口且 release 幂等', () => {
    const room = createRoom(db, { name: '成员厅', ownerCooId: COO }, 100);
    const seat = joinSeat(db, { roomId: room.id, cooId: COO, name: '阿岚', token: 'token-member-1', visibleFromSeq: 2 });

    expect(memberOf(db, room.id, COO)?.removedAt).toBeNull();
    expect(membersOf(db, room.id).map((member) => member.cooId)).toEqual([COO]);

    const released = releaseSeat(db, room.id, seat.id, 7, 555);
    expect(released?.releasedAt).toBe(555);
    expect(released?.visibleToSeq).toBe(7);
    expect(seatInterval(db, room.id, seat.id)).toEqual({ visibleFromSeq: 2, visibleToSeq: 7 });

    expect(activeSeatForCoo(db, COO)).toBeNull();
    expect(memberOf(db, room.id, COO)).not.toBeNull();
    expect(membersOf(db, room.id)).toHaveLength(1);

    const again = releaseSeat(db, room.id, seat.id, 99, 999);
    expect(again?.releasedAt).toBe(555);
    expect(again?.visibleToSeq).toBe(7);
    expect(releaseSeat(db, room.id, 's-missing', 1)).toBeNull();

    const seat2 = joinSeat(db, { roomId: room.id, cooId: COO, name: '阿岚', token: 'token-member-2', visibleFromSeq: 10 });
    expectCode(() => releaseSeat(db, room.id, seat2.id, 9), 'invalid');
    expect(activeSeatForCoo(db, COO)?.id).toBe(seat2.id);
  });

  it('重进开新席位与新区间，旧区间保留，成员不重复', () => {
    const room = createRoom(db, { name: '重进厅', ownerCooId: COO }, 100);
    const first = joinSeat(db, { roomId: room.id, cooId: COO, name: '阿岚', token: 'token-rejoin-1', visibleFromSeq: 0 });
    releaseSeat(db, room.id, first.id, 4, 200);

    const second = joinSeat(db, { roomId: room.id, cooId: COO, name: '阿岚', token: 'token-rejoin-2', visibleFromSeq: 10 });
    expect(second.id).not.toBe(first.id);
    expect(second.visibleFromSeq).toBe(10);
    expect(second.visibleToSeq).toBeNull();
    expect(seatInterval(db, room.id, first.id)).toEqual({ visibleFromSeq: 0, visibleToSeq: 4 });
    expect(seatInterval(db, room.id, second.id)).toEqual({ visibleFromSeq: 10, visibleToSeq: null });
    expect(activeSeats(db, room.id).map((row) => row.id)).toEqual([second.id]);
    expect(membersOf(db, room.id)).toHaveLength(1);
  });

  it('换房：目标满则源席位与成员写入一起回滚；成功时区间各自封口', () => {
    const a = createRoom(db, { name: '甲厅', ownerCooId: COO, capacity: 3 }, 100);
    const b = createRoom(db, { name: '乙厅', ownerCooId: COO, capacity: 2 }, 200);
    db.prepare('UPDATE rooms SET capacity = 2 WHERE id = ?').run(b.id);
    const mine = joinSeat(db, { roomId: a.id, cooId: COO, name: '阿岚', token: 'token-switch-1', visibleFromSeq: 0 });
    joinSeat(db, { roomId: b.id, cooId: COO2, name: '甲', token: 'token-switch-2', visibleFromSeq: 0 });
    joinSeat(db, { roomId: b.id, cooId: COO3, name: '乙', token: 'token-switch-3', visibleFromSeq: 0 });

    expectCode(() => switchSeat(db, {
      fromRoomId: a.id,
      fromSeatId: mine.id,
      visibleToSeq: 6,
      to: { roomId: b.id, cooId: COO, name: '阿岚', token: 'token-switch-4', visibleFromSeq: 100 },
    }), 'room_full');

    expect(activeSeatForCoo(db, COO)?.id).toBe(mine.id);
    expect(seatInterval(db, a.id, mine.id)).toEqual({ visibleFromSeq: 0, visibleToSeq: null });
    expect(memberOf(db, b.id, COO)).toBeNull();
    expect(sessionOf(db, COO)).toEqual({ current_room_id: a.id, current_seat_id: mine.id });

    const other = activeSeatForCoo(db, COO2);
    releaseSeat(db, b.id, other!.id, 7, 300);

    const moved = switchSeat(db, {
      fromRoomId: a.id,
      fromSeatId: mine.id,
      visibleToSeq: 6,
      to: { roomId: b.id, cooId: COO, name: '阿岚', token: 'token-switch-4', visibleFromSeq: 100 },
    });
    expect(moved.released.visibleToSeq).toBe(6);
    expect(moved.seat.roomId).toBe(b.id);
    expect(activeSeatForCoo(db, COO)?.id).toBe(moved.seat.id);
    expect(seatInterval(db, a.id, mine.id)).toEqual({ visibleFromSeq: 0, visibleToSeq: 6 });
    expect(memberOf(db, a.id, COO)).not.toBeNull();
    expect(memberOf(db, b.id, COO)).not.toBeNull();
    expect(sessionOf(db, COO)).toEqual({ current_room_id: b.id, current_seat_id: moved.seat.id });

    expectCode(() => switchSeat(db, {
      fromRoomId: b.id,
      fromSeatId: moved.seat.id,
      visibleToSeq: 8,
      to: { roomId: a.id, cooId: COO2, name: '甲', token: 'token-switch-5', visibleFromSeq: 200 },
    }), 'invalid');
    expect(activeSeatForCoo(db, COO)?.id).toBe(moved.seat.id);
  });

  it('成员：upsert 幂等，移除后可以恢复并更新 joined_at', () => {
    const room = createRoom(db, { name: '成员厅', ownerCooId: COO }, 100);
    const first = upsertMember(db, room.id, COO, 100);
    expect(first.joinedAt).toBe(100);
    expect(upsertMember(db, room.id, COO, 200).joinedAt).toBe(100);
    expect(membersOf(db, room.id)).toHaveLength(1);

    db.prepare('UPDATE room_members SET removed_at = 300 WHERE room_id = ? AND coo_id = ?').run(room.id, COO);
    expect(memberOf(db, room.id, COO)).toBeNull();
    expect(membersOf(db, room.id)).toHaveLength(0);

    const revived = upsertMember(db, room.id, COO, 400);
    expect(revived.removedAt).toBeNull();
    expect(revived.joinedAt).toBe(400);
    expect(memberOf(db, room.id, COO)?.joinedAt).toBe(400);
    expectCode(() => upsertMember(db, room.id, 'coo-zzzzzzzz', 500), 'unknown_coo');
  });

  it('持久化：重开数据库后房间、成员、席位与区间都还在', () => {
    dir = mkdtempSync(join(tmpdir(), 'parlor-seat-db-'));
    const file = join(dir, 'parlor.db');
    const first = openDb(file);
    migrate(first);
    seedCoo(first, COO);
    const room = createRoom(first, { name: '持久厅', ownerCooId: COO, visibility: 'public' }, 1_000);
    const seat = joinSeat(first, {
      roomId: room.id, cooId: COO, name: '阿岚', token: 'token-persist-1', visibleFromSeq: 3, now: 1_001,
    });
    releaseSeat(first, room.id, seat.id, 12, 1_002);
    first.close();

    const second = openDb(file);
    try {
      migrate(second);
      expect(getRoom(second, room.id)?.name).toBe('持久厅');
      expect(memberOf(second, room.id, COO)?.joinedAt).toBe(1_001);
      expect(seatInterval(second, room.id, seat.id)).toEqual({ visibleFromSeq: 3, visibleToSeq: 12 });
      expect(activeSeatForCoo(second, COO)).toBeNull();
      expect(seatByTokenHash(second, hashSeatToken('token-persist-1'))).toBeNull();

      const again = joinSeat(second, {
        roomId: room.id, cooId: COO, name: '阿岚', token: 'token-persist-2', visibleFromSeq: 20, now: 1_003,
      });
      expect(again.visibleFromSeq).toBe(20);
      expect(activeSeats(second, room.id).map((row) => row.id)).toEqual([again.id]);
    } finally {
      second.close();
    }
  });
});
