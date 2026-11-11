import { toolForOperation } from './helpers/tool-operations.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { PARLOR } from '../src/definition.ts';
import { ParlorClient, ParlorHttpError } from '../src/room/client.ts';
import { GomokuTable } from '../src/room/games/gomoku-table.ts';
import type { ActionRequest, RoomEvent, RoomSnapshot } from '../src/room/protocol.ts';
import { FakeHost } from './helpers/fake-host.ts';

let scratchDir: string;
let world: ReturnType<typeof PARLOR.create>;
let receive: (event: RoomEvent) => void;
let snapshot: RoomSnapshot;
let seq: number;

const call = async (name: string) => {
  const result = await toolForOperation(world, name)!.handler(
    name === 'parlor_ddz_action' ? { move: 'play', cards: ['3'] } : {}, {} as ToolCallContext,
  );
  return typeof result === 'string' ? result : result.text;
};

const turn = (revision = 8, tableId = 't1') => receive({
  seq: ++seq, ts: Date.now(), from: 'system', type: 'parlor.table.turn',
  scope: { kind: 'seat', seatId: 'mine' }, text: '两家都不要，这一轮你先出。',
  data: { tableId, table: { game: 'ddz', seat: 'mine', tableId, revision, yourTurn: true } },
});

beforeEach(async () => {
  vi.useFakeTimers();
  scratchDir = mkdtempSync(join(tmpdir(), 'parlor-table-revision-'));
  seq = 10;
  const ctx = fakeWorldContext(PARLOR, { scratchDir });
  ctx.cfg.serverUrl = 'http://127.0.0.1:8790';
  ctx.cfg.seatName = '小满';
  ctx.cfg.room = 'lobby';
  ctx.secret = name => name === 'PARLOR_SEAT_TOKEN' ? 'test-seat-token' : 'inv';
  snapshot = {
    id: 'lobby', seat: { id: 'mine', name: '小满', kind: 'pet', tier: 'full', joinedAt: Date.now() },
    seats: [], maxSeats: 30, latest: seq, now: Date.now(), at: '测试时刻', events: [],
    table: { game: 'ddz', label: '斗地主', status: 'playing', host: 'mine', text: '桌面', id: 't1', revision: 7 },
    tablePrivate: { game: 'ddz', seat: 'mine', tableId: 't1', revision: 7, text: '你的牌：3、4。' },
  };
  vi.spyOn(ParlorClient.prototype, 'initializeIdentity').mockResolvedValue(true);
  vi.spyOn(ParlorClient.prototype, 'snapshot').mockImplementation(async () => snapshot);
  vi.spyOn(ParlorClient.prototype, 'stream').mockImplementation(async (_token, _since, onEvent, signal) => {
    receive = onEvent;
    await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
  });
  world = PARLOR.create(ctx);
  await world.start(new FakeHost());
});

afterEach(async () => {
  await world?.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(scratchDir, { recursive: true, force: true });
});

const expectRevision = (revision: number) => vi.spyOn(ParlorClient.prototype, 'action')
  .mockImplementation(async (_token, payload: ActionRequest) => {
    if (!('revision' in payload) || payload.revision !== revision) {
      throw new ParlorHttpError(409, '这一手已经过去了：你看到的是旧桌面，刷新后再来');
    }
    return { ok: true, seq: ++seq, ts: Date.now(), at: '测试时刻', text: '出了牌。' };
  });

describe('World 牌桌版本同步', () => {
  it('五子棋 state 只给一份点阵，旧服务器的通用行动回执也精简', async () => {
    const engine = new GomokuTable({ id: 'mine', name: '小满' }, 60_000, 0);
    engine.join({ id: 'other', name: '对手' });
    engine.start('mine', 1000);
    engine.act('mine', { row: 0, col: 10 }, 1001);
    engine.act('other', { row: 14, col: 14 }, 1001);
    const table = { ...engine.public(), id: 't1', tableId: 't1', revision: 8, label: '五子棋', text: engine.publicText() };
    const tablePrivate = {
      ...engine.view('mine')!, tableId: 't1', revision: 8,
      text: '你执黑。\n...............\n建议：parlor_game_action {action:"place"}',
    };
    const response = { ...snapshot, seq: ++seq, table, tablePrivate, tables: [table, snapshot.table!] };
    const games = vi.spyOn(ParlorClient.prototype, 'games').mockResolvedValue(response);
    const readState = async () => {
      const output = await world.tools().find(tool => tool.name === 'parlor_game_info')!.handler({ op: 'state' }, {} as ToolCallContext);
      return JSON.parse(typeof output === 'string' ? output : output.text);
    };
    const state = await readState();
    expect(state.table.board).toContain('\n14 ..............o');
    expect(state.tables[0].board).toBeUndefined();
    expect(state.tables[1]).toMatchObject({ game: snapshot.table!.game, revision: snapshot.table!.revision });
    expect(state.tables[1].text).toBeUndefined();
    expect(state.tablePrivate.board).toBeUndefined();
    expect(state.tablePrivate.hints).toBeUndefined();
    expect(state.tablePrivate.text).toMatch(/^你执黑。\n建议（行,列）：\(\d+,\d+\) /);
    expect(state.tablePrivate.text).not.toContain('parlor_game_action');
    expect(response.table.board).toHaveLength(225);
    expect(response.tablePrivate.board).toHaveLength(225);

    const action = expectRevision(8);
    action.mockResolvedValueOnce({ ok: true, seq: ++seq, ts: 1002, at: '测试时刻',
      tableId: 't1', revision: 9, table, tablePrivate } as Awaited<ReturnType<ParlorClient['action']>>);
    const refresh = vi.mocked(ParlorClient.prototype.snapshot).mockClear();
    const receipt = await world.tools().find(tool => tool.name === 'parlor_game_action')!.handler(
      { action: 'place', params: { row: 7, col: 7 } }, {} as ToolCallContext,
    );
    expect(action.mock.calls[0][1]).toMatchObject({ table: 't1', revision: 8 });
    const accepted = JSON.parse(typeof receipt === 'string' ? receipt : receipt.text);
    expect(accepted).toMatchObject({ ok: true, tableId: 't1', revision: 9, requestId: expect.any(String) });
    expect(accepted.table).toBeUndefined();
    expect(accepted.tablePrivate).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();

    games.mockResolvedValueOnce({ ...response, tablePrivate: null });
    const watching = await readState();
    expect(watching.table.board).toBe(state.table.board);
    expect(watching.tablePrivate).toBeNull();
  });

  it('通用 state 读到的新版本供省略桌号的下一次行动使用', async () => {
    vi.spyOn(ParlorClient.prototype, 'games').mockResolvedValue({
      seq: ++seq, at: '测试时刻', table: { ...snapshot.table!, revision: 8 },
      tablePrivate: { ...snapshot.tablePrivate!, revision: 8 },
    });
    await world.tools().find(tool => tool.name === 'parlor_game_info')!.handler({ op: 'state' }, {} as ToolCallContext);
    const action = expectRevision(8);
    await world.tools().find(tool => tool.name === 'parlor_game_action')!.handler({ action: 'play', params: { cards: ['3'] } }, {} as ToolCallContext);
    expect(action.mock.calls[0][1]).toMatchObject({ type: 'game_action', table: 't1', revision: 8 });
  });
  it('通用工具直接使用服务器目录，支持本地尚未注册的游戏', async () => {
    const response = { ok: true, protocol: 'parlor.game.v1', game: { id: 'future' } };
    const query = vi.spyOn(ParlorClient.prototype, 'games').mockResolvedValue(response);
    const info = await toolForOperation(world, 'parlor_game_info')!.handler(
      { op: 'describe', game: 'future' }, {} as ToolCallContext,
    );
    expect(JSON.parse(typeof info === 'string' ? info : info.text)).toEqual(response);
    expect(query.mock.calls[0][1]).toEqual({ op: 'describe', game: 'future' });
    const action = vi.spyOn(ParlorClient.prototype, 'action').mockResolvedValue({ ok: true, seq: ++seq, ts: Date.now(), at: '测试时刻' });
    const args = { table: 'future-table', action: 'fly', params: { altitude: 3 }, revision: 1 };
    const output = await toolForOperation(world, 'parlor_game_action')!.handler(args, {} as ToolCallContext);
    expect(JSON.parse(typeof output === 'string' ? output : output.text).ok).toBe(true);
    expect(action.mock.calls[0][1]).toMatchObject({ ...args, type: 'game_action', requestId: expect.any(String) });
    await toolForOperation(world, 'parlor_table_open')!.handler({ game: 'future' }, {} as ToolCallContext);
    expect(action.mock.calls[1][1]).toMatchObject({ type: 'table_open', game: 'future' });
  });

  it('通用动作只在网络失败时沿用幂等键重试，不替换显式版本', async () => {
    const action = vi.spyOn(ParlorClient.prototype, 'action')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ ok: true, seq: ++seq, ts: Date.now(), at: '测试时刻' });
    const tool = toolForOperation(world, 'parlor_game_action')!;
    await tool.handler({ table: 't1', action: 'play', params: { cards: ['3'] }, revision: 2 }, {} as ToolCallContext);
    expect(action.mock.calls).toHaveLength(2);
    expect(action.mock.calls[0][1]).toEqual(action.mock.calls[1][1]);
    expect(action.mock.calls[0][1]).toMatchObject({ revision: 2 });
    action.mockClear().mockRejectedValue(new ParlorHttpError(409, '旧桌面'));
    const result = await tool.handler({ table: 't1', action: 'play', params: {}, revision: 2, requestId: 'retry-id' }, {} as ToolCallContext);
    expect(action).toHaveBeenCalledTimes(1);
    expect(typeof result === 'string' ? result : result.text).toContain('retry-id');
  });

  it('查验回执传递本次本人结论，历史仍可按需从本人桌面读取', async () => {
    const result = '查验历史（仅自己可见）：第1夜查 3号=狼人。';
    snapshot = { ...snapshot,
      table: { ...snapshot.table!, game: 'werewolf', label: '狼人杀' },
      tablePrivate: { game: 'werewolf', seat: 'mine', tableId: 't1', canAct: false, text: result },
    };
    const inspection = { day: 1, target: 3, result: 'wolf' } as const;
    vi.spyOn(ParlorClient.prototype, 'action').mockResolvedValue({
      ok: true, seq: ++seq, ts: Date.now(), at: '测试时刻', inspection,
    });
    const output = await toolForOperation(world, 'parlor_werewolf_action')!.handler(
      { windowId: 'w1', move: 'inspect', target: 3 }, {} as ToolCallContext,
    );
    const receipt = JSON.parse(typeof output === 'string' ? output : output.text);
    expect(receipt.inspection).toEqual(inspection);
    expect(receipt.tablePrivate).toBeUndefined();
    expect(await call('parlor_table_view')).toContain(result);
  });
  it('重新领出的通知到达后立即出牌，使用该通知的版本，不等待后台快照', async () => {
    const action = expectRevision(8);
    turn();
    expect(await call('parlor_ddz_action')).toContain('出了');
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('迟到的旧快照不能盖掉重新领出通知带来的新版本', async () => {
    let release!: (value: RoomSnapshot) => void;
    vi.mocked(ParlorClient.prototype.snapshot).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    receive({ seq: ++seq, ts: Date.now(), from: 'system', type: 'parlor.table.action',
      scope: { kind: 'room' }, text: '上一家过。', data: { tableId: 't1' } });
    await vi.advanceTimersByTimeAsync(0);
    turn();
    release(structuredClone(snapshot));
    await Promise.resolve();
    await Promise.resolve();
    expectRevision(8);
    expect(await call('parlor_ddz_action')).toContain('出了');
  });

  it.each(['parlor_table_view', 'parlor_look'])('%s 主动读到的桌面版本也用于下一次出牌', async name => {
    snapshot = { ...snapshot, latest: ++seq, tablePrivate: { ...snapshot.tablePrivate!, revision: 8 } };
    await call(name);
    expectRevision(8);
    expect(await call('parlor_ddz_action')).toContain('出了');
  });

  it('重连补发的旧行动通知不能覆盖启动快照里更晚的版本', async () => {
    snapshot = { ...snapshot, latest: 20, tablePrivate: { ...snapshot.tablePrivate!, revision: 9 } };
    await call('parlor_table_view');
    // 断线补发游标仍从 10 继续，但快照已经看到了游标 20。
    turn(8);
    expectRevision(9);
    expect(await call('parlor_ddz_action')).toContain('出了');
  });

  it('迟到的旧离桌快照不能清掉已经收到的新一手', async () => {
    turn();
    snapshot = { ...snapshot, tablePrivate: null, table: undefined };
    await call('parlor_table_view');
    const action = expectRevision(8);
    expect(await call('parlor_ddz_action')).toContain('出了');
    expect(action.mock.calls[0][1]).toMatchObject({ table: 't1', revision: 8 });
  });

  it('真正的旧动作仍报冲突，不换版本自动重放', async () => {
    turn();
    const action = expectRevision(9);
    expect(await call('parlor_ddz_action')).toContain('这一手已经过去了');
    expect(action).toHaveBeenCalledTimes(1);
  });
});
