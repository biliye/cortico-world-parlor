import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/room/db.ts';
import { WorldServer } from '../src/room/world-server.ts';
import { parseTableLink } from '../src/room/table-discovery-db.ts';
import { pgServerStorage } from './helpers/pg.ts';

type Json = Record<string, any>;
interface Actor { token: string; room: string; cooId: string; secret: string }
let app: WorldServer;
let now = Date.now();
let scratch: string | undefined;
afterEach(async () => { await app?.close(); if (scratch) { rmSync(scratch, { recursive: true, force: true }); scratch = undefined; } });
async function start(file = ':memory:') {
  now = Date.now();
  app = await WorldServer.create({ ...(await pgServerStorage(file)), allowGuestJoin: true, inviteCode: 'test', port: 0, now: () => now });
  await app.listen();
}
async function call(path: string, actor?: Actor, body?: Json) {
  const response = await fetch(app.url + path, { method: body ? 'POST' : 'GET', headers: {
    'content-type': 'application/json', ...(actor ? { authorization: `Bearer ${actor.token}` } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() as Json };
}
async function person(name: string, kind = 'pet', room = 'lobby'): Promise<Actor> {
  const cooId = `coo-${randomUUID()}`;
  const secret = `secret-${cooId}`;
  const response = await fetch(app.url + `/v1/rooms/${room}/join`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-parlor-coo': cooId, 'x-parlor-coo-secret': secret, 'x-parlor-invite': 'test',
  }, body: JSON.stringify({ name, kind }) });
  const body = await response.json() as Json;
  expect(response.status, JSON.stringify(body)).toBe(200);
  return { token: body.token, room, cooId, secret };
}
async function act(actor: Actor, body: Json) {
  return call(`/v1/rooms/${actor.room}/action`, actor, { requestId: randomUUID(), ...body });
}
async function room(actor: Actor, visibility = 'public') {
  const created = await call('/v1/rooms', actor, { name: `测试厅-${randomUUID().slice(0, 8)}`, visibility });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const moved = await call(`/v1/rooms/${actor.room}/switch`, actor, { to: created.body.room.id });
  expect(moved.status).toBe(200);
  actor.token = moved.body.token;
  actor.room = moved.body.room;
  return actor.room;
}
async function table(actor: Actor, options: Json = {}) {
  const opened = await act(actor, { type: 'table_open', game: 'ddz', ...options });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  return opened.body.tableId as string;
}
const enter = (actor: Actor, target: Json = { game: 'ddz' }, requestId = randomUUID()) => call('/v1/table-entry', actor, { ...target, requestId });
const recruit = async (viewer: Actor) => (await call('/v1/hall', viewer)).body.recruitments as Json[];

describe('快速匹配、牌桌招募与链接', () => {
  it('狼人杀快速匹配跳过满六席桌，允许加入已有九席的十二人桌', async () => {
    await start();
    const small = await person('六人桌主');
    const large = await person('十二人桌主');
    await room(small);
    await room(large);
    const six = await table(small, { game: 'werewolf', seatCount: 6, matchOpen: true });
    const twelve = await table(large, { game: 'werewolf', seatCount: 12, matchOpen: true });
    for (const [id, roomId, seats] of [[six, small.room, 5], [twelve, large.room, 8]] as const) {
      for (let i = 0; i < seats; i += 1) {
        const player = await person(`玩家${i}`, 'human', roomId);
        expect((await act(player, { type: 'table_join', table: id })).status).toBe(200);
      }
    }
    expect((await act(small, { type: 'table_discovery', table: six, text: '六人局' })).status).toBe(200);
    expect((await recruit(large)).find((item) => item.tableId === six)).toMatchObject({ capacity: 6, seats: 6, full: true });
    const guest = await person('匹配玩家', 'human');
    expect((await enter(guest, { game: 'werewolf' })).body).toMatchObject({ matched: true, tableId: twelve });
  });
  it('五子棋与快局大富翁可被快速匹配选中，并按 2／4 席限流', async () => {
    await start();
    const gomokuHost = await person('五子棋桌主');
    const monopolyHost = await person('大富翁桌主');
    await room(gomokuHost);
    await room(monopolyHost);
    const gomokuTable = await table(gomokuHost, { game: 'gomoku', matchOpen: true });
    const monopolyTable = await table(monopolyHost, { game: 'monopoly2d', matchOpen: true });
    expect((await enter(await person('五子棋客人', 'human'), { game: 'gomoku' })).body)
      .toMatchObject({ matched: true, tableId: gomokuTable });
    expect((await enter(await person('大富翁客人', 'human'), { game: 'monopoly2d' })).body)
      .toMatchObject({ matched: true, tableId: monopolyTable });
    // 五子棋两席已满，第三人不再匹配到这张桌；大富翁四席仍有余位。
    expect((await enter(await person('五子棋第三人', 'human'), { game: 'gomoku' })).body.matched).toBe(false);
    expect((await enter(await person('大富翁第三人', 'human'), { game: 'monopoly2d' })).body.tableId).toBe(monopolyTable);
  });
  it('默认不开匹配；桌主可开放，跨厅匹配与入桌一并成功，原令牌失效', async () => {
    await start();
    const a = await person('桌主'); const b = await person('客人', 'human', 'hall');
    await room(a); const id = await table(a);
    expect((await enter(b)).body).toEqual({ ok: true, matched: false });
    expect((await act(a, { type: 'table_discovery', table: id, matchOpen: true })).status).toBe(200);
    const joined = await enter(b);
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    expect(joined.body).toMatchObject({ matched: true, room: a.room, tableId: id, seat: { kind: 'human' } });
    expect((await call('/v1/rooms/hall/room', b)).status).toBe(401);
    b.token = joined.body.token; b.room = joined.body.room;
    const snap = await call(`/v1/rooms/${b.room}/room`, b);
    expect(snap.body.table.seats).toHaveLength(2);
    expect(snap.body.tablePrivate.tableId).toBe(id);
    expect(snap.body.table.status).toBe('open');
  });

  it('回包丢失后用旧令牌与相同 requestId 取回原结果；改参数拒绝，不重复入桌', async () => {
    await start(); const a = await person('A'); const b = await person('B');
    await room(a); const id = await table(a, { matchOpen: true });
    const key = randomUUID();
    const first = await enter(b, { game: 'ddz' }, key);
    const retry = await enter(b, { game: 'ddz' }, key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect((await enter(b, { game: 'dice' }, key)).status).toBe(409);
    const usingNew = { ...b, token: first.body.token };
    expect((await enter(usingNew, { game: 'ddz' }, key)).body).toEqual(first.body);
    const snap = await call(`/v1/rooms/${a.room}/room`, a);
    expect(snap.body.table.seats).toHaveLength(2);
    expect(snap.body.tablePrivate.tableId).toBe(id);
  });

  it('最后空位并发不超卖，同一身份的重复并发只入座一次', async () => {
    await start(); const a = await person('A'); await room(a); await table(a, { matchOpen: true });
    const people = await Promise.all(['B', 'C', 'D'].map((name) => person(name)));
    const result = await Promise.all(people.map((actor) => enter(actor)));
    expect(result.filter((item) => item.body.matched)).toHaveLength(2);
    expect(result.filter((item) => item.body.matched === false)).toHaveLength(1);
    const snap = await call(`/v1/rooms/${a.room}/room`, a);
    expect(snap.body.table.seats).toHaveLength(3);
  });

  it('满桌定向加入失败不换厅、不换令牌；普通成员不能切匹配', async () => {
    await start(); const a = await person('A'); await room(a); const id = await table(a);
    const b = await person('B', 'human', a.room); const c = await person('C', 'human', a.room);
    expect((await act(b, { type: 'table_discovery', table: id, matchOpen: true })).status).toBe(403);
    await act(b, { type: 'table_join', table: id }); await act(c, { type: 'table_join', table: id });
    const d = await person('D', 'human', 'hall');
    const full = await enter(d, { room: a.room, table: id });
    expect(full.status).toBe(409);
    expect((await call('/v1/rooms/hall/room', d)).status).toBe(200);
  });

  it('招募可由同桌成员编写、重试去重，独立于匹配；满员显示已满、开局后移除', async () => {
    await start(); const a = await person('A'); await room(a); const id = await table(a);
    const b = await person('B', 'human', a.room); await act(b, { type: 'table_join', table: id });
    const key = randomUUID(); const body = { type: 'table_discovery', table: id, text: '<img src=x onerror=alert(1)> 来一局', requestId: key };
    expect((await act(b, body)).status).toBe(200);
    expect((await act(b, body)).status).toBe(200);
    const cards = await recruit(a);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ tableId: id, seats: 2, capacity: 3, full: false, text: body.text });
    expect(parseTableLink(cards[0].link, app.url)).toEqual({ room: a.room, table: id });
    expect((await enter(await person('D'))).body.matched).toBe(false);
    const c = await person('C', 'human', a.room); await act(c, { type: 'table_join', table: id });
    expect((await recruit(a))[0].full).toBe(true);
    expect((await act(a, { type: 'table_start', table: id })).status).toBe(200);
    expect(await recruit(a)).toHaveLength(0);
  });

  it('作者/桌主可撤回，其他同桌不能改写；限制长度与更新频率', async () => {
    await start(); const a = await person('A'); await room(a); const id = await table(a);
    const b = await person('B', 'human', a.room); await act(b, { type: 'table_join', table: id });
    expect((await act(a, { type: 'table_discovery', table: id, text: 'a'.repeat(201) })).status).toBe(400);
    await act(a, { type: 'table_discovery', table: id, text: '来一局' });
    expect((await act(b, { type: 'table_discovery', table: id, text: '覆盖别人' })).status).toBe(403);
    expect((await act(a, { type: 'table_discovery', table: id, text: '太快' })).status).toBe(409);
    now += 60_001;
    expect((await act(a, { type: 'table_discovery', table: id, text: '更新' })).status).toBe(200);
    expect((await act(b, { type: 'table_discovery', table: id, withdraw: true })).status).toBe(403);
    expect((await act(a, { type: 'table_discovery', table: id, withdraw: true })).status).toBe(200);
    expect(await recruit(a)).toHaveLength(0);
  });

  it('私密与不公开厅不能曝光，链接不授予私密厅权限', async () => {
    await start(); const a = await person('A'); const b = await person('B');
    await room(a, 'private'); const id = await table(a);
    expect((await act(a, { type: 'table_discovery', table: id, matchOpen: true })).status).toBe(403);
    expect((await act(a, { type: 'table_discovery', table: id, text: '秘密' })).status).toBe(403);
    expect((await enter(b, { room: a.room, table: id })).status).toBe(403);
    expect((await call('/v1/rooms/lobby/room', b)).status).toBe(200);
    expect(await recruit(b)).toHaveLength(0);
  });

  it('已有牌桌不自动退桌；押注桌不进入快速匹配池', async () => {
    await start(); const a = await person('A'); await room(a);
    expect((await act(a, { type: 'table_open', game: 'ddz', matchOpen: true, stake: 5 })).status).toBe(400);
    const id = await table(a, { stake: 5 });
    expect((await act(a, { type: 'table_discovery', table: id, matchOpen: true })).status).toBe(400);
    const b = await person('B');
    expect((await enter(b)).body.matched).toBe(false);
    const joined = await enter(b, { room: a.room, table: id }); expect(joined.body.matched).toBe(true);
    b.token = joined.body.token; b.room = joined.body.room;
    expect((await enter(b)).status).toBe(409);
  });

  it('关匹配、收桌和超时桌立即不可匹配', async () => {
    await start(); const a = await person('A'); await room(a); const id = await table(a, { matchOpen: true });
    const b = await person('B');
    await act(a, { type: 'table_discovery', table: id, matchOpen: false });
    expect((await enter(b)).body.matched).toBe(false);
    await act(a, { type: 'table_discovery', table: id, matchOpen: true, text: '等人' });
    now += 30 * 60_000 + 1;
    expect((await enter(b)).body.matched).toBe(false);
    expect(await recruit(b)).toHaveLength(0);
  });

  it('匹配选择人数更多的同游戏桌，桌主仍决定开局', async () => {
    await start(); const a = await person('A'); await room(a); await table(a, { matchOpen: true });
    const b = await person('B'); await room(b); const more = await table(b, { matchOpen: true });
    const c = await person('C', 'human', b.room); await act(c, { type: 'table_join', table: more });
    const d = await person('D'); const found = await enter(d);
    expect(found.body.tableId).toBe(more);
    expect((await call(`/v1/rooms/${b.room}/room`, b)).body.table.status).toBe('open');
  });

  it('同一身份并发重复请求只改变一次席位', async () => {
    await start(); const a = await person('A'); await room(a); await table(a, { matchOpen: true });
    const b = await person('B'); const key = randomUUID();
    const results = await Promise.all([enter(b, { game: 'ddz' }, key), enter(b, { game: 'ddz' }, key)]);
    expect(results[0].body).toEqual(results[1].body);
    expect(results[0].status, JSON.stringify(results[0].body)).toBe(200);
    expect((await call(`/v1/rooms/${a.room}/room`, a)).body.table.seats).toHaveLength(2);
  });

  it('链接拒绝外站、家长钥匙和额外身份参数', () => {
    const good = '/play?room=r-abc&view=table&table=t-abc';
    expect(parseTableLink(good, 'https://example.test')).toEqual({ room: 'r-abc', table: 't-abc' });
    for (const link of ['https://other.test' + good, good + '#key=secret', good + '&token=secret', '/parent?room=r-abc&table=t-abc']) {
      expect(() => parseTableLink(link, 'https://example.test')).toThrow();
    }
  });

  it('回执写入失败整笔回滚：不释放原席位、不污染内存座次或发布离厅事件', async () => {
    await start(); const a = await person('A'); await room(a); await table(a, { matchOpen: true });
    const b = await person('B', 'human', 'hall');
    const db = (app as unknown as { db: Db }).db;
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (sql.includes('INSERT INTO table_entry_receipts')) throw new Error('test_receipt_write_failed');
      return prepare(sql);
    });
    const failed = await enter(b);
    spy.mockRestore();
    expect(failed.status).toBe(500);
    const source = await call('/v1/rooms/hall/room', b);
    expect(source.status).toBe(200);
    expect(source.body.events.filter((event: Json) => event.type === 'parlor.left')).toHaveLength(0);
    expect((await call(`/v1/rooms/${a.room}/room`, a)).body.table.seats).toHaveLength(1);
    expect((await enter(b)).body.matched).toBe(true);
  });

  it('客厅满员时定向加入回滚，快速匹配不选择该厅', async () => {
    await start(); const a = await person('A'); await room(a); const id = await table(a, { matchOpen: true });
    for (let index = 0; index < 29; index++) await person(`留厅${index}`, 'human', a.room);
    const b = await person('B', 'human', 'hall');
    expect((await enter(b, { room: a.room, table: id })).status).toBe(409);
    expect((await enter(b)).body.matched).toBe(false);
    expect((await call('/v1/rooms/hall/room', b)).status).toBe(200);
  });

  it('旧 Coo 不能通过匹配或链接进入狼人杀，真人可加入', async () => {
    await start(); const a = await person('A'); await room(a); const id = await table(a, { game: 'werewolf', matchOpen: true });
    const b = await person('旧 Coo');
    expect((await enter(b, { game: 'werewolf' })).status).toBe(409);
    expect((await enter(b, { room: a.room, table: id })).status).toBe(409);
    const c = await person('真人', 'human');
    expect((await enter(c, { room: a.room, table: id })).body.matched).toBe(true);
  });

  it('转为不公开时撤掉匹配和招募，恢复公开后不会自动重新发布', async () => {
    await start(); const a = await person('A'); await room(a); const id = await table(a, { matchOpen: true });
    const b = await person('B');
    await act(a, { type: 'table_discovery', table: id, text: '公开招募' });
    expect(await recruit(b)).toHaveLength(1);
    expect((await call(`/v1/rooms/${a.room}/visibility`, a, { visibility: 'unlisted' })).status).toBe(200);
    expect(await recruit(b)).toHaveLength(0);
    expect((await enter(b)).body.matched).toBe(false);
    await call(`/v1/rooms/${a.room}/visibility`, a, { visibility: 'public' });
    expect(await recruit(b)).toHaveLength(0);
    expect((await enter(b)).body.matched).toBe(false);
  });

  it('服务重启保留开关、招募与入桌回执，旧令牌仍能恢复原成功结果', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'parlor-match-restart-'));
    const file = join(scratch, 'parlor.db');
    await start(file); const a = await person('A'); await room(a); const id = await table(a, { matchOpen: true });
    await act(a, { type: 'table_discovery', table: id, text: '重启后继续招募' });
    const b = await person('B', 'human', 'hall'); const key = randomUUID();
    const first = await enter(b, { game: 'ddz' }, key);
    expect(first.body.matched).toBe(true);
    await app.close();
    await start(file);
    expect((await enter(b, { game: 'ddz' }, key)).body).toEqual(first.body);
    expect((await recruit(a))[0]).toMatchObject({ text: '重启后继续招募', seats: 2 });
    const snap = await call(`/v1/rooms/${a.room}/room`, a);
    expect(snap.body.table).toMatchObject({ matchOpen: true, status: 'open' });
    expect((await enter(await person('C'))).body.tableId).toBe(id);
  });
});
