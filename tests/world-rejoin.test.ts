/** 席位被服务器释放后，World 不能拿着死令牌一直重试：要按同一身份重新入座。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pgServerStorage } from './helpers/pg.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { WorldContext } from 'cortico/world.ts';
import { PARLOR } from '../src/definition.ts';
import type { ParlorConfigSection } from '../src/config.ts';
import { ParlorClient } from '../src/room/client.ts';
import { WorldServer } from '../src/room/world-server.ts';
import { FakeHost } from './helpers/fake-host.ts';

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
      (event) => event.type === 'parlor.link' && event.text.includes('重新入座'),
    ));
  });
});
