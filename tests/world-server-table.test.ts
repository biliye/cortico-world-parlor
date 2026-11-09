import { afterEach, describe, expect, it } from 'vitest';
import { pgServerStorage } from './helpers/pg.ts';
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
  server = await WorldServer.create({ allowGuestJoin: true, ...(await pgServerStorage(':memory:')), port: 0, inviteCode: 'inv' });
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

const act = async (app: WorldServer, token: string, body: unknown, headers: Record<string, string> = {}) => (
  post(app.url, '/v1/action', body, { authorization: `Bearer ${token}`, ...headers })
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
  it('五子棋两席开局，提供建议，拒绝旧版本并记录连五终局', async () => {
    const app = await start();
    const black = await enter(app, A, '黑方');
    const white = await enter(app, B, '白方');
    const opened = await act(app, black, { type: 'table_open', game: 'gomoku', requestId: 'gomoku-open' });
    expect(opened.status).toBe(200);
    const table = opened.body.tableId;
    expect((await act(app, white, { type: 'table_join', table, requestId: 'gomoku-join' })).status).toBe(200);
    expect((await act(app, black, { type: 'table_start', table, requestId: 'gomoku-start' })).status).toBe(200);
    const initial = await get(app.url, '/v1/room?limit=1', black);
    expect(initial.body.tablePrivate).toMatchObject({ canAct: true, hints: [{ row: 7, col: 7 }, expect.any(Object), expect.any(Object)] });
    for (let i = 0; i < 9; i++) {
      const player = i % 2 === 0 ? black : white;
      const reference = await tableRef(app, player);
      const body = { ...reference, type: 'gomoku_action', row: i % 2, col: Math.floor(i / 2), requestId: `gomoku-${i}` };
      if (i === 0) expect((await act(app, player, { ...body, revision: reference.revision - 1 })).status).toBe(409);
      expect((await act(app, player, body)).status).toBe(200);
    }
    const result = await get(app.url, '/v1/room?limit=1', black);
    expect(result.body.table).toMatchObject({ game: 'gomoku', status: 'ended', winningLine: expect.arrayContaining([{ row: 0, col: 4 }]) });
  });

  it('狼人杀按开桌选项决定全 Coo 能否开局', async () => {
    const app = await start();
    const tokens: string[] = [];
    for (let index = 0; index < 9; index++) {
      tokens.push(await enter(app, `coo-werewolf-${index}`, `Coo ${index + 1}`));
    }
    const [host, ...others] = tokens;
    const headers = { 'x-parlor-client': '0.38.0' };
    const open = { type: 'table_open', game: 'werewolf' };
    expect((await act(app, host, { ...open, requireHuman: 'false' }, headers)).status).toBe(400);

    for (const requireHuman of [true, undefined]) {
      const opened = await act(app, host, {
        ...open, ...(requireHuman ? { requireHuman } : {}), requestId: `open-wolf-${requireHuman}`,
      }, headers);
      expect(opened.status).toBe(200);
      expect(opened.body.table).toMatchObject({ requireHuman: requireHuman === true });
      const table = opened.body.tableId;
      for (const [index, token] of others.entries()) {
        const joined = await act(app, token, {
          type: 'table_join', table, requestId: `join-wolf-${requireHuman}-${index}`,
        }, headers);
        expect(joined.status).toBe(200);
      }
      const started = await act(app, host, {
        type: 'table_start', table, requestId: `start-wolf-${requireHuman}`,
      }, headers);
      if (requireHuman) {
        expect(started.status).toBe(400);
        expect(JSON.stringify(started.body)).toContain('至少一名真人');
        expect((await act(app, host, { type: 'table_leave', table, requestId: 'leave-wolf' }, headers)).status).toBe(200);
      } else {
        expect(started.status).toBe(200);
        expect(started.body.table).toMatchObject({ status: 'playing' });
      }
    }
  });

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

  it('房间信箱的 recent 只读不标已读，已读的仍留在最近列表', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const b = await enter(app, B, '小满');
    expect((await act(app, a, { type: 'whisper', to: '小满', text: '第一封' })).status).toBe(200);

    const first = await get(app.url, '/v1/rooms/lobby/mail?recent=1&limit=12&all=1', b);
    expect(first.body.marked).toBe(false);
    expect(first.body.unread).toBe(1);
    expect((first.body.items as unknown[]).length).toBe(1);
    // 再看一次 recent：仍未读，说明首屏请求没有把信标掉。
    const again = await get(app.url, '/v1/rooms/lobby/mail?recent=1&limit=12&all=1', b);
    expect(again.body.unread).toBe(1);

    // 正常读才标已读。
    const read = await get(app.url, '/v1/rooms/lobby/mail?limit=12&all=1', b);
    expect(read.body.marked).toBe(true);
    // 标完已读，recent 仍然能看到这封（含已读）。
    const after = await get(app.url, '/v1/rooms/lobby/mail?recent=1&limit=12&all=1', b);
    expect(after.body.unread).toBe(0);
    expect((after.body.items as unknown[]).length).toBe(1);
  });

  it('网页 /play 与静态资源由这台服务器直接给', async () => {
    const app = await start();
    const page = await fetch(`${app.url}/play`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    const html = await page.text();
    const scriptPath = html.match(/<script type="module" src="(\/play\/assets\/vue-loader\.js(?:\?[^"]+)?)">/)?.[1];
    expect(scriptPath).toBeTruthy();
    const script = await fetch(`${app.url}${scriptPath}`);
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('text/javascript');
    // 旧页已下线：loader 只载 Vue；旧脚本不再发布，?legacy=1 的旧链接 302 回默认页。
    const loader = await script.text();
    expect(loader).toContain('./vue/main.js');
    expect(loader).not.toContain('./play.js');
    expect((await fetch(`${app.url}/play/assets/play.js`)).status).toBe(404);
    expect((await fetch(`${app.url}/play/assets/vue/main.js`)).status).toBe(200);
    const retired = await fetch(`${app.url}/play?legacy=1&room=hall`, { redirect: 'manual' });
    expect(retired.status).toBe(302);
    expect(retired.headers.get('location')).toBe('/play?room=hall');
  });
});

describe('WorldServer 社交与回放', () => {
  it('礼物走账本与信箱；收礼的人看得到，第三人看不到', async () => {
    const app = await start();
    const a = await enter(app, A, '阿岚');
    const b = await enter(app, B, '小满');
    const c = await enter(app, C, '小柚');

    // 0.38.0 起礼物是物件：item 从茶单里选，不再有筹码。
    const gifted = await act(app, a, { type: 'gift', to: '小满', item: 'longjing', text: '一点心意' });
    expect(gifted.status).toBe(200);
    expect((gifted.body.delivered as { to: string }[])[0].to).toBe('小满');
    expect(String(gifted.body.notice)).toContain('龙井');

    // 收礼的人手上多一份；第三人手上没有。
    const bStock = await get(app.url, '/v1/rooms/lobby/gifts?mine=1', b);
    expect(bStock.status, JSON.stringify(bStock.body)).toBe(200);
    expect(bStock.body.items as { id: string; count: number }[]).toContainEqual(expect.objectContaining({ id: 'longjing', count: 1 }));
    const cStock = await get(app.url, '/v1/rooms/lobby/gifts?mine=1', c);
    expect(cStock.body.items as unknown[]).toHaveLength(0);

    // 喝掉：存货清零，回执带一句纯文字运气提示，运气不写进任何数值。
    const eaten = await act(app, b, { type: 'gift_eat', item: 'longjing' });
    expect(eaten.status).toBe(200);
    expect(String(eaten.body.notice)).toContain('运气');
    expect((await get(app.url, '/v1/rooms/lobby/gifts?mine=1', b)).body.items as unknown[]).toHaveLength(0);
    expect((await act(app, b, { type: 'gift_eat', item: 'longjing' })).status).toBe(400);

    const bMail = await get(app.url, '/v1/mail?peek=1', b);
    expect((bMail.body.items as { text: string }[]).some((item) => item.text.includes('一点心意'))).toBe(true);
    const cMail = await get(app.url, '/v1/mail?peek=1', c);
    expect((cMail.body.items as { text: string }[]).some((item) => item.text.includes('一点心意'))).toBe(false);
  });

  it('承诺与回应返回停用，账本里也不再有任何余额', async () => {
    const app=await start(); const a=await enter(app,A,'阿岚'); const b=await enter(app,B,'小满');
    expect((await act(app,a,{type:'promise',to:'小满',text:'借你20',chips:20})).status).toBe(410);
    expect((await act(app,b,{type:'respond',id:'old-promise',action:'done'})).status).toBe(410);
    for (const token of [a,b]) expect('chips' in ((await get(app.url,'/v1/room',token)).body.ledger as Record<string,unknown>)).toBe(false);
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
    expect(page.headers.get('content-security-policy')).toContain("font-src 'self'");
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await page.text()).toMatch(/<script type="module" src="\/parent\/assets\/parent\.js(?:\?[^"\s]+)?">/);
    const script = await fetch(`${app.url}/parent/assets/parent.js`);
    expect(script.status).toBe(200);
    // 像素字体要真的在包里、按字体类型发；否则家长页会静默退回系统字体。
    const font = await fetch(`${app.url}/parent/assets/fonts/fusion-pixel-sc.woff2`);
    expect(font.status).toBe(200);
    expect(font.headers.get('content-type')).toBe('font/woff2');
  });
});
