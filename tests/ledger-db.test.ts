import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDb, withTransaction, type Db } from '../src/room/db.ts';
import { LedgerDb, type LedgerRecordInput } from '../src/room/ledger-db.ts';
import {
  REFILL_GAP_MS,
  REFILL_TO,
  START_CHIPS,
  type LedgerEntry,
} from '../src/room/ledger.ts';

const A = 'coo-aaaaaaaa';
const B = 'coo-bbbbbbbb';
const C = 'coo-cccccccc';

const seed = (db: Db): void => {
  const coo = db.prepare('INSERT INTO coos(id, kind, display_name, created_at) VALUES (?, ?, ?, 1)');
  for (const id of [A, B, C]) coo.run(id, 'pet', id);
  const room = db.prepare(
    `INSERT INTO rooms(id, kind, name, owner_coo_id, visibility, capacity, epoch, seq, created_at, last_active_at)
     VALUES (?, 'room', ?, ?, 'unlisted', 8, ?, 0, 1, 1)`,
  );
  for (const id of ['lobby', 'a', 'b']) room.run(id, id, A, `epoch-${id}`);
};

let db: Db;
let store: LedgerDb;

beforeEach(() => {
  db = openDb();
  migrate(db);
  seed(db);
  store = new LedgerDb(db, { now: () => 1000 });
});

afterEach(() => {
  db.close();
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

const promise = (
  options: { from?: string; to?: string; due?: number; chips?: number; room?: string } = {},
): LedgerEntry => store.record({
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
  it('余额由 transfers 现算：房间发行进来，礼物与了结出去', () => {
    const grant = store.ensureGrant(A, 'lobby');
    expect(grant).not.toBeNull();
    expect(grant).toMatchObject({ kind: 'grant', from: 'room', to: A, visibility: 'private' });
    expect(store.balanceOf(A)).toBe(START_CHIPS);
    expect(store.balanceOf(B)).toBe(0);

    store.record({
      kind: 'gift', room: 'lobby', from: A, to: B, text: '先给你 40', visibility: 'private',
      transfers: [{ from: A, to: B, amount: 40 }],
    });
    expect(store.balanceOf(A)).toBe(START_CHIPS - 40);
    expect(store.balanceOf(B)).toBe(40);

    store.record({
      kind: 'settle', room: 'lobby', from: A, to: B, text: '再结 60', visibility: 'private',
      transfers: [{ from: A, to: B, amount: 60 }],
    });
    expect(store.balanceOf(A)).toBe(START_CHIPS - 100);
    expect(store.balanceOf(B)).toBe(100);
    expect(store.balanceOf(C)).toBe(0);

    const rows = db.prepare("SELECT COUNT(*) AS n FROM ledger_transfers WHERE from_kind = 'room'").get() as { n: number };
    expect(rows.n).toBe(1);

    // 底池（押给房间）也是一种合法转移：to_kind='room'、to_coo_id=NULL。
    store.record({
      kind: 'ante', room: 'lobby', from: A, text: '押注', visibility: 'room',
      transfers: [{ from: A, to: 'room', amount: 5 }],
    });
    expect(store.balanceOf(A)).toBe(START_CHIPS - 105);
    const toRoom = db.prepare(
      "SELECT to_kind, to_coo_id FROM ledger_transfers WHERE from_coo_id = ? AND to_kind = 'room'",
    ).get(A) as { to_kind: string; to_coo_id: string | null };
    expect(toRoom).toEqual({ to_kind: 'room', to_coo_id: null });
  });

  it('participants 按写入顺序读回，不依赖 rowid', () => {
    const entry = store.record(game('lobby', [B, A, C], [A]));
    expect(store.byId(entry.id)?.participants).toEqual([B, A, C]);
  });

  it('承诺状态按 ord 取最后一条 accept/decline/cancel/settle/default', () => {
    const first = promise();
    expect(store.promiseStatus(first)).toBe('pending');
    expect(store.promiseStatus(first.id)).toBe('pending');

    store.record({ kind: 'accept', ref: first.id, room: 'lobby', from: B, to: A, text: '好', visibility: 'private' });
    expect(store.promiseStatus(first)).toBe('accepted');

    store.record({
      kind: 'settle', ref: first.id, room: 'lobby', from: B, to: A, text: '结了', visibility: 'private',
      transfers: [{ from: A, to: B, amount: 50 }],
    });
    expect(store.promiseStatus(first)).toBe('settled');
    expect(store.balanceOf(A)).toBe(-50);
    expect(store.balanceOf(B)).toBe(50);

    const declined = promise();
    store.record({ kind: 'decline', ref: declined.id, room: 'lobby', from: B, to: A, text: '不', visibility: 'private' });
    expect(store.promiseStatus(declined)).toBe('declined');

    const cancelled = promise();
    store.record({ kind: 'cancel', ref: cancelled.id, room: 'lobby', from: A, to: B, text: '算了', visibility: 'private' });
    expect(store.promiseStatus(cancelled)).toBe('cancelled');

    const expired = promise();
    store.record({ kind: 'default', ref: expired.id, room: 'lobby', from: 'room', to: B, text: '到期', visibility: 'private' });
    expect(store.promiseStatus(expired)).toBe('defaulted');

    const note = store.record({ kind: 'note', room: 'lobby', from: A, text: '不是承诺', visibility: 'private' });
    expect(store.promiseStatus(note)).toBeNull();

    expect(store.find(first.id.slice(0, first.id.length - 1))?.id).toBe(first.id);
  });

  it('ensureGrant 一个 coo 只发一次；maybeRefill 见底补到 300 且隔 6 小时', () => {
    const now = 1000;
    expect(store.ensureGrant(A, 'lobby')).not.toBeNull();
    expect(store.ensureGrant(A, 'lobby')).toBeNull();
    expect(store.balanceOf(A)).toBe(START_CHIPS);

    // 唯一索引兜底：绕过 ensureGrant 直接插第二条非 refill grant 也会被拒。
    expect(() => db.prepare(
      `INSERT INTO ledger_entries(id, ts, room_id, kind, visibility, from_kind, to_kind, to_coo_id, text, is_refill)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run('dup-grant', 1, 'lobby', 'grant', 'private', 'room', 'coo', A, '重复')).toThrow(/UNIQUE/);

    store.record({
      kind: 'gift', room: 'lobby', from: A, to: B, text: '全给你', visibility: 'private',
      transfers: [{ from: A, to: B, amount: START_CHIPS }],
    });
    expect(store.balanceOf(A)).toBe(0);

    expect(store.maybeRefill(A, 'lobby', now)).not.toBeNull();
    expect(store.balanceOf(A)).toBe(REFILL_TO);
    expect(store.maybeRefill(A, 'lobby', now)).toBeNull();

    store.record({
      kind: 'gift', room: 'lobby', from: A, to: B, text: '又花光了', visibility: 'private',
      transfers: [{ from: A, to: B, amount: REFILL_TO }],
    });
    expect(store.balanceOf(A)).toBe(0);
    expect(store.maybeRefill(A, 'lobby', now + REFILL_GAP_MS - 1)).toBeNull();
    expect(store.maybeRefill(A, 'lobby', now + REFILL_GAP_MS)).not.toBeNull();
    expect(store.balanceOf(A)).toBe(REFILL_TO);
  });

  it('expire 只扫指定客厅，重复调用不重复记', () => {
    const inA = promise({ room: 'a', due: 2000 });
    const inB = promise({ room: 'b', due: 2000 });
    const pending = promise({ room: 'a', due: 2000 });
    store.record({ kind: 'accept', ref: inA.id, room: 'a', from: B, to: A, text: '好', visibility: 'private' });
    store.record({ kind: 'accept', ref: inB.id, room: 'b', from: B, to: A, text: '好', visibility: 'private' });

    const created = store.expire(3000, 'a');
    expect(created.map((entry) => entry.ref)).toEqual([inA.id]);
    expect(created[0]).toMatchObject({ kind: 'default', from: 'room', to: B, room: 'a', visibility: 'private' });
    expect(created[0].participants).toEqual([A, B]);
    expect(created[0].text).toBe('到期没结：一杯奶茶');

    expect(store.promiseStatus(inA)).toBe('defaulted');
    expect(store.promiseStatus(inB)).toBe('accepted');
    expect(store.promiseStatus(pending)).toBe('pending');
    expect(store.expire(3000, 'a')).toHaveLength(0);

    expect(store.expire(3000, 'b')).toHaveLength(1);
    expect(store.promiseStatus(inB)).toBe('defaulted');
  });

  it('summaryFor 按 coo 汇总局数/胜负平/余额/未了结（跨客厅）', () => {
    store.record(game('lobby', [A, B], [A]));
    store.record(game('b', [A, B], [B]));
    store.record(game('lobby', [A, B], [A, B], true));
    store.record({
      kind: 'gift', room: 'lobby', from: A, to: B, text: '20 枚', visibility: 'private',
      transfers: [{ from: A, to: B, amount: 20 }],
    });
    promise({ from: B, to: A });

    expect(store.summaryFor(A)).toMatchObject({
      cooId: A, games: 3, wins: 1, losses: 1, draws: 1, chips: -20,
    });
    expect(store.summaryFor(A).open.map((item) => item.direction)).toEqual(['in']);
    expect(store.summaryFor(B)).toMatchObject({
      games: 3, wins: 1, losses: 1, draws: 1, chips: 20,
    });
    expect(store.summaryFor(C)).toMatchObject({
      cooId: C, games: 0, wins: 0, losses: 0, draws: 0, chips: 0, open: [],
    });
  });

  it('事务回滚：外层抛错或条目内失败都不留半条', () => {
    expect(() => withTransaction(db, () => {
      store.record(game('lobby', [A, B], [A]));
      throw new Error('stop');
    })).toThrow('stop');
    expect(store.count()).toBe(0);

    expect(() => store.record({
      kind: 'gift', room: 'lobby', from: A, to: B, text: '转给不存在的人', visibility: 'private',
      transfers: [{ from: A, to: 'coo-missing', amount: 10 }],
    })).toThrow(/FOREIGN KEY/);
    expect(store.count()).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM ledger_transfers').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM ledger_participants').get() as { n: number }).n).toBe(0);
  });

  it('文件库关了再开：余额、承诺状态、未了结与转移明细都还在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parlor-ledger-db-'));
    try {
      const file = join(dir, 'parlor.sqlite');
      const first = LedgerDb.open(file, { now: () => 1000 });
      seed(first.db);
      first.ensureGrant(A, 'lobby');
      const created = first.record({
        kind: 'promise', room: 'lobby', from: A, to: B, text: '一杯奶茶', visibility: 'private',
        due: 9000, data: { fromName: '阿岚', toName: '小满', chips: 40 },
      });
      first.record({ kind: 'accept', ref: created.id, room: 'lobby', from: B, to: A, text: '好', visibility: 'private' });
      first.record({
        kind: 'gift', room: 'lobby', from: A, to: B, text: '先给你 20', visibility: 'private',
        transfers: [{ from: A, to: B, amount: 20 }],
      });
      first.db.close();

      const second = LedgerDb.open(file, { now: () => 2000 });
      try {
        expect(second.balanceOf(A)).toBe(START_CHIPS - 20);
        expect(second.balanceOf(B)).toBe(20);
        expect(second.promiseStatus(second.find(created.id)!)).toBe('accepted');
        expect(second.openFor(A)).toHaveLength(1);
        expect(second.openFor(A)[0]).toMatchObject({
          id: created.id, status: 'accepted', direction: 'out', counterpart: '小满', due: 9000, chips: 40,
        });
        expect(second.summaryFor(A).chips).toBe(START_CHIPS - 20);
        const entry = second.byId(created.id)!;
        expect(entry.transfers).toBeUndefined();
        expect(second.byId(second.openFor(A)[0].id)?.ref).toBeUndefined();
      } finally {
        second.db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('同一个 effectId 只记一次，返回旧条目且不重复转移', () => {
    const input: LedgerRecordInput = {
      kind: 'gift', room: 'lobby', from: A, to: B, text: '10 枚', visibility: 'private',
      effectId: 'fx-1', transfers: [{ from: A, to: B, amount: 10 }],
    };
    const first = store.record(input);
    const again = store.record({ ...input, text: '重复投递' });

    expect(again.id).toBe(first.id);
    expect(again.text).toBe('10 枚');
    expect(again.effectId).toBe('fx-1');
    expect(store.count()).toBe(1);
    expect(store.balanceOf(B)).toBe(10);
    expect(store.byEffectId('fx-1')?.id).toBe(first.id);
  });

  it('不裁条目：超过旧 JSON 的 5000 上限也全部保留', () => {
    withTransaction(db, () => {
      for (let index = 0; index < 5001; index += 1) {
        store.record({ kind: 'note', room: 'lobby', from: A, text: `第 ${index} 条`, visibility: 'private' });
      }
    });
    expect(store.count()).toBe(5001);
  });
});
