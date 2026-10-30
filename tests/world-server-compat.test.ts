/**
 * 旧版 World（0.13.x 的 18 个工具）打新多客厅服务器：
 * 这是「新服务器可以替代旧服务器」的第一道证据，和牌桌/社交的 HTTP 测试互补。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { WorldContext } from 'cortico/world.ts';
import { PARLOR } from '../src/definition.ts';
import type { ParlorConfigSection } from '../src/config.ts';
import { ParlorClient } from '../src/room/client.ts';
import { WorldServer } from '../src/room/world-server.ts';
import { FakeHost } from './helpers/fake-host.ts';

const until = async (predicate: () => boolean, timeout = 5000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待超时');
};

let scratchDir: string;
let server: WorldServer | undefined;
let world: ReturnType<typeof PARLOR.create> | undefined;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'parlor-compat-'));
});

afterEach(async () => {
  await world?.stop();
  world = undefined;
  await server?.close();
  server = undefined;
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

const tool = (name: string) => {
  const found = world!.tools().find((entry) => entry.name === name);
  if (!found) throw new Error(`没有工具 ${name}`);
  return found;
};

const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => (
  String(await tool(name).handler(args, {} as ToolCallContext))
);

describe('旧 World 工具 × 新服务器', () => {
  it('连接、说话、私聊、查看、回放、骰子一局都能走通', async () => {
    server = new WorldServer({ allowGuestJoin: true, dbFile: ':memory:', port: 0, inviteCode: 'inv' });
    await server.listen();

    const secrets: Record<string, string> = { PARLOR_INVITE_CODE: 'inv' };
    const ctx = makeContext(secrets);
    ctx.cfg.serverUrl = server.url;
    ctx.cfg.seatName = '小满';
    world = PARLOR.create(ctx);
    const host = new FakeHost();
    await world.start(host);
    expect(host.events[0]?.type).toBe('parlor.started');

    const friend = new ParlorClient(server.url, {
      cooId: 'coo-ffffffff',
      cooSecret: 'friend-secret-0123456789',
    });
    const joined = await friend.join('inv', { name: '阿岚' });
    await friend.action(joined.token, { type: 'say', text: '@小满 你好' });
    await until(() => host.events.some((event) => event.type === 'parlor.message'));
    expect(host.events.find((event) => event.type === 'parlor.message')?.text).toContain('阿岚：@小满 你好');

    expect(await call('parlor_say', { text: '大家好' })).toContain('服务器已收下');
    const friendSnapshot = await friend.snapshot(joined.token, 0, 50);
    expect(friendSnapshot.events.map((event) => event.text)).toContain('大家好');

    expect(await call('parlor_whisper', { to: '阿岚', text: '离线也看得到' })).toContain('已投递到');
    expect(await call('parlor_look')).toContain('客厅');
    expect(await call('parlor_replay', { limit: 50 })).toContain('【回放】');

    // 骰子一局：她开桌，人坐下，她开始；人停牌后轮到她。
    expect(await call('parlor_table_open', { game: 'dice' })).toContain('骰子桌开了');
    await friend.action(joined.token, { type: 'table_join', requestId: 'friend-join' });
    const started = await call('parlor_table_start');
    expect(started).toContain('服务器已收下');
    const view = await call('parlor_table_view');
    expect(view).toContain('骰子桌');
    expect(await call('parlor_table_action', { action: 'stand' })).toContain('停牌了');
    const table = await friend.snapshot(joined.token, 0, 1);
    const revision = table.tablePrivate?.revision ?? table.table?.revision;
    expect(typeof revision).toBe('number');
    await friend.action(joined.token, {
      type: 'table_action', action: 'stand', requestId: 'friend-stand', revision,
    });

    const ended = await friend.snapshot(joined.token, 0, 100);
    expect(ended.table?.status).toBe('ended');
    expect(ended.ledger?.games).toBe(1);
  });
});
