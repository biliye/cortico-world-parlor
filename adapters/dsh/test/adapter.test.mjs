import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../src/host.ts';

const origin = 'http://127.0.0.1:8790';
const ownerKey = 'test-parent-owner-key';
const firstToken = 'test-hall-token';
const roomToken = 'test-lobby-token';
const testSeat = { id: 's-test', name: 'DSH', kind: 'pet' };
const endpoint = 'http://dsh.invalid/api/cortico-parlor-dsh.parent';
const gameBody = { type: 'game_action', table: 't-test', action: 'place',
  params: { row: 7, col: 7 }, revision: 12, requestId: 'move-01' };
const roomsFixture = Array.from({ length: 110 }, (_, i) => ({
  id: i === 0 ? 'lobby' : `r-fixture-${i}`,
  name: i === 0 ? '客厅' : `回归客厅 ${i}`,
  kind: 'room', visibility: i === 1 ? 'private' : 'public', capacity: 30,
  seats: i === 1 ? 2 : 0, tableCount: i === 1 ? 1 : 0,
  games: i === 1 ? ['ddz'] : [], mine: i === 1, archived: i === 1,
  topic: '给 DSH 做联调的客厅', lastActiveAt: 1_700_000_000_000,
}));
const tablePatch = {
  table: { id: 't-test', status: 'playing' },
  tablePrivate: { seat: 's-test', hand: ['A'] },
  tables: [{ id: 't-other', status: 'ended', revealed: [{ seat: 'other', hand: ['K'] }] }],
};

function harness() {
  let saved;
  const start = () => {
    const tools = new Map();
    let route;
    apply({
      profileContext: { name: 'web' },
      credentials: {
        async modifyRecord(key, update) {
          assert.match(key, /^cortico-parlor-dsh\/profile-[a-f0-9]{64}$/);
          const replacement = await update(saved);
          if (replacement) saved = structuredClone(replacement);
          return structuredClone(saved);
        },
      },
      tools: { register: tool => tools.set(tool.name, tool) },
      inject: (_keys, init) => init({ connection: { fetch: { register: value => { route = value; } } } }),
    }, { serverUrl: origin, inviteCode: 'fixture-invite' });
    return {
      call(name, parameters) {
        const tool = tools.get(name);
        assert.ok(tool);
        return tool.execute(parameters, { signal: new AbortController().signal });
      },
      parent(type = 'application/json') {
        assert.equal(route.path, '/api/cortico-parlor-dsh.parent');
        assert.deepEqual(route.methods, ['POST']);
        return route.fetch(new Request(endpoint, {
          method: 'POST', headers: { 'content-type': type },
        }));
      },
    };
  };
  return { start };
}

function fakeGateway(t) {
  let actions = 0;
  let joins = 0;
  let profileIdentity;
  let mode = 'ok';
  t.mock.method(globalThis, 'fetch', async (value, init = {}) => {
    const url = new URL(value);
    assert.equal(url.origin, origin);
    const headers = new Headers(init.headers);
    const token = headers.get('authorization');
    const body = init.body ? JSON.parse(init.body) : undefined;
    switch (url.pathname) {
      case '/healthz':
        return Response.json({ protocol: 2, globalIdentity: { authority: origin, audience: origin } });
      case '/v1/identity/session':
        assert.equal(body.audience, origin);
        assert.ok(body.cooSecret.length >= 32);
        if (profileIdentity) assert.equal(body.cooId, profileIdentity);
        profileIdentity = body.cooId;
        return Response.json({
          token: 'test-identity-ticket', expiresAt: Date.now() + 600_000, person: { handle: '#dsh' },
        });
      case '/v1/rooms/hall/join':
      case '/v1/rooms/lobby/join':
        joins++;
        assert.equal(headers.get('x-parlor-identity'), 'test-identity-ticket');
        assert.equal(headers.get('x-parlor-invite'), 'fixture-invite');
        assert.equal(headers.get('x-parlor-coo-secret'), null);
        assert.deepEqual(body, { kind: 'pet', name: 'DSH', tier: 'off' });
        return Response.json(url.pathname.includes('hall')
          ? { room: 'hall', seat: testSeat, token: firstToken, ownerKey }
          : { room: 'lobby', seat: testSeat, token: roomToken });
      case '/v1/rooms':
        assert.equal(token, 'Bearer ' + firstToken);
        return Response.json({ rooms: roomsFixture });
      case '/v1/rooms/hall/switch':
        assert.equal(token, 'Bearer ' + firstToken);
        assert.equal(body.to, 'lobby');
        if (mode === 'room-full') return Response.json({ error: '客厅最多 30 个会说话的席位' }, { status: 409 });
        return Response.json({ room: 'lobby', seat: testSeat, token: roomToken });
      case '/v1/me/location':
        assert.equal(token, 'Bearer ' + roomToken);
        return mode === 'expired'
          ? Response.json({ error: 'expired' }, { status: 401 })
          : Response.json({ room: 'lobby', seat: testSeat });
      case '/v1/rooms/lobby/games':
        assert.equal(token, 'Bearer ' + roomToken);
        assert.equal(url.searchParams.get('op'), 'state');
        if (mode === 'table-missing') return Response.json({ error: '这张桌子不存在' }, { status: 404 });
        return Response.json({
          table: { id: 't-test', revision: 12 }, availableActions: [{ action: 'place' }],
        });
      case '/v1/rooms/hall/action':
        actions++;
        assert.equal(token, 'Bearer ' + firstToken);
        assert.equal(body.type, 'table_open');
        return Response.json({ error: '大厅是进场和选房的地方，不能开桌；先走进一个客厅' }, { status: 409 });
      case '/v1/rooms/lobby/action':
        actions++;
        assert.equal(token, 'Bearer ' + roomToken);
        if (body.type === 'table_start') {
          return Response.json({ ok: true, requestId: body.requestId, tableId: body.table, revision: 2,
            seq: 12, at: '2026-11-19 16:00:00', seats: ['DSH', '陪练甲', '陪练乙'], deadline: 1_700_000_060_000,
            deadlineAt: '2026-11-19 16:01:00', turn: 'DSH', ...tablePatch });
        }
        if (body.type === 'table_leave') {
          return Response.json({ ok: true, revision: 3, closed: false, seq: 13, ...tablePatch, table: null });
        }
        assert.deepEqual(body, gameBody);
        if (mode === 'unknown') throw new Error('connection closed');
        if (mode === 'expired') return Response.json({ error: 'expired' }, { status: 401 });
        if (mode === 'stale') return Response.json({ error: 'old revision' }, { status: 409 });
        if (mode === 'invalid-action') return Response.json({ error: '未知动作 place；先查询游戏动作说明' }, { status: 400 });
        return Response.json({ ok: true, revision: 13 });
      default:
        assert.fail('Unexpected request ' + url.pathname);
    }
  });
  return { setMode: value => { mode = value; }, joins: () => joins, actions: () => actions };
}

async function enterLobby(plugin) {
  const list = await plugin.call('parlor_room', { op: 'list' });
  assert.equal(list.currentRoom, 'hall');
  assert.deepEqual(await plugin.call('parlor_room', { op: 'visit', room: 'lobby' }), {
    room: 'lobby', seat: testSeat,
  });
}

test('joins once, saves both keys privately and restores the authoritative room after restart', async t => {
  const gateway = fakeGateway(t);
  const context = harness();
  const plugin = context.start();
  assert.equal((await plugin.parent('text/plain')).status, 415);
  assert.equal(gateway.joins(), 0);
  await enterLobby(plugin);
  const restarted = context.start();
  const state = await restarted.call('parlor_game_info', { op: 'state' });
  assert.equal(state.table.revision, 12);
  const { type, ...move } = gameBody;
  assert.deepEqual(await restarted.call('parlor_game_action', move), { ok: true, revision: 13 });
  const parent = await restarted.parent();
  assert.equal(parent.status, 200);
  assert.equal(parent.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await parent.json(), { url: `${origin}/parent#key=${ownerKey}` });
  assert.equal(gateway.joins(), 1);
  assert.equal(gateway.actions(), 1);
});

test('does not replay a mutation on a conflict, lost response or expired seat', async t => {
  const gateway = fakeGateway(t);
  const plugin = harness().start();
  await enterLobby(plugin);
  const { type, ...move } = gameBody;
  gateway.setMode('stale');
  await assert.rejects(plugin.call('parlor_game_action', move), /^Error: 茶室 HTTP 409：old revision$/);
  assert.equal(gateway.actions(), 1);
  gateway.setMode('unknown');
  await assert.rejects(plugin.call('parlor_game_action', move), /本次 requestId：move-01/);
  assert.equal(gateway.actions(), 2);
  gateway.setMode('expired');
  await assert.rejects(plugin.call('parlor_game_action', move), /^Error: 茶室 HTTP 401：expired$/);
  assert.equal(gateway.actions(), 3);
  assert.equal(gateway.joins(), 1);
  assert.equal((await plugin.call('parlor_game_info', { op: 'state' })).table.revision, 12);
  assert.equal(gateway.joins(), 2);
  assert.equal(gateway.actions(), 3);
});

test('keeps the precise HTTP status and server reason across room, table, and game tools', async t => {
  const gateway = fakeGateway(t);
  const plugin = harness().start();
  await assert.rejects(plugin.call('parlor_table', { op: 'open', game: 'gomoku', requestId: 'open-01' }),
    /^Error: 茶室 HTTP 409：大厅是进场和选房的地方，不能开桌；先走进一个客厅$/);
  gateway.setMode('room-full');
  await assert.rejects(plugin.call('parlor_room', { op: 'visit', room: 'lobby' }),
    /^Error: 茶室 HTTP 409：客厅最多 30 个会说话的席位$/);
  gateway.setMode('table-missing');
  await enterLobby(plugin);
  await assert.rejects(plugin.call('parlor_game_info', { op: 'state' }),
    /^Error: 茶室 HTTP 404：这张桌子不存在$/);
  gateway.setMode('invalid-action');
  const { type, ...move } = gameBody;
  await assert.rejects(plugin.call('parlor_game_action', move),
    /^Error: 茶室 HTTP 400：未知动作 place；先查询游戏动作说明$/);
});

test('keeps all visible rooms in a compact directory and only returns the touched table receipt', async t => {
  fakeGateway(t);
  const plugin = harness().start();
  const directory = await plugin.call('parlor_room', { op: 'list' });
  assert.deepEqual(directory.rooms.map(room => room.id), roomsFixture.map(room => room.id));
  assert.deepEqual(directory.rooms[0], { id: 'lobby', name: '客厅', seats: 0, capacity: 30, visibility: 'public' });
  assert.deepEqual(directory.rooms[1], { id: 'r-fixture-1', name: '回归客厅 1', seats: 2, capacity: 30,
    visibility: 'private', archived: true, mine: true, games: ['ddz'], tableCount: 1 });
  assert.ok(Buffer.byteLength(JSON.stringify(directory.rooms)) < Buffer.byteLength(JSON.stringify(roomsFixture)) * 0.7);

  await plugin.call('parlor_room', { op: 'visit', room: 'lobby' });
  const started = await plugin.call('parlor_table', { op: 'start', table: 't-test', requestId: 'start-01' });
  assert.deepEqual(started, { ok: true, requestId: 'start-01', tableId: 't-test', revision: 2,
    seq: 12, at: '2026-11-19 16:00:00', seats: ['DSH', '陪练甲', '陪练乙'], deadline: 1_700_000_060_000,
    deadlineAt: '2026-11-19 16:01:00', turn: 'DSH' });
  const left = await plugin.call('parlor_table', { op: 'leave', table: 't-test', requestId: 'leave-01' });
  assert.deepEqual(left, { ok: true, requestId: 'leave-01', tableId: 't-test', revision: 3, closed: false, seq: 13 });
});
