import { toolForOperation } from './helpers/tool-operations.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { PARLOR } from '../src/definition.ts';
import { ParlorClient, ParlorHttpError } from '../src/room/client.ts';
import type { RoomSnapshot, Seat, SwitchResponse } from '../src/room/protocol.ts';
import { FakeHost } from './helpers/fake-host.ts';

type StreamArgs = Parameters<ParlorClient['stream']>;
let streams: Array<{ args: StreamArgs; reject: (error: Error) => void }>;
let scratch: string;
let world: ReturnType<typeof PARLOR.create>;
let host: FakeHost;
let secrets: Record<string, string>;
const oldSeat: Seat = { id: 'old-seat', name: '小满', kind: 'pet', tier: 'full', joinedAt: 1 };
const newSeat: Seat = { ...oldSeat, id: 'new-seat' };
const snap = (room: string, seat: Seat): RoomSnapshot => ({
  id: room, seat, seats: [seat], latest: 10, now: Date.now(), at: '测试时刻', events: [], maxSeats: 30,
});
const moved: SwitchResponse = { ok: true, room: 'target', seat: newSeat, token: 'new-token', leaveSeq: 10, joinSeq: 10 };
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await toolForOperation(world, name)!.handler(args, {} as ToolCallContext);
  return typeof result === 'string' ? result : result.text;
};

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'parlor-room-transition-'));
  streams = [];
  secrets = { PARLOR_SEAT_TOKEN: 'old-token', PARLOR_INVITE_CODE: 'inv' };
  const ctx = fakeWorldContext(PARLOR, { scratchDir: scratch });
  ctx.cfg.serverUrl = 'http://127.0.0.1:8790';
  ctx.cfg.room = 'lobby';
  ctx.cfg.seatName = oldSeat.name;
  ctx.secret = name => secrets[name] ?? '';
  ctx.storeSecret = (name, value) => { secrets[name] = value; };
  vi.spyOn(ParlorClient.prototype, 'initializeIdentity').mockResolvedValue(true);
  vi.spyOn(ParlorClient.prototype, 'location').mockImplementation(async token => ({
    room: token === 'old-token' ? 'lobby' : 'target',
    seat: token === 'old-token' ? oldSeat : newSeat,
  }));
  vi.spyOn(ParlorClient.prototype, 'snapshot').mockImplementation(async (_token, _since, _limit, room) =>
    snap(room ?? 'lobby', room === 'target' ? newSeat : oldSeat));
  vi.spyOn(ParlorClient.prototype, 'switchTo').mockResolvedValue(moved);
  vi.spyOn(ParlorClient.prototype, 'stream').mockImplementation(async (...args) => {
    await new Promise<void>((resolve, reject) => {
      streams.push({ args, reject });
      const abort = () => reject(new ParlorHttpError(401, '旧厅令牌已失效'));
      if (args[3]?.aborted) abort();
      else args[3]?.addEventListener('abort', abort, { once: true });
    });
  });
  world = PARLOR.create(ctx);
  host = new FakeHost();
  await world.start(host);
});

afterEach(async () => {
  await world?.stop();
  vi.restoreAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});

describe('换厅与旧连接隔离', () => {
  it('先退出旧流再换厅，迟到401和事件不会重领新令牌或污染新厅', async () => {
    const rejoin = vi.spyOn(ParlorClient.prototype, 'join');
    vi.mocked(ParlorClient.prototype.switchTo).mockImplementationOnce(async () => {
      expect(streams[0].args[3]?.aborted).toBe(true);
      return moved;
    });
    expect(await call('parlor_room_visit', { room: 'target' })).toContain('target');
    expect(streams.map(stream => stream.args[0])).toEqual(['old-token', 'new-token']);
    streams[0].reject(new ParlorHttpError(401, '迟到的旧连接失败'));
    streams[0].args[2]({ seq: 11, ts: Date.now(), type: 'parlor.say', from: '旧厅玩家',
      scope: { kind: 'room' }, text: '@小满 旧厅消息不该进新厅' });
    streams[0].args[5]?.();
    await new Promise(resolve => setImmediate(resolve));
    expect(rejoin).not.toHaveBeenCalled();
    expect(secrets.PARLOR_SEAT_TOKEN).toBe('new-token');
    expect(host.events.some(event => event.text.includes('旧厅消息不该进新厅'))).toBe(false);
  });

  it('换厅失败后恢复原厅流，仍沿用原令牌', async () => {
    vi.mocked(ParlorClient.prototype.switchTo).mockRejectedValueOnce(new ParlorHttpError(409, '牌局未结束'));
    expect(await call('parlor_room_visit', { room: 'target' })).toContain('牌局未结束');
    expect(streams.map(stream => stream.args[0])).toEqual(['old-token', 'old-token']);
    expect(streams[1].args[4]).toBe('lobby');
    expect(secrets.PARLOR_SEAT_TOKEN).toBe('old-token');
  });

  it('换厅进行中拒绝另一笔换厅或匹配，成功后只建立一条新流', async () => {
    let finish!: (result: SwitchResponse) => void;
    vi.mocked(ParlorClient.prototype.switchTo).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = call('parlor_room_visit', { room: 'target' });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(await call('parlor_room_visit', { room: 'other' })).toContain('正在换厅');
    expect(await call('parlor_table_join', { game: 'ddz' })).toContain('正在换厅');
    finish(moved);
    await first;
    expect(ParlorClient.prototype.switchTo).toHaveBeenCalledTimes(1);
    expect(streams).toHaveLength(2);
  });

  it('当前流真正401时仍按原机制重入座，不能把所有401都忽略', async () => {
    const rejoin = vi.spyOn(ParlorClient.prototype, 'join').mockResolvedValue({
      room: 'lobby', seat: oldSeat, token: 'renewed-token', ownerToken: '', maxSeats: 30,
    });
    streams[0].reject(new ParlorHttpError(401, '当前席位被释放'));
    await vi.waitFor(() => expect(streams).toHaveLength(2));
    expect(rejoin).toHaveBeenCalledTimes(1);
    expect(secrets.PARLOR_SEAT_TOKEN).toBe('renewed-token');
    expect(streams[1].args[0]).toBe('renewed-token');
  });
});
