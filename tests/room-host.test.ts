import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction, type Db } from '../src/room/db.ts';
import { RoomHost } from '../src/room/room-host.ts';
import { createRoom } from '../src/room/room-seat-db.ts';
import { closeTestDb, openTestDb } from './helpers/test-db.ts';

const A = 'coo-aaaaaaaa';
const B = 'coo-bbbbbbbb';
const C = 'coo-cccccccc';

let db: Db;
let lobby: RoomHost;
let other: RoomHost;
let full: RoomHost;

const seed = async (): Promise<void> => {
  const coo = db.prepare('INSERT INTO coos(id, kind, display_name, created_at) VALUES (?, ?, ?, 1)');
  for (const id of [A, B, C]) await coo.run(id, 'pet', id);
  await createRoom(db, { id: 'lobby', name: '客厅', ownerCooId: A, capacity: 8 });
  await createRoom(db, { id: 'other', name: '别厅', ownerCooId: A, capacity: 8 });
  await createRoom(db, { id: 'full', name: '满厅', ownerCooId: A });
  // 模拟库内满员边界以验证换房失败回滚。
  await db.prepare("UPDATE rooms SET capacity = 2 WHERE id = 'full'").run();
};

const tokenFactory = (): (() => string) => {
  let index = 0;
  return () => `token-${++index}`;
};

beforeEach(async () => {
  db = await openTestDb();
  await seed();
  const tokens = tokenFactory();
  lobby = await RoomHost.create(db, 'lobby', { now: () => 1000, token: tokens });
  other = await RoomHost.create(db, 'other', { now: () => 1000, token: tokens });
  full = await RoomHost.create(db, 'full', { now: () => 1000, token: tokens });
});

afterEach(async () => {
  await closeTestDb(db);
});

describe('RoomHost 聊天切片', () => {
  it('牌桌事件提交后立即通知推送，外层事务回滚不通知、不泄漏桌聊', async () => {
    const commits: string[] = [];
    let now = Date.now();
    const host = await RoomHost.create(db, 'lobby', { now: () => now, onCommit: room => commits.push(room) });
    await host.join(A, { name:'阿岚' });
    const opened = await host.openTable(A, { game:'ddz' }, 'notify-open');
    expect(commits).toContain('lobby');
    commits.length = 0;
    await host.tableSay(A, '已提交桌聊', opened.tableId);
    expect(commits).toEqual(['lobby']);
    commits.length = 0;
    now += 100;
    await expect(withTransaction(db, async () => {
      await host.tableSay(A, '不能发出的桌聊', opened.tableId);
      expect(commits).toEqual([]);
      throw new Error('rollback-notify');
    })).rejects.toThrow('rollback-notify');
    expect(commits).toEqual([]);
    expect((await host.history(A)).some(event => event.text === '不能发出的桌聊')).toBe(false);
  });
  it('加入/说话/提及/快照：本厅看得到，别厅看不到', async () => {
    const a = await lobby.join(A, { name: '阿岚' });
    const b = await lobby.join(B, { name: '小满' });
    expect(a.token).toBe('token-1');
    expect((await lobby.seatOf(A))?.name).toBe('阿岚');

    const said = (await lobby.say(A, '@小满 在吗')).event;
    expect(said.mentions).toEqual([b.seat.id]);
    expect((await lobby.history(B)).map((event) => event.text)).toContain('@小满 在吗');
    expect((await lobby.history(B)).map((event) => event.text)).toContain('小满 进了客厅。');
    expect((await lobby.history(B)).map((event) => event.text)).not.toContain('阿岚 进了客厅。');

    const snap = await lobby.snapshot(B);
    expect(snap.id).toBe('lobby');
    expect(snap.seat.name).toBe('小满');
    expect(snap.maxSeats).toBe(30);
    expect(snap.events.map((event) => event.text)).toContain('@小满 在吗');
  });

  it('@ 名字按最长匹配：Coo 与 Coo 2 不互相串', async () => {
    await lobby.join(A, { name: 'Coo' });
    const second = await lobby.join(B, { name: 'Coo 2' });
    await lobby.join(C, { name: '阿岚' });

    const toSecond = (await lobby.say(C, '@Coo 2 来一下')).event;
    expect(toSecond.mentions).toEqual([second.seat.id]);

    const toFirst = (await lobby.say(B, '@Coo 来一下')).event;
    expect(toFirst.mentions).toEqual([(await lobby.seatOf(A))!.id]);
  });

  it('私聊：目标看得到、别人看不到；信箱留一封，读后未读清零', async () => {
    const a = await lobby.join(A, { name: '阿岚' });
    const b = await lobby.join(B, { name: '小满' });
    await lobby.join(C, { name: '小柚' });

    const whisper = await lobby.whisper(A, '小满', '只给你');
    expect(whisper.mailSeq).toBeGreaterThan(0);
    expect((await lobby.history(B)).map((event) => event.text)).toContain('只给你');
    expect((await lobby.history(C)).map((event) => event.text)).not.toContain('只给你');
    expect(await lobby.mailUnread(B)).toBe(1);
    expect(await lobby.mailUnread(A)).toBe(0);

    const page = await lobby.readMail(B);
    expect(page.items.map((item) => item.text)).toEqual(['只给你']);
    expect(await lobby.mailUnread(B)).toBe(0);
    expect(a.seat.id).not.toBe(b.seat.id);
  });

  it('离开：释放席位但成员保留；之后说话被拒；重进开新区间', async () => {
    const first = await lobby.join(A, { name: '阿岚' });
    await lobby.join(B, { name: '小满' });
    await lobby.say(A, '离开前');
    const left = await lobby.leave(A);
    expect(left.seat?.releasedAt).not.toBeNull();
    expect(await lobby.seatOf(A)).toBeNull();
    await expect(lobby.say(A, '离开后')).rejects.toThrow(/不在这个客厅/);
    await expect(lobby.seatByToken(first.token)).rejects.toThrow(/无效/);

    await lobby.say(B, 'A 走之后');
    const second = await lobby.join(A, { name: '阿岚' });
    expect(second.seat.visibleFromSeq).toBeGreaterThan(first.seat.visibleFromSeq);
    const texts = (await lobby.history(A)).map((event) => event.text);
    expect(texts).toContain('阿岚 进了客厅。');
    expect(texts).not.toContain('离开前');
    expect(texts).not.toContain('A 走之后');
  });

  it('换房：源厅离开事件 + 目标厅加入事件；源席位释放，目标席位生效', async () => {
    await lobby.join(A, { name: '阿岚' });
    const moved = await lobby.switchTo(A, 'other');
    expect(moved.leaveEvent.text).toContain('别厅');
    expect(moved.joinEvent.text).toContain('阿岚');
    expect(await lobby.seatOf(A)).toBeNull();
    expect((await other.seatOf(A))?.id).toBe(moved.seat.id);
    expect(moved.released?.releasedAt).not.toBeNull();
    expect(moved.token).toBeTruthy();
  });

  it('目标满员：换房失败，源席位/源事件/源 seq 全部回滚', async () => {
    await lobby.join(A, { name: '阿岚' });
    await full.join(B, { name: '小满' });
    await full.join(C, { name: '小柚' });
    const before = await lobby.latest();

    await expect(lobby.switchTo(A, 'full')).rejects.toThrow(/最多|满|full/);
    expect(await lobby.seatOf(A)).not.toBeNull();
    expect(await other.seatOf(A)).toBeNull();
    expect(await lobby.latest()).toBe(before);
  });

  it('一个 Coo 不能在两个客厅同时有活跃席位；换房前先离开', async () => {
    await lobby.join(A, { name: '阿岚' });
    await expect(other.join(A, { name: '阿岚' })).rejects.toThrow(/另一个客厅/);
  });
});
