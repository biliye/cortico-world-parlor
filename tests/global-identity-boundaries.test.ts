import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { PARLOR } from '../src/definition.ts';
import { ParlorClient } from '../src/room/client.ts';
import { WorldServer } from '../src/room/world-server.ts';
import { FakeHost } from './helpers/fake-host.ts';

const servers: WorldServer[] = [];
const worlds: ReturnType<typeof PARLOR.create>[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.stop();
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function start(authority = 'self', inviteCode = '') {
  const s = new WorldServer({ identityAuthority: authority, inviteCode });
  servers.push(s); await s.listen(); return s;
}

describe('全局身份的入场与续席边界', () => {
  it.each(['alias', 'hall', 'public'])('F2：%s 入座仍要求本服务器邀请码，登记身份不能免码', async route => {
    const authority = await start(); const target = await start(authority.url, 'target-only-invite');
    const client = new ParlorClient(target.url, { cooId: 'coo-boundary1', cooSecret: 'boundary-secret-0123456789' });
    await client.initializeIdentity(authority.url, '', '小满');
    const created = await client.createRoom({ name: '公开厅', visibility: 'public' });
    const room = route === 'hall' ? 'hall' : route === 'public' ? created.room.id : undefined;
    const roomId = room ?? 'lobby';
    for (const code of ['', 'wrong']) await expect(client.join(code, { name: '小满' }, room)).rejects.toThrow('邀请码不对');
    const joined = await client.join('target-only-invite', { name: '小满' }, room);
    expect(joined.seat.name).toBe('小满');
    await client.leaveRoom(joined.token, roomId);
    // 已被目标服务器认识、甚至已来过，也不能靠身份重新免码进场。
    await expect(client.join('', { name: '小满' }, room)).rejects.toThrow('邀请码不对');
  });

  async function setupWorld() {
    const authority = await start(); const target = await start(authority.url, 'target-only-invite');
    const scratchDir = mkdtempSync(join(tmpdir(), 'parlor-boundary-')); dirs.push(scratchDir);
    const secrets: Record<string, string> = {};
    const base = fakeWorldContext(PARLOR, { scratchDir });
    const ctx = { ...base, secret: (name: string) => secrets[name] ?? '', storeSecret: (name: string, value: string) => { secrets[name] = value; } };
    ctx.cfg.serverUrl = target.url; ctx.cfg.identityUrl = authority.url;
    ctx.cfg.room = 'lobby'; ctx.cfg.inviteCode = 'target-only-invite'; ctx.cfg.seatName = '小满';
    const first = PARLOR.create(ctx); worlds.push(first); await first.start(new FakeHost());
    const identityFile = join(ctx.dataDir, 'parlor-identity.json');
    const identity = JSON.parse(readFileSync(identityFile, 'utf8'));
    const token = secrets.PARLOR_SEAT_TOKEN;
    const snapshot = await new ParlorClient(target.url).snapshot(token, 0, 1, 'lobby');
    await first.stop(); worlds.splice(worlds.indexOf(first), 1);
    await authority.close(); servers.splice(servers.indexOf(authority), 1);
    return { target, ctx, secrets, identity, identityFile, token, snapshot };
  }

  it('F3：权威停机后，有效席位直接续用，聊天、目录、建房和牌桌均可用', async () => {
    const { target, ctx, secrets, identity, identityFile, token, snapshot } = await setupWorld();
    const resumed = PARLOR.create(ctx); worlds.push(resumed);
    const host = new FakeHost(); await resumed.start(host);
    expect(host.events[0]?.type).toBe('parlor.started');
    expect(secrets.PARLOR_SEAT_TOKEN).toBe(token);
    expect(JSON.parse(readFileSync(identityFile, 'utf8'))).toEqual(identity);
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const value = await resumed.tools().find(t => t.name === name)!.handler(args, {} as any);
      return typeof value === 'string' ? value : value.text;
    };
    expect(await tool('parlor_say', { text: '权威停机仍能说话' })).toContain('服务器已收下');
    expect(await tool('parlor_look')).toContain('小满');
    expect(await tool('parlor_rooms')).toContain('我现在在');
    expect(await tool('parlor_room_create', { name: '续席新厅' })).toContain('开好了');
    expect(await tool('parlor_table_open', { game: 'ddz' })).toContain('服务器已收下');
    const live = await new ParlorClient(target.url).snapshot(token, 0, 20, 'lobby');
    expect(live.seat.id).toBe(snapshot.seat.id);
    expect(live.events.some(e => e.text === '权威停机仍能说话')).toBe(true);
  });

  it.each(['missing', 'invalid'])('F3：%s 席位不能绕过身份验证；权威不可达给出可读错误', async state => {
    const { target, ctx, secrets, identityFile, identity } = await setupWorld();
    if (state === 'missing') delete secrets.PARLOR_SEAT_TOKEN;
    else secrets.PARLOR_SEAT_TOKEN = 'invalid-seat-token';
    const next = PARLOR.create(ctx); worlds.push(next);
    await expect(next.start(new FakeHost())).rejects.toThrow('身份服务暂时无法连接');
    expect(JSON.parse(readFileSync(identityFile, 'utf8'))).toEqual(identity);
    expect((target.dbHandle.prepare('SELECT COUNT(*) AS n FROM room_seats').get() as { n: number }).n).toBe(1);
  });

  it('F3：即使有有效席位，身份域配置不一致仍然拒绝启动', async () => {
    const { ctx } = await setupWorld();
    ctx.cfg.identityUrl = 'https://different-authority.invalid';
    const next = PARLOR.create(ctx); worlds.push(next);
    await expect(next.start(new FakeHost())).rejects.toThrow('另一统一身份服务');
  });
});
