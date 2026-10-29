/**
 * 牌桌私聊（scope: table）：只有说话那一刻坐在这一桌的人看得到，
 * 客厅里的人和后来的同桌都看不到；家长页（owner 令牌）与回放跟着席位走。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ParlorClient } from '../src/room/client.ts';
import { ParlorServer } from '../src/room/server.ts';
import { decideWake, scopeVisibleTo, type RoomEvent, type Seat, type WakeTier } from '../src/room/protocol.ts';

let server: ParlorServer;
let client: ParlorClient;

beforeEach(async () => {
  server = new ParlorServer({ id: 'lobby', inviteCode: 'inv', port: 0 });
  await server.listen();
  client = new ParlorClient(server.url);
});

afterEach(async () => {
  await server.close();
});

const join = (name: string) => client.join('inv', { name });
const texts = (events: { text: string }[]): string[] => events.map((event) => event.text);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('牌桌私聊', () => {
  it('只有同桌看得见：客厅快照、回放、家长页', async () => {
    const a = await join('阿岚');
    const b = await join('小满');
    const c = await join('路人');
    await client.action(a.token, { type: 'table_open', game: 'ddz' });
    await client.action(b.token, { type: 'table_join' });
    await client.action(a.token, { type: 'table_start' });
    await client.action(a.token, { type: 'table_say', text: '这手我先让' });

    const mine = await client.snapshot(a.token, 0, 50);
    const said = mine.events.find((event) => event.type === 'parlor.table.say');
    expect(said?.text).toBe('这手我先让');
    expect(said?.scope.kind).toBe('table');
    if (said?.scope.kind === 'table') {
      // 席位快照：那一刻的同桌，脚本陪练不算房间席位。
      expect(said.scope.seats).toContain(a.seat.id);
      expect(said.scope.seats).toContain(b.seat.id);
      expect(said.scope.seats).not.toContain(c.seat.id);
      expect(said.scope.tableId.length).toBeGreaterThan(0);
    }

    expect(texts((await client.snapshot(b.token, 0, 50)).events)).toContain('这手我先让');
    expect(texts((await client.snapshot(c.token, 0, 50)).events)).not.toContain('这手我先让');

    // 回放跟快照用同一条可见性判定。
    expect(texts((await client.replay(a.token, 50)).events)).toContain('这手我先让');
    expect(texts((await client.replay(c.token, 50)).events)).not.toContain('这手我先让');

    // 家长页用的就是自家席位的 owner 令牌：看得见自家孩子桌上说的话。
    const ownerView = await fetch(
      `${server.url}/v1/room?token=${encodeURIComponent(a.ownerToken)}&limit=50`,
    ).then((response) => response.json() as Promise<{ events: { text: string }[] }>);
    expect(texts(ownerView.events)).toContain('这手我先让');
  });

  it('不在桌上不许说，也不会悄悄变成全房间可见', async () => {
    const a = await join('阿岚');
    const c = await join('路人');
    await client.action(a.token, { type: 'table_open', game: 'ddz' });

    await expect(client.action(c.token, { type: 'table_say', text: '我也想插一句' }))
      .rejects.toThrow('你不在这一桌');
    expect(texts((await client.snapshot(c.token, 0, 50)).events)).not.toContain('我也想插一句');
  });

  it('没有牌桌时说不了，回客厅说', async () => {
    const a = await join('阿岚');
    await expect(client.action(a.token, { type: 'table_say', text: '随便说点' }))
      .rejects.toThrow('现在没有牌桌');
  });

  it('桌上发言与客厅发言共用一个限速', async () => {
    const a = await join('阿岚');
    await client.action(a.token, { type: 'table_open', game: 'ddz' });
    await client.action(a.token, { type: 'table_say', text: '一句' });
    await expect(client.action(a.token, { type: 'say', text: '换个频道' })).rejects.toThrow('说得太快了');
    await sleep(80);
    await expect(client.action(a.token, { type: 'say', text: '换个频道' })).resolves.toMatchObject({ ok: true });
  });
});

describe('桌上发言的可见性与唤醒判定', () => {
  const event: RoomEvent = {
    seq: 7,
    ts: 0,
    type: 'parlor.table.say',
    from: 's1',
    scope: { kind: 'table', tableId: 't7', seats: ['s1', 's2'] },
    text: 'hi',
  };
  const seat = (id: string, tier: WakeTier): Seat => ({ id, name: id, kind: 'pet', tier, joinedAt: 0 });

  it('只有同桌看得见，后来坐上来的人不算', () => {
    expect(scopeVisibleTo(event.scope, 's2')).toBe(true);
    expect(scopeVisibleTo(event.scope, 's3')).toBe(false);
  });

  it('同桌一律叫醒（摘要与只 @ 挡也叫），只有「离开」不叫', () => {
    expect(decideWake(event, seat('s2', 'digest'))).toEqual({ wake: true, addressed: true, reason: 'table' });
    expect(decideWake(event, seat('s2', 'quiet')).wake).toBe(true);
    expect(decideWake(event, seat('s2', 'off')).wake).toBe(false);
    // 不在这一桌的人不因为它被叫醒。
    expect(decideWake(event, seat('s3', 'digest'))).toEqual({ wake: false, addressed: false, reason: 'room' });
  });
});
