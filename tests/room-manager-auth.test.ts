import { afterEach, describe, expect, it } from 'vitest';
import { ParlorClient } from '../src/room/client.ts';
import { WorldServer } from '../src/room/world-server.ts';

let server: WorldServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

const childId = 'coo-room-owner-0001';
const childHeaders = {
  'x-parlor-coo': childId,
  'x-parlor-coo-secret': 'owner-secret-01234567890123456789',
};
const bearer = (token: string) => ({ authorization: 'Bearer ' + token });
const request = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(server!.url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
};

const setup = async (global: boolean) => {
  server = new WorldServer({ dbFile: ':memory:', port: 0, inviteCode: 'inv',
    ...(global ? { identityAuthority: 'self' } : {}) });
  await server.listen();
  const child = await request('/v1/rooms/hall/join', { name: '房主Coo', kind: 'pet' },
    { ...childHeaders, 'x-parlor-invite': 'inv' });
  expect(child.status).toBe(200);
  const player = await request('/v1/parent/play', { key: child.body.ownerKey, room: 'hall' });
  expect(player.status).toBe(200);
  if (global) expect(player.body.identity.cooSecret).toBe('seat-only');
  const created = await request('/v1/rooms', { name: '家长建的测试厅', visibility: 'public' }, bearer(player.body.token));
  expect(created.status).toBe(200);
  const owner = server.dbHandle.prepare('SELECT owner_coo_id FROM rooms WHERE id=?')
    .get(created.body.room.id) as { owner_coo_id: string };
  expect(owner.owner_coo_id).toBe(player.body.identity.cooId);
  return { room: created.body.room.id as string, player: player.body, child: child.body };
};

describe('房主管理识别有效席位令牌', () => {
  it.each([false, true])('global=%s：家长创建的客厅可只凭席位令牌管理，不需要旧凭证或家长 cookie', async (global) => {
    const { room, player } = await setup(global);
    const access = await request(`/v1/rooms/${room}/access`, undefined, bearer(player.token));
    expect(access.status).toBe(200);
    expect(access.body.owner.cooId).toBe(player.identity.cooId);
    const changed = await request(`/v1/rooms/${room}/visibility`, { visibility: 'unlisted' }, bearer(player.token));
    expect(changed.status).toBe(200);
    const again = await request(`/v1/rooms/${room}/access`, undefined, bearer(player.token));
    expect(again.body.room.visibility).toBe('unlisted');
  });

  it('陌生成员、伪造身份及无效/已释放令牌不能管理；房主换厅的新令牌仍可管理', async () => {
    const { room, player } = await setup(true);
    const visitor = await request('/v1/rooms/hall/join', { name: '来客' }, {
      'x-parlor-invite': 'inv', 'x-parlor-coo': 'coo-room-visitor-0002',
      'x-parlor-coo-secret': 'visitor-secret-01234567890123456789',
    });
    expect(visitor.status).toBe(200);
    expect((await request(`/v1/rooms/${room}/access`, undefined, bearer(visitor.body.token))).status).toBe(403);
    expect((await request(`/v1/rooms/${room}/visibility`, { visibility: 'private' }, bearer(visitor.body.token))).status).toBe(403);
    expect((await request(`/v1/rooms/${room}/access`, undefined, {
      ...bearer(visitor.body.token), 'x-parlor-coo': player.identity.cooId,
    })).status).toBe(403);
    expect((await request(`/v1/rooms/${room}/access`, undefined, bearer('forged-token'))).status).toBe(401);

    const moved = await new ParlorClient(server!.url).switchTo(player.token, 'hall', 'lobby');
    expect((await request(`/v1/rooms/${room}/access`, undefined, bearer(player.token))).status).toBe(401);
    expect((await request(`/v1/rooms/${room}/access`, undefined, bearer(moved.token))).status).toBe(200);
  });
});
