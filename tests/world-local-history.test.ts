import { toolForOperation } from './helpers/tool-operations.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { PARLOR } from '../src/definition.ts';
import { ParlorClient } from '../src/room/client.ts';
import { WorldServer } from '../src/room/world-server.ts';
import { loadOrCreateIdentity, IDENTITY_FILE } from '../src/room/identity.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { pgServerStorage } from './helpers/pg.ts';
import { LocalHistory, type HistoryMessage } from '../src/local-history.ts';

let world: ReturnType<typeof PARLOR.create> | undefined;
let server: WorldServer | undefined;
let dir: string;
afterEach(async () => { await world?.stop(); await server?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
const until = async (check: () => Promise<boolean>) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('等待消息落盘超时');
};
const messages = async (): Promise<HistoryMessage[]> => {
  const result = await world!.webUi!().invoke!('history', 'query', [{}]) as { messages: HistoryMessage[] };
  return result.messages;
};

describe('World 本地消息档案端到端', () => {
  it('坏身份按原规则修复后，档案写进连接后的真实身份分区', async () => {
    dir = mkdtempSync(join(tmpdir(), 'parlor-history-identity-'));
    server = await WorldServer.create({ ...(await pgServerStorage(':memory:')), port: 0, inviteCode: 'inv', defaultRoomId: 'lobby' });
    await server.listen();
    const base = fakeWorldContext(PARLOR, { scratchDir: dir });
    const secrets: Record<string, string> = { PARLOR_INVITE_CODE: 'inv' };
    const ctx = { ...base, secret: (key: string) => secrets[key] || '', storeSecret: (key: string, value: string) => { secrets[key] = value; } };
    ctx.cfg.serverUrl = ctx.cfg.identityUrl = server.url; ctx.cfg.room = 'lobby'; ctx.cfg.seatName = '孩子';
    const file = join(ctx.dataDir, IDENTITY_FILE); mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ cooId: 'coo-history-old', cooSecret: 'bad' }));
    world = PARLOR.create(ctx); await world.start(new FakeHost());
    await toolForOperation(world, 'parlor_say')!.handler({ text: '新身份的发言' }, {} as ToolCallContext);
    const identity = JSON.parse(readFileSync(file, 'utf8'));
    expect(identity.cooId).not.toBe('coo-history-old');
    const disk = new LocalHistory(ctx.dataDir, server.url, identity.cooId);
    try { expect(disk.query().messages.some(item => item.text === '新身份的发言')).toBe(true); }
    finally { disk.close(); }
  });

  it('补收已读信，off 仍记录收发；跨厅私聊不重复，重启和关服后本地记录保留', async () => {
    dir = mkdtempSync(join(tmpdir(), 'parlor-history-world-'));
    server = await WorldServer.create({ ...(await pgServerStorage(':memory:')), port: 0, inviteCode: 'inv', defaultRoomId: 'lobby' });
    await server.listen();
    const base = fakeWorldContext(PARLOR, { scratchDir: dir });
    const secrets: Record<string, string> = { PARLOR_INVITE_CODE: 'inv' };
    const ctx = { ...base, secret: (key: string) => secrets[key] || '', storeSecret: (key: string, value: string) => { secrets[key] = value; } };
    ctx.cfg.serverUrl = ctx.cfg.identityUrl = server.url; ctx.cfg.room = 'lobby'; ctx.cfg.seatName = '孩子'; ctx.cfg.wakeTier = 'off';
    const child = new ParlorClient(server.url, loadOrCreateIdentity(join(ctx.dataDir, IDENTITY_FILE)));
    const joined = await child.join('inv', { name: '孩子', tier: 'off' }, 'lobby');
    secrets.PARLOR_SEAT_TOKEN = joined.token; secrets.PARLOR_OWNER_TOKEN = joined.ownerKey!;
    const friend = new ParlorClient(server.url, { cooId: 'coo-history-friend1', cooSecret: 'history-friend-secret-0001' });
    const peer = await friend.join('inv', { name: '朋友' }, 'lobby');
    await friend.action(peer.token, { type: 'whisper', to: '孩子', text: '先前已经读过的信' }, 'lobby');
    await child.mail(joined.token, 10, false, 'lobby', true);
    const host = new FakeHost(); world = PARLOR.create(ctx); await world.start(host);
    await until(async () => (await messages()).some(item => item.text === '先前已经读过的信'));
    await friend.action(peer.token, { type: 'say', text: '低提醒挡也要留住的公开话' }, 'lobby');
    const say = toolForOperation(world, 'parlor_say')!;
    await say.handler({ text: '孩子说的话' }, {} as ToolCallContext);
    await friend.switchTo(peer.token, 'lobby', 'hall');
    const whisper = toolForOperation(world, 'parlor_whisper')!;
    await whisper.handler({ to: '朋友', text: '孩子跨厅回复' }, {} as ToolCallContext);
    await until(async () => (await messages()).some(item => item.text === '低提醒挡也要留住的公开话'));
    expect((await messages()).filter(item => item.text === '孩子说的话')).toHaveLength(1);
    expect((await messages()).find(item => item.text === '孩子跨厅回复')?.direction).toBe('sent');
    expect(host.events.filter(event => event.type === 'parlor.message')).toHaveLength(0);
    expect((await child.mail(joined.token, 10, true, 'lobby', true)).unread).toBe(0);
    const decl = world.webUi!();
    expect(decl.links!.some(link => link.label.includes('本地消息档案'))).toBe(true);
    const page = await decl.invoke!('history', 'page', []) as { $binary: { base64: string } };
    expect(Buffer.from(page.$binary.base64, 'base64').toString()).toContain('datetime-local');
    await world.stop();
    world = PARLOR.create(ctx); await world.start(new FakeHost());
    await until(async () => {
      const info = await world!.webUi!().invoke!('history', 'info', []) as { syncing: boolean };
      return !info.syncing;
    });
    expect((await messages()).filter(item => item.text === '孩子跨厅回复')).toHaveLength(1);
    expect((await messages()).filter(item => item.text === '孩子说的话')).toHaveLength(1);
    await world.stop(); await server.close(); server = undefined;
    expect((await messages()).some(item => item.text === '先前已经读过的信')).toBe(true);
    // 整个 World 重新构造但没有连接服务器时，本机只读面板仍能定位旧档案。
    await world.stop(); world = PARLOR.create(ctx);
    expect((await messages()).some(item => item.text === '先前已经读过的信')).toBe(true);
  });
});
