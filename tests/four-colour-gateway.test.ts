import { afterEach, expect, it, vi } from 'vitest';
import { ParlorClient } from '../src/room/client.ts';
import { FourColourTable } from '../src/room/games/four-colour-table.ts';
import { gameById } from '../src/room/games/registry.ts';
import { WorldServer } from '../src/room/world-server.ts';
import { pgServerStorage } from './helpers/pg.ts';

let app: WorldServer | undefined;
afterEach(async () => { vi.restoreAllMocks(); await app?.close(); });

it('四彩牌从目录开桌，私有发牌和桌聊遵守席位范围，出牌受版本和幂等保护', async () => {
  vi.spyOn(gameById('four-colour')!, 'create')
    .mockImplementation(({ host, turnMs }) => new FourColourTable(host, turnMs, () => 0));
  app = await WorldServer.create({ ...await pgServerStorage(':memory:'), port: 0, inviteCode: 'inv' });
  await app.listen();
  const room = 'lobby';
  const [a, b, observer] = await Promise.all(['a', 'b', 'observer'].map(async name => {
    const client = new ParlorClient(app!.url, { cooId: `coo-colour-${name}`, cooSecret: `colour-${name}-0123456789-abcdef` });
    return { client, token: (await client.join('inv', { name }, room)).token };
  }));
  const catalog = await a.client.games(a.token, { op: 'list' }, room);
  expect(catalog.games).toContainEqual(expect.objectContaining({ id: 'four-colour' }));
  const opened = await a.client.action(a.token, { type: 'table_open', game: 'four-colour', requestId: 'open' }, room);
  const table = opened.tableId!;
  await b.client.action(b.token, { type: 'table_join', table, requestId: 'join' }, room);
  await a.client.action(a.token, { type: 'table_start', table, requestId: 'start' }, room);

  const read = (player: typeof a) => player.client.games(player.token, { op: 'state', table }, room);
  const initial = await read(a);
  const other = await read(b);
  expect(initial.table).toMatchObject({ capacity: 4, seats: [{ count: 7 }, { count: 7 }] });
  const firstHand = (initial.tablePrivate as ReturnType<FourColourTable['view']>)?.hand;
  const secondHand = (other.tablePrivate as ReturnType<FourColourTable['view']>)?.hand;
  expect(firstHand).toHaveLength(7);
  expect(secondHand).toHaveLength(7);
  expect(secondHand).not.toEqual(firstHand);
  expect(await read(observer)).toMatchObject({ tablePrivate: null, availableActions: [] });

  await a.client.action(a.token, { type: 'table_say', text: '好牌！' }, room);
  expect((await b.client.snapshot(b.token, 0, 50, room)).events.some(event => event.text === '好牌！')).toBe(true);
  expect((await observer.client.snapshot(observer.token, 0, 50, room)).events.some(event => event.text === '好牌！')).toBe(false);

  const revision = (initial.table as { revision: number }).revision;
  const move = { type: 'game_action', action: 'play', params: { card: 102, colour: 'green' }, table, requestId: 'play', revision };
  const post = async (body: unknown, token = a.token) => {
    const response = await fetch(`${app!.url}/v1/rooms/${room}/action`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  expect((await post(move, observer.token)).status).toBe(403);
  expect((await post({ ...move, revision: revision - 1 })).status).toBe(409);
  const played = await post(move);
  expect(played.status).toBe(200);
  expect(await post(move)).toEqual(played);
  expect((await read(observer)).table).toMatchObject({ colour: 'green', seats: [{ count: 6 }, { count: 7 }] });
});
