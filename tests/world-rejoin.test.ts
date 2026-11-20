/** 席位被服务器释放后，World 不能拿着死令牌一直重试：要按同一身份重新入座。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pgServerStorage } from './helpers/pg.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { WorldContext } from 'cortico/world.ts';
import { PARLOR } from '../src/definition.ts';
import type { ParlorConfigSection } from '../src/config.ts';
import { ParlorClient } from '../src/room/client.ts';
import { WorldServer } from '../src/room/world-server.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { toolForOperation } from './helpers/tool-operations.ts';

const until = async (predicate: () => boolean | Promise<boolean>, timeout = 8000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待超时');
};

let scratchDir: string;
let server: WorldServer | undefined;
let world: ReturnType<typeof PARLOR.create> | undefined;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'parlor-rejoin-'));
});

afterEach(async () => {
  await world?.stop();
  world = undefined;
  await server?.close();
  server = undefined;
  rmSync(scratchDir, { recursive: true, force: true });
});

describe('席位被释放后的自动重入', () => {
  it('服务器闲置迁厅后保留凭据回大厅，重启后不会回到旧配置客厅', async () => {
    // 0.36.3 起 Coo 闲置迁厅默认 300 分钟；这条用例只验迁厅机制，
    // 所以显式把宽限设回 60 分钟，免得把下面的 1 小时老化变成「没到期」。
    server = await WorldServer.create({ ...(await pgServerStorage(':memory:')), inviteCode:'inv', cooIdleMinutes: 60 });
    await server.listen();
    const secrets:Record<string,string>={ PARLOR_INVITE_CODE:'inv' };
    const base=fakeWorldContext(PARLOR,{scratchDir});
    const ctx:WorldContext<ParlorConfigSection>={...base,secret:name=>secrets[name]??'',storeSecret:(name,value)=>{secrets[name]=value;}};
    ctx.cfg.serverUrl=server.url;ctx.cfg.identityUrl=server.url;ctx.cfg.room='lobby';ctx.cfg.seatName='自动回厅';
    world=PARLOR.create(ctx);
    const host=new FakeHost();await world.start(host);
    await until(async()=>!!await server!.dbHandle.prepare("SELECT 1 FROM room_seats WHERE name='自动回厅' AND location_capable=1").get());
    const token=secrets.PARLOR_SEAT_TOKEN;
    await server.dbHandle.prepare("UPDATE room_seats SET business_active_at=? WHERE name='自动回厅'").run(Date.now()-3_600_000-1000);
    expect((await server.runLifecycle()).moved).toBe(1);
    await until(()=>host.events.some(event=>event.type==='parlor.link'&&event.text.includes('回到大厅')));
    await world.stop();
    world=PARLOR.create(ctx);await world.start(new FakeHost());
    const active=await server.dbHandle.prepare("SELECT room_id FROM room_seats WHERE name='自动回厅' AND released_at IS NULL").get() as {room_id:string};
    expect(active.room_id).toBe('hall');
    expect(secrets.PARLOR_SEAT_TOKEN).toBe(token);
  });
  it('旧令牌 401 时换新令牌重新入座，并留一句说明', async () => {
    server = await WorldServer.create({ allowGuestJoin: true, ...(await pgServerStorage(':memory:')), port: 0, inviteCode: 'inv' });
    await server.listen();

    const secrets: Record<string, string> = { PARLOR_INVITE_CODE: 'inv' };
    const base = fakeWorldContext(PARLOR, { scratchDir });
    const ctx: WorldContext<ParlorConfigSection> = {
      ...base,
      secret: (name) => secrets[name] ?? '',
      storeSecret: (name, value) => { secrets[name] = value; },
    };
    ctx.cfg.serverUrl = server.url;
    ctx.cfg.identityUrl = server.url;
    ctx.cfg.seatName = '小满';
    ctx.cfg.room = 'hall';
    world = PARLOR.create(ctx);
    const host = new FakeHost();
    await world.start(host);

    // 先确认流真的接上了：朋友说一句，World 收到才算在线。否则测试会撞上
    // 「流还没建立就被释放」的时序，测不到重连那一段。
    const friend = new ParlorClient(server.url, {
      cooId: 'coo-ffffffff',
      cooSecret: 'friend-secret-0123456789',
    });
    const joined = await friend.join('inv', { name: '阿岚' }, 'hall');
    await friend.action(joined.token, { type: 'say', text: '@小满 在吗' }, 'hall');
    await until(() => host.events.some((event) => event.type === 'parlor.message'));

    const activeSeat = async (): Promise<{ id: string } | undefined> => (
      await server!.dbHandle.prepare(
        "SELECT id FROM room_seats WHERE released_at IS NULL AND name = '小满'",
      ).get() as { id: string } | undefined
    );
    const before = await activeSeat();
    expect(before).toBeDefined();

    // 模拟离线清理把席位收走：SSE 泵下一拍会发现席位不在并收掉连接，
    // World 拿旧令牌重连会 401。
    await server!.dbHandle.prepare('UPDATE room_seats SET released_at = ? WHERE id = ?')
      .run(Date.now(), before!.id);

    await until(async () => {
      const now = await activeSeat();
      return !!now && now.id !== before!.id;
    });
    await until(() => host.events.some(
      (event) => event.type === 'parlor.link' && event.origin === 'external' && event.text.includes('已重新连上席位'),
    ));
  });
});

it('主动退厅保持无席位，重启后可用原身份按名字再次进厅', async () => {
  server = await WorldServer.create({ ...(await pgServerStorage(':memory:')), port: 0, inviteCode: 'inv', identityAuthority: 'self' });
  await server.listen();
  const base = fakeWorldContext(PARLOR, { scratchDir });
  base.cfg.serverUrl = base.cfg.identityUrl = server.url;
  base.cfg.inviteCode = 'inv';
  base.cfg.room = 'hall';
  base.cfg.seatName = '主动退厅的 Coo';
  const secrets: Record<string, string> = {};
  const ctx = { ...base, secret: (name: string) => secrets[name] ?? '',
    storeSecret: (name: string, value: string) => { secrets[name] = value; } };
  world = PARLOR.create(ctx);
  await world.start(new FakeHost());

  const invoke = (op: string, args: Record<string, unknown> = {}) => toolForOperation(world!, op)!.handler(args, {} as never);
  const query = (op: string, params: Record<string, unknown> = {}) =>
    world!.tools().find(tool => tool.name === 'parlor_query')!.handler({ op, params }, {} as never);
  const client = new ParlorClient(server.url);
  const { room } = await client.createRoom({ name: '回访客厅', visibility: 'public' }, secrets.PARLOR_SEAT_TOKEN);
  const oldToken = secrets.PARLOR_SEAT_TOKEN;
  const { cooId } = await client.me(oldToken);
  await client.action(oldToken, { type: 'say', text: '留给退厅后的回放' }, 'hall');

  // 模拟已记下退厅意图，离席请求还没有发出时进程退出。
  await world.stop();
  const cursorFile = join(ctx.dataDir, 'parlor-cursor.json');
  const cursor = JSON.parse(readFileSync(cursorFile, 'utf8'));
  writeFileSync(cursorFile, JSON.stringify({ ...cursor, leftBy: cooId }));
  world = PARLOR.create(ctx);
  await world.start(new FakeHost());
  const originalSeat = (await client.location(oldToken)).seat!;
  expect(await invoke('parlor_room_visit', { room: room.name })).toMatchObject({
    failed: true, text: expect.stringMatching(/当前在「大厅」.*leave.*visit/),
  });
  // 尝试入别的厅不会偷偷释放服务器上的旧席位。
  expect(await client.location(oldToken)).toMatchObject({ room: 'hall', seat: { id: originalSeat.id } });
  expect(await invoke('parlor_room_leave')).toContain('已离开客厅');
  expect(secrets.PARLOR_SEAT_TOKEN).toBe('');
  expect(await invoke('parlor_rooms')).toContain('我不在任何客厅');
  expect(await invoke('parlor_room_leave')).toBe('你不在任何客厅。');
  await expect(client.location(oldToken)).rejects.toMatchObject({ status: 401 });
  expect(await query('mail', { peek: true })).toContain('【信箱】');
  expect(await query('mail', { markAllRead: true })).toContain('本次标了');
  expect(await query('account')).toContain('【账本】');
  expect(await query('account', { kind: 'games' })).toContain('【我的全局记录】');
  expect(await query('news')).toBe('还没有新闻。');
  expect(await query('history')).toMatchObject({ failed: true, text: expect.stringContaining('params.room') });
  expect(await query('history', { room: 'hall' })).toContain('留给退厅后的回放');

  await world.stop();
  // 游标中的退厅意图优先于可能残留的旧令牌。
  secrets.PARLOR_SEAT_TOKEN = oldToken;
  world = PARLOR.create(ctx);
  await world.start(new FakeHost());
  expect(await invoke('parlor_rooms')).toContain('我不在任何客厅');
  await server.dbHandle.prepare(`INSERT INTO coo_sessions (coo_id, created_at, last_seen_at, return_room_id)
    VALUES (?, ?, ?, 'hall') ON CONFLICT (coo_id) DO UPDATE SET return_room_id = 'hall'`).run(cooId, Date.now(), Date.now());
  expect(await invoke('parlor_room_visit', { room: room.name })).toContain('已进入');
  expect(await client.me(secrets.PARLOR_SEAT_TOKEN)).toMatchObject({ cooId, seat: { room: room.id } });

  await world.stop();
  world = PARLOR.create(ctx);
  await world.start(new FakeHost());
  expect(world.envPromptVars?.()).toMatchObject({ 'parlor.room': room.id });
});
