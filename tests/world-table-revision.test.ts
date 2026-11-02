import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { PARLOR } from '../src/definition.ts';
import { ParlorClient, ParlorHttpError } from '../src/room/client.ts';
import type { ActionRequest, RoomEvent, RoomSnapshot } from '../src/room/protocol.ts';
import { FakeHost } from './helpers/fake-host.ts';

let scratchDir: string;
let world: ReturnType<typeof PARLOR.create>;
let receive: (event: RoomEvent) => void;
let snapshot: RoomSnapshot;
let seq: number;

const call = async (name: string) => {
  const result = await world.tools().find(tool => tool.name === name)!.handler(
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
    return { ok: true, seq: ++seq, ts: Date.now(), at: '测试时刻' };
  });

describe('World 牌桌版本同步', () => {
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
