import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { ParlorClient } from '../src/room/client.ts';
import { CooAccountDb } from '../src/room/coo-account-db.ts';
import { migrate } from '../src/room/db.ts';
import { divinationDay } from '../src/room/divination-lots.ts';
import { DIVINATION_ROOM, type DivinationDraw, type DivinationView } from '../src/room/divination-protocol.ts';
import { WorldServer } from '../src/room/world-server.ts';
import { pgServerStorage } from './helpers/pg.ts';
import { closeTestDb, openTestDb } from './helpers/test-db.ts';

const { drawIndex } = vi.hoisted(() => ({ drawIndex: vi.fn() }));
vi.mock('node:crypto', async (original) => ({
  ...await original<typeof import('node:crypto')>(), randomInt: drawIndex,
}));

it('以北京时间零点轮换三支头签', () => {
  const before = Date.parse('2026-11-20T15:59:59.999Z');
  const first = divinationDay(before);
  const next = divinationDay(before + 1);
  const third = divinationDay(before + 86_400_001);
  expect([first.key, next.key, third.key]).toEqual(['2026-11-20', '2026-11-21', '2026-11-22']);
  expect([first.head, next.head, third.head].sort((a, b) => a - b)).toEqual([3, 11, 22]);
  expect(divinationDay(before + 1 + 2 * 86_400_000).head).toBe(first.head);
});

it('从 PG schema 20 升级时增设签表并保留既有家长绑定', async () => {
  const db = await openTestDb();
  try {
    await db.exec("DROP TABLE divination_draws; UPDATE meta SET value = '20' WHERE key = 'schema_version';");
    const accounts = new CooAccountDb(db);
    const child = 'coo-legacy-divination';
    await accounts.registerCoo(child, 'divination-legacy-secret', 'pet', '老茶客');
    const { account } = await accounts.ensureAccount(child);
    await migrate(db);
    await migrate(db);
    expect(await accounts.byId(account.id)).toMatchObject({ cooId: child });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM divination_draws').get()).toEqual({ n: 0 });
  } finally { await closeTestDb(db); }
});

it('现有客厅占用问卦阁编号时保留原房间权限与开桌能力', async () => {
  drawIndex.mockReturnValue(0);
  const server = await WorldServer.create({ ...(await pgServerStorage(':memory:')), inviteCode: 'legacy-room', defaultRoomId: DIVINATION_ROOM });
  try {
    await server.listen();
    const response = await fetch(server.url + '/healthz');
    const health = await response.json() as { capabilities: string[] };
    expect(health.capabilities).not.toContain('divination-v1');
    expect((await fetch(server.url + '/v1/divination/room')).status).toBe(404);
    const client = new ParlorClient(server.url, { cooId: 'coo-legacy-room', cooSecret: 'divination-existing-room-secret' });
    const { token } = await client.join('legacy-room', { name: '原来的茶客', kind: 'pet' }, DIVINATION_ROOM);
    expect(await client.action(token, { type: 'table_open', game: 'ddz', requestId: randomUUID() }, DIVINATION_ROOM))
      .toMatchObject({ tableId: expect.any(String) });
  } finally { await server.close(); }
});

it('抽签发私信、头签只播一次，解签跨午夜仍对应原签，红榜和闲话只公开必要信息', async () => {
  let now = Date.parse('2026-11-20T15:59:45Z');
  const server = await WorldServer.create({ ...(await pgServerStorage(':memory:')), inviteCode: 'lot-invite', now: () => now });
  try {
    await server.listen();
    const request = (path: string, cookie = '', body?: unknown) => fetch(server.url + path, {
      headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    const enter = async (name: string, id: string, room: string) => {
      const client = new ParlorClient(server.url, { cooId: `coo-${id}`, cooSecret: `divination-${id}-secret-key` });
      const joined = await client.join('lot-invite', { name, kind: 'pet' }, room);
      const response = await request('/v1/parent/session', '', { key: joined.ownerKey });
      expect(response.status).toBe(200);
      return { client, token: joined.token, cookie: response.headers.get('set-cookie')!.split(';')[0] };
    };
    const child = await enter('阿岚', 'divination-first', 'lobby');
    const other = await enter('南枝', 'divination-other', 'hall');
    const visitor = await enter('小满', 'divination-chat', DIVINATION_ROOM);
    const state = (cookie?: string) => request('/v1/divination/room', cookie).then(r => r.json() as Promise<DivinationView>);
    const unread = (cookie?: string) => request('/v1/divination/unread', cookie).then(r => r.json() as Promise<{ draw: DivinationDraw | null }>);
    const draw = async (cookie: string, requestId: string = randomUUID()): Promise<DivinationDraw> => {
      const response = await request('/v1/divination/draw', cookie, { requestId });
      expect(response.status).toBe(200);
      return ((await response.json()) as { draw: DivinationDraw }).draw;
    };
    expect((await request('/v1/divination/draw', '', { requestId: randomUUID() })).status).toBe(401);
    expect((await request('/v1/divination/chat', '', { text: '路过' })).status).toBe(403);
    const directory = await request('/v1/rooms').then(r => r.json() as Promise<{ rooms: unknown[] }>);
    expect(directory.rooms).toContainEqual(expect.objectContaining({ id: DIVINATION_ROOM, name: '问卦阁' }));
    await expect(visitor.client.action(visitor.token, { type: 'table_open', game: 'ddz', requestId: randomUUID() }, DIVINATION_ROOM))
      .rejects.toMatchObject({ status: 409 });

    drawIndex.mockReturnValueOnce(divinationDay(now).head - 1).mockReturnValueOnce(5).mockReturnValue(0);
    const originalRequest = randomUUID();
    const [first, duplicate] = await Promise.all([draw(child.cookie, originalRequest), draw(child.cookie)]);
    expect(duplicate).toEqual(first);
    // Ensure the request used for the midnight replay is the one that won the race.
    const stored = await server.dbHandle.prepare('SELECT request_id FROM divination_draws WHERE id = ?')
      .get<{ request_id: string }>(first.id);
    expect(first.head).toBe(true);
    now += 1_000;
    const ordinaryGood = await draw(other.cookie);
    expect(ordinaryGood).toMatchObject({ head: false, lot: { number: 6, grade: '上吉' } });
    await draw(visitor.cookie);
    expect(await state()).toMatchObject({ canDraw: false, draw: null, board: [
      { number: 6, head: false }, { number: first.lot.number, head: true },
    ] });
    expect((await state()).board.every(entry => !('poem' in entry) && !('interpretation' in entry))).toBe(true);
    const hall = await other.client.history(other.token, 0, 30, 'hall');
    expect(hall.events.filter(event => event.data?.divination === true)).toMatchObject([
      { text: expect.stringMatching(/^恭喜 .+ 在问卦阁抽中了头签！$/), scope: { kind: 'room' } },
    ]);

    const mailbox = await child.client.mail(child.token, 10, true, 'lobby', true);
    const letters = mailbox.items.filter(item => item.action === 'divination_request');
    expect(letters).toHaveLength(1);
    expect(letters[0].text).toContain(first.lot.poem);
    const reply = JSON.parse(letters[0].text.match(/parlor_message (\{[^\n]+?\})回信/)![1]);
    const notices = await child.client.history(child.token, 0, 30, 'lobby');
    expect(notices.events.filter(event => event.type === 'parlor.whisper')).toMatchObject([
      { data: { mail: { seq: letters[0].seq } }, scope: { kind: 'seat' } },
    ]);
    const send = (who: typeof child, text: string, room: string) => who.client.action(who.token, {
      type: 'whisper', to: reply.to, text: reply.text.replace('你的解读', text),
    }, room);
    await expect(send(other, '冒名解签', 'hall')).rejects.toMatchObject({ status: 409 });
    expect(await unread(child.cookie)).toEqual({ draw: null });

    expect((await request('/v1/divination/chat', child.cookie, { text: '大家晚上好' })).status).toBe(200);
    await visitor.client.action(visitor.token, { type: 'say', text: '来坐坐！' }, DIVINATION_ROOM);
    expect((await state(other.cookie)).chat).toMatchObject([
      { text: '大家晚上好' }, { name: '小满', text: '来坐坐！' },
    ]);
    const updatedHall = await other.client.history(other.token, 0, 30, 'hall');
    expect(updatedHall.events.some(event => event.text === '大家晚上好')).toBe(false);

    now = Date.parse('2026-11-20T16:00:00Z');
    expect(await state(child.cookie)).toMatchObject({ board: [], draw: null });
    expect(await draw(child.cookie, stored!.request_id)).toEqual(first);
    const second = await draw(child.cookie);
    expect(second).toMatchObject({ day: '2026-11-21', head: false, interpretation: null });
    expect(second.id).not.toBe(first.id);
    await send(child, '今晚可以和我一起喝茶。', 'lobby');
    expect(await unread(child.cookie)).toMatchObject({ draw: { id: first.id, interpretation: '今晚可以和我一起喝茶。' } });
    expect(await unread(other.cookie)).toEqual({ draw: null });
    expect((await state(child.cookie)).draw).toEqual(second);
    await request('/v1/divination/seen', other.cookie, { id: first.id });
    expect((await unread(child.cookie)).draw?.id).toBe(first.id);
    await request('/v1/divination/seen', child.cookie, { id: first.id });
    expect(await unread(child.cookie)).toEqual({ draw: null });

    const accounts = new CooAccountDb(server.dbHandle, { now: () => now });
    const identity = { cooId: 'coo-divination-away', cooSecret: 'divination-away-secret' };
    await accounts.registerCoo(identity.cooId, identity.cooSecret, 'pet', '常小满');
    const offline = await accounts.ensureAccount(identity.cooId);
    const login = await request('/v1/parent/session', '', { key: offline.ownerKey });
    const offlineDraw = await draw(login.headers.get('set-cookie')!.split(';')[0]);
    const offlineMail = await new ParlorClient(server.url, identity).mailAsIdentity(10, true);
    expect(offlineMail.items).toContainEqual(expect.objectContaining({ action: 'divination_request', text: expect.stringContaining(offlineDraw.id) }));
  } finally { await server.close(); }
});
