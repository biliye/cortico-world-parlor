import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ParlorClient } from '../src/room/client.ts';
import { ParlorServer } from '../src/room/server.ts';
import { REPLAY_RETENTION_MS, ReplayStore } from '../src/room/replay.ts';
import type { RoomEvent } from '../src/room/protocol.ts';

const dirs: string[] = [];

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'parlor-replay-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const event = (seq: number, ts = 1_700_000_000_000 + seq, seatId?: string): RoomEvent => ({
  seq,
  ts,
  type: 'parlor.say',
  from: 's1',
  scope: seatId ? { kind: 'seat', seatId } : { kind: 'room' },
  text: `第 ${seq} 条`,
});

describe('回放存储', () => {
  it('按席位过滤：公开的都能看，私密的只有本人；before 往前翻', () => {
    const store = new ReplayStore({ now: () => 1_700_000_000_500 });
    for (const item of [event(1), event(2, undefined, 'a'), event(3, undefined, 'b'), event(4)]) {
      store.append(item);
    }

    const a = store.page('a', 100);
    expect(a.events.map((entry) => entry.seq)).toEqual([1, 2, 4]);
    expect(a.older).toBe(false);
    expect(a.events[0].at).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(a.events[0]).not.toHaveProperty('scope');

    expect(store.page('b', 100).events.map((entry) => entry.seq)).toEqual([1, 3, 4]);

    const tail = store.page('a', 2);
    expect(tail.events.map((entry) => entry.seq)).toEqual([2, 4]);
    expect(tail.older).toBe(true);

    const older = store.page('a', 2, 4);
    expect(older.events.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(older.older).toBe(false);
  });

  it('落盘后重启：事件还在，序号去重', () => {
    const dir = scratch();
    const file = join(dir, 'replay.jsonl');
    const now = 1_700_000_000_000;
    const first = ReplayStore.load({ file, now: () => now });
    first.append(event(1, now - 2000));
    first.append(event(2, now - 1000));

    const second = ReplayStore.load({ file, now: () => now });
    expect(second.count()).toBe(2);
    expect(second.page('c', 10).events.map((entry) => entry.text)).toEqual(['第 1 条', '第 2 条']);

    second.append(event(2, now));
    expect(second.count()).toBe(2);
  });

  it('只留 7 天：更旧的加载时丢掉，并把文件重写', () => {
    const dir = scratch();
    const file = join(dir, 'replay.jsonl');
    const now = 1_700_000_000_000;
    const old = event(1, now - REPLAY_RETENTION_MS - 1);
    const fresh = event(2, now - 1000);
    writeFileSync(file, `${JSON.stringify(old)}\n${JSON.stringify(fresh)}\n`);

    const store = ReplayStore.load({ file, now: () => now });
    expect(store.count()).toBe(1);
    expect(store.page('c', 10).events.map((entry) => entry.seq)).toEqual([2]);
    const left = readFileSync(file, 'utf8').trim().split('\n');
    expect(left).toHaveLength(1);
    expect(JSON.parse(left[0]).seq).toBe(2);
  });

  it('房间数据里更早的事件可以被补进回放，重复的不会写两遍', () => {
    const store = new ReplayStore({ now: () => 1_700_000_000_000 });
    store.seed([event(1), event(2)]);
    store.seed([event(2), event(3)]);
    expect(store.count()).toBe(3);
  });
});

describe('回放接口', () => {
  const start = async (): Promise<{ server: ParlorServer; client: ParlorClient; dir: string }> => {
    const dir = scratch();
    const server = new ParlorServer({ id: 'lobby', inviteCode: 'inv', port: 0, dataFile: join(dir, 'room.json') });
    await server.listen();
    return { server, client: new ParlorClient(server.url), dir };
  };

  it('自己的私密事件能看，别人的看不到；家长令牌与本人相同；before 能往前翻', async () => {
    const { server, client } = await start();
    try {
      const a = await client.join('inv', { name: '阿岚' });
      const b = await client.join('inv', { name: '小满' });
      const c = await client.join('inv', { name: '旁观' });

      await client.action(a.token, { type: 'say', text: '公开的一句' });
      await client.action(a.token, { type: 'whisper', to: '小满', text: '只给小满' });

      const mine = await client.replay(b.token, 100);
      expect(mine.retentionDays).toBe(7);
      expect(mine.at).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
      expect(mine.events.some((entry) => entry.text === '只给小满')).toBe(true);
      expect(mine.events.some((entry) => entry.text === '公开的一句')).toBe(true);
      expect(mine.events.every((entry) => entry.at.length > 0)).toBe(true);

      const owner = await client.replay(b.ownerToken, 100);
      expect(owner.events.map((entry) => entry.seq)).toEqual(mine.events.map((entry) => entry.seq));

      const third = await client.replay(c.token, 100);
      expect(third.events.some((entry) => entry.text === '只给小满')).toBe(false);
      expect(third.events.some((entry) => entry.text === '公开的一句')).toBe(true);

      const sender = await client.replay(a.token, 100);
      expect(sender.events.some((entry) => entry.text === '只给小满')).toBe(false);

      const page = await client.replay(b.token, 1);
      expect(page.events).toHaveLength(1);
      expect(page.older).toBe(true);
      const older = await client.replay(b.token, 100, page.events[0].seq);
      expect(older.events.every((entry) => entry.seq < page.events[0].seq)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('重启后回放还在（replay.jsonl 单独落盘）', async () => {
    const dir = scratch();
    const dataFile = join(dir, 'room.json');
    const first = new ParlorServer({ id: 'lobby', inviteCode: 'inv', port: 0, dataFile });
    await first.listen();
    const client = new ParlorClient(first.url);
    const a = await client.join('inv', { name: '阿岚' });
    await client.action(a.token, { type: 'say', text: '重启前的话' });
    await first.close();

    const second = new ParlorServer({ id: 'lobby', inviteCode: 'inv', port: 0, dataFile });
    await second.listen();
    try {
      const secondClient = new ParlorClient(second.url);
      const again = await secondClient.replay(a.token, 100);
      expect(again.events.some((entry) => entry.text === '重启前的话')).toBe(true);
    } finally {
      await second.close();
    }
  });
});
