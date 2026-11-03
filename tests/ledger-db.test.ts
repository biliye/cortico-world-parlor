import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTransaction, type Db } from '../src/room/db.ts';
import { LedgerDb, type LedgerRecordInput } from '../src/room/ledger-db.ts';
import {
  REFILL_GAP_MS,
  REFILL_TO,
  START_CHIPS,
  type LedgerEntry,
} from '../src/room/ledger.ts';
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
  options: { from?: string; to?: string; due?: number; chips?: number; room?: string } = {},
): Promise<LedgerEntry> => store.record({
  kind: 'promise',
  room: options.room ?? 'lobby',
  from: options.from ?? A,
  to: options.to ?? B,
  text: '一杯奶茶',
  visibility: 'private',
  ...(options.due !== undefined ? { due: options.due } : {}),
  data: { fromName: '阿岚', toName: '小满', ...(options.chips ? { chips: options.chips } : {}) },
});

describe('全局账本 SQLite store', () => {
  it('PG 摘要 recent 保持最近五条混合流水及单条净额，对局分页另算含底注净额', async () => {
    await store.ensureGrant(A,'lobby');
    await store.record({kind:'ante',room:'lobby',from:A,participants:[A],text:'底注',visibility:'private',effectId:'recent-game/ante',transfers:[{from:A,to:'room',amount:100}]});
    await store.record({...game('lobby',[A],[A]),game:'ddz',text:'结算',effectId:'recent-game/result',data:{tableId:'recent-game'},transfers:[{from:'room',to:A,amount:300}]});
    await store.record({kind:'gift',room:'a',from:A,to:B,text:'送礼',visibility:'private',transfers:[{from:A,to:B,amount:25}]});
    await store.record({kind:'note',room:'b',from:'room',to:A,text:'作废退款',visibility:'private',transfers:[{from:'room',to:A,amount:100}]});
    const summary = await store.summaryFor(A);
    expect(summary.recent.map(row=>[row.kind,row.chips])).toEqual([['note',100],['gift',-25],['game',300],['ante',-100],['grant',1000]]);
    expect(summary.chips).toBe(1275);
    const {personalHistory} = await import('../src/room/personal-account.ts');
    expect((await personalHistory(db,A)).items[0].chips).toBe(200);
    expect(summary.recent.every(row=>!('from_coo_id' in row) && !('transfers' in row))).toBe(true);
    await store.record({kind:'gift',room:'a',from:B,to:A,text:'回礼',visibility:'private',transfers:[{from:B,to:A,amount:5}]});
    expect((await store.summaryFor(A)).recent.map(row=>row.kind)).toEqual(['gift','note','gift','game','ante']);
  });
  it('旧对局缺少游戏信息时，全局战绩显示其他', async () => {
    await store.record({...game('lobby',[A],[A]),game:undefined,data:{}});
    expect((await store.summaryFor(A)).byGame).toMatchObject([{game:'unknown',label:'其他',games:1}]);
  });
  it('余额由 transfers 现算：房间发行进来，礼物与了结出去', async () => {
    const grant = await store.ensureGrant(A, 'lobby');
    expect(grant).not.toBeNull();
    expect(grant).toMatchObject({ kind: 'grant', from: 'room', to: A, visibility: 'private' });
    expect(await store.balanceOf(A)).toBe(START_CHIPS);
    expect(await store.balanceOf(B)).toBe(0);

    await store.record({
      kind: 'gift', room: 'lobby', from: A, to: B, text: '先给你 40', visibility: 'private',
      transfers: [{ from: A, to: B, amount: 40 }],
    });
    expect(await store.balanceOf(A)).toBe(START_CHIPS - 40);
    expect(await store.balanceOf(B)).toBe(40);

    await store.record({
      kind: 'settle', room: 'lobby', from: A, to: B, text: '再结 60', visibility: 'private',
      transfers: [{ from: A, to: B, amount: 60 }],
    });
    expect(await store.balanceOf(A)).toBe(START_CHIPS - 100);
    expect(await store.balanceOf(B)).toBe(100);
    expect(await store.balanceOf(C)).toBe(0);

    const rows = await db.prepare("SELECT COUNT(*) AS n FROM ledger_transfers WHERE from_kind = 'room'").get() as { n: number };
    expect(rows.n).toBe(1);

    // 底池（押给房间）也是一种合法转移：to_kind='room'、to_coo_id=NULL。
    await store.record({
      kind: 'ante', room: 'lobby', from: A, text: '押注', visibility: 'room',
      transfers: [{ from: A, to: 'room', amount: 5 }],
    });
    expect(await store.balanceOf(A)).toBe(START_CHIPS - 105);
    const toRoom = await db.prepare(
      "SELECT to_kind, to_coo_id FROM ledger_transfers WHERE from_coo_id = ? AND to_kind = 'room'",
    ).get(A) as { to_kind: string; to_coo_id: string | null };
    expect(toRoom).toEqual({ to_kind: 'room', to_coo_id: null });
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
      transfers: [{ from: A, to: B, amount: 50 }],
    });
    expect(await store.promiseStatus(first)).toBe('settled');
    expect(await store.balanceOf(A)).toBe(-50);
    expect(await store.balanceOf(B)).toBe(50);

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

  it('ensureGrant 一个 coo 只发一次；maybeRefill 见底补到 300 且隔 6 小时', async () => {
    const now = 1000;
    expect(await store.ensureGrant(A, 'lobby')).not.toBeNull();
    expect(await store.ensureGrant(A, 'lobby')).toBeNull();
    expect(await store.balanceOf(A)).toBe(START_CHIPS);

    // 唯一索引兜底：绕过 ensureGrant 直接插第二条非 refill grant 也会被拒。
    await expect(db.prepare(
      `INSERT INTO ledger_entries(id, ts, room_id, kind, visibility, from_kind, to_kind, to_coo_id, text, is_refill)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run('dup-grant', 1, 'lobby', 'grant', 'private', 'room', 'coo', A, '重复')).rejects.toThrow(/UNIQUE|duplicate key/i);

    await store.record({
      kind: 'gift', room: 'lobby', from: A, to: B, text: '全给你', visibility: 'private',
      transfers: [{ from: A, to: B, amount: START_CHIPS }],
    });
    expect(await store.balanceOf(A)).toBe(0);

    expect(await store.maybeRefill(A, 'lobby', now)).not.toBeNull();
    expect(await store.balanceOf(A)).toBe(REFILL_TO);
    expect(await store.maybeRefill(A, 'lobby', now)).toBeNull();

    await store.record({
      kind: 'gift', room: 'lobby', from: A, to: B, text: '又花光了', visibility: 'private',
      transfers: [{ from: A, to: B, amount: REFILL_TO }],
    });
    expect(await store.balanceOf(A)).toBe(0);
    expect(await store.maybeRefill(A, 'lobby', now + REFILL_GAP_MS - 1)).toBeNull();
    expect(await store.maybeRefill(A, 'lobby', now + REFILL_GAP_MS)).not.toBeNull();
    expect(await store.balanceOf(A)).toBe(REFILL_TO);
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

  it('summaryFor 按 coo 汇总局数/胜负平/余额/未了结（跨客厅）', async () => {
    await store.record(game('lobby', [A, B], [A]));
    await store.record(game('b', [A, B], [B]));
    await store.record(game('lobby', [A, B], [A, B], true));
    await store.record({
      kind: 'gift', room: 'lobby', from: A, to: B, text: '20 枚', visibility: 'private',
      transfers: [{ from: A, to: B, amount: 20 }],
    });
    await promise({ from: B, to: A });

    expect(await store.summaryFor(A)).toMatchObject({
      cooId: A, games: 3, wins: 1, losses: 1, draws: 1, chips: -20,
    });
    expect((await store.summaryFor(A)).open).toEqual([]); // retired promises do not appear in the personal account
    expect(await store.summaryFor(B)).toMatchObject({
      games: 3, wins: 1, losses: 1, draws: 1, chips: 20,
    });
    expect(await store.summaryFor(C)).toMatchObject({
      cooId: C, games: 0, wins: 0, losses: 0, draws: 0, chips: 0, open: [],
    });
  });

  it('事务回滚：外层抛错或条目内失败都不留半条', async () => {
    await expect(withTransaction(db, async () => {
      await store.record(game('lobby', [A, B], [A]));
      throw new Error('stop');
    })).rejects.toThrow('stop');
    expect(await store.count()).toBe(0);

    await expect(store.record({
      kind: 'gift', room: 'lobby', from: A, to: B, text: '转给不存在的人', visibility: 'private',
      transfers: [{ from: A, to: 'coo-missing', amount: 10 }],
    })).rejects.toThrow(/FOREIGN KEY|foreign key/i);
    expect(await store.count()).toBe(0);
    expect(((await db.prepare('SELECT COUNT(*) AS n FROM ledger_transfers').get()) as { n: number }).n).toBe(0);
    expect(((await db.prepare('SELECT COUNT(*) AS n FROM ledger_participants').get()) as { n: number }).n).toBe(0);
  });

  it('文件库关了再开：余额、承诺状态、未了结与转移明细都还在', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parlor-ledger-db-'));
    try {
      const file = join(dir, 'parlor.sqlite');
      const first = new LedgerDb(await openTestDb(file), { now: () => 1000 });
      await seed(first.db);
      await first.ensureGrant(A, 'lobby');
      const created = await first.record({
        kind: 'promise', room: 'lobby', from: A, to: B, text: '一杯奶茶', visibility: 'private',
        due: 9000, data: { fromName: '阿岚', toName: '小满', chips: 40 },
      });
      await first.record({ kind: 'accept', ref: created.id, room: 'lobby', from: B, to: A, text: '好', visibility: 'private' });
      await first.record({
        kind: 'gift', room: 'lobby', from: A, to: B, text: '先给你 20', visibility: 'private',
        transfers: [{ from: A, to: B, amount: 20 }],
      });
      await closeTestDb(first.db);

      const second = new LedgerDb(await openTestDb(file), { now: () => 2000 });
      try {
        expect(await second.balanceOf(A)).toBe(START_CHIPS - 20);
        expect(await second.balanceOf(B)).toBe(20);
        expect(await second.promiseStatus((await second.find(created.id))!)).toBe('accepted');
        expect(await second.openFor(A)).toHaveLength(1);
        expect((await second.openFor(A))[0]).toMatchObject({
          id: created.id, status: 'accepted', direction: 'out', counterpart: '小满', due: 9000, chips: 40,
        });
        expect((await second.summaryFor(A)).chips).toBe(START_CHIPS - 20);
        const entry = (await second.byId(created.id))!;
        expect(entry.transfers).toBeUndefined();
        expect((await second.byId((await second.openFor(A))[0].id))?.ref).toBeUndefined();
      } finally {
        await closeTestDb(second.db);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('同一个 effectId 只记一次，返回旧条目且不重复转移', async () => {
    const input: LedgerRecordInput = {
      kind: 'gift', room: 'lobby', from: A, to: B, text: '10 枚', visibility: 'private',
      effectId: 'fx-1', transfers: [{ from: A, to: B, amount: 10 }],
    };
    const first = await store.record(input);
    const again = await store.record({ ...input, text: '重复投递' });

    expect(again.id).toBe(first.id);
    expect(again.text).toBe('10 枚');
    expect(again.effectId).toBe('fx-1');
    expect(await store.count()).toBe(1);
    expect(await store.balanceOf(B)).toBe(10);
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
