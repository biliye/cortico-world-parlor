/**
 * 招募快照（真实 PG）：inbox 里「现在能加入的桌」。
 *
 * 与 TableDiscovery.recruits() 的差别是不逐桌读桌面，所以这里重点验
 * 过滤（满员 / 过期 / 冻结 / 非公开 / 关掉匹配）、狼人杀按 state 定容量、
 * 排序三档、30 秒缓存与按次截断。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/room/db.ts';
import { CooAccountDb } from '../src/room/coo-account-db.ts';
import { createRoom } from '../src/room/room-seat-db.ts';
import { RecruitSnapshot } from '../src/room/recruit-snapshot.ts';
import { closeTestDb, openTestDb } from './helpers/test-db.ts';

const NOW = Date.parse('2026-11-09T12:00:00+08:00');
const MINUTE = 60_000;

let db: Db | undefined;
afterEach(async () => { if (db) await closeTestDb(db); db = undefined; });

interface SeedTable {
  id: string;
  roomId: string;
  epoch: string;
  game: string;
  seats: number;
  deadlineAt?: number;
  status?: string;
  frozenAt?: number | null;
  matchOpen?: boolean;
  version?: number;
  state?: unknown;
}

/** 直接落库造桌：只填快照真正会读的列，人数用 table_seats 的真实行数。 */
const seedTable = async (d: Db, seed: SeedTable): Promise<void> => {
  await d.prepare(
    `INSERT INTO tables(id, room_id, room_epoch, game, status, deadline_at, frozen_at, state_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seed.id, seed.roomId, seed.epoch, seed.game, seed.status ?? 'open',
    seed.deadlineAt ?? NOW + 30 * MINUTE, seed.frozenAt ?? null,
    seed.state === undefined ? null : JSON.stringify(seed.state), NOW, NOW,
  );
  for (let index = 0; index < seed.seats; index += 1) {
    await d.prepare(
      'INSERT INTO table_seats(table_id, room_id, seat_id, position, joined_at) VALUES (?, ?, ?, ?, ?)',
    ).run(seed.id, seed.roomId, `s-${index}`, index + 1, NOW);
  }
  await d.prepare(
    `INSERT INTO table_discovery(table_id, match_open, recruit_text, updated_at, recruit_version)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(seed.id, seed.matchOpen === false ? 0 : 1, '来个人', NOW, seed.version ?? 1);
};

async function seedRooms(d: Db): Promise<{ publicEpoch: string; privateEpoch: string; unlistedEpoch: string }> {
  const owner = 'coo-snap-owner';
  await new CooAccountDb(d).registerCoo(owner, 'secret-snap-owner-0123456789', 'pet', '房主');
  const open = await createRoom(
    d, { id: 'r-snap-open', name: '公开厅', ownerCooId: owner, visibility: 'public' }, NOW,
  );
  const priv = await createRoom(
    d, { id: 'r-snap-priv', name: '私密厅', ownerCooId: owner, visibility: 'private' }, NOW,
  );
  // 建厅默认是 unlisted：与既有 recruits()/matchables() 口径一致，不公开就不进招募。
  const unlisted = await createRoom(d, { id: 'r-snap-unlisted', name: '没公开的厅', ownerCooId: owner }, NOW);
  return { publicEpoch: open.epoch, privateEpoch: priv.epoch, unlistedEpoch: unlisted.epoch };
}

describe('招募快照（真实 PG）', () => {
  it('只给公开、未满、未过期、未冻结的桌；越接近坐满越前，再按截止早、桌号', async () => {
    db = await openTestDb();
    const { publicEpoch, privateEpoch, unlistedEpoch } = await seedRooms(db);
    const base = { roomId: 'r-snap-open', epoch: publicEpoch };

    await seedTable(db, { ...base, id: 't-snap-ddz2', game: 'ddz', seats: 2, deadlineAt: NOW + 10 * MINUTE, version: 3 });
    await seedTable(db, { ...base, id: 't-snap-gomoku1', game: 'gomoku', seats: 1, deadlineAt: NOW + 5 * MINUTE });
    await seedTable(db, { ...base, id: 't-snap-tie-a', game: 'dice', seats: 2, deadlineAt: NOW + 20 * MINUTE });
    await seedTable(db, { ...base, id: 't-snap-tie-b', game: 'dice', seats: 2, deadlineAt: NOW + 20 * MINUTE });
    await seedTable(db, {
      ...base, id: 't-snap-werewolf6', game: 'werewolf', seats: 2, deadlineAt: NOW + 40 * MINUTE, state: { seatCount: 6 },
    });
    await seedTable(db, {
      ...base, id: 't-snap-werewolf9', game: 'werewolf', seats: 2, deadlineAt: NOW + 40 * MINUTE, state: { seatCount: 9 },
    });

    // 以下七张都不该出现。
    await seedTable(db, { ...base, id: 't-snap-full', game: 'ddz', seats: 3 });
    await seedTable(db, { ...base, id: 't-snap-expired', game: 'ddz', seats: 1, deadlineAt: NOW - MINUTE });
    await seedTable(db, { ...base, id: 't-snap-frozen', game: 'ddz', seats: 1, frozenAt: NOW - MINUTE });
    await seedTable(db, { ...base, id: 't-snap-ended', game: 'ddz', seats: 1, status: 'ended' });
    await seedTable(db, { ...base, id: 't-snap-matchoff', game: 'ddz', seats: 1, matchOpen: false });
    await seedTable(db, {
      roomId: 'r-snap-priv', epoch: privateEpoch, id: 't-snap-private', game: 'ddz', seats: 1,
    });
    await seedTable(db, {
      roomId: 'r-snap-unlisted', epoch: unlistedEpoch, id: 't-snap-unlisted', game: 'ddz', seats: 1,
    });

    const snapshot = new RecruitSnapshot(db, () => NOW);
    const tables = await snapshot.take(10);
    expect(tables.map((table) => table.tableId)).toEqual([
      't-snap-ddz2', 't-snap-gomoku1', 't-snap-tie-a', 't-snap-tie-b', 't-snap-werewolf6', 't-snap-werewolf9',
    ]);
    expect(tables[0]).toMatchObject({
      room: 'r-snap-open', roomName: '公开厅', game: 'ddz', seats: 2, capacity: 3, recruitVersion: 3,
    });
    // 狼人杀容量按开局人数定，不是注册表里的默认 9。
    expect(tables.find((table) => table.tableId === 't-snap-werewolf6')?.capacity).toBe(6);
    expect(tables.find((table) => table.tableId === 't-snap-werewolf9')?.capacity).toBe(9);
  });

  it('30 秒内复用同一份快照，过期后重查；截断只在返回时做', async () => {
    db = await openTestDb();
    const { publicEpoch } = await seedRooms(db);
    const base = { roomId: 'r-snap-open', epoch: publicEpoch };
    await seedTable(db, { ...base, id: 't-snap-old1', game: 'ddz', seats: 1 });
    await seedTable(db, { ...base, id: 't-snap-old2', game: 'ddz', seats: 2 });

    let clock = NOW;
    const snapshot = new RecruitSnapshot(db, () => clock);
    expect((await snapshot.take(10)).map((table) => table.tableId)).toEqual(['t-snap-old2', 't-snap-old1']);
    // 缓存里是全量候选：同 30 秒内换个 limit 不用重查也不受影响。
    expect(await snapshot.take(1)).toHaveLength(1);

    await seedTable(db, { ...base, id: 't-snap-new', game: 'ddz', seats: 2 });
    expect((await snapshot.take(10)).map((table) => table.tableId)).not.toContain('t-snap-new');

    clock += 30_000;
    expect((await snapshot.take(10)).map((table) => table.tableId)).toContain('t-snap-new');
  });
});
