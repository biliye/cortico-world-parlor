import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { PARLOR } from '../src/definition.ts';
import { ParlorClient } from '../src/room/client.ts';
import { EventDb } from '../src/room/event-db.ts';
import { REPLAY_RETENTION_MS } from '../src/room/replay.ts';
import { PgDb } from '../src/room/storage/postgres.ts';
import { GAME_RESPONSE_MAX_BYTES } from '../src/room/table-engine.ts';
import { WorldServer } from '../src/room/world-server.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { pgServerStorage } from './helpers/pg.ts';

it('Coo 回看已结算斗地主，分页、授权、重启与留存边界沿用真实 PG 数据', async () => {
  const scratchDir = mkdtempSync(join(tmpdir(), 'parlor-table-replay-'));
  const storage = await pgServerStorage(join(scratchDir, 'db'));
  const clock = { now: Date.now() };
  const options = { ...storage, port: 0, inviteCode: 'inv', allowGuestJoin: true, now: () => clock.now };
  let server = await WorldServer.create(options);
  await server.listen();
  const secrets: Record<string, string> = { PARLOR_INVITE_CODE: 'inv', PARLOR_ALLOW_GUEST_JOIN: '1' };
  const ctx = fakeWorldContext(PARLOR, { scratchDir });
  ctx.cfg.serverUrl = ctx.cfg.identityUrl = server.url;
  ctx.cfg.room = 'lobby';
  ctx.cfg.seatName = '复盘玩家';
  const world = PARLOR.create({ ...ctx, secret: name => secrets[name] ?? '', storeSecret: (name, value) => { secrets[name] = value; } });
  const cooGames = async (args: Record<string, unknown>) => {
    const result = await world.tools().find(tool => tool.name === 'parlor_game_info')!.handler(args, {} as never);
    if (typeof result !== 'string') throw new Error(result.text);
    return JSON.parse(result) as Record<string, any>;
  };

  try {
    await world.start(new FakeHost());
    const a = { client: new ParlorClient(server.url), token: secrets.PARLOR_SEAT_TOKEN };
    const [b, c, watcher] = await Promise.all(['bob', 'carol', 'watcher'].map(async name => {
      const client = new ParlorClient(server.url, { cooId: `coo-replay-${name}`, cooSecret: `secret-replay-${name}-0123456789` });
      const joined = await client.join('inv', { name }, 'lobby');
      return { client, token: joined.token };
    }));
    const send = (player: typeof a, body: Parameters<ParlorClient['action']>[1]) => player.client.action(player.token, body, 'lobby');
    const table = (await send(a, { type: 'table_open', game: 'ddz', requestId: 'ddz-open' })).tableId!;
    await send(watcher, { type: 'table_join', table, requestId: 'waiting-join' });
    await send(watcher, { type: 'table_leave', table, requestId: 'waiting-leave' });
    await send(b, { type: 'table_join', table, requestId: 'ddz-join-b' });
    await send(c, { type: 'table_join', table, requestId: 'ddz-join-c' });
    const startedAt = clock.now;
    await send(a, { type: 'table_start', table, requestId: 'ddz-start' });
    await expect(a.client.games(a.token, { op: 'replay', table }, 'lobby')).rejects.toMatchObject({ status: 409 });
    expect((await cooGames({ op: 'replay' })).replays).toEqual([]);

    const state = async (player: typeof a) => await player.client.games(player.token, { op: 'state', table }, 'lobby') as Record<string, any>;
    const act = async (player: typeof a, action: string, params: Record<string, unknown>, id: string) => {
      const view = await state(player);
      await send(player, { type: 'game_action', table, action, params, requestId: id, revision: view.table.revision });
    };
    await act(a, 'bid', { call: true }, 'ddz-bid');
    await send(watcher, { type: 'say', text: '无关的房间聊天' });
    const second = (await send(watcher, { type: 'table_open', game: 'dice', requestId: 'other-table' })).tableId!;
    for (let play = 1; play <= 20; play++) {
      clock.now += 10;
      const hand = (await state(a)).tablePrivate.hand;
      if (hand.length === 1) {
        const db = await PgDb.open({ url: storage.databaseUrl! });
        try {
          const events = new EventDb(db);
          for (let index = 0; index < 40; index++) {
            await events.append('lobby', { type: 'parlor.table.action', scope: { kind: 'room' }, from: 'system',
              ts: clock.now, text: '鲸'.repeat(180), data: { tableId: table } });
          }
        } finally { await db.close(); }
      }
      await act(a, 'play', { cards: [hand[0]] }, `play-${play}`);
      if (hand.length === 1) break;
      await act(b, 'pass', {}, `pass-b-${play}`);
      await act(c, 'pass', {}, `pass-c-${play}`);
    }
    const endedAt = clock.now;
    expect((await cooGames({ op: 'replay' })).replays).toEqual([
      expect.objectContaining({ tableId: table, game: 'ddz', status: 'ended', startedAt, endedAt }),
    ]);
    expect((await watcher.client.games(watcher.token, { op: 'replay' }, 'lobby')).replays).toEqual([]);
    await expect(watcher.client.games(watcher.token, { op: 'replay', table }, 'lobby')).rejects.toMatchObject({ status: 404 });

    const all = [];
    let before: number | undefined;
    for (let pageIndex = 0; pageIndex < 12; pageIndex++) {
      const page = await cooGames({ op: 'replay', table, limit: 50, ...(before === undefined ? {} : { before }) });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(GAME_RESPONSE_MAX_BYTES);
      expect(page.steps.length).toBeLessThanOrEqual(50);
      if (pageIndex === 0) expect(page.steps.length).toBeLessThan(50); // byte budget, not just page count
      expect(JSON.stringify(page.steps)).not.toMatch(/无关的房间聊天|骰子|"hand"|"snapshot"/);
      all.unshift(...page.steps);
      if (!page.older) break;
      expect(page.nextBefore).toBe(page.steps[0].seq);
      before = page.nextBefore;
    }
    expect(all.map(step => step.seq)).toEqual([...new Set(all.map(step => step.seq))].sort((left, right) => left - right));
    expect(all.some(step => step.type === 'parlor.table.start')).toBe(true);
    expect(all.at(-1)?.type).toBe('parlor.table.end');
    const own = all.find(step => step.hasSnapshot)!;
    expect(own.text).toBe('本人行动记录');
    const step = await cooGames({ op: 'replayStep', table, seq: own.seq });
    expect(step.snapshot).toMatchObject({ tableId: table, revision: own.revision, hand: expect.any(Array) });
    for (const player of [b, watcher]) {
      await expect(player.client.games(player.token, { op: 'replayStep', table, seq: own.seq }, 'lobby')).rejects.toMatchObject({ status: 404 });
    }
    await expect(a.client.games(a.token, { op: 'replayStep', table, seq: 2147483648 }, 'lobby')).rejects.toMatchObject({ status: 400 });

    await world.stop();
    clock.now += 10;
    await send(a, { type: 'table_join', table: second, requestId: 'other-join' });
    await send(watcher, { type: 'table_start', table: second, requestId: 'other-start' });
    await server.close();
    clock.now += 31 * 60_000;
    server = await WorldServer.create(options);
    await server.listen();
    const restarted = new ParlorClient(server.url);
    const room = (await restarted.createRoom({ name: '换厅回看', visibility: 'public' }, a.token)).room.id;
    const moved = await restarted.switchTo(a.token, 'lobby', room);
    const list = await restarted.games(moved.token, { op: 'replay' }, room);
    expect(list.replays).toEqual([
      expect.objectContaining({ tableId: second, status: 'abandoned' }),
      expect.objectContaining({ tableId: table, status: 'ended' }),
    ]);
    const aborted = await restarted.games(moved.token, { op: 'replay', table: second }, room);
    expect(aborted.table).toMatchObject({ status: 'abandoned' });
    await expect(restarted.games(moved.token, { op: 'replayStep', table: second, seq: own.seq }, room)).rejects.toMatchObject({ status: 404 });
    const old = await restarted.games(moved.token, { op: 'replayStep', table, seq: own.seq }, room);
    expect(old.snapshot).toEqual(step.snapshot);

    clock.now = endedAt + REPLAY_RETENTION_MS + 1;
    await expect(restarted.games(moved.token, { op: 'replay', table }, room)).rejects.toMatchObject({ status: 410, message: expect.stringContaining('7 天') });
  } finally {
    await world.stop();
    await server.close();
  }
}, 45_000);
