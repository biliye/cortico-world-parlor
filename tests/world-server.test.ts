import { afterEach, describe, expect, it, vi } from 'vitest';
import { pgServerStorage } from './helpers/pg.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientIp, clientIpRateKey } from '../src/room/http.ts';
import { SlidingRateLimit } from '../src/room/rate-limit.ts';
import { WorldServer, type WorldServerOptions } from '../src/room/world-server.ts';

const A = 'coo-aaaaaaaa';
const B = 'coo-bbbbbbbb';
const C = 'coo-cccccccc';
const D = 'coo-dddddddd';
const E = 'coo-eeeeeeee';

let dir: string | undefined;
let server: WorldServer | undefined;

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const start = async (options: Pick<WorldServerOptions, 'now' | 'poolMax' | 'host' | 'publicUrl'> = {}): Promise<WorldServer> => {
  dir = mkdtempSync(join(tmpdir(), 'parlor-world-'));
  server = await WorldServer.create({ allowGuestJoin: true,
    ...(await pgServerStorage(join(dir, 'parlor.db'))),
    port: 0,
    inviteCode: 'inv',
    defaultRoomId: 'lobby',
    ...options,
  });
  await server.listen();
  return server;
};

const secretFor = (cooId: string): string => `secret-${cooId}-0123456789`;

const cooHeaders = (cooId: string, name = ''): Record<string, string> => ({
  'content-type': 'application/json',
  'x-parlor-coo': cooId,
  'x-parlor-coo-secret': secretFor(cooId),
  // 房间 join 对「新身份」要求邀请码；这里默认带上，跟 World 客户端一致。
  'x-parlor-invite': 'inv',
  ...(name ? { 'x-parlor-name': name } : {}),
});

const post = async (
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

const get = async (base: string, path: string, token: string) => {
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

describe('WorldServer 聊天网关', () => {
  it('搜人按认证身份累计分钟额度，其他身份仍可查询', async () => {
    let now = Date.now();
    const app = await start({ now: () => now });
    const first = await post(app.url, '/v1/join', { name: '阿岚' }, cooHeaders(A));
    expect(first.status).toBe(200);
    expect((await post(app.url, '/v1/join', { name: '小满' }, cooHeaders(B))).status).toBe(200);
    const search = async (cooId: string) => {
      const response = await fetch(`${app.url}/v1/people`, { headers: cooHeaders(cooId) });
      await response.json();
      return response.status;
    };

    for (let i = 0; i < 60; i++) expect(await search(A)).toBe(200);
    expect((await get(app.url, '/v1/people', first.body.token as string)).status).toBe(429);
    expect(await search(B)).toBe(200);
    now += 60_000;
    expect(await search(A)).toBe(200);
  });

  it('搜人并发名额用完时仍可读取大厅目录，完成后释放名额', async () => {
    const app = await start({ poolMax: 2 });
    expect((await post(app.url, '/v1/join', { name: '阿岚' }, cooHeaders(A))).status).toBe(200);
    let started!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    const db = app.dbHandle;
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      if (sql.includes('WITH recent AS')) {
        const all = statement.all.bind(statement);
        statement.all = async (...params) => {
          started();
          await paused;
          return all(...params);
        };
      }
      return statement;
    });
    const search = () => fetch(`${app.url}/v1/people`, { headers: cooHeaders(A) });
    const pending = search();
    try {
      await Promise.race([waiting, pending.then(result => { throw new Error(`搜人提前返回 ${result.status}`); })]);
      expect((await search()).status).toBe(429);
      expect((await fetch(`${app.url}/v1/rooms`)).status).toBe(200);
    } finally {
      spy.mockRestore();
      release();
      await pending;
    }
    expect((await pending).status).toBe(200);
    expect((await search()).status).toBe(200);
  });

  it('公聊的短窗口按身份跨厅累计，窗口过后可以继续发言', async () => {
    let now = Date.now();
    const app = await start({ now: () => now });
    const joined = await post(app.url, '/v1/join', { name: '阿岚' }, cooHeaders(A));
    expect(joined.status).toBe(200);
    const say = (room: string, token: unknown) => post(app.url, `/v1/rooms/${room}/action`, {
      type: 'say', text: '大家好',
    }, { authorization: `Bearer ${token}` });
    for (let i = 0; i < 8; i++) {
      now += 100;
      expect((await say('lobby', joined.body.token)).status).toBe(200);
    }

    const moved = await post(app.url, '/v1/rooms/lobby/switch', { to: 'hall' }, {
      authorization: `Bearer ${joined.body.token}`,
    });
    expect(moved.status).toBe(200);
    expect((await say('hall', moved.body.token)).status).toBe(429);
    now += 10_000;
    expect((await say('hall', moved.body.token)).status).toBe(200);
  });

  it('建房、进厅、说话、快照、历史；目录只列公开厅', async () => {
    const app = await start();
    const created = await post(app.url, '/v1/rooms', {
      name: '可可厅', visibility: 'public', capacity: 8,
    }, cooHeaders(A));
    expect(created.status).toBe(200);
    const roomId = (created.body.room as { id: string }).id;

    const joined = await post(app.url, `/v1/rooms/${roomId}/join`, { name: '阿岚' }, cooHeaders(A));
    expect(joined.status).toBe(200);
    expect(joined.body.ownerKey).toBeTruthy();
    const token = joined.body.token as string;

    const said = await post(app.url, `/v1/rooms/${roomId}/action`, { type: 'say', text: '大家好' }, {
      authorization: `Bearer ${token}`,
    });
    expect(said.status).toBe(200);

    const snapshot = await get(app.url, `/v1/rooms/${roomId}/room`, token);
    expect(snapshot.status).toBe(200);
    expect((snapshot.body.events as { text: string }[]).map((event) => event.text)).toContain('大家好');

    const history = await get(app.url, `/v1/rooms/${roomId}/history`, token);
    expect(history.status).toBe(200);
    expect((history.body.events as { text: string }[]).map((event) => event.text)).toContain('大家好');

    const directory = await fetch(`${app.url}/v1/rooms`);
    expect(directory.status).toBe(200);
    const rooms = (await directory.json() as { rooms: { id: string }[] }).rooms;
    expect(rooms.some((room) => room.id === roomId)).toBe(true);
  });

  it('私聊落信箱；目标看得到，第三人看不到', async () => {
    const app = await start();
    const created = await post(app.url, '/v1/rooms', { name: '私聊厅', visibility: 'public' }, cooHeaders(A));
    const roomId = (created.body.room as { id: string }).id;
    const a = await post(app.url, `/v1/rooms/${roomId}/join`, { name: '阿岚' }, cooHeaders(A));
    const b = await post(app.url, `/v1/rooms/${roomId}/join`, { name: '小满' }, cooHeaders(B));
    const c = await post(app.url, `/v1/rooms/${roomId}/join`, { name: '小柚' }, cooHeaders(C));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(200);
    const aToken = a.body.token as string;
    const bToken = b.body.token as string;
    const cToken = c.body.token as string;

    const whispered = await post(app.url, `/v1/rooms/${roomId}/action`, {
      type: 'whisper', to: '小满', text: '只给你',
    }, { authorization: `Bearer ${aToken}` });
    expect(whispered.status).toBe(200);

    const bHistory = await get(app.url, `/v1/rooms/${roomId}/history`, bToken);
    expect((bHistory.body.events as { text: string }[]).map((event) => event.text)).toContain('只给你');
    const cHistory = await get(app.url, `/v1/rooms/${roomId}/history`, cToken);
    expect((cHistory.body.events as { text: string }[]).map((event) => event.text)).not.toContain('只给你');

    const bMail = await get(app.url, `/v1/rooms/${roomId}/mail`, bToken);
    expect((bMail.body.items as { text: string }[]).map((item) => item.text)).toEqual(['只给你']);
  });

  it('离开后旧令牌 401；换房失败不留半路状态', async () => {
    const app = await start();
    const created = await post(app.url, '/v1/rooms', { name: '甲厅', visibility: 'public' }, cooHeaders(A));
    const roomId = (created.body.room as { id: string }).id;
    const other = await post(app.url, '/v1/rooms', { name: '乙厅', visibility: 'public' }, cooHeaders(A));
    const otherId = (other.body.room as { id: string }).id;
    const joined = await post(app.url, `/v1/rooms/${roomId}/join`, { name: '阿岚' }, cooHeaders(A));
    const token = joined.body.token as string;

    const left = await post(app.url, `/v1/rooms/${roomId}/leave`, {}, { authorization: `Bearer ${token}` });
    expect(left.status).toBe(200);
    expect((await get(app.url, `/v1/rooms/${roomId}/room`, token)).status).toBe(401);

    const again = await post(app.url, `/v1/rooms/${roomId}/join`, { name: '阿岚' }, cooHeaders(A));
    const newToken = again.body.token as string;
    const moved = await post(app.url, `/v1/rooms/${roomId}/switch`, { to: otherId }, {
      authorization: `Bearer ${newToken}`,
    });
    expect(moved.status).toBe(200);
    expect((await get(app.url, `/v1/rooms/${otherId}/room`, moved.body.token as string)).status).toBe(200);

    // 再切回一个满员目标：源席位必须还在
    const full = await post(app.url, '/v1/rooms', { name: '满厅', visibility: 'public', capacity: 2 }, cooHeaders(A));
    const fullId = (full.body.room as { id: string }).id;
    // 模拟库内满员目标，验证换房事务回滚。
    await app.dbHandle.prepare('UPDATE rooms SET capacity = 2 WHERE id = ?').run(fullId);
    await post(app.url, `/v1/rooms/${fullId}/join`, { name: '乙' }, cooHeaders(B));
    await post(app.url, `/v1/rooms/${fullId}/join`, { name: '丙' }, cooHeaders(C));
    const blocked = await post(app.url, `/v1/rooms/${otherId}/switch`, { to: fullId }, {
      authorization: `Bearer ${moved.body.token as string}`,
    });
    expect(blocked.status).toBe(409);
    expect((await get(app.url, `/v1/rooms/${otherId}/room`, moved.body.token as string)).status).toBe(200);
  });

  it('旧 /v1 别名落到默认客厅；旧 join 返回空 ownerToken', async () => {
    const app = await start();
    const joined = await post(app.url, '/v1/join', { name: '老客户端' }, {
      ...cooHeaders(D), 'x-parlor-invite': 'inv',
    });
    expect(joined.status).toBe(200);
    expect(joined.body.ownerToken).toBe('');
    const token = joined.body.token as string;

    const snapshot = await get(app.url, '/v1/room', token);
    expect(snapshot.status).toBe(200);
    expect((snapshot.body as { id: string }).id).toBe('lobby');

    const said = await post(app.url, '/v1/action', { type: 'say', text: '旧协议' }, {
      authorization: `Bearer ${token}`,
    });
    expect(said.status).toBe(200);
    const history = await get(app.url, '/v1/history', token);
    expect((history.body.events as { text: string }[]).map((event) => event.text)).toContain('旧协议');
  });

  it('网页人类 join：独立身份 + 席位令牌，能进默认客厅', async () => {
    const app = await start();
    const joined = await post(app.url, '/v1/player/join', { name: '路人' }, { 'x-parlor-invite': 'inv' });
    expect(joined.status).toBe(200);
    expect((joined.body.identity as { cooId: string }).cooId).toBeTruthy();
    const token = joined.body.token as string;
    const snapshot = await get(app.url, '/v1/room', token);
    expect(snapshot.status).toBe(200);
    expect((snapshot.body as { seat: { name: string } }).seat.name).toBe('路人');
  });

  it('SSE 先发 retry 和历史', async () => {
    const app = await start();
    const created = await post(app.url, '/v1/rooms', { name: '流厅', visibility: 'public' }, cooHeaders(A));
    const roomId = (created.body.room as { id: string }).id;
    const joined = await post(app.url, `/v1/rooms/${roomId}/join`, { name: '阿岚' }, cooHeaders(A));
    const token = joined.body.token as string;
    await post(app.url, `/v1/rooms/${roomId}/action`, { type: 'say', text: '流里的话' }, {
      authorization: `Bearer ${token}`,
    });

    const controller = new AbortController();
    const response = await fetch(`${app.url}/v1/rooms/${roomId}/stream?token=${token}&since=0`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    // 流是异步写的：retry 先到，历史在同一个请求里随后写；读到历史为止。
    const decoder = new TextDecoder();
    let text = '';
    for (let attempt = 0; attempt < 20 && !text.includes('流里的话'); attempt += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    expect(text).toContain('retry: 3000');
    expect(text).toContain('流里的话');
    controller.abort();
  });

  it('网页只接收牌桌更新通知，原协议和旁观者的可见范围照旧', async () => {
    const app = await start();
    const room = '/v1/rooms/lobby';
    const a = await post(app.url, `${room}/join`, { name: '甲' }, cooHeaders(A));
    const b = await post(app.url, `${room}/join`, { name: '乙' }, cooHeaders(B));
    const observer = await post(app.url, `${room}/join`, { name: '丙' }, cooHeaders(C));
    const headers = (token: unknown) => ({ authorization: `Bearer ${String(token)}` });
    const action = (token: unknown, body: unknown) => post(app.url, `${room}/action`, body, headers(token));
    const opened = await action(a.body.token, { type: 'table_open', game: 'gomoku', requestId: 'open' });
    const table = opened.body.tableId;
    expect((await action(b.body.token, { type: 'table_join', table, requestId: 'join' })).status).toBe(200);
    expect((await action(a.body.token, { type: 'table_start', table, requestId: 'start' })).status).toBe(200);
    expect((await action(a.body.token, { type: 'say', text: '历史读到这里' })).status).toBe(200);

    const controllers: AbortController[] = [];
    const read = async (token: unknown, source: 'web' | 'coo' | 'other') => {
      const controller = new AbortController();
      controllers.push(controller);
      const response = await fetch(`${app.url}${room}/stream?since=0`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]),
        headers: {
          ...headers(token),
          ...(source === 'web' ? { 'x-parlor-stream': 'compact-table-v1' } : {}),
          ...(source === 'coo' ? { 'x-parlor-client': 'test-coo' } : {}),
        },
      });
      expect(response.status).toBe(200);
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let frames = '';
      while (!frames.includes('历史读到这里')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE ended before marker');
        frames += chunk.value;
      }
      return frames.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    };

    try {
      const cooA = await read(a.body.token, 'coo');
      const actor = cooA.some(event => event.type === 'parlor.table.turn') ? a : b;
      const coo = actor === a ? cooA : await read(b.body.token, 'coo');
      const web = await read(actor.body.token, 'web');
      const type = 'parlor.table.turn';
      const turn = coo.find(event => event.type === type);
      expect(turn).toMatchObject({ scope: { kind: 'seat' }, data: { table: { revision: expect.any(Number) } } });
      expect(web.find(event => event.type === type)).toEqual({ seq: turn.seq, type });
      expect((await read(observer.body.token, 'web')).some(event => event.type === type)).toBe(false);
      expect((await read(observer.body.token, 'other')).some(event => event.type === type)).toBe(false);
      expect(web.filter(event => event.type !== type)).toEqual(coo.filter(event => event.type !== type));

      const log = vi.spyOn(console, 'log');
      const now = Date.now;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + 61_000);
      try {
        const prefix = 'parlor: SSE 流量 ';
        await vi.waitFor(() => {
          const entry = log.mock.calls.find(([message]) => typeof message === 'string' && message.startsWith(prefix));
          expect(entry).toBeDefined();
          const traffic = JSON.parse(entry![0].slice(prefix.length));
          expect(traffic.activeBySource).toEqual({ web: 2, coo: actor === a ? 1 : 2, other: 1 });
          expect(traffic.bytes).toBe(Object.values<number>(traffic.bytesBySource).reduce((sum, bytes) => sum + bytes, 0));
          expect(traffic.bytesBySource.other).toBeGreaterThan(0);
          expect(traffic.turnBytesBySource.web).toBeGreaterThan(0);
          expect(traffic.turnBytesBySource.coo).toBeGreaterThan(traffic.turnBytesBySource.web);
          expect(traffic.turnBytesBySource.other).toBe(0);
        }, { timeout: 1500 });
      } finally {
        clock.mockRestore();
        log.mockRestore();
      }
    } finally {
      for (const controller of controllers) controller.abort();
    }
  });
});

describe('网关频控', () => {
  it('从可信回环代理获取规范化的末尾地址，直连使用 TCP 对端', () => {
    const request = (remoteAddress: string, forwarded: string) => ({
      socket: { remoteAddress }, headers: { 'x-forwarded-for': forwarded },
    });
    const proxied = request('::ffff:127.0.0.1', '198.51.100.7, 2001:0DB8:0000::1');
    expect(clientIp(proxied, true)).toBe('2001:db8::1');
    expect(clientIp(proxied, false)).toBe('127.0.0.1');
    expect(clientIp(request('192.0.2.2', '198.51.100.7'), true)).toBe('192.0.2.2');
    expect(clientIp(request('127.0.0.1', 'unknown'), true)).toBe('127.0.0.1');
    expect(clientIpRateKey(proxied, true)).toBe('2001:db8:0:0::/64');
    expect(clientIpRateKey(request('2001:db8::cafe:2', ''), false)).toBe('2001:db8:0:0::/64');
    expect(clientIpRateKey(request('2001:db8:0:1::2', ''), false)).toBe('2001:db8:0:1::/64');
    expect(clientIpRateKey(request('::ffff:192.0.2.2', ''), false)).toBe('192.0.2.2');
  });

  it('配置公开源后按回环对端识别代理，不要求监听地址写成数字回环', async () => {
    const app = await start({ host: 'localhost', publicUrl: 'https://parlor.example' });
    const joined = await post(app.url, '/v1/join', { name: '阿岚' }, cooHeaders(A));
    expect(joined.status).toBe(200);
    const login = (address: string) => post(app.url, '/v1/parent/session', { key: joined.body.ownerKey }, {
      'x-forwarded-for': address,
    });
    for (let i = 0; i < 10; i++) expect((await login('192.0.2.1')).status).toBe(200);
    expect((await login('192.0.2.1')).status).toBe(429);
    expect((await login('192.0.2.2')).status).toBe(200);
  });

  it('表满时保留现有额度，窗口过期后回收键', () => {
    const rates = new SlidingRateLimit(1, { ms: 3_600_000, limit: 2 }, { burst: { ms: 10_000, limit: 1 } });
    expect(rates.take('existing', 0)).toBe(true);
    expect(rates.take('existing', 1)).toBe(false);
    expect(rates.take('existing', 10_000)).toBe(true);
    expect(rates.take('existing', 20_000)).toBe(false);
    expect(rates.take('next', 20_000)).toBe(false);
    expect(rates.take('next', 3_610_000)).toBe(true);
  });

  it('常规表满时共享桶接纳新键，常规表腾出空位时保留未过期的额度', () => {
    const rates = new SlidingRateLimit(1, { ms: 1_000, limit: 1 }, { overflowBuckets: 1 });
    expect(rates.take('existing', 0)).toBe(true);
    expect(rates.take('new', 100)).toBe(true);
    expect(rates.take('existing', 101)).toBe(false);
    expect(rates.take('another', 101)).toBe(false);
    expect(rates.take('new', 1_000)).toBe(false);
    expect(rates.take('new', 1_100)).toBe(true);
  });
});
