/**
 * 私密厅：邀请制长期成员、统一准入、移除即断访问、改成私密要显式保留名单；
 * 家长页在桌上有别的真人时藏起孩子的暗牌与私牌事件。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WorldServer } from '../src/room/world-server.ts';

const O = 'coo-pv000001';
const U = 'coo-pv000002';
const V = 'coo-pv000003';
const CHILD = 'coo-pv000004';

let server: WorldServer | undefined;

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
});

const start = async (clock = { now: 1_770_000_000_000 }): Promise<{ app: WorldServer; clock: { now: number } }> => {
  server = new WorldServer({
    allowGuestJoin: false,
    dbFile: ':memory:',
    port: 0,
    inviteCode: 'inv',
    now: () => clock.now,
  });
  await server.listen();
  return { app: server, clock };
};

const cooHeaders = (cooId: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-parlor-coo': cooId,
  'x-parlor-coo-secret': `secret-${cooId}-0123456789`,
});

const post = async (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

const get = async (base: string, path: string, headers: Record<string, string>) => {
  const response = await fetch(`${base}${path}`, { headers });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

const enter = async (app: WorldServer, cooId: string, name: string): Promise<string> => {
  const joined = await post(app.url, '/v1/join', { name }, { ...cooHeaders(cooId), 'x-parlor-invite': 'inv' });
  expect(joined.status).toBe(200);
  return joined.body.token as string;
};

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

const switchTo = async (app: WorldServer, token: string, from: string, to: string) => {
  const response = await fetch(`${app.url}/v1/rooms/${from}/switch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer(token) },
    body: JSON.stringify({ to }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

const makePrivate = async (app: WorldServer, owner: string, name: string): Promise<string> => {
  const created = await post(app.url, '/v1/rooms', { name, visibility: 'private' }, cooHeaders(owner));
  expect(created.status).toBe(200);
  return (created.body.room as { id: string }).id;
};

describe('私密厅准入与邀请', () => {
  it('没被邀请进不去；邀请要接受；接受后能自己进出；移除即断', async () => {
    const { app } = await start();
    const o = await enter(app, O, '房主');
    const u = await enter(app, U, '小U');
    const v = await enter(app, V, '小V');
    const priv = await makePrivate(app, O, '私密厅');

    expect((await switchTo(app, u, 'lobby', priv)).status).toBe(403);
    expect((await switchTo(app, v, 'lobby', priv)).status).toBe(403);

    const invited = await post(app.url, '/v1/invite', { to: '小U', room: priv }, cooHeaders(O));
    expect(invited.status).toBe(200);
    expect(invited.body.pending).toBe(true);
    const invitationId = invited.body.invitationId as string;
    expect(invitationId).toBeTruthy();

    // 信里带着邀请号。
    const mail = await get(app.url, '/v1/mail?all=1', bearer(u));
    const letter = (mail.body.items as { action?: string; invitationId?: string; room: string }[])
      .find((item) => item.action === 'room_invite');
    expect(letter?.invitationId).toBe(invitationId);
    expect(letter?.room).toBe(priv);

    // 别人拿到邀请号也接受不了。
    expect((await post(app.url, `/v1/invitations/${invitationId}/accept`, {}, bearer(v))).status).toBe(403);
    expect((await post(app.url, `/v1/invitations/${invitationId}/accept`, {}, bearer(u))).status).toBe(200);

    const moved = await switchTo(app, u, 'lobby', priv);
    expect(moved.status).toBe(200);
    const tokenIn = moved.body.token as string;

    // 长期成员：离开之后还能自己回来。
    const toHall = await switchTo(app, tokenIn, priv, 'hall');
    expect(toHall.status).toBe(200);
    const back = await switchTo(app, toHall.body.token as string, 'hall', priv);
    expect(back.status).toBe(200);

    // 房主移除：席位当场释放，再进被拒。
    // 只有房主能看/改成员名单。
    expect((await get(app.url, `/v1/rooms/${priv}/access`, bearer(back.body.token as string))).status).toBe(403);
    const removed = await post(app.url, `/v1/rooms/${priv}/access`, { action: 'revoke', cooId: U }, cooHeaders(O));
    expect(removed.status).toBe(200);
    expect(removed.body.removedSeat).toBe(true);
    expect((await get(app.url, `/v1/rooms/${priv}/room`, bearer(back.body.token as string))).status).toBe(401);

    const uAgain = await enter(app, U, '小U');
    expect((await switchTo(app, uAgain, 'lobby', priv)).status).toBe(403);

    // 房主重新邀请才恢复。
    const againInvite = await post(app.url, '/v1/invite', { to: '小U', room: priv }, cooHeaders(O));
    expect(againInvite.status).toBe(200);
    await post(app.url, `/v1/invitations/${againInvite.body.invitationId as string}/accept`, {}, bearer(uAgain));
    expect((await switchTo(app, uAgain, 'lobby', priv)).status).toBe(200);
    // 房主本人当然能进。
    expect((await switchTo(app, o, 'lobby', priv)).status).toBe(200);
  });

  it('邀请 7 天过期', async () => {
    const { app, clock } = await start();
    await enter(app, O, '房主');
    const u = await enter(app, U, '小U');
    const priv = await makePrivate(app, O, '私密厅');
    const invited = await post(app.url, '/v1/invite', { to: '小U', room: priv }, cooHeaders(O));
    const id = invited.body.invitationId as string;

    clock.now += 8 * 24 * 3_600_000;
    expect((await post(app.url, `/v1/invitations/${id}/accept`, {}, bearer(u))).status).toBe(409);
    expect((await switchTo(app, u, 'lobby', priv)).status).toBe(403);
  });

  it('改成私密不会静默授权来过的人；房主显式保留才作数', async () => {
    const { app } = await start();
    await enter(app, O, '房主');
    const u = await enter(app, U, '小U');
    const created = await post(app.url, '/v1/rooms', { name: '公开厅', visibility: 'public' }, cooHeaders(O));
    const room = (created.body.room as { id: string }).id;

    const entered = await switchTo(app, u, 'lobby', room);
    expect(entered.status).toBe(200);
    await post(app.url, `/v1/rooms/${room}/leave`, {}, bearer(entered.body.token as string));
    // 小V 还在里面；改成私密时不在保留名单里，当场请出去。
    const v = await enter(app, V, '小V');
    const vInside = await switchTo(app, v, 'lobby', room);
    expect(vInside.status).toBe(200);

    // 不保留：在场的小V 被请出去，小U 也进不去。
    const flipped = await post(app.url, `/v1/rooms/${room}/visibility`, { visibility: 'private' }, cooHeaders(O));
    expect(flipped.status).toBe(200);
    expect((flipped.body.removed as string[]) ?? []).toContain(V);
    expect((await get(app.url, `/v1/rooms/${room}/room`, bearer(vInside.body.token as string))).status).toBe(401);
    const u2 = await enter(app, U, '小U');
    expect((await switchTo(app, u2, 'lobby', room)).status).toBe(403);

    // 显式授权：能进。
    expect((await post(app.url, `/v1/rooms/${room}/access`, { action: 'grant', cooId: U }, cooHeaders(O))).status)
      .toBe(200);
    expect((await switchTo(app, u2, 'lobby', room)).status).toBe(200);
  });
  it('开局前移除开桌的人：桌子跟着收起来', async () => {
    const { app } = await start();
    const o = await enter(app, O, '房主');
    const u = await enter(app, U, '小U');
    const priv = await makePrivate(app, O, '私密厅');
    const invited = await post(app.url, '/v1/invite', { to: '小U', room: priv }, cooHeaders(O));
    await post(app.url, `/v1/invitations/${invited.body.invitationId as string}/accept`, {}, bearer(u));
    const moved = await switchTo(app, u, 'lobby', priv);
    expect(moved.status).toBe(200);
    const token = moved.body.token as string;

    const opened = await post(app.url, `/v1/rooms/${priv}/action`, {
      type: 'table_open', game: 'dice', requestId: 'open',
    }, bearer(token));
    expect(opened.status).toBe(200);

    const removed = await post(app.url, `/v1/rooms/${priv}/access`, { action: 'revoke', cooId: U }, cooHeaders(O));
    expect(removed.status).toBe(200);
    expect((await get(app.url, `/v1/rooms/${priv}/room?limit=1`, bearer(token))).status).toBe(401);

    // 桌子被收起来：房主自己进来看，快照里没有未结束的桌。
    const oIn = await switchTo(app, o, 'lobby', priv);
    expect(oIn.status).toBe(200);
    const snap = await get(app.url, `/v1/rooms/${priv}/room?limit=1`, bearer(oIn.body.token as string));
    const live = (snap.body.tables as { status: string }[]).filter((table) => table.status !== 'ended');
    expect(live.length).toBe(0);
  });
});

describe('家长页防偷看', () => {
  it('桌上有别的真人：藏起孩子的暗牌与私牌事件；只有脚本时照常显示', async () => {
    const { app } = await start();
    const child = await post(app.url, '/v1/rooms/lobby/join', { name: '小满' }, {
      ...cooHeaders(CHILD), 'x-parlor-invite': 'inv',
    });
    expect(child.status).toBe(200);
    const ownerKey = child.body.ownerKey as string;
    const session = await fetch(`${app.url}/v1/parent/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ownerKey }),
    });
    expect(session.status).toBe(200);
    const cookie = (session.headers.get('set-cookie') || '').split(';')[0];
    const played = await post(app.url, '/v1/parent/play', {}, { cookie });
    const parentToken = played.body.token as string;

    // 孩子开骰子桌，家长玩家坐下，开局：桌上有另一个真人。
    const childToken = child.body.token as string;
    const opened = await post(app.url, '/v1/action', { type: 'table_open', game: 'dice', requestId: 'open' }, bearer(childToken));
    const tableId = opened.body.tableId as string;
    await post(app.url, '/v1/action', { type: 'table_join', table: tableId, requestId: 'join' }, bearer(parentToken));
    const started = await post(app.url, '/v1/action', { type: 'table_start', table: tableId, requestId: 'start' }, bearer(childToken));
    expect(started.status).toBe(200);

    const hidden = await get(app.url, '/v1/parent/view?limit=50', { cookie });
    expect(hidden.status).toBe(200);
    expect(hidden.body.ownerPrivateHidden).toBe(true);
    expect(hidden.body.tablePrivate).toBeNull();
    expect((hidden.body.events as { type: string }[]).some((event) => event.type === 'parlor.table.turn')).toBe(false);
  });

  it('房主自己的家长玩家能进这间私密厅（不算第三方）', async () => {
    const { app } = await start();
    const child = await post(app.url, '/v1/rooms/lobby/join', { name: '小满' }, {
      ...cooHeaders(CHILD), 'x-parlor-invite': 'inv',
    });
    const ownerKey = child.body.ownerKey as string;
    const session = await fetch(`${app.url}/v1/parent/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ownerKey }),
    });
    const cookie = (session.headers.get('set-cookie') || '').split(';')[0];
    const played = await post(app.url, '/v1/parent/play', {}, { cookie });
    const token = played.body.token as string;

    const created = await post(app.url, '/v1/rooms', { name: '孩子的私密厅', visibility: 'private' }, cooHeaders(CHILD));
    const room = (created.body.room as { id: string }).id;
    expect((await switchTo(app, token, 'lobby', room)).status).toBe(200);
  });

  it('孩子跟脚本打（没有别的真人）时家长照常看到私视图', async () => {
    const { app } = await start();
    const child = await post(app.url, '/v1/rooms/lobby/join', { name: '小满' }, {
      ...cooHeaders(CHILD), 'x-parlor-invite': 'inv',
    });
    const ownerKey = child.body.ownerKey as string;
    const session = await fetch(`${app.url}/v1/parent/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ownerKey }),
    });
    const cookie = (session.headers.get('set-cookie') || '').split(';')[0];
    const childToken = child.body.token as string;

    const opened = await post(app.url, '/v1/action', { type: 'table_open', game: 'ddz', requestId: 'open' }, bearer(childToken));
    const tableId = opened.body.tableId as string;
    await post(app.url, '/v1/action', { type: 'table_start', table: tableId, requestId: 'start' }, bearer(childToken));

    const shown = await get(app.url, '/v1/parent/view?limit=50', { cookie });
    expect(shown.body.ownerPrivateHidden).toBe(false);
    expect((shown.body.tablePrivate as { text?: string } | null)?.text).toContain('斗地主');
  });
});
