import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorldServer } from '../src/room/world-server.ts';
import { ParlorClient } from '../src/room/client.ts';
import { AeroplaneTable } from '../src/room/games/aeroplane-table.ts';
import { gameById } from '../src/room/games/registry.ts';
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

describe('飞行棋 HTTP 网关（真实 PG）', () => {
  it('飞行棋两人开桌，掷骰与选飞机共用严格版本和幂等回执', async () => {
    const create = vi.spyOn(gameById('aeroplane')!, 'create').mockImplementation(({ host, turnMs }) =>
      new AeroplaneTable({ host, turnMs, rollDie: () => 6, firstSeat: () => 0 }));
    try {
      const [a, b, spectator] = await start();
      const catalog = await a.client.games(a.token, { op: 'list' }, 'lobby');
      expect(catalog.games).toContainEqual(expect.objectContaining({ id: 'aeroplane', label: '飞行棋' }));
      const opened = await a.client.action(a.token, { type: 'table_open', game: 'aeroplane', requestId: 'flight-open' }, 'lobby');
      const table = opened.tableId!;
      await b.client.action(b.token, { type: 'table_join', table, requestId: 'flight-join' }, 'lobby');
      await a.client.action(a.token, { type: 'table_start', table, requestId: 'flight-start' }, 'lobby');
      const read = (player: typeof a) => player.client.games(player.token, { op: 'state', table }, 'lobby') as Promise<Record<string, any>>;
      const initial = await read(a);
      expect(initial.table).toMatchObject({ capacity: 4, phase: 'await_roll', seats: [{ planes: [-1, -1, -1, -1] }, { planes: [-1, -1, -1, -1] }] });
      expect(initial.availableActions).toMatchObject([{ action: 'roll' }]);

      const roll = { type: 'game_action', action: 'roll', params: {}, table, requestId: 'flight-roll', revision: initial.table.revision };
      expect((await post(spectator.token, roll)).status).toBe(403);
      const rolled = await post(a.token, roll);
      expect(rolled.status).toBe(200);
      expect((await post(a.token, roll)).body).toEqual(rolled.body);
      const choice = await read(a);
      expect(choice).toMatchObject({ table: { phase: 'await_move', die: 6 }, availableActions: [{ action: 'move' }] });
      expect(choice.tablePrivate.moves.map((move: { plane: number }) => move.plane)).toEqual([1, 2, 3, 4]);
      expect(await read(spectator)).toMatchObject({ table: { die: 6 }, tablePrivate: null, availableActions: [] });

      const move = { type: 'aeroplane_action', action: 'move', plane: 2, table, requestId: 'flight-move', revision: choice.table.revision };
      expect((await post(a.token, { ...move, revision: initial.table.revision })).status).toBe(409);
      expect((await post(a.token, move)).status).toBe(200);
      const after = await read(a);
      expect(after.table).toMatchObject({ phase: 'await_roll', revision: choice.table.revision + 1 });
      expect(after.table.seats[0].planes).toEqual([-1, 0, -1, -1]);
      expect(after.availableActions).toMatchObject([{ action: 'roll' }]);
    } finally {
      create.mockRestore();
    }
  });
});
