import { afterEach, expect, it, vi } from 'vitest';
import { pgServerStorage } from './helpers/pg.ts';
import { WorldServer } from '../src/room/world-server.ts';
import { activeSeatForCoo } from '../src/room/room-seat-db.ts';
import { CooAccountDb } from '../src/room/coo-account-db.ts';
import { parseGuestInvite } from '../web-src/lib/entry.ts';

const PASSWORD = 'a local fixture password';
let server: WorldServer;
let now: number;

afterEach(async () => {
  await server?.close();
});

async function call(path: string, body?: Record<string, unknown>, headers: Record<string, string> = {}) {
  const response = await fetch(server.url + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() as Record<string, any>,
    cookie: (response.headers.get('set-cookie') ?? '').split(';')[0]! };
}

async function start(identityAuthority = 'self') {
  now = Date.now();
  server = await WorldServer.create({
    ...(await pgServerStorage(':memory:')), port: 0, inviteCode: 'extension-fixture',
    identityAuthority, operatorKey: 'operator-fixture', now: () => now,
  });
  await server.listen();
}

async function family(name: string) {
  const coo = 'coo-fixture-' + name;
  const joined = await call('/v1/rooms/lobby/join', { name }, {
    'x-parlor-coo': coo, 'x-parlor-coo-secret': 'secret-for-' + coo, 'x-parlor-invite': 'extension-fixture',
  });
  expect(joined.status, JSON.stringify(joined.body)).toBe(200);
  const played = await call('/v1/parent/play', { key: joined.body.ownerKey, room: 'hall' });
  expect(played.status, JSON.stringify(played.body)).toBe(200);
  return played;
}

it('正式网页登录退厅时保留会话，牌桌锁阻止退厅，之后可以返回自己的私密厅', async () => {
  await start();
  const original = await family('leave-room');
  const credentials = { loginName: '退厅测试玩家', password: PASSWORD };
  expect((await call('/v1/web/credentials', credentials, { cookie: original.cookie })).status).toBe(200);
  const login = await call('/v1/web/login', credentials);
  const auth = { cookie: login.cookie };
  const playing = await call('/v1/web/play', { takeover: true }, auth);
  const seatAuth = { authorization: 'Bearer ' + playing.body.token };
  const destination = (await call('/v1/rooms', { name: '目的客厅', visibility: 'private' }, seatAuth)).body.room.id;
  const entered = await call('/v1/rooms/hall/switch', { to: destination }, seatAuth);
  const opening = await call(`/v1/rooms/${destination}/action`,
    { type: 'table_open', game: 'gomoku', requestId: 'leave-room-open' }, seatAuth);
  expect(opening.status).toBe(200);
  expect((await call('/v1/me/leave', { seatId: entered.body.seat.id }, seatAuth)).status).toBe(409);
  expect((await call(`/v1/rooms/${destination}/action`,
    { type: 'table_leave', table: opening.body.tableId, requestId: 'leave-room-close' }, seatAuth)).status).toBe(200);
  expect((await call('/v1/me/leave', { seatId: entered.body.seat.id }, seatAuth)).body).toEqual({ ok: true, left: true });
  expect((await call('/v1/web/me', undefined, auth)).body.seated).toBe(false);
  expect((await call('/v1/me/location', undefined, seatAuth)).status).toBe(401);
  const publicRooms = await call('/v1/rooms');
  expect(publicRooms.body.rooms).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: destination })]));
  const joined = await call('/v1/web/play', { room: destination }, auth);
  expect(joined.body).toMatchObject({ room: destination, identity: { cooId: playing.body.identity.cooId } });
  expect(joined.body.seat.id).not.toBe(entered.body.seat.id);
});

it('游客可以主动退席并保留试玩资格，再入场仍只进获邀客厅', async () => {
  await start();
  const inviter = await family('invite-leave');
  const invite = await call('/v1/web/invites', {}, { cookie: inviter.cookie });
  const redeemed = await call('/v1/web/redeem', { code: invite.body.code, name: '试退厅' });
  const auth = { cookie: redeemed.cookie };
  const joined = await call('/v1/web/play', {}, auth);
  const bearer = { authorization: 'Bearer ' + joined.body.token };
  const position = await call('/v1/me/location', undefined, bearer);
  expect(position.body.seat.id).toBe(joined.body.seat.id);
  expect((await call('/v1/me/leave', { seatId: position.body.seat.id }, bearer)).body).toEqual({ ok: true, left: true });
  expect((await call('/v1/web/me', undefined, auth)).body).toMatchObject({ guest: true, seated: false });
  const rejoined = await call('/v1/web/play', { room: 'hall' }, auth);
  expect(rejoined.body).toMatchObject({ guest: true, room: joined.body.room });
});

it('Coo 直进并保存原身份，网页两次登录只有明确接管才换令牌', async () => {
  await start();
  const original = await family('original');
  const parent = { cookie: original.cookie };
  const legacySeat = { authorization: 'Bearer ' + original.body.token };
  const login = { loginName: '原玩家', password: PASSWORD };
  expect((await call('/v1/web/login', login)).status).toBe(401);
  expect((await call('/v1/web/credentials', login)).status).toBe(401);
  expect((await call('/v1/web/credentials', login, { ...parent, origin: 'https://other.example' })).status).toBe(403);
  expect((await call('/v1/web/credentials', undefined, parent)).body.suggestedName).toBe('original家的家长');
  expect((await call('/v1/web/credentials', login, parent)).status).toBe(200);
  const secondParent = await family('second');
  expect((await call('/v1/web/credentials', login, { cookie: secondParent.cookie })).status).toBe(409);
  const logins = await Promise.all(Array.from({ length: 4 }, () => call('/v1/web/login', login)));
  expect(logins.map(result => result.status)).toEqual([200, 200, 200, 200]);
  const [desktop, phone] = [logins[0]!, logins[1]!];
  const webFeedback = '/v1/support/feedback?as=web';
  expect((await call(webFeedback, { text: '尚未领取网页席位', requestId: 'web-login-feedback' }, { cookie: phone.cookie })).status).toBe(200);
  expect((await call(webFeedback, undefined, { cookie: desktop.cookie })).body.feedback).toHaveLength(1);
  expect(phone.cookie).not.toBe(desktop.cookie);
  expect((await call('/v1/rooms/hall/room', undefined, legacySeat)).status).toBe(200);
  expect((await call('/v1/parent/me', undefined, { cookie: phone.cookie })).status).toBe(401);
  expect((await call('/v1/web/play', {}, { cookie: phone.cookie })).status).toBe(409);
  const picked = await call('/v1/web/play', { takeover: true }, { cookie: phone.cookie });
  expect(picked.status, JSON.stringify(picked.body)).toBe(200);
  expect(picked.body.identity.cooId).toBe(original.body.identity.cooId);
  expect(picked.body.seat.id).toBe(original.body.seat.id);
  expect((await call('/v1/rooms/hall/room', undefined, legacySeat)).status).toBe(401);
  const webSeat = { authorization: 'Bearer ' + picked.body.token };
  expect((await call('/v1/rooms/hall/room', undefined, webSeat)).status).toBe(200);
  expect((await call('/v1/web/invites', {}, { ...webSeat, cookie: desktop.cookie })).status).toBe(403);
  expect((await call('/v1/web/invites', {}, { ...webSeat, cookie: phone.cookie })).status).toBe(200);
  const created = await call('/v1/rooms', { name: '正式会员厅' }, webSeat);
  const moved = await call('/v1/rooms/hall/switch', { to: created.body.room.id }, webSeat);
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  expect(moved.body.token).toBe(picked.body.token);
  const table = await call('/v1/rooms/' + moved.body.room + '/action', {
    type: 'table_open', game: 'gomoku', requestId: 'member-table',
  }, webSeat);
  expect(table.status).toBe(200);
  expect((await call('/v1/web/logout', {}, { cookie: phone.cookie })).status).toBe(200);
  expect((await call('/v1/rooms/' + moved.body.room + '/room', undefined, webSeat)).status).toBe(401);
  expect((await call('/v1/web/me', undefined, { cookie: desktop.cookie })).status).toBe(200);
  const resumed = await call('/v1/web/play', { takeover: true }, { cookie: desktop.cookie });
  expect(resumed.body).toMatchObject({ room: moved.body.room, tableId: table.body.tableId });
  expect((await call('/v1/web/credentials', { ...login, password: PASSWORD + ' updated' }, parent)).status).toBe(200);
  expect((await call('/v1/web/me', undefined, { cookie: desktop.cookie })).status).toBe(401);
});

it('用户发码可追溯，竞态下只兑一次，游客不能换厅或发码，撤销后旧令牌失效', async () => {
  await start();
  const inviter = await family('inviter');
  const other = await family('other');
  const auth = { cookie: inviter.cookie };
  const { body: invite, status } = await call('/v1/web/invites', {}, auth);
  expect(status).toBe(200);
  expect((await call('/v1/web/invites/' + invite.id + '/revoke', {}, { cookie: other.cookie })).status).toBe(404);
  const redeem = () => call('/v1/web/redeem', { code: invite.code, name: '试玩来客' });
  const attempts = await Promise.all([redeem(), redeem()]);
  expect(attempts.map(r => r.status).sort()).toEqual([200, 403]);
  const guest = { cookie: attempts.find(r => r.status === 200)!.cookie };
  const played = await call('/v1/web/play', {}, guest);
  expect(played.status, JSON.stringify(played.body)).toBe(200);
  expect(played.body.room).toBe('guest-play');
  const seat = { authorization: 'Bearer ' + played.body.token };
  expect((await call('/v1/web/me', undefined, guest)).body).toMatchObject({ name: '试玩来客', seated: true, guest: true });
  expect((await call('/v1/web/invites', {}, guest)).status).toBe(403);
  expect((await call('/v1/web/invites', {}, { cookie: guest.cookie + '; ' + inviter.cookie })).status).toBe(403);
  expect((await call('/v1/rooms/guest-play/switch', { to: 'lobby' }, seat)).status).toBe(403);
  expect((await call('/v1/rooms/hall/join', {}, { ...seat, 'x-parlor-invite': 'extension-fixture' })).status).toBe(403);
  expect((await call('/v1/rooms', { name: '绕过大厅' }, seat)).status).toBe(403);
  expect((await call('/v1/dm', { to: 'inviter', text: '打扰了' }, seat)).status).toBe(403);
  expect((await call('/v1/rooms/guest-play/action', { type: 'whisper', to: 'inviter', text: '打扰了' }, seat)).status).toBe(403);
  expect((await call('/v1/me/rename', { name: 'inviter' }, seat)).status).toBe(403);
  const outsideHost = { authorization: 'Bearer ' + inviter.body.token };
  const outside = await call('/v1/rooms', { name: '游客范围外', visibility: 'public' }, outsideHost);
  const outsideRoom = outside.body.room.id as string;
  const moved = await call('/v1/rooms/hall/switch', { to: outsideRoom }, outsideHost);
  expect(moved.status).toBe(200);
  const table = await call('/v1/rooms/' + outsideRoom + '/action', {
    type: 'table_open', game: 'gomoku', matchOpen: true, requestId: 'outside-table',
  }, { authorization: 'Bearer ' + moved.body.token });
  expect(table.status).toBe(200);
  expect((await call('/v1/table-entry', { table: table.body.tableId, room: outsideRoom, requestId: 'guest-table' }, seat)).status).toBe(404);
  expect((await call('/v1/table-entry', { game: 'gomoku', requestId: 'guest-match' }, seat)).body.matched).toBe(false);
  const guestTable = await call('/v1/rooms/guest-play/action', {
    type: 'table_open', game: 'gomoku', requestId: 'guest-open',
  }, seat);
  expect(guestTable.status, JSON.stringify(guestTable.body)).toBe(200);
  const sse = await fetch(server.url + '/v1/rooms/guest-play/stream', { headers: seat });
  expect(sse.status).toBe(200);
  const readToEnd = sse.text();
  const audit = (await call('/v1/web/invites', undefined, auth)).body.invites[0];
  expect(audit).toMatchObject({ id: invite.id, room: 'guest-play', guestId: played.body.identity.cooId, redeemedAt: now });
  expect(audit.issuerId).toBeTruthy();
  expect(audit.code).toBeUndefined();
  const operator = { authorization: 'Bearer operator-fixture' };
  expect((await call('/v1/web/operator/invites?q=' + encodeURIComponent(audit.guestHandle), undefined, operator)).body.invites)
    .toMatchObject([{ issuerId: audit.issuerId, guestId: audit.guestId }]);
  expect((await call('/v1/web/operator/invites/' + invite.id + '/revoke', {}, operator)).status).toBe(200);
  expect((await call('/v1/rooms/guest-play/room', undefined, seat)).status).toBe(401);
  expect((await call('/v1/web/play', { takeover: true }, guest)).status).toBe(401);
  await expect(readToEnd).resolves.toContain('retry:');
  await vi.waitFor(async () => expect(await activeSeatForCoo(server.dbHandle, played.body.identity.cooId)).toBeNull());
});

it('未兑换邀请码与已兑换游客资格分别到期', async () => {
  await start();
  const { cookie } = await family('expiry');
  const expired = (await call('/v1/web/invites', {}, { cookie })).body;
  const fresh = (await call('/v1/web/invites', {}, { cookie })).body;
  const guest = await call('/v1/web/redeem', { code: fresh.code, name: '限时玩家' });
  expect(guest.status).toBe(200);
  const played = await call('/v1/web/play', {}, { cookie: guest.cookie });
  expect(played.status).toBe(200);
  now += 86_400_000;
  expect((await call('/v1/web/me', undefined, { cookie: guest.cookie })).status).toBe(401);
  expect((await call('/v1/rooms/guest-play/room', undefined, { authorization: 'Bearer ' + played.body.token })).status).toBe(401);
  await server.releaseEndedWebSeats(now);
  expect(await activeSeatForCoo(server.dbHandle, played.body.identity.cooId)).toBeNull();
  now += 6 * 86_400_000;
  expect((await call('/v1/web/redeem', { code: expired.code, name: '已过期' })).status).toBe(403);
});

it('结束试玩立刻释放席位，原码保持已兑换状态', async () => {
  await start();
  const { cookie } = await family('guest-logout');
  const invite = (await call('/v1/web/invites', {}, { cookie })).body;
  const redeem = () => call('/v1/web/redeem', { code: invite.code, name: '主动离场' });
  const guest = await redeem();
  const auth = { cookie: guest.cookie };
  const played = await call('/v1/web/play', {}, auth);
  expect(played.status).toBe(200);
  expect(await activeSeatForCoo(server.dbHandle, played.body.identity.cooId)).not.toBeNull();
  expect((await call('/v1/web/logout', {}, auth)).status).toBe(200);
  expect(await activeSeatForCoo(server.dbHandle, played.body.identity.cooId)).toBeNull();
  expect((await call('/v1/web/play', {}, auth)).status).toBe(401);
  expect((await redeem()).status).toBe(403);
});

it('家长凭钥匙直接发可分享的游客链接，领取后仍然只兑一次', async () => {
  await start();
  const db = new CooAccountDb(server.dbHandle);
  const child = 'coo-invite-link-fixture';
  await db.registerCoo(child, 'invite-link-fixture-secret', 'pet', '发链接的 Coo');
  const { account, ownerKey } = await db.ensureAccount(child);
  const parent = await call('/v1/parent/session', { key: ownerKey });
  expect(parent.status).toBe(200);
  expect(await db.playerCooOf(account.id)).toBeNull();
  const issuer = { cookie: parent.cookie };
  const endpoint = '/v1/web/parent/invites';
  expect((await call(endpoint, {})).status).toBe(401);
  const issued = await call(endpoint, {}, issuer);
  expect(issued.status).toBe(200);
  const url = new URL(issued.body.link);
  expect(url.origin).toBe(server.url);
  expect(url.pathname + url.search).toBe('/play?entry=guest');
  const code = parseGuestInvite(url.search, url.hash);
  expect(code).toBe(issued.body.code);
  expect(await db.playerCooOf(account.id)).toBeNull();
  expect((await fetch(url)).status).toBe(200);
  const redeem = () => call('/v1/web/redeem', { code, name: '点击链接的朋友' });
  const guest = await redeem();
  expect(guest.status).toBe(200);
  expect((await redeem()).status).toBe(403);
  expect((await call(endpoint, {}, { cookie: guest.cookie })).status).toBe(401);
  const listed = (await call(endpoint, undefined, { cookie: [issuer.cookie, guest.cookie].join('; ') })).body.invites;
  expect(listed).toMatchObject([{ id: issued.body.id, issuerId: account.id, guestName: '点击链接的朋友' }]);
  expect(listed[0].link).toBeUndefined();
  expect((await call(endpoint + '/' + issued.body.id + '/revoke', {}, issuer)).status).toBe(200);
  expect((await call('/v1/web/play', {}, { cookie: guest.cookie })).status).toBe(401);
});

it('空闲席位按令牌回收，旧设备退出不影响已接管的设备，改密和到期也回收', async () => {
  await start();
  const parent = await family('idle-member');
  const owner = { cookie: parent.cookie };
  const cooId = parent.body.identity.cooId;
  const login = { loginName: '空闲玩家', password: PASSWORD };
  const credentials = (input: typeof login) => call('/v1/web/credentials', input, owner);
  expect((await credentials(login)).status).toBe(200);
  const first = { cookie: (await call('/v1/web/login', login)).cookie };
  const second = { cookie: (await call('/v1/web/login', login)).cookie };
  const play = (auth: { cookie: string }) => call('/v1/web/play', { takeover: true }, auth);
  expect((await play(first)).status).toBe(200);
  const picked = await play(second);
  expect(picked.status).toBe(200);
  expect((await call('/v1/web/logout', {}, first)).status).toBe(200);
  expect((await call('/v1/rooms/hall/room', undefined, { authorization: 'Bearer ' + picked.body.token })).status).toBe(200);
  expect((await call('/v1/web/logout', {}, second)).status).toBe(200);
  expect(await activeSeatForCoo(server.dbHandle, cooId)).toBeNull();

  const third = { cookie: (await call('/v1/web/login', login)).cookie };
  expect((await play(third)).status).toBe(200);
  const changed = { ...login, password: PASSWORD + ' changed' };
  expect((await credentials(changed)).status).toBe(200);
  expect((await call('/v1/web/me', undefined, third)).status).toBe(401);
  await vi.waitFor(async () => expect(await activeSeatForCoo(server.dbHandle, cooId)).toBeNull());
  const fourth = { cookie: (await call('/v1/web/login', changed)).cookie };
  expect((await play(fourth)).status).toBe(200);
  now += 30 * 86_400_000;
  await server.releaseEndedWebSeats(now);
  expect(await activeSeatForCoo(server.dbHandle, cooId)).toBeNull();
});

it('代理身份服上未下场的家长收到 409，频繁设置登录凭据会限流', async () => {
  await start('https://identity.example');
  const db = new CooAccountDb(server.dbHandle);
  const child = 'coo-remote-parent-fixture';
  await db.registerCoo(child, 'remote-parent-fixture-secret', 'pet', '代理身份服');
  const { ownerKey } = await db.ensureAccount(child);
  const parent = await call('/v1/parent/session', { key: ownerKey });
  expect(parent.status).toBe(200);
  const set = (password: string) => call('/v1/web/credentials', { loginName: '代理家长', password }, { cookie: parent.cookie });
  expect((await set(PASSWORD)).status).toBe(409);
  for (let i = 0; i < 4; i++) expect((await set('too short')).status).toBe(400);
  expect((await set(PASSWORD)).status).toBe(429);
});

it('凭据哈希格式损坏时返回普通登录失败', async () => {
  await start();
  const { cookie } = await family('malformed-hash');
  const login = { loginName: '哈希检查', password: PASSWORD };
  expect((await call('/v1/web/credentials', login, { cookie })).status).toBe(200);
  await server.dbHandle.prepare('UPDATE web_player_credentials SET password_hash=? WHERE login_name=?')
    .run('scrypt:00112233445566778899aabbccddeeff:ff', login.loginName);
  expect(await call('/v1/web/login', login)).toMatchObject({ status: 401, body: { error: '登录名或密码不对' } });
});
