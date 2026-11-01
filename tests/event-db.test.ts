import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db } from '../src/room/db.ts';
import { EventDb } from '../src/room/event-db.ts';
import { closeTestDb, openTestDb } from './helpers/test-db.ts';

const A = 'coo-aaaaaaaa';
const B = 'coo-bbbbbbbb';
const C = 'coo-cccccccc';

let db: Db;
let events: EventDb;

const seed = async (): Promise<void> => {
  const coo = db.prepare('INSERT INTO coos(id, kind, display_name, created_at) VALUES (?, ?, ?, 1)');
  for (const id of [A, B, C]) await coo.run(id, 'pet', id);
  const room = db.prepare(
    `INSERT INTO rooms(id, kind, name, owner_coo_id, visibility, capacity, epoch, seq, created_at, last_active_at)
     VALUES (?, 'room', ?, ?, 'unlisted', 8, ?, 0, 1, 1)`,
  );
  for (const id of ['lobby', 'other']) await room.run(id, id, A, `epoch-${id}`);
  const seat = db.prepare(
    `INSERT INTO room_seats(room_id, id, coo_id, kind, name, tier, token_hash, joined_at, visible_from_seq)
     VALUES (?, ?, ?, 'pet', ?, 'digest', ?, 1, 0)`,
  );
  await seat.run('lobby', 's1', A, '阿岚', 'token-1');
  await seat.run('lobby', 's2', B, '小满', 'token-2');
  await seat.run('lobby', 's3', C, '小柚', 'token-3');
};

beforeEach(async () => {
  db = await openTestDb();
  await seed();
  events = new EventDb(db);
});

afterEach(async () => {
  await closeTestDb(db);
});

const say = async (roomId: string, text: string, from = 's1') => events.append(roomId, {
  type: 'parlor.say', ts: 1000, from, scope: { kind: 'room' }, text,
});

describe('客厅事件流', () => {
  it('append 递增本房 seq；两个客厅各自从 1 开始，不串号', async () => {
    expect(await events.latest('lobby')).toBe(0);
    expect((await say('lobby', '一')).seq).toBe(1);
    expect((await say('lobby', '二')).seq).toBe(2);
    expect((await say('other', '别厅')).seq).toBe(1);
    expect(await events.latest('lobby')).toBe(2);
    expect(await events.latest('other')).toBe(1);
  });

  it('公开事件对厅内任何 coo 可见；不会跨厅泄漏', async () => {
    await say('lobby', '客厅的话');
    await say('other', '别厅的话');
    expect((await events.history('lobby', { cooId: A })).map((event) => event.text)).toEqual(['客厅的话']);
    expect((await events.history('lobby', { cooId: C })).map((event) => event.text)).toEqual(['客厅的话']);
    expect((await events.history('other', { cooId: A })).map((event) => event.text)).toEqual(['别厅的话']);
  });

  it('私聊按 coo 授权：目标看得到，别人看不到；换 seat 仍按 coo', async () => {
    await events.append('lobby', {
      type: 'parlor.whisper', ts: 1000, from: 's2',
      scope: { kind: 'seat', seatId: 's1' }, text: '只给你',
    });
    expect((await events.history('lobby', { cooId: A })).map((event) => event.text)).toEqual(['只给你']);
    expect((await events.history('lobby', { cooId: B })).map((event) => event.text)).toEqual([]);
    expect((await events.history('lobby', { cooId: C })).map((event) => event.text)).toEqual([]);
  });

  it('牌桌聊只给当时在桌的 coo；不在桌的看不到', async () => {
    await events.append('lobby', {
      type: 'parlor.table.say', ts: 1000, from: 's1',
      scope: { kind: 'table', tableId: 't1', seats: ['s1', 's2'] }, text: '桌内话',
    });
    expect((await events.history('lobby', { cooId: A })).map((event) => event.text)).toEqual(['桌内话']);
    expect((await events.history('lobby', { cooId: B })).map((event) => event.text)).toEqual(['桌内话']);
    expect((await events.history('lobby', { cooId: C })).map((event) => event.text)).toEqual([]);
  });

  it('可见区间：from 不含、until 含；区间外看不到', async () => {
    for (let index = 1; index <= 5; index += 1) await say('lobby', `#${index}`);
    const page = await events.history('lobby', {
      cooId: A,
      interval: { visibleFromSeq: 2, visibleUntilSeq: 4 },
    });
    expect(page.map((event) => event.text)).toEqual(['#3', '#4']);
  });

  it('since 与 recent：recent 取最后 N 条但按旧到新返回', async () => {
    for (let index = 1; index <= 5; index += 1) await say('lobby', `#${index}`);
    expect((await events.history('lobby', { cooId: A, since: 3 })).map((event) => event.text)).toEqual(['#4', '#5']);
    expect((await events.recent('lobby', { cooId: A, limit: 2 })).map((event) => event.text)).toEqual(['#4', '#5']);
  });

  it('mentions/data/from 快照能读回', async () => {
    const event = await events.append('lobby', {
      type: 'parlor.ledger', ts: 1000, from: 'system',
      scope: { kind: 'seat', seatId: 's1' }, text: '收到礼物',
      mentions: ['s1'], data: { kind: 'gift', chips: 3 },
    });
    expect(event.scope).toEqual({ kind: 'seat', seatId: 's1' });
    const [stored] = await events.history('lobby', { cooId: A });
    expect(stored).toMatchObject({
      seq: event.seq,
      from: 'system',
      mentions: ['s1'],
      data: { kind: 'gift', chips: 3 },
    });
  });

  it('写入失败回滚：事件和 rooms.seq 都不前进', async () => {
    await say('lobby', '先有一条');
    const before = await events.latest('lobby');
    await expect(events.append('lobby', {
      type: 'parlor.whisper', ts: 1000, from: 's1',
      scope: { kind: 'seat', seatId: 's1' }, text: '坏收件人',
      audience: [{ cooId: 'coo-missing' }],
    })).rejects.toThrow(/FOREIGN KEY|foreign key/i);
    expect(await events.latest('lobby')).toBe(before);
    expect(await events.count('lobby')).toBe(1);
  });
});

describe('事件清理', () => {
  it('删掉超过保留期的事件，最后 500 条永远留着', async () => {
    // 601 条：seq 1 很旧，seq 2..601 都是新的。
    for (let index = 0; index < 601; index += 1) {
      await events.append('lobby', {
        type: 'parlor.say',
        ts: index === 0 ? 1 : 10_000,
        from: 's1',
        scope: { kind: 'room' },
        text: `第 ${index + 1} 条`,
      });
    }
    expect(await events.prune('lobby', 10_000 + 1, 500)).toBe(100);
    const left = await events.recent('lobby', { cooId: A, limit: 200 });
    expect(left).toHaveLength(200);
    expect(left[0].seq).toBe(402);
    expect(left.at(-1)?.seq).toBe(601);
  });
});
