import { toolForOperation } from './helpers/tool-operations.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { PARLOR } from '../src/definition.ts';
import { ParlorClient, ParlorHttpError } from '../src/room/client.ts';
import { WorldServer } from '../src/room/world-server.ts';
import { pgServerStorage } from './helpers/pg.ts';
import { FakeHost } from './helpers/fake-host.ts';

let scratchDir: string;
let server: WorldServer;
let world: ReturnType<typeof PARLOR.create> | undefined;
let secrets: Record<string, string>;

beforeEach(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), 'parlor-startup-fix-'));
  server = await WorldServer.create({
    ...(await pgServerStorage(':memory:')), port: 0, inviteCode: 'inv', allowGuestJoin: true, identityAuthority: 'self',
  });
  await server.listen();
  secrets = { PARLOR_INVITE_CODE: 'inv' };
});

afterEach(async () => {
  await world?.stop();
  world = undefined;
  await server?.close();
  vi.restoreAllMocks();
  rmSync(scratchDir, { recursive: true, force: true });
});

const context = () => {
  const base = fakeWorldContext(PARLOR, { scratchDir });
  base.cfg.serverUrl = server.url;
  base.cfg.identityUrl = server.url;
  base.cfg.inviteCode = 'inv';
  base.cfg.seatName = '小满';
  base.cfg.room = 'hall';
  return { ...base, secret: (name: string) => secrets[name] ?? '',
    storeSecret: (name: string, value: string) => { secrets[name] = value; } };
};

const start = async (ctx = context()) => {
  world = PARLOR.create(ctx);
  const host = new FakeHost();
  await world.start(host);
  return host;
};
const currentRoom = async () => (await world!.envPromptVars() as Record<string,string> | null)?.['parlor.room'];
const snapshot = async () => new ParlorClient(server.url).snapshot(secrets.PARLOR_SEAT_TOKEN, 0, 1, await currentRoom());

describe('换服务器与启动时改名', () => {
  it.each([false, true])('失效的当前厅回配置默认厅并写回，残留令牌=%s', async staleToken => {
    secrets.PARLOR_CURRENT_ROOM = 'r-missing';
    if (staleToken) secrets.PARLOR_SEAT_TOKEN = 'stale-seat-token';
    const host = await start();
    expect(await currentRoom()).toBe('hall');
    expect((await snapshot()).seat.name).toBe('小满');
    expect(host.events.some(e => e.type === 'parlor.link' && e.text.includes('原客厅不存在，已回到大厅'))).toBe(true);
  });

  it('配置默认厅也无效时诚实失败，不悄悄换到别处', async () => {
    const ctx = context();
    ctx.cfg.room = 'r-also-missing';
    secrets.PARLOR_CURRENT_ROOM = 'r-missing';
    await expect(start(ctx)).rejects.toThrow('目标客厅不存在');
    expect(secrets.PARLOR_CURRENT_ROOM).toBe('r-missing');
  });

  it('404 回配置中的普通客厅，权限拒绝与错误邀请码不触发兜底', async () => {
    await start();
    const client = new ParlorClient(server.url);
    const { room } = await client.createRoom({ name: '配置厅', visibility: 'public' }, secrets.PARLOR_SEAT_TOKEN);
    await world!.stop();
    secrets.PARLOR_CURRENT_ROOM = 'r-missing';
    delete secrets.PARLOR_SEAT_TOKEN;
    // 让同一身份回目标厅，不遗留大厅席位。
    const identity = JSON.parse(readFileSync(join(context().dataDir, 'parlor-identity.json'), 'utf8'));
    const active = await server.dbHandle.prepare('SELECT id FROM room_seats WHERE coo_id = ? AND released_at IS NULL').get(identity.cooId) as { id: string };
    await server.dbHandle.prepare('UPDATE room_seats SET released_at = ? WHERE id = ?').run(Date.now(), active.id);
    const joinRequest = vi.spyOn(ParlorClient.prototype, 'join').mockRejectedValueOnce(new ParlorHttpError(404, '目标客厅不存在'));
    const ctx = context(); ctx.cfg.room = room.id;
    await start(ctx);
    expect(await currentRoom()).toBe(room.id);
    expect(joinRequest).toHaveBeenCalledTimes(2);
    await world!.stop();
    secrets.PARLOR_CURRENT_ROOM = 'r-missing'; delete secrets.PARLOR_SEAT_TOKEN;
    joinRequest.mockClear().mockRejectedValueOnce(new ParlorHttpError(403, '邀请码不对'));
    await expect(start(ctx)).rejects.toThrow('邀请码不对');
    expect(joinRequest).toHaveBeenCalledTimes(1);
  });

  it('正常串门后重启仍回原厅并保留席位', async () => {
    await start();
    const client = new ParlorClient(server.url);
    const { room } = await client.createRoom({ name: '串门厅', visibility: 'public' }, secrets.PARLOR_SEAT_TOKEN);
    const tool = toolForOperation(world!, 'parlor_room_visit')!;
    await tool.handler({ room: room.id }, {} as ToolCallContext);
    const before = await snapshot();
    await world!.stop();
    const ctx = context();
    ctx.cfg.identityUrl = server.url;
    await start(ctx);
    expect(await currentRoom()).toBe(room.id);
    expect((await snapshot()).seat.id).toBe(before.seat.id);
  });

  it.each([false, true])('改席名后启动原席位立即改名，不换席位，令牌丢失=%s', async lostToken => {
    await start();
    const before = await snapshot();
    await world!.stop();
    if (lostToken) delete secrets.PARLOR_SEAT_TOKEN;
    const rename = vi.spyOn(ParlorClient.prototype, 'rename');
    const ctx = context();
    ctx.cfg.seatName = '  换名后   的小满  ';
    await start(ctx);
    const after = await snapshot();
    expect(after.seat.id).toBe(before.seat.id);
    expect(after.seat.name).toBe('换名后 的小满');
    expect(rename).toHaveBeenCalledTimes(1);
    await world!.stop();
    await start(ctx);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('旧服务器缺少改名入口时继续连接并给出处置说明', async () => {
    await start();
    await world!.stop();
    vi.spyOn(ParlorClient.prototype, 'rename').mockRejectedValue(new ParlorHttpError(404, '没有这个接口'));
    const ctx = context(); ctx.cfg.seatName = '新名字';
    const host = await start(ctx);
    expect(host.events.some(e => e.type === 'parlor.link' && e.text.includes('请升级服务器'))).toBe(true);
    expect((await snapshot()).seat.name).toBe('小满');
  });

  it('续用有效令牌时改名不重新向身份服务取通行证', async () => {
    await start();
    await world!.stop();
    // 补档本来就需要身份通行证；这里隔离它，只检验续席与改名本身。
    vi.spyOn(ParlorClient.prototype, 'replayAsIdentity').mockResolvedValue({
      room: 'hall', latest: 0, now: Date.now(), at: '', retentionDays: 7, events: [], older: false,
    });
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).includes('/v1/identity/')) throw new Error('身份服务已离线');
      return originalFetch(input, init);
    });
    const ctx = context(); ctx.cfg.seatName = '离线时改名';
    await start(ctx);
    expect((await snapshot()).seat.name).toBe('离线时改名');
    expect(fetchSpy.mock.calls.some(([input]) => String(input).includes('/v1/identity/'))).toBe(false);
  });

  it('身份服务不一致时说明绝对路径、删除步骤与原身份无法自动恢复', async () => {
    const ctx = context();
    const file = join(ctx.dataDir, 'parlor-identity.json');
    const identity = { cooId: 'coo-mismatch01', cooSecret: 'identity-secret-012345678901', authority: 'https://old.example' };
    writeFileSync(file, JSON.stringify(identity));
    await expect(start(ctx)).rejects.toThrow(file);
    await expect(start(ctx)).rejects.toThrow('删除本机身份文件');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(identity);
  });

  it('改名接口只接受有效席位令牌，拒绝空名与超长名字', async () => {
    await start();
    const before = await snapshot();
    const post = (token: string, name: string) => fetch(`${server.url}/v1/me/rename`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name, cooId: 'someone-else', seatId: 'someone-else' }),
    });
    expect((await post('forged', '冒名')).status).toBe(401);
    expect((await post(secrets.PARLOR_SEAT_TOKEN, ' ')).status).toBe(400);
    expect((await post(secrets.PARLOR_SEAT_TOKEN, '长'.repeat(25))).status).toBe(400);
    expect((await post(secrets.PARLOR_SEAT_TOKEN, '自己改名')).status).toBe(200);
    expect((await snapshot()).seat).toMatchObject({ id: before.seat.id, name: '自己改名' });
  });

  it.each(['ddz', 'werewolf'])('%s 家长局中改名后，HTTP 快照和增量牌桌即时跟随，允许与别人同名', async game => {
    await start();
    const play = await fetch(`${server.url}/v1/parent/play`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: secrets.PARLOR_OWNER_TOKEN, room: 'lobby' }),
    });
    expect(play.status).toBe(200);
    const cookie = play.headers.get('set-cookie')!.split(';')[0];
    const parent = await play.json() as { token: string; seat: { id: string; name: string } };
    const client = new ParlorClient(server.url);
    await client.action(parent.token, { type: 'table_open', game, requestId: 'open' }, 'lobby');
    for (let i = 0; i < (game === 'ddz' ? 2 : 8); i++) {
      const friend = new ParlorClient(server.url, { cooId: `coo-renamer${i}`, cooSecret: `rename-secret-${i}-0123456789` });
      await friend.initializeIdentity(server.url, '', `同行${i}`);
      const joined = await friend.join('inv', { name: `同行${i}` }, 'lobby');
      await friend.action(joined.token, { type: 'table_join', requestId: `join-${i}` }, 'lobby');
    }
    await client.action(parent.token, { type: 'table_start', requestId: 'start' }, 'lobby');
    const before = await client.snapshot(parent.token, 0, 1, 'lobby');
    const renamed = await fetch(`${server.url}/v1/parent/rename`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: '同行0' }),
    });
    expect(renamed.status).toBe(200);
    const after = await client.snapshot(parent.token, 0, 1, 'lobby');
    const named = (view: unknown) => (view as { seats: Array<{ id: string; name: string }> }).seats.find(s => s.id === parent.seat.id)?.name;
    expect(named(after.table)).toBe('同行0');
    expect(named(after.tables![0])).toBe('同行0');
    const slice = await fetch(`${server.url}/v1/rooms/lobby/table`, { headers: { authorization: `Bearer ${parent.token}` } });
    const sliced = await slice.json() as { table: unknown; tables: unknown[] };
    expect(named(sliced.table)).toBe('同行0');
    expect(named(sliced.tables[0])).toBe('同行0');
    expect(after.table?.revision).toBe(before.table?.revision);
    expect(after.tablePrivate?.hand).toEqual(before.tablePrivate?.hand);
  });
});
