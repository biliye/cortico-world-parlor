import { afterEach, expect, it } from 'vitest';
import { pgServerStorage } from './helpers/pg.ts';
import { WorldServer } from '../src/room/world-server.ts';

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

async function start() {
  now = Date.now();
  server = await WorldServer.create({
    ...(await pgServerStorage(':memory:')), port: 0, inviteCode: 'extension-fixture',
    identityAuthority: 'self', operatorKey: 'operator-fixture', now: () => now,
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
  const desktop = await call('/v1/web/login', login);
  const phone = await call('/v1/web/login', login);
  expect(desktop.status).toBe(200);
  expect(phone.status).toBe(200);
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
  now += 6 * 86_400_000;
  expect((await call('/v1/web/redeem', { code: expired.code, name: '已过期' })).status).toBe(403);
});
