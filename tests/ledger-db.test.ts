import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTransaction, type Db } from '../src/room/db.ts';
import { LedgerDb, type LedgerRecordInput } from '../src/room/ledger-db.ts';
import { type LedgerEntry } from '../src/room/ledger.ts';
import { closeTestDb, openTestDb } from './helpers/test-db.ts';

const A = 'coo-aaaaaaaa';
const B = 'coo-bbbbbbbb';
const C = 'coo-cccccccc';

const seed = async (db: Db): Promise<void> => {
  const coo = db.prepare('INSERT INTO coos(id, kind, display_name, created_at) VALUES (?, ?, ?, 1)');
  for (const id of [A, B, C]) await coo.run(id, 'pet', id);
  const room = db.prepare(
    `INSERT INTO rooms(id, kind, name, owner_coo_id, visibility, capacity, epoch, seq, created_at, last_active_at)
     VALUES (?, 'room', ?, ?, 'unlisted', 8, ?, 0, 1, 1)`,
  );
  for (const id of ['lobby', 'a', 'b']) await room.run(id, id, A, `epoch-${id}`);
};

let db: Db;
let store: LedgerDb;

beforeEach(async () => {
  db = await openTestDb();
  await seed(db);
  store = new LedgerDb(db, { now: () => 1000 });
});

afterEach(async () => {
  await closeTestDb(db);
});

const game = (
  room: string,
  participants: string[],
  winners: string[],
  tie = false,
): Omit<LedgerEntry, 'id' | 'ts'> => ({
  kind: 'game',
  room,
  from: 'room',
  game: 'dice',
  participants,
  winners,
  text: `${room} 的一局`,
  visibility: 'room',
  data: { tie },
});

const promise = async (
  options: { from?: string; to?: string; due?: number; room?: string } = {},
): Promise<LedgerEntry> => store.record({
  kind: 'promise',
  room: options.room ?? 'lobby',
  from: options.from ?? A,
  to: options.to ?? B,
  text: '一杯奶茶',
  visibility: 'private',
  ...(options.due !== undefined ? { due: options.due } : {}),
  data: { fromName: '阿岚', toName: '小满' },
});

/** 一条按物品记的礼物/喝掉条目——持有量就是靠这些条目现算的。 */
const item = (
  kind: 'gift' | 'gift_used',
  from: string,
  itemId: string,
  to?: string,
): Promise<LedgerEntry> => store.record({
  kind,
  room: 'lobby',
  from,
  ...(to ? { to } : {}),
  text: kind === 'gift' ? `一份${itemId}` : `喝掉了${itemId}`,
  visibility: 'private',
  data: { itemId, itemName: itemId },
});

describe('全局账本 SQLite store', () => {
  it('PG 摘要 recent 保持最近五条混合流水，礼物流水按件算', async () => {
    await item('gift', A, 'longjing', B);
    await store.record({
      ...game('lobby', [A], [A]), text: '结算', effectId: 'recent-game/result', data: { tableId: 'recent-game' },
    });
    await store.record({ kind: 'note', room: 'b', from: 'room', to: A, text: '房间留言', visibility: 'private' });

    const summary = await store.summaryFor(A);
    expect(summary.recent.map((row) => row.kind)).toEqual(['note', 'game', 'gift']);
    expect(summary.recent.every((row) => !('transfers' in row))).toBe(true);

    const { personalHistory } = await import('../src/room/personal-account.ts');
    expect((await personalHistory(db, A, { kind: 'gifts' })).items[0])
      .toMatchObject({ kind: 'gift', itemId: 'longjing', itemName: 'longjing', direction: 'out' });

    await item('gift', B, 'moli', A);
    expect((await store.summaryFor(A)).recent.map((row) => row.kind)).toEqual(['gift', 'note', 'game', 'gift']);
    // 收与送在流水上是两个方向，都不带任何金额。
    const gifts = await personalHistory(db, A, { kind: 'gifts' });
    expect(gifts.items[0]).toMatchObject({ kind: 'gift', itemId: 'moli', direction: 'in' });
    expect(gifts.items.every((row) => !('chips' in row))).toBe(true);
  });
  it('旧对局缺少游戏信息时，全局战绩显示其他', async () => {
    await store.record({ ...game('lobby', [A], [A]), game: undefined, data: {} });
    expect((await store.summaryFor(A)).byGame).toMatchObject([{ game: 'unknown', label: '其他', games: 1 }]);
  });
  it('持有量由条目现算：收到的礼物减去喝掉的，喝成负数就从持有里消失', async () => {
    expect(await store.heldGifts(B)).toEqual({});
    await item('gift', A, 'longjing', B);
    await item('gift', A, 'longjing', B);
    await item('gift', A, 'guihuagao', B);
    expect(await store.heldGifts(B)).toEqual({ longjing: 2, guihuagao: 1 });
    expect(await store.heldCount(B, 'longjing')).toBe(2);
    // 送礼的人手上不多。
    expect(await store.heldGifts(A)).toEqual({});
    expect(await store.heldCount(A, 'longjing')).toBe(0);

    await item('gift_used', B, 'longjing');
    expect(await store.heldCount(B, 'longjing')).toBe(1);
    expect(await store.usedSince(B, 0)).toBe(1);
    expect(await store.usedSince(B, 5000)).toBe(0);

    await item('gift_used', B, 'longjing');
    await item('gift_used', B, 'longjing');
    expect(await store.heldGifts(B)).toEqual({ guihuagao: 1 });
    expect(await store.heldCount(B, 'longjing')).toBe(0);
    expect(await store.usedSince(B, 0)).toBe(3);
  });

  it('participants 按写入顺序读回，不依赖 rowid', async () => {
    const entry = await store.record(game('lobby', [B, A, C], [A]));
    expect((await store.byId(entry.id))?.participants).toEqual([B, A, C]);
  });

  it('承诺状态按 ord 取最后一条 accept/decline/cancel/settle/default', async () => {
    const first = await promise();
    expect(await store.promiseStatus(first)).toBe('pending');
    expect(await store.promiseStatus(first.id)).toBe('pending');

    await store.record({ kind: 'accept', ref: first.id, room: 'lobby', from: B, to: A, text: '好', visibility: 'private' });
    expect(await store.promiseStatus(first)).toBe('accepted');

    await store.record({
      kind: 'settle', ref: first.id, room: 'lobby', from: B, to: A, text: '结了', visibility: 'private',
    });
    expect(await store.promiseStatus(first)).toBe('settled');
    // 了结不产生任何金额。
    expect(await store.heldGifts(A)).toEqual({});
    expect(await store.heldGifts(B)).toEqual({});

    const declined = await promise();
    await store.record({ kind: 'decline', ref: declined.id, room: 'lobby', from: B, to: A, text: '不', visibility: 'private' });
    expect(await store.promiseStatus(declined)).toBe('declined');

    const cancelled = await promise();
    await store.record({ kind: 'cancel', ref: cancelled.id, room: 'lobby', from: A, to: B, text: '算了', visibility: 'private' });
    expect(await store.promiseStatus(cancelled)).toBe('cancelled');

    const expired = await promise();
    await store.record({ kind: 'default', ref: expired.id, room: 'lobby', from: 'room', to: B, text: '到期', visibility: 'private' });
    expect(await store.promiseStatus(expired)).toBe('defaulted');

    const note = await store.record({ kind: 'note', room: 'lobby', from: A, text: '不是承诺', visibility: 'private' });
    expect(await store.promiseStatus(note)).toBeNull();

    expect((await store.find(first.id.slice(0, first.id.length - 1)))?.id).toBe(first.id);
  });

  it('0.37 及以前的礼物没有 itemId，不算持有；新条目按 itemId 聚合', async () => {
    await store.record({ kind: 'gift', room: 'lobby', from: A, to: B, text: '一杯奶茶', visibility: 'private' });
    expect(await store.heldGifts(B)).toEqual({});
    // 跨客厅也合并：持有量跟着人走，不跟着房间走。
    await store.record({
      kind: 'gift', room: 'a', from: A, to: B, text: '龙井', visibility: 'private',
      data: { itemId: 'longjing', itemName: '龙井' },
    });
    await store.record({
      kind: 'gift', room: 'b', from: C, to: B, text: '龙井', visibility: 'private',
      data: { itemId: 'longjing', itemName: '龙井' },
    });
    expect(await store.heldGifts(B)).toEqual({ longjing: 2 });
  });

  it('expire 只扫指定客厅，重复调用不重复记', async () => {
    const inA = await promise({ room: 'a', due: 2000 });
    const inB = await promise({ room: 'b', due: 2000 });
    const pending = await promise({ room: 'a', due: 2000 });
    await store.record({ kind: 'accept', ref: inA.id, room: 'a', from: B, to: A, text: '好', visibility: 'private' });
    await store.record({ kind: 'accept', ref: inB.id, room: 'b', from: B, to: A, text: '好', visibility: 'private' });

    const created = await store.expire(3000, 'a');
    expect(created.map((entry) => entry.ref)).toEqual([inA.id]);
    expect(created[0]).toMatchObject({ kind: 'default', from: 'room', to: B, room: 'a', visibility: 'private' });
    expect(created[0].participants).toEqual([A, B]);
    expect(created[0].text).toBe('到期没结：一杯奶茶');

    expect(await store.promiseStatus(inA)).toBe('defaulted');
    expect(await store.promiseStatus(inB)).toBe('accepted');
    expect(await store.promiseStatus(pending)).toBe('pending');
    expect(await store.expire(3000, 'a')).toHaveLength(0);

    expect(await store.expire(3000, 'b')).toHaveLength(1);
    expect(await store.promiseStatus(inB)).toBe('defaulted');
  });

  it('summaryFor 按 coo 汇总局数/胜负平/礼物/未了结（跨客厅）', async () => {
    await store.record(game('lobby', [A, B], [A]));
    await store.record(game('b', [A, B], [B]));
    await store.record(game('lobby', [A, B], [A, B], true));
    await item('gift', A, 'longjing', B);
    await promise({ from: B, to: A });

    expect(await store.summaryFor(A)).toMatchObject({
      cooId: A, games: 3, wins: 1, losses: 1, draws: 1,
    });
    expect((await store.summaryFor(A)).open).toEqual([]); // retired promises do not appear in the personal account
    expect(await store.summaryFor(B)).toMatchObject({
      games: 3, wins: 1, losses: 1, draws: 1,
    });
    expect(await store.summaryFor(C)).toMatchObject({
      cooId: C, games: 0, wins: 0, losses: 0, draws: 0, open: [],
    });
  });

  it('事务回滚：外层抛错或条目内失败都不留半条', async () => {
    await expect(withTransaction(db, async () => {
      await store.record(game('lobby', [A, B], [A]));
      throw new Error('stop');
    })).rejects.toThrow('stop');
    expect(await store.count()).toBe(0);

    await expect(store.record({
      kind: 'gift', room: 'lobby', from: A, to: 'coo-missing', text: '送给不存在的人', visibility: 'private',
      data: { itemId: 'longjing', itemName: '龙井' },
    })).rejects.toThrow(/FOREIGN KEY|foreign key/i);
    expect(await store.count()).toBe(0);
    expect(((await db.prepare('SELECT COUNT(*) AS n FROM ledger_participants').get()) as { n: number }).n).toBe(0);
  });

  it('文件库关了再开：持有量、承诺状态、未了结都还在', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parlor-ledger-db-'));
    try {
      const file = join(dir, 'parlor.sqlite');
      const first = new LedgerDb(await openTestDb(file), { now: () => 1000 });
      await seed(first.db);
      const created = await first.record({
        kind: 'promise', room: 'lobby', from: A, to: B, text: '一杯奶茶', visibility: 'private',
        due: 9000, data: { fromName: '阿岚', toName: '小满' },
      });
      await first.record({ kind: 'accept', ref: created.id, room: 'lobby', from: B, to: A, text: '好', visibility: 'private' });
      await first.record({
        kind: 'gift', room: 'lobby', from: A, to: B, text: '一份龙井', visibility: 'private',
        data: { itemId: 'longjing', itemName: '龙井' },
      });
      await first.record({
        kind: 'gift_used', room: 'lobby', from: B, text: '喝掉了龙井', visibility: 'private',
        data: { itemId: 'puer', itemName: '普洱' },
      });
      await closeTestDb(first.db);

      const second = new LedgerDb(await openTestDb(file), { now: () => 2000 });
      try {
        expect(await second.heldCount(B, 'longjing')).toBe(1);
        expect(await second.usedSince(B, 0)).toBe(1);
        expect(await second.promiseStatus((await second.find(created.id))!)).toBe('accepted');
        expect(await second.openFor(A)).toHaveLength(1);
        expect((await second.openFor(A))[0]).toMatchObject({
          id: created.id, status: 'accepted', direction: 'out', counterpart: '小满', due: 9000,
        });
        expect(await second.heldCount(A, 'longjing')).toBe(0);
        const entry = (await second.byId(created.id))!;
        expect(entry.ref).toBeUndefined();
        expect((await second.byId((await second.openFor(A))[0].id))?.ref).toBeUndefined();
      } finally {
        await closeTestDb(second.db);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('同一个 effectId 只记一次，返回旧条目', async () => {
    const input: LedgerRecordInput = {
      kind: 'gift', room: 'lobby', from: A, to: B, text: '一份龙井', visibility: 'private',
      effectId: 'fx-1', data: { itemId: 'longjing', itemName: '龙井' },
    };
    const first = await store.record(input);
    const again = await store.record({ ...input, text: '重复投递' });

    expect(again.id).toBe(first.id);
    expect(again.text).toBe('一份龙井');
    expect(again.effectId).toBe('fx-1');
    expect(await store.count()).toBe(1);
    // 幂等：重放不会再送一份。
    expect(await store.heldCount(B, 'longjing')).toBe(1);
    expect((await store.byEffectId('fx-1'))?.id).toBe(first.id);
  });

  it('不裁条目：超过旧 JSON 的 5000 上限也全部保留', async () => {
    await withTransaction(db, async () => {
      for (let index = 0; index < 5001; index += 1) {
        await store.record({ kind: 'note', room: 'lobby', from: A, text: `第 ${index} 条`, visibility: 'private' });
      }
    });
    expect(await store.count()).toBe(5001);
  });
});
