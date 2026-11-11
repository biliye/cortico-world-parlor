import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ParlorClient } from '../src/room/client.ts';
import { GAME_LIST } from '../src/room/games/registry.ts';
import type { RatingBoard } from '../src/room/ratings/types.ts';
import { PgDb } from '../src/room/storage/postgres.ts';
import { WorldServer } from '../src/room/world-server.ts';
import { pgServerStorage } from './helpers/pg.ts';

type TableAction = Extract<Parameters<ParlorClient['action']>[1], {
  type: 'table_open' | 'table_join' | 'table_leave' | 'table_start' | 'game_action';
}>;

it('逐席结算随牌桌事务持久化，榜单跨厅、限登录访问并在重启后重建', async () => {
  const storage = await pgServerStorage(mkdtempSync(join(tmpdir(), 'parlor-ratings-')));
  const clock = { now: Date.now() };
  const options = { ...storage, port: 0, inviteCode: 'inv', allowGuestJoin: true, now: () => clock.now };
  let server = await WorldServer.create(options);
  await server.listen();

  try {
    const client = new ParlorClient(server.url);
    const members = await Promise.all(['Alice', 'Bob', 'Visitor'].map(async name => {
      const cooId = `coo-rating-${name.toLowerCase()}`;
      const guest = new ParlorClient(server.url, { cooId, cooSecret: `secret-${name}-01234567890123` });
      const joined = await guest.join('inv', { name }, 'lobby');
      return { token: joined.token, cooId };
    }));
    const [alice, bob, visitor] = members;
    let room = 'lobby';
    const auth = { authorization: `Bearer ${visitor!.token}` };
    const endpoint = (game: string) => `${server.url}/v1/hall/ratings?game=${game}`;
    const catalog = `${server.url}/v1/hall/ratings`;
    expect((await fetch(catalog)).status).toBe(401);
    expect(await (await fetch(catalog, { headers: auth })).json()).toEqual({
      games: GAME_LIST.filter(game => game.rated).map(({ id, label }) => ({ id, label })),
    });
    expect((await fetch(endpoint('gomoku'))).status).toBe(401);
    expect((await fetch(endpoint('monopoly'), { headers: auth })).status).toBe(400);
    for (const game of [undefined, '', ' ']) {
      await expect(client.games(alice!.token, { op: 'ratings', game })).rejects.toThrow('查等级分榜需要 game');
    }
    const read = async (token: string) => await new ParlorClient(server.url)
      .games(token, { op: 'ratings', game: 'gomoku' }) as unknown as RatingBoard;
    expect(await read(alice!.token)).toMatchObject({ since: null, groups: [], mine: { games: 0, rating: null } });

    const send = (player: typeof alice, body: TableAction) =>
      client.action(player!.token, { ...body, requestId: body.requestId ?? randomUUID() }, room);
    const tableIds: string[] = [];
    for (let n = 0; n < 10; n++) {
      if (n === 5) {
        const other = await client.createRoom({ name: '第二个客厅', visibility: 'public' }, alice!.token);
        for (const player of [alice!, bob!]) player.token = (await client.switchTo(player.token, room, other.room.id)).token;
        room = other.room.id;
      }
      const table = (await send(alice, { type: 'table_open', game: 'gomoku' })).tableId!;
      tableIds.push(table);
      if (n === 0) {
        await send(visitor, { type: 'table_join', table });
        await send(visitor, { type: 'table_leave', table });
      }
      await send(bob, { type: 'table_join', table });
      await send(alice, { type: 'table_start', table });
      for (let col = 0; col < 5; col++) {
        const place = async (player: typeof alice, row: number) => {
          const state = await client.games(player!.token, { op: 'state', table }, room);
          const revision = (state.table as { revision: number }).revision;
          const move = {
            type: 'game_action', table, action: 'place', params: { row, col },
            revision, requestId: `gomoku-${n}-${row}-${col}`,
          } as const;
          const result = await send(player, move);
          if (n === 0 && col === 4) expect(await send(player, move)).toEqual(result);
        };
        await place(alice, 0);
        if (col < 4) await place(bob, 1);
      }
      if (n === 0) {
        expect(await read(alice!.token)).toMatchObject({ groups: [], mine: { games: 1, rating: expect.any(Number) } });
      }
    }
    const db = await PgDb.open({ url: storage.databaseUrl! });
    try {
      const seats = await db.prepare('SELECT coo_id, rank FROM table_seat_results WHERE table_id = ? ORDER BY rank')
        .all(tableIds[0]);
      expect(seats).toEqual([{ coo_id: alice!.cooId, rank: 1 }, { coo_id: bob!.cooId, rank: 2 }]);
      const count = await db.prepare('SELECT COUNT(*) AS n FROM table_seat_results').get<{ n: string }>();
      expect(Number(count?.n)).toBe(20);
    } finally {
      await db.close();
    }

    expect(await read(alice!.token)).toMatchObject({ mine: { games: 10, rating: 264.4 } });
    await server.close();
    server = await WorldServer.create(options);
    await server.listen();
    const board = await read(visitor!.token);
    expect(board).toMatchObject({
      minGames: 10, mine: { games: 0, rating: null },
      groups: [{ rows: [
        { name: 'Alice', position: 1, games: 10, rating: 264.4, mine: false },
        { name: 'Bob', position: 2, games: 10, rating: -264.4, mine: false },
      ] }],
    });
    expect(await read(alice!.token)).toMatchObject({ mine: { games: 10, rating: 264.4 } });
    expect(await (await fetch(endpoint('gomoku') + '&limit=1', { headers: auth })).json())
      .toMatchObject({ truncated: true, groups: [{ rows: [{ name: 'Alice' }] }] });
    expect(await (await fetch(endpoint('ddz'), { headers: auth })).json()).toMatchObject({ groups: [], since: null });
  } finally {
    await server.close();
  }
}, 45_000);
