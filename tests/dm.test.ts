/**
 * 网页私聊：按 coo 找人、离线投信箱、会话列表/历史/已读、限速。
 * 这些测试只走 HTTP，不碰浏览器；浮窗本身由本机 ego 冒烟另行目击。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldServer } from '../src/room/world-server.ts';

type Json = Record<string, any>;

let dir: string | undefined;
let server: WorldServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'parlor-dm-'));
});

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const start = async (): Promise<WorldServer> => {
  server = new WorldServer({ dbFile: join(dir!, 'parlor.db'), port: 0, inviteCode: 'inv', defaultRoomId: 'lobby' });
  await server.listen();
  return server;
};

const secretFor = (cooId: string): string => `secret-${cooId}-0123456789`;

const headers = (cooId: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-parlor-coo': cooId,
  'x-parlor-coo-secret': secretFor(cooId),
  'x-parlor-invite': 'inv',
});

const post = async (base: string, path: string, body: unknown, extra: Record<string, string> = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extra },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Json };
};

const get = async (base: string, path: string, extra: Record<string, string> = {}) => {
  const response = await fetch(`${base}${path}`, { headers: extra });
  return { status: response.status, body: await response.json() as Json };
};

const joinRoom = async (app: WorldServer, cooId: string, name: string) => {
  const response = await post(app.url, '/v1/join', { name }, headers(cooId));
  expect(response.status).toBe(200);
  return response.body.token as string;
};

describe('网页私聊', () => {
  it('互发、离线投递、会话摘要与未读', async () => {
    const app = await start();
    const a = 'coo-dmtest00001';
    const b = 'coo-dmtest00002';
    const c = 'coo-dmtest00003';
    await joinRoom(app, a, '小满');
    const bToken = await joinRoom(app, b, '阿岚');
    const cToken = await joinRoom(app, c, '小柚');

    // C 先离开，模拟离线。
    const left = await post(app.url, '/v1/rooms/lobby/leave', {}, Object.fromEntries(
      Object.entries({ authorization: `Bearer ${cToken}`, 'x-parlor-coo': c, 'x-parlor-coo-secret': secretFor(c) }),
    ));
    expect(left.status).toBe(200);

    const first = await post(app.url, '/v1/dm', { to: b, text: '晚上好' }, headers(a));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect((first.body.message as Json).fromMe).toBe(true);

    // 离线的人也能收到信。
    const offline = await post(app.url, '/v1/dm', { to: c, text: '回头一起玩' }, headers(a));
    expect(offline.status).toBe(200);
    expect((offline.body.peer as Json).online).toBe(false);

    // B 的会话：一条未读，名字是席位名。
    const bThreads = await get(app.url, '/v1/dm/threads', headers(b));
    expect(bThreads.status).toBe(200);
    const bList = bThreads.body.threads as Json[];
    expect(bList).toHaveLength(1);
    expect(bList[0].peer).toBe(a);
    expect(bList[0].name).toBe('小满');
    expect(bList[0].unread).toBe(1);
    expect(bList[0].lastText).toBe('晚上好');
    expect(bThreads.body.unread).toBe(1);

    // A 那边能看到自己发出的那份。
    const aThreads = await get(app.url, '/v1/dm/threads', headers(a));
    const aList = aThreads.body.threads as Json[];
    expect(aList.map((item) => item.peer).sort()).toEqual([b, c].sort());
    expect(aList.every((item) => item.lastFromMe)).toBe(true);

    // B 回一条；历史按时间正序，两边都在。
    const reply = await post(app.url, '/v1/dm', { to: a, text: '你也是' }, headers(b));
    expect(reply.status).toBe(200);
    const history = await get(app.url, `/v1/dm?peer=${a}`, headers(b));
    expect(history.status).toBe(200);
    const messages = history.body.messages as Json[];
    expect(messages.map((item) => item.text)).toEqual(['晚上好', '你也是']);
    expect(messages[0].fromMe).toBe(false);
    expect(messages[1].fromMe).toBe(true);

    // 标记已读。
    const read = await post(app.url, '/v1/dm/read', { peer: a }, headers(b));
    expect(read.status).toBe(200);
    const after = await get(app.url, '/v1/dm/threads', headers(b));
    expect((after.body.threads as Json[])[0].unread).toBe(0);
    expect(after.body.unread).toBe(0);

    // 离线的人再进来，信还在。
    await joinRoom(app, c, '小柚');
    const cThreads = await get(app.url, '/v1/dm/threads', headers(c));
    expect((cThreads.body.threads as Json[])[0].lastText).toBe('回头一起玩');
    expect(cThreads.body.unread).toBe(1);
  });

  it('搜人只给在线的人和聊过的人；参数与限速', async () => {
    const app = await start();
    const a = 'coo-dmtest00011';
    const b = 'coo-dmtest00012';
    const c = 'coo-dmtest00013';
    await joinRoom(app, a, '小满');
    const bToken = await joinRoom(app, b, '阿岚');
    const cToken = await joinRoom(app, c, '路人丙');
    // C 离线，且没聊过 → 搜不到。
    await post(app.url, '/v1/rooms/lobby/leave', {}, {
      authorization: `Bearer ${cToken}`, 'x-parlor-coo': c, 'x-parlor-coo-secret': secretFor(c),
    });

    const found = await get(app.url, '/v1/people?q=阿', headers(a));
    expect(found.status).toBe(200);
    const names = (found.body.people as Json[]).map((person) => person.name);
    expect(names).toContain('阿岚');
    expect(names).not.toContain('路人丙');

    // 聊过之后，离线的人也能搜到（并按 cooId 发）。
    await post(app.url, '/v1/dm', { to: c, text: '在吗' }, headers(a));
    const again = await get(app.url, '/v1/people?q=路人', headers(a));
    expect((again.body.people as Json[]).map((person) => person.name)).toContain('路人丙');

    // 参数。
    expect((await post(app.url, '/v1/dm', { to: a, text: '给自己' }, headers(a))).status).toBe(400);
    expect((await post(app.url, '/v1/dm', { to: b, text: '   ' }, headers(a))).status).toBe(400);
    expect((await post(app.url, '/v1/dm', { to: b, text: '一'.repeat(2001) }, headers(a))).status).toBe(400);
    expect((await post(app.url, '/v1/dm', { to: 'coo-nobody00001', text: '有人吗' }, headers(a))).status).toBe(404);
    expect((await post(app.url, '/v1/dm', { to: b, text: '谁' })).status).toBe(401);

    // 限速：一分钟最多 20 条。前面已经发过 1 条，再发 21 条必然撞上。
    let limited = 0;
    for (let index = 0; index < 21; index += 1) {
      const sent = await post(app.url, '/v1/dm', { to: b, text: `刷屏 ${index}` }, headers(a));
      if (sent.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });
});
