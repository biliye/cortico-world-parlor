/**
 * 并发正确性：同一份测试跑 SQLite 与 PostgreSQL。
 *
 * SQLite 靠单写者 + BEGIN IMMEDIATE 串行；PostgreSQL 靠行锁 + 唯一索引 + 容量触发器。
 * 两边都要满足这些不变量，所以断言只写结果，不写实现细节。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/room/db.ts';
import { EventDb } from '../src/room/event-db.ts';
import { LedgerDb } from '../src/room/ledger-db.ts';
import { RoomHost } from '../src/room/room-host.ts';
import { joinSeat } from '../src/room/room-seat-db.ts';
import { closeTestDb, openTestDb } from './helpers/test-db.ts';

let db: Db;

const seedCoo = async (id: string): Promise<void> => {
  await db.prepare("INSERT INTO coos(id, kind, display_name, created_at) VALUES (?, 'pet', ?, 1)").run(id, id);
};

const seedRoom = async (id: string, capacity: number, owner: string): Promise<void> => {
  await db.prepare(
    `INSERT INTO rooms(id, kind, name, owner_coo_id, visibility, capacity, epoch, seq, created_at, last_active_at)
     VALUES (?, 'room', ?, ?, 'public', ?, ?, 0, 1, 1)`,
  ).run(id, id, owner, capacity, `epoch-${id}`);
};

beforeEach(async () => {
  db = await openTestDb();
});

afterEach(async () => {
  await closeTestDb(db);
});

describe('并发正确性', () => {
  it('最后一手结算下桌后重试原请求，仍返回原回执且不重复结算', async () => {
    for (const id of ['coo-last-a', 'coo-last-b']) await seedCoo(id);
    await seedRoom('room-last', 8, 'coo-last-a');
    const host = await RoomHost.create(db, 'room-last');
    await host.join('coo-last-a', { name: '最后一手甲' });
    await host.join('coo-last-b', { name: '最后一手乙' });
    const opened = await host.openTable('coo-last-a', { game: 'dice' }, 'last-open');
    await host.joinTable('coo-last-b', opened.tableId, 'last-join');
    await host.startTable('coo-last-a', opened.tableId, 'last-start');
    const revisionA = (await host.snapshot('coo-last-a')).tablePrivate?.revision as number;
    await host.tableAction('coo-last-a', { type: 'stand' }, {
      tableId: opened.tableId, revision: revisionA, requestId: 'last-a',
    });
    const revisionB = (await host.snapshot('coo-last-b')).tablePrivate?.revision as number;
    const options = { tableId: opened.tableId, revision: revisionB, requestId: 'last-b' };
    const receipt = await host.tableAction('coo-last-b', { type: 'stand' }, options);
    await expect(host.tableAction('coo-last-b', { type: 'stand' }, options)).resolves.toEqual(receipt);
    const finalized = await db.prepare('SELECT COUNT(*) AS n FROM table_finalizations WHERE table_id = ?').get(opened.tableId) as { n: number };
    expect(finalized.n).toBe(1);
  });

  it('外层事务失败后，开桌草稿和退桌操作都不污染内存中的已提交桌', async () => {
    await seedCoo('coo-outer');
    await seedRoom('room-outer', 8, 'coo-outer');
    const host = await RoomHost.create(db, 'room-outer');
    await host.join('coo-outer', { name: '事务测试' });
    await expect(db.runInTransaction(async () => {
      await host.openTable('coo-outer', { game: 'dice' }, 'rolled-back-open');
      throw new Error('外层失败');
    })).rejects.toThrow('外层失败');
    expect((await host.snapshot('coo-outer')).tables).toEqual([]);

    const opened = await host.openTable('coo-outer', { game: 'dice' }, 'committed-open');
    await expect(db.runInTransaction(async () => {
      await host.leaveTable('coo-outer', opened.tableId, 'rolled-back-leave');
      throw new Error('外层失败');
    })).rejects.toThrow('外层失败');
    expect((await host.snapshot('coo-outer')).table?.id).toBe(opened.tableId);
    const row = await db.prepare('SELECT status FROM tables WHERE id = ?').get(opened.tableId) as { status: string };
    expect(row.status).toBe('open');
  });

  it('同一客厅并发入座：成功数不超过容量，活跃席位与容量一致', async () => {
    const capacity = 3;
    // 主人 + 20 个抢座的人；主人自己不坐。
    await seedCoo('coo-owner');
    for (let index = 0; index < 20; index += 1) await seedCoo(`coo-seat-${index}`);
    await seedRoom('room-cap', capacity, 'coo-owner');

    const attempts = Array.from({ length: 20 }, (_, index) => joinSeat(db, {
      roomId: 'room-cap',
      cooId: `coo-seat-${index}`,
      name: `席位${index}`,
      token: `token-seat-${index}`,
      visibleFromSeq: 0,
    }));
    const results = await Promise.allSettled(attempts);
    const ok = results.filter((result) => result.status === 'fulfilled').length;
    expect(ok).toBe(capacity);

    const row = await db.prepare(
      "SELECT COUNT(*) AS n FROM room_seats WHERE room_id = 'room-cap' AND released_at IS NULL AND kind <> 'observer'",
    ).get() as { n: number };
    expect(row.n).toBe(capacity);

    // 失败的全部是 room_full，不是别的错。
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(String((result.reason as Error).message)).toMatch(/room_full|最多/);
      }
    }
  });

  it('并发礼物不超支：余额 100，10 笔各 100 只有 1 笔成功', async () => {
    await seedCoo('coo-giver');
    await seedCoo('coo-taker');
    await seedRoom('room-gift', 8, 'coo-giver');
    const host = await RoomHost.create(db, 'room-gift');
    await host.join('coo-giver', { name: '送礼的' });
    await host.join('coo-taker', { name: '收礼的' });

    // 把送礼人的余额压到 100：先记一笔 900 的支出。
    const ledger = new LedgerDb(db);
    await ledger.record({
      kind: 'ante',
      room: 'room-gift',
      from: 'coo-giver',
      to: 'room',
      text: '测试前先花掉 900 枚',
      visibility: 'private',
      transfers: [{ from: 'coo-giver', to: 'room', amount: 900 }],
      data: { fromName: '送礼的', chips: 900 },
    });
    expect(await ledger.balanceOf('coo-giver')).toBe(100);

    const attempts = Array.from({ length: 10 }, () => host.gift('coo-giver', '收礼的', '一份礼物', 100));
    const results = await Promise.allSettled(attempts);
    const ok = results.filter((result) => result.status === 'fulfilled').length;
    expect(ok).toBe(1);
    expect(await ledger.balanceOf('coo-giver')).toBe(0);
    expect(await ledger.balanceOf('coo-taker')).toBe(1100);
  });

  it('事务中途失败整笔回滚：事件、seq、收件人都不留', async () => {
    await seedCoo('coo-tx');
    await seedRoom('room-tx', 8, 'coo-tx');
    const events = new EventDb(db);
    const before = await events.latest('room-tx');

    await expect((async () => {
      await db.runInTransaction(async () => {
        await events.append('room-tx', {
          type: 'parlor.say', ts: 1, from: 'system', scope: { kind: 'room' }, text: '这条不该留下',
        });
        throw new Error('故意失败');
      });
    })()).rejects.toThrow('故意失败');

    expect(await events.latest('room-tx')).toBe(before);
    const row = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE room_id = 'room-tx'").get() as { n: number };
    expect(row.n).toBe(0);
  });
});
