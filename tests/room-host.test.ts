import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type Db } from '../src/room/db.ts';
import { RoomHost } from '../src/room/room-host.ts';
import { createRoom } from '../src/room/room-seat-db.ts';

const A = 'coo-aaaaaaaa';
const B = 'coo-bbbbbbbb';
const C = 'coo-cccccccc';

let db: Db;
let lobby: RoomHost;
let other: RoomHost;
let full: RoomHost;

const seed = (): void => {
  const coo = db.prepare('INSERT INTO coos(id, kind, display_name, created_at) VALUES (?, ?, ?, 1)');
  for (const id of [A, B, C]) coo.run(id, 'pet', id);
  createRoom(db, { id: 'lobby', name: '客厅', ownerCooId: A, capacity: 8 });
  createRoom(db, { id: 'other', name: '别厅', ownerCooId: A, capacity: 8 });
  createRoom(db, { id: 'full', name: '满厅', ownerCooId: A });
  // 模拟库内满员边界以验证换房失败回滚。
  db.prepare("UPDATE rooms SET capacity = 2 WHERE id = 'full'").run();
};

const tokenFactory = (): (() => string) => {
  let index = 0;
  return () => `token-${++index}`;
};

beforeEach(() => {
  db = openDb();
  migrate(db);
  seed();
  const tokens = tokenFactory();
  lobby = new RoomHost(db, 'lobby', { now: () => 1000, token: tokens });
  other = new RoomHost(db, 'other', { now: () => 1000, token: tokens });
  full = new RoomHost(db, 'full', { now: () => 1000, token: tokens });
});

afterEach(() => {
  db.close();
});

describe('RoomHost 聊天切片', () => {
  it('加入/说话/提及/快照：本厅看得到，别厅看不到', () => {
    const a = lobby.join(A, { name: '阿岚' });
    const b = lobby.join(B, { name: '小满' });
    expect(a.token).toBe('token-1');
    expect(lobby.seatOf(A)?.name).toBe('阿岚');

    const said = lobby.say(A, '@小满 在吗').event;
    expect(said.mentions).toEqual([b.seat.id]);
    expect(lobby.history(B).map((event) => event.text)).toContain('@小满 在吗');
    expect(lobby.history(B).map((event) => event.text)).toContain('小满 进了客厅。');
    expect(lobby.history(B).map((event) => event.text)).not.toContain('阿岚 进了客厅。');

    const snap = lobby.snapshot(B);
    expect(snap.id).toBe('lobby');
    expect(snap.seat.name).toBe('小满');
    expect(snap.maxSeats).toBe(30);
    expect(snap.events.map((event) => event.text)).toContain('@小满 在吗');
  });

  it('@ 名字按最长匹配：Coo 与 Coo 2 不互相串', () => {
    lobby.join(A, { name: 'Coo' });
    const second = lobby.join(B, { name: 'Coo 2' });
    lobby.join(C, { name: '阿岚' });

    const toSecond = lobby.say(C, '@Coo 2 来一下').event;
    expect(toSecond.mentions).toEqual([second.seat.id]);

    const toFirst = lobby.say(B, '@Coo 来一下').event;
    expect(toFirst.mentions).toEqual([lobby.seatOf(A)!.id]);
  });

  it('私聊：目标看得到、别人看不到；信箱留一封，读后未读清零', () => {
    const a = lobby.join(A, { name: '阿岚' });
    const b = lobby.join(B, { name: '小满' });
    lobby.join(C, { name: '小柚' });

    const whisper = lobby.whisper(A, '小满', '只给你');
    expect(whisper.mailSeq).toBeGreaterThan(0);
    expect(lobby.history(B).map((event) => event.text)).toContain('只给你');
    expect(lobby.history(C).map((event) => event.text)).not.toContain('只给你');
    expect(lobby.mailUnread(B)).toBe(1);
    expect(lobby.mailUnread(A)).toBe(0);

    const page = lobby.readMail(B);
    expect(page.items.map((item) => item.text)).toEqual(['只给你']);
    expect(lobby.mailUnread(B)).toBe(0);
    expect(a.seat.id).not.toBe(b.seat.id);
  });

  it('离开：释放席位但成员保留；之后说话被拒；重进开新区间', () => {
    const first = lobby.join(A, { name: '阿岚' });
    lobby.join(B, { name: '小满' });
    lobby.say(A, '离开前');
    const left = lobby.leave(A);
    expect(left.seat?.releasedAt).not.toBeNull();
    expect(lobby.seatOf(A)).toBeNull();
    expect(() => lobby.say(A, '离开后')).toThrow(/不在这个客厅/);
    expect(() => lobby.seatByToken(first.token)).toThrow(/无效/);

    lobby.say(B, 'A 走之后');
    const second = lobby.join(A, { name: '阿岚' });
    expect(second.seat.visibleFromSeq).toBeGreaterThan(first.seat.visibleFromSeq);
    const texts = lobby.history(A).map((event) => event.text);
    expect(texts).toContain('阿岚 进了客厅。');
    expect(texts).not.toContain('离开前');
    expect(texts).not.toContain('A 走之后');
  });

  it('换房：源厅离开事件 + 目标厅加入事件；源席位释放，目标席位生效', () => {
    lobby.join(A, { name: '阿岚' });
    const moved = lobby.switchTo(A, 'other');
    expect(moved.leaveEvent.text).toContain('别厅');
    expect(moved.joinEvent.text).toContain('阿岚');
    expect(lobby.seatOf(A)).toBeNull();
    expect(other.seatOf(A)?.id).toBe(moved.seat.id);
    expect(moved.released?.releasedAt).not.toBeNull();
    expect(moved.token).toBeTruthy();
  });

  it('目标满员：换房失败，源席位/源事件/源 seq 全部回滚', () => {
    lobby.join(A, { name: '阿岚' });
    full.join(B, { name: '小满' });
    full.join(C, { name: '小柚' });
    const before = lobby.latest();

    expect(() => lobby.switchTo(A, 'full')).toThrow(/最多|满|full/);
    expect(lobby.seatOf(A)).not.toBeNull();
    expect(other.seatOf(A)).toBeNull();
    expect(lobby.latest()).toBe(before);
  });

  it('一个 Coo 不能在两个客厅同时有活跃席位；换房前先离开', () => {
    lobby.join(A, { name: '阿岚' });
    expect(() => other.join(A, { name: '阿岚' })).toThrow(/另一个客厅/);
  });
});
