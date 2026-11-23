import { afterEach, describe, expect, it } from 'vitest';
import { WorldServer } from '../src/room/world-server.ts';
import { ParlorClient } from '../src/room/client.ts';
import { GAME_RESPONSE_MAX_BYTES } from '../src/room/table-engine.ts';
import { pgServerStorage } from './helpers/pg.ts';

let app: WorldServer | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function start(clock?: { now: number }, suffixes = ['a', 'b', 'c']) {
  app = await WorldServer.create({ ...(await pgServerStorage(':memory:')), port: 0,
    inviteCode: 'inv', ...(clock ? { now: () => clock.now } : {}),
  });
  await app.listen();
  const players = await Promise.all(suffixes.map(async suffix => {
    const client = new ParlorClient(app!.url, { cooId: `coo-generic-${suffix}`, cooSecret: `secret-generic-${suffix}-0123456789` });
    const joined = await client.join('inv', { name: suffix }, 'lobby');
    return { client, token: joined.token };
  }));
  return players;
}

async function post(token: string, body: unknown) {
  const response = await fetch(`${app!.url}/v1/rooms/lobby/action`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

describe('通用游戏 HTTP JSON 网关（真实 PG）', () => {
  it('麻将同一窗口可并发提交，旁观者只看公开牌河，通知只发到行动席位', async () => {
    const players = await start(undefined, ['a', 'b', 'c', 'd', 'spectator']);
    const [host, , , , spectator] = players;
    const catalog = await host.client.games(host.token, { op: 'list' }, 'lobby');
    expect(catalog.games).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'mahjong-sichuan' }),
      expect.objectContaining({ id: 'mahjong-guangdong' }),
    ]));
    const opened = await host.client.action(host.token, {
      type: 'table_open', game: 'mahjong-sichuan', requestId: 'mahjong-open',
    }, 'lobby');
    const table = opened.tableId!;
    for (const p of players.slice(1, 4)) {
      await p.client.action(p.token, { type: 'table_join', table, requestId: 'mahjong-join' }, 'lobby');
    }
    await host.client.action(host.token, { type: 'table_start', table, requestId: 'mahjong-start' }, 'lobby');
    const read = (player: typeof host) => player.client.games(player.token, { op: 'state', table }, 'lobby') as Promise<Record<string, any>>;
    const watches = await read(spectator);
    expect(watches.tablePrivate).toBeNull();
    expect(watches.table.seats.every((p: Record<string, unknown>) => !('hand' in p))).toBe(true);
    const states = await Promise.all(players.slice(0, 4).map(read));
    const exchanges = states.map((state, i) => {
      const { windowId, hand } = state.tablePrivate;
      expect(state.tablePrivate.text).toContain('未见张数');
      expect(state.availableActions[0]).toMatchObject({ action: 'exchange', defaults: { windowId } });
      const suits = [0, 1, 2].map(suit => (hand as number[]).filter(t => Math.floor(t / 9) === suit));
      const tiles = suits.find(suit => suit.length >= 3)!.slice(0, 3);
      return { type: 'game_action', table, action: 'exchange', params: { windowId, tiles }, requestId: 'exchange-' + i };
    });
    const replies = await Promise.all(exchanges.map((action, i) => post(players[i].token, action)));
    expect(replies.map(reply => reply.status)).toEqual([200, 200, 200, 200]);
    expect((await post(host.token, exchanges[0])).body).toEqual(replies[0].body);
    expect((await post(host.token, { ...exchanges[0], requestId: 'stale' })).status).toBe(409);
    const missingStates = await Promise.all(players.slice(0, 4).map(read));
    for (const [i, p] of players.slice(0, 4).entries()) {
      const reply = await post(p.token, { type: 'game_action', table, action: 'missing',
        params: { windowId: missingStates[i].tablePrivate.windowId, suit: 2 }, requestId: 'missing-' + i });
      expect(reply.status).toBe(200);
    }
    const ready = await Promise.all(players.slice(0, 4).map(read));
    const dealer = ready.findIndex(s => s.tablePrivate.yourTurn);
    const own = ready[dealer].tablePrivate;
    const tile = own.discardable[0];
    expect(own.hints.length).toBeGreaterThan(0);
    const discard = { type: ready[dealer].table.game + '_action', table, action: 'discard',
      windowId: own.windowId, tile, requestId: 'mahjong-discard' };
    const reply = await post(players[dealer].token, discard);
    expect(reply.status).toBe(200);
    expect(reply.body.table.seats[dealer].river).toEqual([{ tile, order: 1 }]);
    const observed = await read(spectator);
    expect(observed.table.seats[dealer].river).toEqual([{ tile, order: 1 }]);
    expect(observed.tablePrivate).toBeNull();
    const spectatorEvents = await fetch(app!.url + '/v1/rooms/lobby/room', {
      headers: { authorization: 'Bearer ' + spectator.token },
    }).then(res => res.json()) as { events: Array<{ type: string }> };
    expect(spectatorEvents.events.some(event => event.type === 'parlor.table.turn')).toBe(false);
  });

  it('中国象棋从目录开桌，只有执棋方能收到提示和合法走法', async () => {
    const clock = { now: Date.now() };
    const [a, b, spectator] = await start(clock);
    const catalog = await a.client.games(a.token, { op: 'list' }, 'lobby');
    expect(catalog.games).toContainEqual(expect.objectContaining({ id: 'xiangqi', label: '中国象棋' }));
    const info = await a.client.games(a.token, { op: 'describe', game: 'xiangqi' }, 'lobby');
    expect(info.game).toMatchObject({ revisionMode: 'strict', actions: [{ action: 'move' }, { action: 'move_hint' }, { action: 'resign' }] });
    const opened = await a.client.action(a.token, { type: 'table_open', game: 'xiangqi', requestId: 'xiangqi-open' }, 'lobby');
    const table = opened.tableId!;
    await b.client.action(b.token, { type: 'table_join', table, requestId: 'xiangqi-join' }, 'lobby');
    await a.client.action(a.token, { type: 'table_start', table, requestId: 'xiangqi-start' }, 'lobby');

    const read = async (player: typeof a) => await player.client.games(player.token, { op: 'state', table }, 'lobby') as Record<string, any>;
    const [first, second] = await Promise.all([read(a), read(b)]);
    const [red, black, state] = first.tablePrivate.canAct ? [a, b, first] : [b, a, second];
    const watching = await read(spectator);
    expect(watching.table.board).toEqual(state.table.board);
    expect(watching.table.hints).toBeUndefined();
    expect(watching.tablePrivate).toBeNull();
    expect(state.tablePrivate.hints).toHaveLength(3);
    expect(state.tablePrivate.text).toContain('建议走法');
    for (const path of ['room', `table?table=${table}`]) {
      const url = `${app!.url}/v1/rooms/lobby/${path}`;
      const get = (encoding: string) => fetch(url, { headers: { authorization: `Bearer ${red.token}`, 'accept-encoding': encoding } });
      const plain = await get('identity');
      const gzip = await get('gzip');
      expect(plain.headers.get('content-encoding')).toBeNull();
      expect(gzip.headers.get('content-encoding')).toBe('gzip');
      expect(gzip.headers.get('vary')).toBe('accept-encoding');
      expect(await gzip.json()).toEqual(await plain.json());
    }
    expect(state.availableActions.map((entry: { action: string }) => entry.action)).toEqual(['move', 'move_hint', 'resign']);
    const { from, to } = state.tablePrivate.hints[0];
    const body = {
      type: 'game_action', table, action: 'move_hint', params: { hint: 1 },
      revision: state.table.revision, requestId: 'xiangqi-move',
    };
    const incomplete = await post(red.token, { ...body, action: 'move', params: { from } });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.code).toBe('xiangqi_move_rejected');
    expect((await post(red.token, { ...body, revision: body.revision - 1 })).status).toBe(409);
    expect((await post(spectator.token, body)).status).toBe(403);
    clock.now += 2500;
    const invalid = await post(red.token, { ...body, action: 'move', params: { from: { row: 9, col: 1 }, to: { row: 8, col: 3 } } });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ code: 'xiangqi_move_rejected', error: expect.stringMatching(/马腿被挡.*还剩 58 秒/) });
    const recovery = JSON.parse(invalid.body.error.match(/parlor_game_action (\{.*\})。换一手/u)?.[1] ?? '{}');
    expect(recovery).toEqual({ table, revision: body.revision, action: 'move', params: { from, to } });
    expect((await read(red)).table.revision).toBe(body.revision);
    const recovered = { ...body, ...recovery, requestId: 'xiangqi-recovery' };
    const moved = await post(red.token, recovered);
    expect(moved.status).toBe(200);
    expect((await post(red.token, recovered)).body).toEqual(moved.body);
    expect((await read(red)).tablePrivate.hints).toBeUndefined();
    const reply = await read(black);
    expect(reply.table.last).toMatchObject({ from, to });
    expect(reply.tablePrivate.hints).toHaveLength(3);
    expect((await post(red.token, { ...body, ...recovery, requestId: 'expired-recovery' })).status).toBe(409);
    const hint = { ...body, revision: reply.table.revision, params: { hint: 2 } };
    const hinted = await post(black.token, hint);
    expect(hinted.status).toBe(200);
    expect((await post(black.token, hint)).body).toEqual(hinted.body);
    const [expected, redTurn] = [reply.tablePrivate.hints[1], (await read(red)).table];
    expect(redTurn.last).toMatchObject({ from: expected.from, to: expected.to });
    expect((await post(red.token, { ...body, action: 'resign', params: {}, revision: redTurn.revision, requestId: 'xiangqi-resign' })).status).toBe(200);
    expect((await read(spectator)).table).toMatchObject({ status: 'ended', cause: 'resign', winner: reply.table.turn });
  });

  it('认证后可发现目录和参数；别的客厅不能复用席位令牌', async () => {
    const [a] = await start();
    const unauthorized = await fetch(`${app!.url}/v1/games`);
    expect(unauthorized.status).toBe(401);
    const catalog = await a.client.games(a.token, { op: 'list' }, 'lobby');
    expect(catalog.protocol).toBe('parlor.game.v1');
    expect(catalog.games).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'gomoku' })]));
    const desc = await a.client.games(a.token, { op: 'describe', game: 'gomoku' }, 'lobby');
    expect(desc.game).toMatchObject({
      id: 'gomoku',
      revisionMode: 'strict',
      actions: [
        {
          action: 'place',
          parameters: {
            additionalProperties: false,
            properties: {
              row: { type: 'integer', minimum: 0, maximum: 14 },
              col: { type: 'integer', minimum: 0, maximum: 14 },
            },
          },
        },
        { action: 'resign' },
      ],
    });
    await expect(a.client.games(a.token, { op: 'describe', game: 'nope' }, 'lobby')).rejects.toMatchObject({ status: 404 });
    const room = (await a.client.createRoom({ name: '另一个客厅', visibility: 'public' }, a.token)).room;
    await expect(a.client.games(a.token, { op: 'state' }, room.id)).rejects.toMatchObject({ status: 401 });
  });

  it('通用落子保留幂等与版本锁，旧动作接口可与通用接口混用', async () => {
    const [a, b, c] = await start();
    const opened = await a.client.action(a.token, { type: 'table_open', game: 'gomoku', requestId: 'open' }, 'lobby');
    const table = opened.tableId!;
    await b.client.action(b.token, { type: 'table_join', table, requestId: 'join' }, 'lobby');
    await a.client.action(a.token, { type: 'table_start', table, requestId: 'start' }, 'lobby');
    const read = async (player: typeof a) =>
      await player.client.games(player.token, { op: 'state', table }, 'lobby') as Record<string, any>;
    const [aState, bState] = await Promise.all([read(a), read(b)]);
    const [black, white, state] = aState.tablePrivate.canAct ? [a, b, aState] : [b, a, bState];
    expect(state.availableActions).toMatchObject([{ action: 'place' }, { action: 'resign' }]);
    expect(state.game.actions).toBeUndefined();
    expect(state.tables[0].board).toBeUndefined();
    const body = { type: 'game_action', table, action: 'place', params: { row: 7, col: 7 }, requestId: 'place', revision: state.table.revision };
    expect((await post(black.token, { ...body, revision: body.revision - 1 })).status).toBe(409);
    expect((await post(black.token, { ...body, revision: undefined })).status).toBe(400);
    for (const params of [{ row: '7', col: 7 }, { row: 99, col: 7 }, { row: 7 }, { row: 7, col: 7, player_id: 'other' }]) {
      expect((await post(black.token, { ...body, params })).status).toBe(400);
    }
    expect((await post(black.token, { ...body, player_id: 'other' })).status).toBe(400);
    expect((await post(black.token, { ...body, requestId: '' })).status).toBe(400);
    expect((await post(c.token, body)).status).toBe(403);
    const first = await post(black.token, body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ protocol: 'parlor.game.v1', tableId: table, requestId: 'place', revision: body.revision + 1 });
    expect(first.body.table).toBeUndefined();
    expect(first.body.tablePrivate).toBeUndefined();
    expect((await post(black.token, body)).body).toEqual(first.body);
    expect((await post(black.token, { ...body, params: { row: 6, col: 6 } })).status).toBe(409);
    expect((await post(white.token, { ...body, requestId: 'stale-white', params: { row: 8, col: 8 } })).status).toBe(409);
    const whiteState = await read(white);
    await white.client.action(white.token, { type: 'gomoku_action', table, row: 8, col: 8, revision: whiteState.table.revision, requestId: 'legacy-white' }, 'lobby');
    const after = await read(black);
    expect(after.table.revision).toBe(body.revision + 2);
    expect(after.availableActions).toMatchObject([{ action: 'place' }, { action: 'resign' }]);
  });

  it('暗骰只给本人；查看别桌不会夹带本人原桌的暗骰', async () => {
    const [a, b, c] = await start();
    const first = await a.client.action(a.token, { type: 'table_open', game: 'dice', requestId: 'dice-open' }, 'lobby');
    await b.client.action(b.token, { type: 'table_join', table: first.tableId, requestId: 'dice-join' }, 'lobby');
    await a.client.action(a.token, { type: 'table_start', table: first.tableId, requestId: 'dice-start' }, 'lobby');
    const other = await c.client.action(c.token, { type: 'table_open', game: 'gomoku', requestId: 'other-open' }, 'lobby');
    const own = await a.client.games(a.token, { op: 'state', table: first.tableId }, 'lobby') as Record<string, any>;
    expect(own.tablePrivate.dice).toHaveLength(2);
    expect(own.availableActions.map((entry: { action: string }) => entry.action)).toEqual(['roll', 'stand']);
    const spectator = await c.client.games(c.token, { op: 'state', table: first.tableId }, 'lobby');
    expect(spectator).toMatchObject({ tablePrivate: null, availableActions: [] });
    const elsewhere = await a.client.games(a.token, { op: 'state', table: other.tableId }, 'lobby');
    expect(elsewhere).toMatchObject({ tablePrivate: null, availableActions: [] });
    await expect(a.client.games(a.token, { op: 'state', table: 'no-such-table' }, 'lobby')).rejects.toMatchObject({ status: 404 });
  });

  it('狼人杀通用动作保留窗口校验，不要求整桌 revision，历史沿用权限投影', async () => {
    const clock = { now: 1_770_000_000_000 };
    const players = await start(clock);
    for (const suffix of ['d', 'e', 'f']) {
      const client = new ParlorClient(app!.url, { cooId: `coo-generic-${suffix}`, cooSecret: `secret-generic-${suffix}-0123456789` });
      players.push({ client, token: (await client.join('inv', { name: suffix }, 'lobby')).token });
    }
    const a = players[0];
    const opened = await a.client.action(a.token, { type: 'table_open', game: 'werewolf', seatCount: 6, requestId: 'wolf-open' }, 'lobby');
    const table = opened.tableId!;
    for (const [index, player] of players.slice(1).entries()) {
      await player.client.action(player.token, { type: 'table_join', table, requestId: `wolf-join-${index}` }, 'lobby');
    }
    await a.client.action(a.token, { type: 'table_start', table, requestId: 'wolf-start' }, 'lobby');
    clock.now += 20_000;
    let actor: { token: string; state: Record<string, any> } | undefined;
    for (let attempt = 0; attempt < 60 && !actor; attempt++) {
      for (const player of players) {
        const state = await player.client.games(player.token, { op: 'state', table }, 'lobby') as Record<string, any>;
        if (state.availableActions.some((entry: { action: string }) => entry.action === 'inspect')) {
          actor = { token: player.token, state };
          break;
        }
      }
      if (!actor) await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(actor).toBeDefined();
    const available = actor!.state.availableActions[0];
    const target = actor!.state.tablePrivate.seatNo === 1 ? 2 : 1;
    const params = { ...available.defaults, target };
    const body = { type: 'game_action', table, action: available.action, params, requestId: 'wolf-generic' };
    expect((await post(actor!.token, { ...body, params: { ...params, windowId: 'stale-window' } })).status).toBe(409);
    const acted = await post(actor!.token, body);
    expect(acted.status).toBe(200);
    expect(acted.body).toMatchObject({ windowId: params.windowId, requestId: 'wolf-generic' });
    expect(acted.body.inspection).toEqual({ day: 1, target, result: expect.stringMatching(/^(wolf|good)$/) });
    expect(acted.body.tablePrivate).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(acted.body))).toBeLessThan(1024);
    expect((await post(actor!.token, body)).body).toEqual(acted.body);
    const history = await a.client.games(a.token, { op: 'history', table }, 'lobby') as Record<string, any>;
    expect(history.log.nights).toBeUndefined();
    const review = await a.client.games(a.token, { op: 'history', table, review: true }, 'lobby') as Record<string, any>;
    expect(review.log.nights).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(review))).toBeLessThanOrEqual(GAME_RESPONSE_MAX_BYTES);
    await expect(a.client.games(a.token, { op: 'history', table, cursor: 'nights:0' }, 'lobby'))
      .rejects.toMatchObject({ status: 400 });
  });
});
