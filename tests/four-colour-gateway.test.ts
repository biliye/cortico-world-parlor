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

it('手动喊牌从通用游戏动作可用，仅同桌可抓漏喊且罚摸的牌只发给本人', async () => {
  vi.spyOn(gameById('four-colour')!, 'create')
    .mockImplementation(({ host, turnMs }) => new FourColourTable(host, turnMs, () => 0));
  const originalStart = FourColourTable.prototype.start;
  vi.spyOn(FourColourTable.prototype, 'start').mockImplementation(function (this: FourColourTable, ...args) {
    const step = originalStart.apply(this, args);
    const state = this.exportState() as { players: Array<{ hand: number[] }>; stock: number[]; discard: number[]; colour: string };
    state.players[0].hand = [1, 2];
    state.players[1].hand = [3, 4];
    state.discard = [0];
    state.colour = 'red';
    state.stock = Array.from({ length: 103 }, (_, index) => index + 5);
    this.restoreState(state);
    return step;
  });
  app = await WorldServer.create({ ...await pgServerStorage(':memory:'), port: 0, inviteCode: 'inv' });
  await app.listen();
  const room = 'lobby';
  const [a, b, observer] = await Promise.all(['a', 'b', 'observer'].map(async name => {
    const client = new ParlorClient(app!.url, { cooId: `coo-call-${name}`, cooSecret: `colour-call-${name}-0123456789` });
    return { client, token: (await client.join('inv', { name }, room)).token };
  }));
  const { tableId: table } = await a.client.action(a.token, { type: 'table_open', game: 'four-colour', requestId: 'open' }, room);
  await b.client.action(b.token, { type: 'table_join', table, requestId: 'join' }, room);
  const post = async (token: string, body: Record<string, unknown>) => {
    const response = await fetch(`${app!.url}/v1/rooms/${room}/action`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ table, ...body }),
    });
    return { status: response.status, body: await response.json() };
  };
  const start = { type: 'table_start', requestId: 'start', callLastCard: true };
  expect((await post(b.token, start)).status).toBe(403);
  const started = await post(a.token, start);
  expect(started.status).toBe(200);
  expect(await post(a.token, start)).toMatchObject({ status: 200, body: { revision: started.body.revision, seq: started.body.seq } });
  expect((await post(a.token, { ...start, callLastCard: false })).status).toBe(409);

  const read = (player: typeof a) => player.client.games(player.token, { op: 'state', table }, room);
  const initial = await read(a);
  expect(initial.table).toMatchObject({ callLastCard: true });
  const revision = (initial.table as { revision: number }).revision;
  const action = (name: string, requestId: string, rev: number, params = {}) => ({
    type: 'game_action', action: name, params, requestId, revision: rev,
  });
  expect((await post(a.token, action('play', 'play', revision, { card: 1 }))).status).toBe(200);
  const caller = await read(a);
  const catcher = await read(b);
  expect(caller).toMatchObject({ availableActions: [{ action: 'call' }], tablePrivate: { hand: [{ id: 2 }], yourTurn: false } });
  expect(catcher).toMatchObject({ availableActions: [{ action: 'catch' }], tablePrivate: { hand: [{ id: 3 }, { id: 4 }], yourTurn: false } });
  expect(await read(observer)).toMatchObject({ tablePrivate: null, availableActions: [] });
  const catchRevision = (catcher.table as { revision: number }).revision;
  expect((await post(observer.token, action('catch', 'spectator', catchRevision))).status).toBe(403);
  expect((await post(b.token, action('catch', 'stale', revision))).status).toBe(409);
  const caught = await post(b.token, action('catch', 'catch', catchRevision));
  expect(caught.status).toBe(200);
  expect(await post(b.token, action('catch', 'catch', catchRevision))).toEqual(caught);
  const final = await read(a);
  expect(final.tablePrivate).toMatchObject({ hand: [{ id: 2 }, { id: 107 }, { id: 106 }] });
  expect((await read(b)).tablePrivate).toMatchObject({ hand: [{ id: 3 }, { id: 4 }] });
});
