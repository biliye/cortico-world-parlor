import { afterEach, describe, expect, it } from 'vitest';
import { WorldServer } from '../src/room/world-server.ts';
import { ParlorClient } from '../src/room/client.ts';
import { GAME_RESPONSE_MAX_BYTES } from '../src/room/table-engine.ts';
import { pgServerStorage } from './helpers/pg.ts';

let app: WorldServer | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function start(clock?: { now: number }) {
  app = await WorldServer.create({ ...(await pgServerStorage(':memory:')), port: 0,
    inviteCode: 'inv', ...(clock ? { now: () => clock.now } : {}),
  });
  await app.listen();
  const players = await Promise.all(['a', 'b', 'c'].map(async suffix => {
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
  it('中国象棋从目录开桌，只有执棋方能收到提示和合法走法', async () => {
    const [a, b, spectator] = await start();
    const catalog = await a.client.games(a.token, { op: 'list' }, 'lobby');
    expect(catalog.games).toContainEqual(expect.objectContaining({ id: 'xiangqi', label: '中国象棋' }));
    const info = await a.client.games(a.token, { op: 'describe', game: 'xiangqi' }, 'lobby');
    expect(info.game).toMatchObject({ revisionMode: 'strict', actions: [{ action: 'move' }, { action: 'resign' }] });
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
    expect(state.availableActions.map((entry: { action: string }) => entry.action)).toEqual(['move', 'resign']);
    const { from, to } = state.tablePrivate.hints[0];
    const body = {
      type: 'game_action', table, action: 'move', params: { from, to },
      revision: state.table.revision, requestId: 'xiangqi-move',
    };
    expect((await post(red.token, { ...body, params: { from } })).status).toBe(400);
    expect((await post(red.token, { ...body, revision: body.revision - 1 })).status).toBe(409);
    expect((await post(spectator.token, body)).status).toBe(403);
    const moved = await post(red.token, body);
    expect(moved.status).toBe(200);
    expect((await post(red.token, body)).body).toEqual(moved.body);
    expect((await read(red)).tablePrivate.hints).toBeUndefined();
    const reply = await read(black);
    expect(reply.table.last).toMatchObject({ from, to });
    expect(reply.tablePrivate.hints).toHaveLength(3);
    expect((await post(black.token, { ...body, action: 'resign', params: {}, revision: reply.table.revision, requestId: 'xiangqi-resign' })).status).toBe(200);
    expect((await read(spectator)).table).toMatchObject({ status: 'ended', cause: 'resign', winner: state.table.turn });
  });

  it('认证后可发现目录和参数；别的客厅不能复用席位令牌', async () => {
    const [a] = await start();
    const unauthorized = await fetch(`${app!.url}/v1/games`);
    expect(unauthorized.status).toBe(401);
    const catalog = await a.client.games(a.token, { op: 'list' }, 'lobby');
    expect(catalog.protocol).toBe('parlor.game.v1');
    expect(catalog.games).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'gomoku' })]));
    const desc = await a.client.games(a.token, { op: 'describe', game: 'gomoku' }, 'lobby');
    expect(desc.game).toMatchObject({ id: 'gomoku', revisionMode: 'strict', actions: [{ action: 'place', parameters: { required: ['row', 'col'] } }] });
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
    const state = await a.client.games(a.token, { op: 'state' }, 'lobby') as Record<string, any>;
    expect(state.availableActions).toMatchObject([{ action: 'place' }]);
    expect(state.game.actions).toBeUndefined();
    expect(state.tables[0].board).toBeUndefined();
    const body = { type: 'game_action', table, action: 'place', params: { row: 7, col: 7 }, requestId: 'place', revision: state.table.revision };
    expect((await post(a.token, { ...body, revision: body.revision - 1 })).status).toBe(409);
    expect((await post(a.token, { ...body, revision: undefined })).status).toBe(400);
    for (const params of [{ row: '7', col: 7 }, { row: 99, col: 7 }, { row: 7 }, { row: 7, col: 7, player_id: 'other' }]) {
      expect((await post(a.token, { ...body, params })).status).toBe(400);
    }
    expect((await post(a.token, { ...body, player_id: 'other' })).status).toBe(400);
    expect((await post(a.token, { ...body, requestId: '' })).status).toBe(400);
    expect((await post(c.token, body)).status).toBe(403);
    const first = await post(a.token, body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ protocol: 'parlor.game.v1', tableId: table, requestId: 'place', revision: body.revision + 1 });
    expect(first.body.table).toBeUndefined();
    expect(first.body.tablePrivate).toBeUndefined();
    expect((await post(a.token, body)).body).toEqual(first.body);
    expect((await post(a.token, { ...body, params: { row: 6, col: 6 } })).status).toBe(409);
    expect((await post(b.token, { ...body, requestId: 'stale-white', params: { row: 8, col: 8 } })).status).toBe(409);
    const white = await b.client.games(b.token, { op: 'state', table }, 'lobby') as Record<string, any>;
    await b.client.action(b.token, { type: 'gomoku_action', table, row: 8, col: 8, revision: white.table.revision, requestId: 'legacy-white' }, 'lobby');
    const after = await a.client.games(a.token, { op: 'state', table }, 'lobby') as Record<string, any>;
    expect(after.table.revision).toBe(body.revision + 2);
    expect(after.availableActions).toMatchObject([{ action: 'place' }]);
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
