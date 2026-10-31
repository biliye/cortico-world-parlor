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

describe('删除客厅', () => {
  it.each([false, true])('global=%s：只有房主能删除；释放席位、隐藏目录，历史与账户保留，重复操作幂等', async (global) => {
    const { room, player } = await setup(global);
    const client = new ParlorClient(server!.url);
    const childSeat = server!.dbHandle.prepare("SELECT token_hash FROM room_seats WHERE coo_id=? AND released_at IS NULL").get(childId);
    const visitor = await request('/v1/rooms/' + room + '/join', { name: '来客' }, {
      'x-parlor-invite': 'inv', 'x-parlor-coo': 'coo-delete-visitor',
      'x-parlor-coo-secret': 'visitor-secret-01234567890123456789',
    });
    expect(visitor.status).toBe(200);
    const token = visitor.body.token;
    expect((await request('/v1/rooms/' + room + '/delete', {}, bearer(token))).status).toBe(403);
    expect((await request('/v1/rooms/' + room + '/delete', {}, bearer('forged'))).status).toBe(401);
    expect((await request('/v1/rooms/hall/delete', {}, bearer(player.token))).status).toBe(403);
    await client.action(token, { type: 'say', text: '保留的历史' }, room);
    const beforeCoos = server!.dbHandle.prepare('SELECT COUNT(*) AS n FROM coos').get()?.n;
    const beforeAccounts = server!.dbHandle.prepare('SELECT COUNT(*) AS n FROM accounts').get()?.n;
    const ledger = server!.dbHandle.prepare('SELECT * FROM ledger_entries ORDER BY id').all();
    const deleted = await request('/v1/rooms/' + room + '/delete', {}, bearer(player.token));
    expect(deleted.status).toBe(200);
    expect(deleted.body.room).toMatchObject({ archived: true, seats: 0, capacity: 30 });
    const archived = server!.dbHandle.prepare('SELECT archived_at FROM rooms WHERE id=?').get(room)?.archived_at;
    const again = await request('/v1/rooms/' + room + '/delete', {}, bearer(player.token));
    expect(again.status).toBe(200);
    expect(server!.dbHandle.prepare('SELECT archived_at FROM rooms WHERE id=?').get(room)?.archived_at).toBe(archived);
    expect((await request('/v1/rooms?all=1', undefined, bearer(player.token))).body.rooms.some((x: any) => x.id === room)).toBe(false);
    expect((await request('/v1/hall', undefined, bearer(player.token))).body.rooms.some((x: any) => x.id === room)).toBe(false);
    expect((await request('/v1/rooms/' + room + '/room', undefined, bearer(token))).status).toBe(401);
    expect((await request('/v1/rooms/' + room + '/access', undefined, bearer(player.token))).status).toBe(409);
    expect((await request('/v1/rooms/' + room + '/join', { name: '再来' }, {
      'x-parlor-invite': 'inv', 'x-parlor-coo': 'coo-delete-visitor',
      'x-parlor-coo-secret': 'visitor-secret-01234567890123456789',
    })).status).toBe(403);
    expect(server!.dbHandle.prepare("SELECT COUNT(*) AS n FROM events WHERE room_id=? AND text='保留的历史'").get(room)?.n).toBe(1);
    expect(server!.dbHandle.prepare("SELECT COUNT(*) AS n FROM events WHERE room_id=? AND json_extract(data_json,'$.reason')='room_deleted'").get(room)?.n).toBe(1);
    expect(server!.dbHandle.prepare('SELECT COUNT(*) AS n FROM coos').get()?.n).toBe(beforeCoos);
    expect(server!.dbHandle.prepare('SELECT COUNT(*) AS n FROM accounts').get()?.n).toBe(beforeAccounts);
    expect(server!.dbHandle.prepare('SELECT * FROM ledger_entries ORDER BY id').all()).toEqual(ledger);
    expect(server!.dbHandle.prepare("SELECT token_hash FROM room_seats WHERE coo_id=? AND released_at IS NULL").get(childId)).toEqual(childSeat);
    expect(server!.dbHandle.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('未结束的等待、叫地主、打牌桌均阻止删除，拒绝时不改变席位和历史', async () => {
    const { room, player } = await setup(false);
    const client = new ParlorClient(server!.url);
    const moved = await client.switchTo(player.token, 'hall', room);
    await client.action(moved.token, { type: 'table_open', game: 'ddz', requestId: 'delete-guard-open' }, room);
    const before = server!.dbHandle.prepare('SELECT seq FROM rooms WHERE id=?').get(room)?.seq;
    for (const status of ['open', 'bidding', 'playing']) {
      server!.dbHandle.prepare('UPDATE tables SET status=? WHERE room_id=?').run(status, room);
      const result = await request('/v1/rooms/' + room + '/delete', {}, bearer(moved.token));
      expect(result.status).toBe(409);
      expect(result.body.error).toContain('未结束');
      expect(server!.dbHandle.prepare('SELECT archived_at, seq FROM rooms WHERE id=?').get(room)).toMatchObject({ archived_at: null, seq: before });
      expect((await request('/v1/rooms/' + room + '/room', undefined, bearer(moved.token))).status).toBe(200);
    }
    server!.dbHandle.prepare("UPDATE tables SET status='open' WHERE room_id=?").run(room);
    await client.action(moved.token, { type: 'table_leave', requestId: 'delete-guard-leave' }, room);
    expect((await request('/v1/rooms/' + room + '/delete', {}, bearer(moved.token))).status).toBe(200);
  });

  it('删除私密厅撤销待接受邀请，旧邀请不能重新打开客厅', async () => {
    const { player } = await setup(false);
    const made = await request('/v1/rooms', { name: '要关闭的私密厅', visibility: 'private' }, bearer(player.token));
    const room = made.body.room.id;
    const invite = await request('/v1/rooms/' + room + '/invite', { to: childId }, bearer(player.token));
    expect(invite.status).toBe(200);
    expect((await request('/v1/rooms/' + room + '/delete', {}, bearer(player.token))).status).toBe(200);
    const row = server!.dbHandle.prepare('SELECT status FROM room_invitations WHERE id=?').get(invite.body.invitationId);
    expect(row?.status).toBe('revoked');
    expect((await request('/v1/invitations/' + invite.body.invitationId + '/accept', {}, childHeaders)).status).toBe(409);
  });

  it('普通厅新建固定 30 席，旧小容量兼容；第 31 个会说话的席位被拒绝', async () => {
    const { player } = await setup(false);
    for (const capacity of [undefined, 2, 8, 16, 30]) {
      const made = await request('/v1/rooms', { name: '固定人数厅', visibility: 'public', capacity }, bearer(player.token));
      expect(made.status).toBe(200);
      expect(made.body.room.capacity).toBe(30);
    }
    expect((await request('/v1/rooms', { name: '非法人数厅', capacity: 0 }, bearer(player.token))).status).toBe(400);
    expect((await request('/v1/rooms', { name: '非法人数厅', capacity: 31 }, bearer(player.token))).status).toBe(400);
    const made = await request('/v1/rooms', { name: '三十人边界厅', visibility: 'public' }, bearer(player.token));
    for (let i=0; i<31; i++) {
      const joined = await request('/v1/rooms/' + made.body.room.id + '/join', { name: '客人' + i }, {
        'x-parlor-invite': 'inv', 'x-parlor-coo': 'coo-capacity-test-' + i,
        'x-parlor-coo-secret': 'capacity-secret-01234567890123456789-' + i,
      });
      expect(joined.status, JSON.stringify({ i, body: joined.body })).toBe(i < 30 ? 200 : 409);
    }
  });
});
