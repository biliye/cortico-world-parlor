/** 席位被服务器释放后，World 不能拿着死令牌一直重试：要按同一身份重新入座。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

const until = async (predicate: () => boolean, timeout = 8000): Promise<void> => {
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
  it('旧令牌 401 时换新令牌重新入座，并留一句说明', async () => {
    server = new WorldServer({ allowGuestJoin: true, dbFile: ':memory:', port: 0, inviteCode: 'inv' });
    await server.listen();

    const secrets: Record<string, string> = { PARLOR_INVITE_CODE: 'inv' };
    const base = fakeWorldContext(PARLOR, { scratchDir });
    const ctx: WorldContext<ParlorConfigSection> = {
      ...base,
      secret: (name) => secrets[name] ?? '',
      storeSecret: (name, value) => { secrets[name] = value; },
    };
    ctx.cfg.serverUrl = server.url;
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

    const activeSeat = () => server!.dbHandle.prepare(
      "SELECT id FROM room_seats WHERE released_at IS NULL AND name = '小满'",
    ).get() as { id: string } | undefined;
    const before = activeSeat();
    expect(before).toBeDefined();

    // 模拟离线清理把席位收走：SSE 泵下一拍会发现席位不在并收掉连接，
    // World 拿旧令牌重连会 401。
    server!.dbHandle.prepare('UPDATE room_seats SET released_at = ? WHERE id = ?')
      .run(Date.now(), before!.id);

    await until(() => {
      const now = activeSeat();
      return !!now && now.id !== before!.id;
    });
    await until(() => host.events.some(
      (event) => event.type === 'parlor.link' && event.text.includes('重新入座'),
    ));
  });
});
