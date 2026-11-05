import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldServer } from '../src/room/world-server.ts';
import { ParlorClient } from '../src/room/client.ts';
import { EventDb } from '../src/room/event-db.ts';
import { historySyncEvent, type HistorySyncEvent } from '../src/room/history-sync.ts';
import { pgServerStorage } from './helpers/pg.ts';
import { openTestDb, closeTestDb } from './helpers/test-db.ts';
import type { Db } from '../src/room/db.ts';

let dir: string;
let server: WorldServer | undefined;
let db: Db | undefined;
afterEach(async () => {
  await server?.close(); server = undefined;
  if (db) await closeTestDb(db); db = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const start = async () => {
  dir = mkdtempSync(join(tmpdir(), 'parlor-history-gateway-'));
  const file = join(dir, 'test.db');
  server = await WorldServer.create({ ...(await pgServerStorage(file)), port: 0, inviteCode: 'inv', defaultRoomId: 'lobby' });
  await server.listen(); db = await openTestDb(file);
  const identities = ['a', 'b', 'c'].map(letter => ({ cooId: `coo-history-${letter}000`, cooSecret: `history-secret-${letter}-0123456789` }));
  const clients = identities.map(identity => new ParlorClient(server!.url, identity));
  const seats = [];
  for (let i = 0; i < clients.length; i++) seats.push(await clients[i].join('inv', { name: `玩家${i}` }, 'lobby'));
  return { clients, identities, seats, events: new EventDb(db) };
};

describe('轻量增量补档真实 HTTP + PostgreSQL', () => {
  it('正序分页与旧回放拥有相同历史权限，离席区间不补公共消息，重进仍能补获准的桌聊/私聊', async () => {
    const { clients: [a, b, c], seats: [sa, sb], events, identities } = await start();
    const say = (text: string) => events.append('lobby', { type: 'parlor.say', ts: Date.now(),
      from: sb.seat.id, scope: { kind: 'room' }, text });
    await say('在场时可见');
    const moved = await a.switchTo(sa.token, 'lobby', 'hall');
    await say('离席期间不可见');
    await events.append('lobby', { type: 'parlor.whisper', ts: Date.now(), from: sb.seat.id,
      scope: { kind: 'seat', seatId: sa.seat.id }, text: '只给甲', audience: [{ cooId: identities[0].cooId, seatId: sa.seat.id }],
      data: { mail: { seq: 91, ts: 1, room: 'lobby' }, name: '乙' } });
    await events.append('lobby', { type: 'parlor.table.say', ts: Date.now(), from: sb.seat.id,
      scope: { kind: 'table', tableId: 'old-table', seats: [sa.seat.id, sb.seat.id] }, text: '甲乙当时同桌',
      audience: [{ cooId: identities[0].cooId, seatId: sa.seat.id }, { cooId: identities[1].cooId, seatId: sb.seat.id }] });
    await a.switchTo(moved.token, 'hall', 'lobby');
    await say('重进后可见');
    const all: HistorySyncEvent[] = [];
    let after = 0;
    for (;;) {
      const page = await a.historySync('lobby', after, 2);
      expect(page.events.every(event => event.seq > after)).toBe(true);
      expect(page.events.map(event => event.seq)).toEqual([...page.events.map(event => event.seq)].sort((x, y) => x - y));
      all.push(...page.events); after = page.events.at(-1)?.seq ?? after;
      if (!page.more) break;
    }
    const replay = await a.replayAsIdentity('lobby', 200);
    expect(all).toEqual(replay.events.map(historySyncEvent));
    expect(all.map(event => event.text)).toEqual(expect.arrayContaining(['在场时可见', '重进后可见', '只给甲', '甲乙当时同桌']));
    expect(all.map(event => event.text)).not.toContain('离席期间不可见');
    expect(await a.historySync('lobby', after)).toEqual({ events: [], more: false });
    const third = await c.historySync('lobby');
    expect(third.events.map(event => event.text)).not.toContain('只给甲');
    expect(third.events.map(event => event.text)).not.toContain('甲乙当时同桌');
    // 没有当前席位，也能以自己的身份补自己的历史。
    await db!.prepare('UPDATE room_seats SET released_at=1 WHERE coo_id=? AND released_at IS NULL').run(identities[0].cooId);
    expect((await a.historySync('lobby')).events.map(event => event.text)).toContain('只给甲');
  });

  it('补档响应剔除大块游戏数据，常规回放仍保留；认证与游标校验不能绕过', async () => {
    const { clients: [a], seats: [sa], events, identities } = await start();
    const entry = await events.append('lobby', { type: 'parlor.table.turn', ts: Date.now(), from: 'system',
      scope: { kind: 'seat', seatId: sa.seat.id }, text: '轮到你',
      data: { actorSeatId: sa.seat.id, actorName: '甲', table: { speeches: '历史发言'.repeat(20_000) } } });
    const compact = await a.historySync('lobby', entry.seq - 1);
    expect(compact.events).toEqual([historySyncEvent(entry)]);
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(600);
    const replay = await a.replayAsIdentity('lobby', 1);
    expect(Buffer.byteLength(JSON.stringify(replay))).toBeGreaterThan(200_000);
    expect(replay.events[0].data?.table).toBeTruthy();
    expect((await fetch(`${server!.url}/v1/me/history-sync?room=lobby`)).status).toBe(401);
    const headers = { 'x-parlor-coo': identities[0].cooId, 'x-parlor-coo-secret': identities[0].cooSecret };
    for (const query of ['after=-1', 'after=1.5', 'after=NaN', 'after=9007199254740992', 'limit=0', 'limit=201']) {
      expect((await fetch(`${server!.url}/v1/me/history-sync?room=lobby&${query}`, { headers })).status).toBe(400);
    }
    expect((await fetch(`${server!.url}/v1/me/history-sync?room=missing`, { headers })).status).toBe(404);
    const forged = await fetch(`${server!.url}/v1/me/history-sync?room=lobby&cooId=another`, { headers });
    expect(forged.status).toBe(200);
    expect((await forged.json() as { events: HistorySyncEvent[] }).events.map(event => event.text)).toContain('轮到你');
  });

  it('回放与补档协商 gzip，拒绝压缩时仍能读取同样的 JSON', async () => {
    const { events, identities } = await start();
    await events.append('lobby', { type: 'parlor.say', ts: Date.now(), from: 'system',
      scope: { kind: 'room' }, text: '保留的聊天正文'.repeat(1000) });
    const headers = { 'x-parlor-coo': identities[0].cooId, 'x-parlor-coo-secret': identities[0].cooSecret };
    for (const path of ['/v1/me/replay', '/v1/me/history-sync']) {
      const plain = await fetch(`${server!.url}${path}?room=lobby`, { headers: { ...headers, 'accept-encoding': 'gzip;q=0, *;q=1' } });
      const compressed = await fetch(`${server!.url}${path}?room=lobby`, { headers: { ...headers, 'accept-encoding': 'gzip' } });
      expect(plain.headers.get('content-encoding')).toBeNull();
      expect(compressed.headers.get('content-encoding')).toBe('gzip');
      expect(compressed.headers.get('vary')).toBe('accept-encoding');
      expect(Number(compressed.headers.get('content-length'))).toBeLessThan(Number(plain.headers.get('content-length')) / 10);
      const a = await plain.json() as { events: HistorySyncEvent[] };
      const b = await compressed.json() as { events: HistorySyncEvent[] };
      expect(a.events).toEqual(b.events);
    }
  });
});
