/** 短号：cooId 前 8 位；搜人、私聊、邀请都能按 #号 找人。 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { likePrefix, parseHandleQuery, shortHandle } from '../src/room/handles.ts';
import { WorldServer } from '../src/room/world-server.ts';

let dir: string | undefined;
let server: WorldServer | undefined;

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const A = 'coo-aaaaaaaa';
const C = 'coo-cccccccc';

const start = async (): Promise<WorldServer> => {
  dir = mkdtempSync(join(tmpdir(), 'parlor-handles-'));
  server = new WorldServer({
    dbFile: join(dir, 'parlor.db'), port: 0, inviteCode: 'inv', defaultRoomId: 'lobby',
  });
  await server.listen();
  return server;
};

const secretFor = (cooId: string): string => `secret-${cooId}-0123456789`;

const cooHeaders = (cooId: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-parlor-coo': cooId,
  'x-parlor-coo-secret': secretFor(cooId),
  'x-parlor-invite': 'inv',
});

const post = async (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

const get = async (base: string, path: string, headers: Record<string, string> = {}) => {
  const response = await fetch(`${base}${path}`, { headers });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

const joinRoom = async (base: string, cooId: string, name: string) => {
  const response = await post(base, '/v1/join', { name }, cooHeaders(cooId));
  expect(response.status).toBe(200);
  return response.body as { token: string; room: string; seat: { id: string; name: string; handle?: string } };
};

describe('短号解析', () => {
  it('取 cooId 前 8 位，小写', () => {
    expect(shortHandle('270FED72-1bba-409e-873e-a7fc4b66380d')).toBe('270fed72');
  });

  it('#号 认前缀与完整 id，也认全角＃和大小写；不是号就返回 null', () => {
    expect(parseHandleQuery(' #270FED72 ')).toBe('270fed72');
    expect(parseHandleQuery('＃270fed72')).toBe('270fed72');
    expect(parseHandleQuery('#270fed72-1bba-409e-873e-a7fc4b66380d'))
      .toBe('270fed72-1bba-409e-873e-a7fc4b66380d');
    expect(parseHandleQuery('#abc')).toBeNull();
    expect(parseHandleQuery('270fed72')).toBeNull();
    expect(parseHandleQuery('#一个小满')).toBeNull();
  });

  it('LIKE 前缀把 _ 和 % 转义掉', () => {
    expect(likePrefix('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
  });
});

describe('按短号找人', () => {
  it('席位带着短号；离线的人也能按号搜到并私聊，来信带发件人号', async () => {
    const app = await start();
    const a = await joinRoom(app.url, A, '阿岚');
    expect(a.seat.handle).toBe(shortHandle(A));
    const c = await joinRoom(app.url, C, '小柚');
    const handleC = c.seat.handle!;
    expect(handleC).toBe(shortHandle(C));

    // 小柚离开：没有席位、也不在线，但身份还在。
    const left = await post(app.url, `/v1/rooms/${c.room}/leave`, {}, bearer(c.token));
    expect(left.status).toBe(200);

    // 按号搜：不看在线/聊过。
    const found = await get(app.url, `/v1/people?q=${encodeURIComponent('#' + handleC)}`, bearer(a.token));
    expect(found.status).toBe(200);
    const people = found.body.people as { cooId: string; name: string; online: boolean; handle: string }[];
    expect(people.map((person) => person.cooId)).toEqual([C]);
    expect(people[0].online).toBe(false);
    expect(people[0].handle).toBe(handleC);

    // 按号私聊离线的人。
    const sent = await post(app.url, '/v1/dm', { to: '#' + handleC, text: '回来打牌吗' }, bearer(a.token));
    expect(sent.status).toBe(200);

    // 小柚的信箱：来信带发件人的号。
    const mail = await get(app.url, '/v1/me/mail', cooHeaders(C));
    expect(mail.status).toBe(200);
    const items = mail.body.items as { text: string; fromHandle?: string }[];
    expect(items.some((item) => item.text.includes('回来打牌吗'))).toBe(true);
    expect(items.find((item) => item.text.includes('回来打牌吗'))?.fromHandle).toBe(shortHandle(A));

    // 完整 id 也认。
    const byFull = await post(app.url, '/v1/dm', { to: '#' + C, text: '完整 id' }, bearer(a.token));
    expect(byFull.status).toBe(200);
  });

  it('前缀撞车不猜：搜出两个人，私聊要完整 id', async () => {
    const app = await start();
    const a = await joinRoom(app.url, A, '阿岚');
    const now = Date.now();
    const db = app.dbHandle;
    db.prepare("INSERT INTO coos(id, kind, display_name, created_at) VALUES (?, 'pet', ?, ?)")
      .run('abcdefgh-0000-4000-8000-000000000001', '双一', now);
    db.prepare("INSERT INTO coos(id, kind, display_name, created_at) VALUES (?, 'pet', ?, ?)")
      .run('abcdefgh-0000-4000-8000-000000000002', '双二', now);

    const found = await get(app.url, '/v1/people?q=%23abcdefgh', bearer(a.token));
    expect(found.status).toBe(200);
    expect((found.body.people as unknown[]).length).toBe(2);

    const ambiguous = await post(app.url, '/v1/dm', { to: '#abcdefgh', text: '在吗' }, bearer(a.token));
    expect(ambiguous.status).toBe(409);
    expect(String(ambiguous.body.error)).toContain('abcdefgh-0000-4000-8000-000000000001');
    expect(String(ambiguous.body.error)).toContain('abcdefgh-0000-4000-8000-000000000002');

    const exact = await post(app.url, '/v1/dm', {
      to: '#abcdefgh-0000-4000-8000-000000000001', text: '只找你',
    }, bearer(a.token));
    expect(exact.status).toBe(200);
  });

  it('不能按自己的号给自己发私聊；不存在的号 404', async () => {
    const app = await start();
    const a = await joinRoom(app.url, A, '阿岚');
    const self = await post(app.url, '/v1/dm', { to: '#' + shortHandle(A), text: '喂' }, bearer(a.token));
    expect(self.status).toBe(400);
    const none = await post(app.url, '/v1/dm', { to: '#ffffffff', text: '喂' }, bearer(a.token));
    expect(none.status).toBe(404);
  });
});
