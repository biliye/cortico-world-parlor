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
  const logs = new Map();
  const archived = new Set();
  const missing = new Set();
  const start = ({ restoreAgent = false, flush } = {}) => {
    const tools = new Map();
    const messages = [];
    const disposals = [];
    const agents = new Map();
    const agent = id => {
      if (!logs.has(id)) logs.set(id, []);
      const log = logs.get(id);
      if (!agents.has(id)) agents.set(id, {
        session: { id, snapshotEvents: (from = 0) => log.slice(from) },
        followup(message) {
          log.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } });
          messages.push({ session: id, ...message });
        },
      });
      return agents.get(id);
    };
    let route;
    let onDomainChange;
    apply({
      profileContext: { name: 'web' },
      agents: { get: id => (restoreAgent && !agents.has(id)) || missing.has(id) ? undefined : agent(id) },
      get(key) {
        if (key === 'workspaceRegistry') return { archivedSessionIds: [...archived] };
        if (key === 'sessionPersistence') return { async stat(id) { return missing.has(id) ? undefined : {}; } };
        if (key === 'sessionController' && restoreAgent) {
          return { async resolveAgent(id) { return { agent: agent(id) }; } };
        }
        if (key === 'sessions' && flush) return { flush };
      },
      effect: setup => disposals.push(setup()),
      on(event, callback) {
        assert.equal(event, 'domain/changed');
        onDomainChange = callback;
      },
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
      messages,
      archive(id) {
        onDomainChange({ domain: 'workspace', table: '', operation: 'put',
          value: { archivedSessionIds: [...archived, id] } });
        archived.add(id);
      },
      markMissing(id) { missing.add(id); },
      dispose: () => disposals.forEach(dispose => dispose()),
      call(name, parameters, sessionId = 'parlor-session') {
        const tool = tools.get(name);
        assert.ok(tool);
        return tool.execute(parameters, { agent: agent(sessionId), signal: new AbortController().signal });
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

function fakeGateway(t, { hallCrowd = [] } = {}) {
  let actions = 0;
  let joins = 0;
  let profileIdentity;
  const streams = [];
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
        if (init.method === 'POST') {
          assert.deepEqual(body, { name: '新私厅', visibility: 'private' });
          return Response.json({ room: { id: 'lobby', name: body.name, visibility: body.visibility } });
        }
        return Response.json({ rooms: roomsFixture });
      case '/v1/rooms/hall/switch':
      case '/v1/rooms/lobby/switch': {
        const fromHall = url.pathname.includes('/hall/');
        assert.equal(token, 'Bearer ' + (fromHall ? firstToken : roomToken));
        assert.equal(body.to, fromHall ? 'lobby' : 'hall');
        if (mode === 'room-full') return Response.json({ error: '客厅最多 30 个会说话的席位' }, { status: 409 });
        return Response.json({ room: body.to, seat: testSeat, token: fromHall ? roomToken : firstToken, joinSeq: 20 });
      }
      case '/v1/rooms/hall/room':
      case '/v1/rooms/lobby/room': {
        const room = url.pathname.split('/')[3];
        assert.equal(token, 'Bearer ' + (room === 'hall' ? firstToken : roomToken));
        return Response.json({
          id: room, name: room, latest: 20, now: 100, seat: testSeat,
          seats: room === 'hall' ? [...hallCrowd, testSeat] : [testSeat],
          online: room === 'hall' && hallCrowd.length
            ? hallCrowd.filter((_, index) => index % 2 === 0).map(person => person.id) : [testSeat.id],
          ...(room === 'lobby' ? {
            tablePrivate: {
              tableId: 't-test', hand: ['private-card'], canAct: mode === 'first-turn',
              ...(mode === 'already-acted' ? { yourTurn: true } : {}),
            },
            tables: [
              { id: 't-test', status: 'open', seats: [testSeat], capacity: 3, openDeadline: 200 },
              { id: 't-full', status: 'open', seats: [testSeat], capacity: 1 },
              { id: 't-ended', status: 'ended', revealed: ['other-card'] },
              { id: 't-expired', status: 'open', openDeadline: 99 },
            ],
          } : {}),
        });
      }
      case '/v1/rooms/hall/stream':
      case '/v1/rooms/lobby/stream': {
        const encoder = new TextEncoder();
        let cancelled = false;
        return new Response(new ReadableStream({
          start(controller) {
            const stream = {
              room: url.pathname.split('/')[3], since: Number(url.searchParams.get('since')),
              send: event => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
              close: () => controller.close(),
              get aborted() { return init.signal.aborted; },
              get cancelled() { return cancelled; },
            };
            streams.push(stream);
          },
          cancel() { cancelled = true; },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      case '/v1/me/invitations':
        return Response.json({ invitations: [{ id: 'inv-test', room: 'lobby' }] });
      case '/v1/invitations/inv-test/accept':
      case '/v1/invitations/inv-second/accept':
        assert.equal(token, 'Bearer ' + firstToken);
        return Response.json({ ok: true, room: 'lobby' });
      case '/v1/invitations/inv-other/decline':
        return Response.json({ ok: true });
      case '/v1/invite':
        assert.equal(token, 'Bearer ' + roomToken);
        assert.deepEqual(body, { to: '#human', room: 'lobby', text: '来打牌' });
        return Response.json({ ok: true, pending: true, invitationId: 'inv-sent', mailSeq: 55 });
      case '/v1/me/mail':
        assert.equal(token, null);
        assert.equal(headers.get('x-parlor-identity'), 'test-identity-ticket');
        assert.equal(url.searchParams.get('peek'), '1');
        return Response.json({ unread: 1, items: [{ room: 'another-room', invitationId: 'inv-test' }] });
      case '/v1/dm/threads':
        return Response.json({ threads: [{ peer: 'other-coo' }], unread: 1 });
      case '/v1/dm':
        assert.equal(url.searchParams.get('peer'), 'other-coo');
        assert.equal(url.searchParams.get('before'), '60');
        return Response.json({ messages: [{ seq: 59, text: '上一封私信' }] });
      case '/v1/dm/read':
        assert.deepEqual(body, { peer: 'other-coo' });
        return Response.json({ ok: true, changed: 1 });
      case '/v1/rooms/lobby/history':
        assert.equal(url.searchParams.get('since'), '21');
        return Response.json({ latest: 24, events: [
          { seq: 22, type: 'parlor.say', text: '客厅消息' },
          { seq: 23, type: 'parlor.table.say', text: '同桌消息', data: { tableId: 't-test' } },
          { seq: 24, type: 'parlor.table.turn', text: '不该显示的私视图' },
        ] });
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
          table: { id: 't-test', revision: 12 },
          availableActions: mode === 'already-acted' ? [] : [{ action: 'place' }],
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
        if (['say', 'table_say', 'whisper'].includes(body.type)) {
          if (mode === 'unknown') throw new Error('connection closed');
          assert.equal(body.text, '你好');
          if (body.type === 'whisper') {
            assert.equal(body.to, '#human');
            return Response.json({ ok: true, seq: 26, delivered: [{ to: '家长', mailSeq: 59 }] });
          }
          return Response.json({ ok: true, seq: 26, event: { seq: body.type === 'say' ? 23 : 24 }, ...tablePatch });
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
  return { setMode: value => { mode = value; }, joins: () => joins, actions: () => actions, streams };
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

test('handles cross-room invitations and keeps acceptance when the room cannot be entered', async t => {
  const gateway = fakeGateway(t);
  const plugin = harness().start();
  assert.equal((await plugin.call('parlor_query', { op: 'mail' })).items[0].room, 'another-room');
  assert.equal((await plugin.call('parlor_room', { op: 'invitations' })).invitations[0].id, 'inv-test');
  assert.deepEqual(await plugin.call('parlor_room', { op: 'decline', params: { id: 'inv-other' } }), { ok: true });
  gateway.setMode('room-full');
  assert.deepEqual(await plugin.call('parlor_room', { op: 'accept', params: { id: 'inv-test' } }), {
    ok: true, room: 'lobby', entered: false, reason: '茶室 HTTP 409：客厅最多 30 个会说话的席位',
  });

  gateway.setMode('ok');
  assert.deepEqual(await plugin.call('parlor_room', { op: 'accept', params: { id: 'inv-second' } }), {
    ok: true, room: 'lobby', entered: true, seat: testSeat,
  });
  const invite = await plugin.call('parlor_room', {
    op: 'invite', params: { to: '#human', room: 'lobby', text: '来打牌' },
  });
  assert.equal(invite.invitationId, 'inv-sent');
  assert.equal((await plugin.call('parlor_room', { op: 'look' })).seats[0].online, true);
});

test('discovers joinable tables and reads and sends messages with explicit scopes', async t => {
  const gateway = fakeGateway(t);
  const plugin = harness().start();
  await enterLobby(plugin);

  const listing = await plugin.call('parlor_table', { op: 'list', openOnly: true });
  assert.deepEqual(listing.tables.map(({ id, occupied, capacity }) => ({ id, occupied, capacity })), [
    { id: 't-test', occupied: 1, capacity: 3 },
  ]);
  assert.doesNotMatch(JSON.stringify(await plugin.call('parlor_table', { op: 'list' })), /private-card|other-card/);
  const history = await plugin.call('parlor_query', { op: 'chat', since: 21, scope: 'table' });
  assert.equal(history.nextSince, 24);
  assert.deepEqual(history.messages.map(message => message.text), ['同桌消息']);

  await assert.rejects(plugin.call('parlor_message', { scope: 'wrong', text: '你好' }), /^Error: scope 必须为/);
  await assert.rejects(plugin.call('parlor_query', { op: 'chat', scope: 'wrong' }), /^Error: scope 必须为/);
  await assert.rejects(plugin.call('parlor_message', { scope: 'room', text: '你好', to: '#human' }), /scope: private/);
  assert.equal(gateway.actions(), 0);
  assert.equal((await plugin.call('parlor_message', { scope: 'room', text: '你好' })).messageSeq, 23);
  const sent = await plugin.call('parlor_message', { scope: 'table', text: '你好' });
  assert.equal(sent.messageSeq, 24);
  assert.doesNotMatch(JSON.stringify(sent), /tablePrivate|revealed/);
  assert.equal((await plugin.call('parlor_message', { scope: 'private', to: '#human', text: '你好' })).delivered[0].mailSeq, 59);
  const { threads } = await plugin.call('parlor_query', { op: 'dm' });
  const { peer } = threads[0];
  assert.equal((await plugin.call('parlor_query', { op: 'dm', peer, before: 60 })).messages[0].seq, 59);
  assert.equal((await plugin.call('parlor_query', { op: 'dm_read', peer })).changed, 1);
  gateway.setMode('unknown');
  await assert.rejects(plugin.call('parlor_message', { scope: 'table', text: '你好' }), /先查看聊天记录/);
  assert.equal(gateway.actions(), 4);
});

test('pages a busy hall, includes the offline self, and indicates a newly created room must be visited', async t => {
  const hallCrowd = Array.from({ length: 377 }, (_, n) => ({
    id: `s-${n}`, name: `测试成员 ${n}`, kind: 'pet', handle: `test-${n}`,
  }));
  fakeGateway(t, { hallCrowd });
  const plugin = harness().start();
  const page = await plugin.call('parlor_room', { op: 'look' });
  assert.equal(page.totalSeats, 378);
  assert.equal(page.onlineSeats, 189);
  assert.equal(page.onlineOnly, true);
  assert.equal(page.seats.length, 30);
  assert.equal(page.seats[0].id, testSeat.id);
  assert.equal(page.seats[0].online, false);
  assert.ok(page.seats.slice(1).every(person => person.online));
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 4000);
  const next = await plugin.call('parlor_room', { op: 'look', params: { offset: page.nextOffset, limit: 50 } });
  assert.equal(next.seats.length, 50);
  assert.ok(next.seats.every(person => !page.seats.some(prior => prior.id === person.id)));
  const offline = await plugin.call('parlor_room', { op: 'look', params: { onlineOnly: false, offset: 190 } });
  assert.ok(offline.seats.length && offline.seats.every(person => !person.online));
  const created = await plugin.call('parlor_room', { op: 'create', params: { name: '新私厅', visibility: 'private' } });
  assert.equal(created.currentRoom, 'hall');
  assert.equal(created.entered, false);
  assert.equal((await plugin.call('parlor_room', { op: 'visit', params: { room: created.room.id } })).room, 'lobby');
});

async function eventually(condition) {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(condition(), 'condition was not reached');
}

const roomEvent = (seq, type, fields = {}) => ({
  seq, type, from: 'system', scope: { kind: 'room' }, text: 'UNTRUSTED REMOTE TEXT', ...fields,
});

test('waiting wakes only the bound session, deduplicates events and restores its cursor', async t => {
  const { streams } = fakeGateway(t);
  const context = harness();
  const plugin = context.start();
  t.after(plugin.dispose);
  await enterLobby(plugin);
  const armed = await plugin.call('parlor_wait', { op: 'start' });
  assert.equal(armed.table, 't-test');
  assert.equal(armed.since, 20);
  await assert.rejects(plugin.call('parlor_wait', { op: 'start' }, 'other-session'), /另一个 DSH 会话/);
  assert.deepEqual(await plugin.call('parlor_wait', { op: 'stop' }, 'other-session'), { active: false, anotherSession: true });
  await eventually(() => streams.length === 1);
  streams[0].send(roomEvent(22, 'parlor.say', { from: 'human' }));
  streams[0].send(roomEvent(23, 'parlor.table.join', { data: { tableId: 'other-table' } }));
  streams[0].send(roomEvent(24, 'parlor.table.join', { data: { tableId: 't-test', seat: 'human' } }));
  streams[0].send(roomEvent(24, 'parlor.table.join', { data: { tableId: 't-test', seat: 'human' } }));
  streams[0].send(roomEvent(25, 'parlor.table.turn', { scope: { kind: 'seat', seatId: testSeat.id }, data: { decision: false } }));
  streams[0].send(roomEvent(26, 'parlor.table.turn', { scope: { kind: 'seat', seatId: testSeat.id } }));
  streams[0].send(roomEvent(27, 'parlor.table.end', { data: { tableId: 't-test' } }));
  await eventually(() => plugin.messages.length === 3);
  assert.match(plugin.messages[0].content[0].text, /玩家入座/);
  assert.match(plugin.messages[1].content[0].text, /轮到本席/);
  assert.match(plugin.messages[2].content[0].text, /已结算/);
  assert.ok(plugin.messages.every(message => message.session === 'parlor-session' && message.source.kind === 'parlor'));
  assert.doesNotMatch(JSON.stringify(plugin.messages), /UNTRUSTED REMOTE TEXT/);

  streams[0].close();
  await eventually(() => streams.length === 2);
  assert.equal(streams[1].since, 27);
  streams[1].send(roomEvent(27, 'parlor.table.end', { data: { tableId: 't-test' } }));
  streams[1].send(roomEvent(28, 'parlor.whisper', { scope: { kind: 'seat', seatId: testSeat.id } }));
  await eventually(() => plugin.messages.length === 4);
  assert.match(plugin.messages[3].content[0].text, /有私信/);

  plugin.dispose();
  const resumed = context.start({ restoreAgent: true });
  t.after(resumed.dispose);
  await eventually(() => streams.length === 3);
  assert.deepEqual({ room: streams[2].room, since: streams[2].since }, { room: 'lobby', since: 28 });
  streams[2].send(roomEvent(29, 'parlor.invite', { scope: { kind: 'seat', seatId: testSeat.id } }));
  await eventually(() => resumed.messages.length === 1);
  assert.match(resumed.messages[0].content[0].text, /客厅邀请/);
  assert.equal(resumed.messages[0].session, 'parlor-session');

  await resumed.call('parlor_room', { op: 'visit', room: 'hall' });
  await eventually(() => streams.length === 4);
  assert.equal(streams[2].aborted, true);
  assert.deepEqual({ room: streams[3].room, since: streams[3].since }, { room: 'hall', since: 20 });
  assert.equal((await resumed.call('parlor_wait', { op: 'status' })).table, undefined);
  await resumed.call('parlor_wait', { op: 'stop' });
  assert.equal(streams[3].aborted, true);
  const stopped = context.start();
  t.after(stopped.dispose);
  assert.deepEqual(await stopped.call('parlor_wait', { op: 'status' }), { active: false });
});

test('arming after the first turn reports the already-available game action before replay begins', async t => {
  const gateway = fakeGateway(t);
  const plugin = harness().start();
  t.after(plugin.dispose);
  await enterLobby(plugin);
  gateway.setMode('first-turn');
  const armed = await plugin.call('parlor_wait', { op: 'start', table: 't-test' });
  assert.equal(armed.since, 20);
  assert.equal(armed.pendingAction, true);
  assert.equal(plugin.messages.length, 0);
  gateway.setMode('already-acted');
  assert.equal((await plugin.call('parlor_wait', { op: 'start' })).pendingAction, false);
});

test('archive and missing-session detection free a persisted watch for another session', async t => {
  const { streams } = fakeGateway(t);
  const context = harness();
  const plugin = context.start();
  t.after(plugin.dispose);
  await enterLobby(plugin);
  await plugin.call('parlor_wait', { op: 'start' });
  await eventually(() => streams.length === 1);
  plugin.archive('unrelated-session');
  assert.equal((await plugin.call('parlor_wait', { op: 'status' })).active, true);
  plugin.archive('parlor-session');
  // Check the listener closed the stream before status can trigger the fallback.
  await eventually(() => streams[0].aborted);
  assert.deepEqual(await plugin.call('parlor_wait', { op: 'status' }), { active: false, reason: 'archived' });
  assert.deepEqual(await plugin.call('parlor_wait', { op: 'status' }, 'replacement'), { active: false });
  assert.equal((await plugin.call('parlor_wait', { op: 'start' }, 'replacement')).active, true);
  plugin.dispose();
  plugin.markMissing('replacement');
  const restarted = context.start({ restoreAgent: true });
  t.after(restarted.dispose);
  assert.deepEqual(await restarted.call('parlor_wait', { op: 'status' }, 'replacement'),
    { active: false, reason: 'missing' });
  assert.deepEqual(await restarted.call('parlor_wait', { op: 'status' }, 'next'), { active: false });
  assert.equal((await restarted.call('parlor_wait', { op: 'start' }, 'next')).active, true);
});

test('replays an unacknowledged notice from the old cursor without submitting it again', async t => {
  const { streams } = fakeGateway(t);
  const context = harness();
  const plugin = context.start({ flush: async () => false });
  t.after(plugin.dispose);
  await enterLobby(plugin);
  await plugin.call('parlor_wait', { op: 'start' });
  await eventually(() => streams.length === 1);
  const notice = roomEvent(21, 'parlor.whisper', { scope: { kind: 'seat', seatId: testSeat.id } });
  streams[0].send(notice);
  await eventually(() => plugin.messages.length === 1 && streams[0].cancelled);
  assert.equal((await plugin.call('parlor_wait', { op: 'status' })).reason, 'delivery_failed');
  plugin.dispose();

  let flushes = 0;
  const restarted = context.start({ restoreAgent: true, flush: async () => { flushes++; return true; } });
  t.after(restarted.dispose);
  await eventually(() => streams.length === 2);
  assert.equal(streams[1].since, 20);
  streams[1].send(notice);
  await eventually(() => flushes === 1);
  assert.equal(restarted.messages.length, 0);
  await restarted.call('parlor_wait', { op: 'stop' });
});
