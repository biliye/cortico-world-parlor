/** 用可控服务器事件流和时钟验证投递行为，不等待真实的一小时。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { PARLOR } from '../src/definition.ts';
import { ParlorClient } from '../src/room/client.ts';
import type { RoomEvent, RoomSnapshot, WakeTier } from '../src/room/protocol.ts';
import { FakeHost } from './helpers/fake-host.ts';

let scratchDir: string;
let world: ReturnType<typeof PARLOR.create>;
let host: FakeHost;
let snapshot: RoomSnapshot;
let receive: (event: RoomEvent) => void;
let seq: number;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));
  scratchDir = mkdtempSync(join(tmpdir(), 'parlor-wake-'));
  seq = 1;
});

afterEach(async () => {
  await world?.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(scratchDir, { recursive: true, force: true });
});

const start = async (tier: WakeTier = 'full'): Promise<void> => {
  const ctx = fakeWorldContext(PARLOR, { scratchDir });
  ctx.cfg.serverUrl = 'http://127.0.0.1:8790';
  ctx.cfg.room = 'lobby';
  ctx.cfg.wakeTier = tier;
  ctx.secret = (name) => name === 'PARLOR_SEAT_TOKEN' ? 'test-seat-token' : 'inv';
  snapshot = {
    id: 'lobby', seat: { id: 'mine', name: '小满', kind: 'pet', tier, joinedAt: Date.now() },
    seats: [], maxSeats: 30, latest: seq, now: Date.now(), at: '测试时刻', events: [], tablePrivate: null,
  };
  vi.spyOn(ParlorClient.prototype, 'initializeIdentity').mockResolvedValue(true);
  vi.spyOn(ParlorClient.prototype, 'snapshot').mockImplementation(async () => snapshot);
  vi.spyOn(ParlorClient.prototype, 'stream').mockImplementation(async (_token, _since, onEvent, signal) => {
    receive = onEvent;
    await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }));
  });
  world = PARLOR.create(ctx);
  host = new FakeHost();
  await world.start(host);
};

const emit = (text: string, extra: Partial<RoomEvent> = {}): void => receive({
  seq: ++seq, ts: Date.now(), from: 'friend', type: 'parlor.say', scope: { kind: 'room' },
  text, data: { name: '阿岚' }, ...extra,
});
const messages = () => host.events.filter((event) => event.type === 'parlor.message' || event.type === 'parlor.digest');
const tableChat = (text: string, mentions?: string[]) => emit(text, {
  type: 'parlor.table.say', scope: { kind: 'table', tableId: 't1', seats: ['mine', 'friend'] },
  data: { name: '阿岚', tableId: 't1' }, mentions,
});
const enterTable = async (): Promise<void> => {
  snapshot.table = { game: 'werewolf', label: '狼人杀', status: 'playing', host: 'mine', text: '桌面', id: 't1' };
  snapshot.tablePrivate = { game: 'werewolf', text: '我的桌面', tableId: 't1', seat: 'mine' };
  emit('只更新桌面', {
    type: 'parlor.table.turn', scope: { kind: 'seat', seatId: 'mine' },
    data: { tableId: 't1', decision: false },
  });
  await vi.advanceTimersByTimeAsync(0);
};

describe('World 普通闲聊预算', () => {
  it('full 连续消息最多等五秒合成一次，不逐条投递', async () => {
    await start();
    emit('第一句');
    await vi.advanceTimersByTimeAsync(2_000);
    emit('第二句');
    await vi.advanceTimersByTimeAsync(2_999);
    expect(messages()).toHaveLength(0);
    emit('第三句');
    await vi.advanceTimersByTimeAsync(1);
    expect(messages()).toHaveLength(1);
    expect(messages()[0].text).toContain('第一句');
    expect(messages()[0].text).toContain('第三句');
  });

  it('full 额度耗尽会暂存，恢复后自动投递；@ 不被阻塞也不占额度', async () => {
    await start();
    for (let i = 0; i < 3; i += 1) {
      emit(`普通批次${i}`);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    emit('预算耗尽后暂存');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(messages()).toHaveLength(3);
    for (let i = 0; i < 10; i += 1) emit(`点名${i}`, { mentions: ['mine'] });
    expect(messages()).toHaveLength(13);
    expect(messages()[3].text).toContain('预算耗尽后暂存');
    emit('等待恢复的普通消息');
    await vi.advanceTimersByTimeAsync(44_999);
    expect(messages()).toHaveLength(13);
    await vi.advanceTimersByTimeAsync(1);
    expect(messages()).toHaveLength(14);
    expect(messages()[13].text).toContain('等待恢复的普通消息');
  });

  it('digest 周期摘要也受平滑恢复限制', async () => {
    await start('digest');
    for (let i = 0; i < 6; i += 1) {
      emit(`周期消息${i}`);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(messages()).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages()).toHaveLength(6);
    expect(messages()[5].text).toContain('周期消息5');
  });

  it('quiet 只在点名时附上积压消息', async () => {
    await start('quiet');
    emit('安静期间的闲聊');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(messages()).toHaveLength(0);
    emit('@小满 找你', { mentions: ['mine'] });
    expect(messages()).toHaveLength(1);
    expect(messages()[0].text).toContain('安静期间的闲聊');
  });

  it('待发消息有条数和正文上限，省略旧消息会明示', async () => {
    await start('quiet');
    for (let i = 0; i < 80; i += 1) emit(`${i}:` + '字'.repeat(397));
    emit('现在点名', { mentions: ['mine'] });
    expect(messages()).toHaveLength(1);
    expect(messages()[0].text).toContain('省略了');
    expect(messages()[0].text).toContain('79:');
    expect(messages()[0].text).not.toContain('阿岚：0:');
    expect(messages()[0].text.length).toBeLessThan(13_000);
  });

  it('局后闲聊不能绕过预算，结算自身及时提醒', async () => {
    await start();
    for (let i = 0; i < 3; i += 1) {
      emit(`消耗额度${i}`);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    await enterTable();
    emit('局中客厅闲聊');
    snapshot.table = undefined;
    snapshot.tablePrivate = null;
    emit('狼人杀终局', { type: 'parlor.table.end', from: 'system', data: { tableId: 't1' } });
    expect(messages()).toHaveLength(4);
    expect(messages()[3].text).toContain('狼人杀终局');
    expect(messages()[3].text).not.toContain('局中客厅闲聊');
    await vi.advanceTimersByTimeAsync(50_000);
    expect(messages()).toHaveLength(5);
    expect(messages()[4].text).toContain('打牌期间的客厅');
    expect(messages()[4].text).toContain('局中客厅闲聊');
  });
});

describe('World 桌聊合并与决策提醒', () => {
  it('普通桌聊从第一句起最多等五秒，持续聊天不无限推迟', async () => {
    await start();
    tableChat('第一句桌聊');
    await vi.advanceTimersByTimeAsync(2_000);
    tableChat('第二句桌聊');
    await vi.advanceTimersByTimeAsync(2_999);
    expect(messages()).toHaveLength(0);
    tableChat('第三句桌聊');
    await vi.advanceTimersByTimeAsync(1);
    expect(messages()).toHaveLength(1);
    expect(messages()[0].text).toContain('第一句桌聊');
    expect(messages()[0].text).toContain('第三句桌聊');
  });

  it.each(['mention', 'turn', 'whisper'] as const)('%s 立即带上桌聊，五秒后不重复投递', async (kind) => {
    await start();
    tableChat('等待交付的桌聊');
    await vi.advanceTimersByTimeAsync(1_000);
    if (kind === 'mention') tableChat('@小满 点到你', ['mine']);
    else emit('立即提醒', {
      type: kind === 'turn' ? 'parlor.table.turn' : 'parlor.whisper',
      scope: { kind: 'seat', seatId: 'mine' }, data: { tableId: 't1' },
    });
    expect(messages()).toHaveLength(1);
    expect(messages()[0].text).toContain('等待交付的桌聊');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(messages()).toHaveLength(1);
  });

  it('狼人杀他人发言只刷新桌面，轮到本人行动及时唤醒', async () => {
    await start();
    await enterTable();
    emit('别人的白天发言', {
      type: 'parlor.table.werewolf.speech', data: { tableId: 't1', game: 'werewolf' },
    });
    emit('纯桌面更新', {
      type: 'parlor.table.turn', scope: { kind: 'seat', seatId: 'mine' },
      data: { tableId: 't1', decision: false },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(messages()).toHaveLength(0);
    emit('轮到你投票', {
      type: 'parlor.table.turn', scope: { kind: 'seat', seatId: 'mine' }, data: { tableId: 't1' },
    });
    expect(messages()).toHaveLength(1);
    expect(messages()[0].text).toContain('轮到你投票');
  });

  it('普通桌聊不消耗客厅闲聊额度', async () => {
    await start();
    for (let i = 0; i < 4; i += 1) {
      tableChat(`桌聊批次${i}`);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(messages()).toHaveLength(4);
    emit('客厅闲聊仍有额度');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(messages()).toHaveLength(5);
    expect(messages()[4].text).toContain('客厅闲聊仍有额度');
  });

  it('停止后取消尚未投递的闲聊和桌聊定时器', async () => {
    await start();
    emit('停止前的客厅消息');
    tableChat('停止前的桌聊');
    await world.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages()).toHaveLength(0);
  });

  it('off 不收桌聊或行动提醒', async () => {
    await start('off');
    tableChat('不该收到的桌聊');
    emit('不该收到的行动', { type: 'parlor.table.turn', scope: { kind: 'seat', seatId: 'mine' } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(messages()).toHaveLength(0);
    await world.stop();
  });
});
