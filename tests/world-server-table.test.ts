import { afterEach, describe, expect, it } from 'vitest';
import { WorldServer } from '../src/room/world-server.ts';

const A = 'coo-aaaaaaaa';
const B = 'coo-bbbbbbbb';
const C = 'coo-cccccccc';

let server: WorldServer | undefined;

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
});

const start = async (): Promise<WorldServer> => {
  server = new WorldServer({ allowGuestJoin: true, dbFile: ':memory:', port: 0, inviteCode: 'inv' });
  await server.listen();
  return server;
};

const secretFor = (cooId: string): string => `secret-${cooId}-0123456789`;

const cooHeaders = (cooId: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-parlor-coo': cooId,
  'x-parlor-coo-secret': secretFor(cooId),
});

const post = async (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
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

const enter = async (app: WorldServer, cooId: string, name: string): Promise<string> => {
  const joined = await post(app.url, '/v1/join', { name }, { ...cooHeaders(cooId), 'x-parlor-invite': 'inv' });
  expect(joined.status).toBe(200);
  return joined.body.token as string;
};

const act = async (app: WorldServer, token: string, body: unknown) => (
  post(app.url, '/v1/action', body, { authorization: `Bearer ${token}` })
);

/** 牌桌动作要带桌面版本与幂等键：现取一次快照。 */
const tableRef = async (app: WorldServer, token: string): Promise<{ table: string; revision: number }> => {
  const snap = await get(app.url, '/v1/room?limit=1', token);
  const table = snap.body.table as { id?: string; revision?: number };
  const priv = snap.body.tablePrivate as { revision?: number } | null;
  expect(typeof table.id).toBe('string');
  const revision = priv?.revision ?? table.revision;
  expect(typeof revision).toBe('number');
  return { table: table.id as string, revision: revision as number };
};

describe('WorldServer 牌桌网关', () => {
  it('旧 /v1/action 就能开桌、坐下、开局、停牌与结算', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const b = await enter(app, B, '小满');

    expect((await act(app, a, { type: 'table_open', requestId: 'open-1', game: 'dice' })).status).toBe(200);
    expect((await act(app, b, { type: 'table_join', requestId: 'join-2' })).status).toBe(200);
    const started = await act(app, a, { type: 'table_start', requestId: 'start-3' });
    expect(started.status).toBe(200);
    expect(started.body.seats).toEqual(['阿岚', '小满']);
    expect(started.body.turn).toBe('阿岚');
    expect(typeof started.body.deadline).toBe('number');

    const first = await tableRef(app, a);
    expect((await act(app, a, {
      type: 'table_action', action: 'stand', table: first.table, revision: first.revision, requestId: 'stand-a',
    })).status).toBe(200);
    const second = await tableRef(app, b);
    expect((await act(app, b, {
      type: 'table_action', action: 'stand', table: second.table, revision: second.revision, requestId: 'stand-b',
    })).status).toBe(200);

    const snapshot = await get(app.url, '/v1/room', b);
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.table).toMatchObject({ game: 'dice', status: 'ended' });
    const ledger = snapshot.body.ledger as { games: number; byGame: unknown[]; recent: unknown[] };
    expect(ledger.games).toBe(1);
    expect(ledger.byGame.length).toBe(1);
    expect(ledger.recent.length).toBeGreaterThan(0);
  });

  it('桌内说话只有同桌看得到；第三人历史与快照都没有', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const b = await enter(app, B, '小满');
    const c = await enter(app, C, '小柚');

    await act(app, a, { type: 'table_open', requestId: 'open-4', game: 'ddz' });
    await act(app, b, { type: 'table_join', requestId: 'join-5' });
    await act(app, a, { type: 'table_start', requestId: 'start-6' });

    expect((await act(app, a, { type: 'table_say', text: '这把我要地主' })).status).toBe(200);
    const bHistory = await get(app.url, '/v1/history?since=0&limit=200', b);
    expect((bHistory.body.events as { text: string }[]).map((event) => event.text)).toContain('这把我要地主');
    const cHistory = await get(app.url, '/v1/history?since=0&limit=200', c);
    expect((cHistory.body.events as { text: string }[]).map((event) => event.text)).not.toContain('这把我要地主');
    expect((await act(app, c, { type: 'table_say', text: '我也想插一句' })).status).toBe(400);
  });

  it('牌局没结束不能离厅或换房（409）', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const b = await enter(app, B, '小满');
    await act(app, a, { type: 'table_open', requestId: 'open-7', game: 'dice' });
    await act(app, b, { type: 'table_join', requestId: 'join-8' });
    expect((await act(app, a, { type: 'table_start', requestId: 'start-9' })).status).toBe(200);

    const left = await post(app.url, '/v1/rooms/lobby/leave', {}, { authorization: `Bearer ${a}` });
    expect(left.status).toBe(409);
    expect(String(left.body.error)).toContain('牌局还没结束');
  });

  it('未开局可以退桌；开桌的人退桌等于收桌', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const b = await enter(app, B, '小满');
    await act(app, a, { type: 'table_open', requestId: 'open-10', game: 'dice' });
    await act(app, b, { type: 'table_join', requestId: 'join-11' });

    expect((await act(app, b, { type: 'table_leave', requestId: 'leave-12' })).status).toBe(200);
    expect((await post(app.url, '/v1/rooms/lobby/leave', {}, { authorization: `Bearer ${b}` })).status).toBe(200);

    expect((await act(app, a, { type: 'table_leave', requestId: 'leave-13' })).status).toBe(200);
    const snapshot = await get(app.url, '/v1/room', a);
    expect(snapshot.body.table).toBeFalsy();
  });
});

describe('WorldServer 大厅、邀请与网页', () => {
  it('大厅是特殊客厅：能进去、能说话、不进目录', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const hall = await fetch(`${app.url}/v1/hall`, { headers: cooHeaders(A) });
    expect(hall.status).toBe(200);
    const hallBody = await hall.json() as { hall: { id: string; capacity: number }; rooms: unknown[] };
    expect(hallBody.hall.id).toBe('hall');

    const switched = await post(app.url, '/v1/rooms/lobby/switch', { to: 'hall' }, {
      authorization: `Bearer ${a}`,
    });
    expect(switched.status).toBe(200);
    const hallToken = switched.body.token as string;
    expect((await post(app.url, '/v1/rooms/hall/action', { type: 'say', text: '有人吗' }, {
      authorization: `Bearer ${hallToken}`,
    })).status).toBe(200);

    const directory = await fetch(`${app.url}/v1/rooms`);
    const rooms = (await directory.json() as { rooms: { id: string }[] }).rooms;
    expect(rooms.some((room) => room.id === 'hall')).toBe(false);
  });

  it('定向邀请：目标收到一条 invite 事件与一封信；可以顺着邀请换房', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const b = await enter(app, B, '小满');
    const created = await post(app.url, '/v1/rooms', { name: '可可厅', visibility: 'public' }, cooHeaders(A));
    const roomId = (created.body.room as { id: string }).id;

    const invited = await post(app.url, '/v1/invite', { to: '小满', room: roomId, text: '来坐坐' }, cooHeaders(A));
    expect(invited.status).toBe(200);
    expect(invited.body.room).toBe(roomId);

    const bHistory = await get(app.url, '/v1/history?since=0&limit=100', b);
    expect((bHistory.body.events as { type: string; text: string }[])
      .some((event) => event.type === 'parlor.invite' && event.text.includes('可可厅'))).toBe(true);
    const bMail = await get(app.url, '/v1/mail?peek=1&all=1', b);
    expect((bMail.body.items as { kind: string; text: string }[])
      .some((item) => item.kind === 'invite' && item.text.includes('可可厅'))).toBe(true);

    const moved = await post(app.url, `/v1/rooms/lobby/switch`, { to: roomId }, {
      authorization: `Bearer ${b}`,
    });
    expect(moved.status).toBe(200);
    const snapshot = await get(app.url, `/v1/rooms/${roomId}/room`, moved.body.token as string);
    expect(snapshot.body.id).toBe(roomId);
  });

  it('网页玩家可以指定客厅入场，并用席位令牌看目录、换房', async () => {
    const app = await start();
    const created = await post(app.url, '/v1/rooms', { name: '网页厅', visibility: 'public' }, cooHeaders(A));
    const roomId = (created.body.room as { id: string }).id;

    const joined = await post(app.url, '/v1/player/join', { name: '爸爸', room: roomId }, {
      'x-parlor-invite': 'inv',
    });
    expect(joined.status).toBe(200);
    expect(joined.body.room).toBe(roomId);
    const token = joined.body.token as string;

    const directory = await get(app.url, '/v1/rooms?all=1', token);
    expect((directory.body.rooms as { id: string }[]).some((room) => room.id === roomId)).toBe(true);
    const hall = await get(app.url, '/v1/hall', token);
    expect((hall.body.me as { room: string }).room).toBe(roomId);

    const moved = await post(app.url, `/v1/rooms/${roomId}/switch`, { to: 'hall' }, {
      authorization: `Bearer ${token}`,
    });
    expect(moved.status).toBe(200);
    expect(moved.body.room).toBe('hall');
    // 旧令牌当场失效。
    expect((await get(app.url, '/v1/rooms/hall/room', token)).status).toBe(401);
  });

  it('网页 /play 与静态资源由这台服务器直接给', async () => {
    const app = await start();
    const page = await fetch(`${app.url}/play`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await page.text()).toContain('<script type="module" src="/play/assets/play.js">');
    const script = await fetch(`${app.url}/play/assets/play.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('text/javascript');
  });
});

describe('WorldServer 社交与回放', () => {
  it('礼物走账本与信箱；收礼的人看得到，第三人看不到', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const b = await enter(app, B, '小满');
    const c = await enter(app, C, '小柚');

    const gifted = await act(app, a, { type: 'gift', to: '小满', text: '一点心意', chips: 10 });
    expect(gifted.status).toBe(200);
    expect((gifted.body.delivered as { to: string }[])[0].to).toBe('小满');

    const bSnapshot = await get(app.url, '/v1/room', b);
    expect((bSnapshot.body.ledger as { chips: number }).chips).toBe(1010);
    const cSnapshot = await get(app.url, '/v1/room', c);
    expect((cSnapshot.body.ledger as { chips: number }).chips).toBe(1000);

    const bMail = await get(app.url, '/v1/mail?peek=1', b);
    expect((bMail.body.items as { text: string }[]).some((item) => item.text.includes('一点心意'))).toBe(true);
    const cMail = await get(app.url, '/v1/mail?peek=1', c);
    expect((cMail.body.items as { text: string }[]).some((item) => item.text.includes('一点心意'))).toBe(false);
  });

  it('承诺：答应、了结时筹码划给债权人', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const b = await enter(app, B, '小满');

    const promise = await act(app, a, { type: 'promise', to: '小满', text: '借你 20', chips: 20 });
    expect(promise.status).toBe(200);

    const bMail = await get(app.url, '/v1/mail?peek=1', b);
    const letter = (bMail.body.items as { id?: string; text: string; entryId?: string }[])
      .find((item) => item.text.includes('借你 20'));
    expect(letter).toBeTruthy();
    const promiseId = letter!.entryId as string;

    expect((await act(app, b, { type: 'respond', id: promiseId, action: 'accept' })).status).toBe(200);
    expect((await act(app, b, { type: 'respond', id: promiseId, action: 'done' })).status).toBe(200);

    const bSnapshot = await get(app.url, '/v1/room', b);
    expect((bSnapshot.body.ledger as { chips: number }).chips).toBe(1020);
    const aSnapshot = await get(app.url, '/v1/room', a);
    expect((aSnapshot.body.ledger as { chips: number }).chips).toBe(980);
  });

  it('回放：公开事件人人有，私聊只有当事人有', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const b = await enter(app, B, '小满');
    const c = await enter(app, C, '小柚');

    await act(app, a, { type: 'say', text: '大家都在吗' });
    await act(app, a, { type: 'whisper', to: '小满', text: '只给你看' });

    const bReplay = await get(app.url, '/v1/replay?limit=100', b);
    expect(bReplay.status).toBe(200);
    const bTexts = (bReplay.body.events as { text: string }[]).map((event) => event.text);
    expect(bTexts).toContain('大家都在吗');
    expect(bTexts).toContain('只给你看');

    const cReplay = await get(app.url, '/v1/replay?limit=100', c);
    expect(cReplay.status).toBe(200);
    const cTexts = (cReplay.body.events as { text: string }[]).map((event) => event.text);
    expect(cTexts).toContain('大家都在吗');
    expect(cTexts).not.toContain('只给你看');
  });
});

describe('家长门户', () => {
  it('ownerKey 换 HttpOnly 会话；只读视图跟着孩子当前席位走', async () => {
    const app = await start();
    const joined = await post(app.url, '/v1/join', { name: '阿岚' }, {
      ...cooHeaders(A),
      'x-parlor-invite': 'inv',
    });
    expect(joined.status).toBe(200);
    const ownerKey = joined.body.ownerKey as string;
    expect(ownerKey).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const token = joined.body.token as string;
    await post(app.url, '/v1/action', { type: 'say', text: '家长也能看到' }, {
      authorization: `Bearer ${token}`,
    });

    const opened = await fetch(`${app.url}/v1/parent/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ownerKey }),
    });
    expect(opened.status).toBe(200);
    const setCookie = opened.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('parlor_parent=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    const cookie = setCookie.split(';')[0];

    const me = await fetch(`${app.url}/v1/parent/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    const meBody = await me.json() as { account: { cooId: string }; seat: { name: string } };
    expect(meBody.account.cooId).toBe(A);
    expect(meBody.seat.name).toBe('阿岚');

    const view = await fetch(`${app.url}/v1/parent/view?limit=50`, { headers: { cookie } });
    expect(view.status).toBe(200);
    const body = await view.json() as {
      room: { id: string }; seat: { name: string }; events: { text: string }[];
    };
    expect(body.room.id).toBe('lobby');
    expect(body.seat.name).toBe('阿岚');
    expect(body.events.map((event) => event.text)).toContain('家长也能看到');

    // 会话不能当席位令牌用；反过来也不行。
    expect((await get(app.url, '/v1/room', cookie)).status).toBe(401);

    // 同一个 Coo 再加入不会再给 ownerKey。
    const again = await post(app.url, '/v1/join', { name: '阿岚' }, {
      ...cooHeaders(A),
      'x-parlor-invite': 'inv',
    });
    expect(again.status).toBe(200);
    expect(again.body.ownerKey).toBeUndefined();
  });

  it('错 key 401；轮换 key 后旧 key 与旧会话都失效', async () => {
    const app = await start();
    const joined = await post(app.url, '/v1/join', { name: '阿岚' }, {
      ...cooHeaders(A),
      'x-parlor-invite': 'inv',
    });
    const ownerKey = joined.body.ownerKey as string;

    const wrong = await fetch(`${app.url}/v1/parent/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'A'.repeat(32) }),
    });
    expect(wrong.status).toBe(401);

    const opened = await fetch(`${app.url}/v1/parent/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ownerKey }),
    });
    const cookie = (opened.headers.get('set-cookie') ?? '').split(';')[0];

    const rotated = await post(app.url, '/v1/me/owner-key/rotate', {}, cooHeaders(A));
    expect(rotated.status).toBe(200);
    const nextKey = rotated.body.ownerKey as string;
    expect(nextKey).not.toBe(ownerKey);

    expect((await fetch(`${app.url}/v1/parent/me`, { headers: { cookie } })).status).toBe(401);
    const oldKey = await fetch(`${app.url}/v1/parent/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ownerKey }),
    });
    expect(oldKey.status).toBe(401);
    const newKey = await fetch(`${app.url}/v1/parent/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: nextKey }),
    });
    expect(newKey.status).toBe(200);
  });

  it('/parent 页面由这台服务器给', async () => {
    const app = await start();
    const page = await fetch(`${app.url}/parent`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await page.text()).toContain('<script type="module" src="/parent/assets/parent.js">');
    const script = await fetch(`${app.url}/parent/assets/parent.js`);
    expect(script.status).toBe(200);
  });
});
