import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { WorldContext } from 'cortico/world.ts';
import { PARLOR } from '../src/definition.ts';
import type { ParlorConfigSection } from '../src/config.ts';
import { ParlorClient } from '../src/room/client.ts';
import { ParlorServer } from '../src/room/server.ts';
import { FakeHost } from './helpers/fake-host.ts';

const until = async (predicate: () => boolean, timeout = 5000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待超时');
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let scratchDir: string;
let server: ParlorServer;
let world: ReturnType<typeof PARLOR.create> | undefined;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'parlor-world-'));
});

afterEach(async () => {
  await world?.stop();
  world = undefined;
  await server?.close();
  rmSync(scratchDir, { recursive: true, force: true });
});

const makeContext = (secrets: Record<string, string>): WorldContext<ParlorConfigSection> => {
  const base = fakeWorldContext(PARLOR, { scratchDir });
  return {
    ...base,
    secret: (name) => secrets[name] ?? '',
    storeSecret: (name, value) => { secrets[name] = value; },
  };
};

const startServer = async (): Promise<void> => {
  server = new ParlorServer({ id: 'lobby', inviteCode: 'inv', port: 0 });
  await server.listen();
};

describe('客厅 World', () => {
  it('干装载不报失败', async () => {
    const report = await dryMountWorld(PARLOR, { scratchDir });
    expect(report.failures).toEqual([]);
  });

  it('连接后发 started；被 @ 时收到房间消息，工具能说话和查看', async () => {
    await startServer();
    const secrets: Record<string, string> = { PARLOR_INVITE_CODE: 'inv' };
    const ctx = makeContext(secrets);
    ctx.cfg.serverUrl = server.url;
    ctx.cfg.seatName = '小满';
    world = PARLOR.create(ctx);
    const host = new FakeHost();
    await world.start(host);
    expect(host.events[0]?.type).toBe('parlor.started');

    const client = new ParlorClient(server.url);
    const friend = await client.join('inv', { name: '阿岚' });
    await until(() => server.onlineSeats().length >= 1);
    await client.action(friend.token, { type: 'say', text: '@小满 你好' });
    await until(() => host.events.some((event) => event.type === 'parlor.message'));
    const message = host.events.find((event) => event.type === 'parlor.message')!;
    expect(message.text).toContain('阿岚：@小满 你好');

    const say = world.tools().find((tool) => tool.name === 'parlor_say')!;
    expect(String(await say.handler({ text: '大家好' }, {} as ToolCallContext))).toContain('已说');
    const snapshot = await client.snapshot(friend.token, 0, 50);
    expect(snapshot.events.map((event) => event.text)).toContain('大家好');

    const look = world.tools().find((tool) => tool.name === 'parlor_look')!;
    const looked = String(await look.handler({}, {} as ToolCallContext));
    expect(looked).toContain('阿岚');
    expect(looked).toContain('小满');

    const setTier = world.tools().find((tool) => tool.name === 'parlor_set_tier')!;
    expect(String(await setTier.handler({ tier: 'quiet' }, {} as ToolCallContext))).toContain('只 @');
    const mine = await client.snapshot(secrets.PARLOR_SEAT_TOKEN!, 0, 1);
    expect(mine.seat.tier).toBe('quiet');
  });

  it('安静挡位下闲聊不叫醒，@ 才叫，醒来带摘要', async () => {
    await startServer();
    const secrets: Record<string, string> = { PARLOR_INVITE_CODE: 'inv' };
    const ctx = makeContext(secrets);
    ctx.cfg.serverUrl = server.url;
    ctx.cfg.seatName = '小满';
    ctx.cfg.wakeTier = 'quiet';
    world = PARLOR.create(ctx);
    const host = new FakeHost();
    await world.start(host);

    const client = new ParlorClient(server.url);
    const friend = await client.join('inv', { name: '阿岚' });
    await until(() => server.onlineSeats().length >= 1);
    await client.action(friend.token, { type: 'say', text: '今天天气不错' });
    await sleep(400);
    expect(host.events.some((event) => event.type === 'parlor.message' || event.type === 'parlor.digest')).toBe(false);

    await client.action(friend.token, { type: 'say', text: '@小满 喊你' });
    await until(() => host.events.some((event) => event.type === 'parlor.message'));
    const message = host.events.find((event) => event.type === 'parlor.message')!;
    expect(message.text).toContain('今天天气不错');
    expect(message.text).toContain('@小满 喊你');
  });

  it('离开挡位连 @ 也不叫', async () => {
    await startServer();
    const secrets: Record<string, string> = { PARLOR_INVITE_CODE: 'inv' };
    const ctx = makeContext(secrets);
    ctx.cfg.serverUrl = server.url;
    ctx.cfg.seatName = '小满';
    ctx.cfg.wakeTier = 'off';
    world = PARLOR.create(ctx);
    const host = new FakeHost();
    await world.start(host);

    const client = new ParlorClient(server.url);
    const friend = await client.join('inv', { name: '阿岚' });
    await until(() => server.onlineSeats().length >= 1);
    await client.action(friend.token, { type: 'say', text: '@小满 在吗' });
    await sleep(400);
    expect(host.events.some((event) => event.type === 'parlor.message' || event.type === 'parlor.digest')).toBe(false);
  });
});
