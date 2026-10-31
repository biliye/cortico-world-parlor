/** 多客厅 World：开客厅、串门、回大厅、邀请，以及专注 B。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { WorldContext } from 'cortico/world.ts';
import { PARLOR } from '../src/definition.ts';
import type { ParlorConfigSection } from '../src/config.ts';
import { ParlorClient } from '../src/room/client.ts';
import { WorldServer } from '../src/room/world-server.ts';
import type { WakeTier } from '../src/room/protocol.ts';
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
let server: WorldServer | undefined;
let world: ReturnType<typeof PARLOR.create> | undefined;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'parlor-multiroom-'));
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

const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
  const tool = world!.tools().find((entry) => entry.name === name);
  if (!tool) throw new Error(`没有工具 ${name}`);
  const result = await tool.handler(args, {} as ToolCallContext);
  return typeof result === 'string' ? result : result.text;
};

const startWorld = async (options: { room?: string; tier?: WakeTier } = {}): Promise<{
  host: FakeHost; friend: ParlorClient; friendToken: string; secrets: Record<string, string>;
  ctx: WorldContext<ParlorConfigSection>;
}> => {
  server = new WorldServer({ allowGuestJoin: true, dbFile: ':memory:', port: 0, inviteCode: 'inv' });
  await server.listen();
  const secrets: Record<string, string> = {
    PARLOR_INVITE_CODE: 'inv',
    PARLOR_ALLOW_GUEST_JOIN: '1',
  };
  const ctx = makeContext(secrets);
  ctx.cfg.serverUrl = server.url;
    ctx.cfg.identityUrl = server.url;
  // 这些用例考的是同房串门与牌桌，落在大厅开不了桌；默认值本身另有用例。
  ctx.cfg.room = options.room ?? 'lobby';
  if (options.tier) ctx.cfg.wakeTier = options.tier;
  ctx.cfg.seatName = '小满';
  world = PARLOR.create(ctx);
  const host = new FakeHost();
  await world.start(host);
  const friend = new ParlorClient(server.url, {
    cooId: 'coo-ffffffff',
    cooSecret: 'friend-secret-0123456789',
  });
  const joined = await friend.join('inv', { name: '阿岚' }, ctx.cfg.room);
  return { host, friend, friendToken: joined.token, secrets, ctx };
};

const visitAndLeave = async (room: string): Promise<number> => {
  const visitor = new ParlorClient(server!.url, {
    cooId: 'coo-visitor-0001', cooSecret: 'visitor-secret-0123456789',
  });
  const joined = await visitor.join('inv', { name: '来访家长', kind: 'human' }, room);
  return (await visitor.leaveRoom(joined.token, room)).seq;
};

const pushedText = (host: FakeHost): string => host.events
  .filter((event) => event.type === 'parlor.message' || event.type === 'parlor.digest')
  .map((event) => event.text).join('\n');

describe('大厅进出不主动推给 Coo', () => {
  it.each(['full', 'digest', 'quiet', 'off'] as const)('%s：大厅进出不进推送或摘要，游标仍推进', async (tier) => {
    const { host, friend, friendToken, ctx } = await startWorld({ room: 'hall', tier });
    const leftSeq = await visitAndLeave('hall');
    await until(() => {
      try {
        const cursor = JSON.parse(readFileSync(join(ctx.dataDir, 'parlor-cursor.json'), 'utf8'));
        return cursor.rooms.hall >= leftSeq;
      } catch { return false; }
    });
    const history = await friend.history(friendToken, 0, 50, 'hall');
    const presence = history.events.filter((event) => event.data?.name === '来访家长');
    expect(presence.map((event) => event.type)).toEqual(['parlor.joined', 'parlor.left']);
    expect(pushedText(host)).not.toContain('进了大厅');
    expect(pushedText(host)).not.toContain('离开了大厅');

    if (tier === 'off') {
      expect(pushedText(host)).toBe('');
      return;
    }
    // 普通聊天仍按原挡位处理；被 @ 时也不能把过滤掉的进出事件夹带回来。
    await friend.action(friendToken, { type: 'say', text: '大厅里仍可说话' }, 'hall');
    await sleep(60);
    await friend.action(friendToken, { type: 'say', text: '@小满 大厅点名仍收到' }, 'hall');
    await until(() => pushedText(host).includes('大厅点名仍收到'));
    expect(pushedText(host)).toContain('大厅里仍可说话');
    expect(pushedText(host)).not.toContain('进了大厅');
    expect(pushedText(host)).not.toContain('离开了大厅');
    // 只停自动投递；主动查看与网页共用的历史仍保留记录。
    expect(await call('parlor_look', { limit: 50 })).toContain('来访家长');
  });

  it.each(['full', 'digest', 'quiet'] as const)('%s：普通客厅仍按原挡位推送进出', async (tier) => {
    const { host, friend, friendToken } = await startWorld({ tier });
    await visitAndLeave('lobby');
    await friend.action(friendToken, { type: 'say', text: '@小满 客厅点名' }, 'lobby');
    await until(() => pushedText(host).includes('客厅点名'));
    expect(pushedText(host)).toContain('来访家长 进了');
    expect(pushedText(host)).toContain('来访家长 离开了');
  });

  it('重启补发的大厅进出也不混进消息', async () => {
    const { ctx, host, friend, friendToken } = await startWorld({ room: 'hall', tier: 'quiet' });
    await friend.action(friendToken, { type: 'say', text: '@小满 重启前确认' }, 'hall');
    await until(() => pushedText(host).includes('重启前确认'));
    await world!.stop();
    world = undefined;
    await visitAndLeave('hall');
    await sleep(60);
    await friend.action(friendToken, { type: 'say', text: '@小满 重启补发仍收到' }, 'hall');
    world = PARLOR.create(ctx);
    const resumed = new FakeHost();
    await world.start(resumed);
    await until(() => pushedText(resumed).includes('重启补发仍收到'));
    expect(pushedText(resumed)).not.toContain('进了大厅');
    expect(pushedText(resumed)).not.toContain('离开了大厅');
  });
});

describe('World 多客厅', () => {
  it('删除所在客厅后自动回大厅，并能重启继续用同一身份聊天', async () => {
    const { host, secrets, ctx } = await startWorld();
    const created = await call('parlor_room_create', { name: '将删除的厅', visibility: 'public' });
    const roomId = /（(r-[A-Za-z0-9_-]+)）/.exec(created)![1];
    expect(await call('parlor_room_visit', { room: roomId })).toContain('将删除的厅');
    const oldToken = secrets.PARLOR_SEAT_TOKEN;
    const res = await fetch(server!.url + '/v1/rooms/' + roomId + '/delete', {
      method: 'POST', headers: { authorization: 'Bearer ' + oldToken },
    });
    expect(res.status).toBe(200);
    await until(() => secrets.PARLOR_CURRENT_ROOM === 'hall', 8000);
    expect(secrets.PARLOR_SEAT_TOKEN).not.toBe(oldToken);
    expect(host.events.some(e => e.type === 'parlor.link' && e.text.includes('已回到大厅'))).toBe(true);
    expect(await call('parlor_say', { text: '回到大厅还能说话' })).not.toContain('失败');
    await world!.stop();
    world = PARLOR.create(ctx);
    await world.start(new FakeHost());
    expect(await call('parlor_look')).toContain('大厅');
  });

  it('首次加入存的是 ownerKey（不是空的 ownerToken），面板家长链接能换会话', async () => {
    const { secrets } = await startWorld();
    const key = secrets.PARLOR_OWNER_TOKEN;
    expect(key).toBeTruthy();
    const session = await fetch(server!.url + '/v1/parent/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    expect(session.status).toBe(200);
    const link = (world!.webUi?.().links ?? []).find((entry) => entry.href.includes('/parent#key='));
    expect(link?.href).toContain(encodeURIComponent(key));
    // 面板三条链接：公开的网页牌桌、带钥匙的我下场玩、带钥匙的家长页。
    const links = world!.webUi?.().links ?? [];
    expect(links).toHaveLength(3);
    expect(links.some((entry) => entry.href === server!.url + '/play')).toBe(true);
    const playLink = links.find((entry) => entry.href.includes('/play#key='));
    expect(playLink?.href).toContain(encodeURIComponent(key));
  });

  it('已有账户再次加入不会把 .env 里的 ownerKey 冲掉', async () => {
    server = new WorldServer({ allowGuestJoin: true, dbFile: ':memory:', port: 0, inviteCode: 'inv' });
    await server.listen();
    const secrets: Record<string, string> = { PARLOR_INVITE_CODE: 'inv' };
    const ctx1 = makeContext(secrets);
    ctx1.cfg.serverUrl = server.url;
    ctx1.cfg.identityUrl = server.url;
    ctx1.cfg.room = 'lobby';
    ctx1.cfg.seatName = '小满';
    const first = PARLOR.create(ctx1);
    await first.start(new FakeHost());
    const saved = secrets.PARLOR_OWNER_TOKEN;
    expect(saved).toBeTruthy();
    await first.stop();

    // 席位令牌丢了、人也先离座：重新加入时服务器不会再发 ownerKey，这时不能拿空串覆盖。
    const seat = secrets.PARLOR_SEAT_TOKEN;
    const left = await fetch(server.url + '/v1/rooms/lobby/leave', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + seat, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(left.status).toBe(200);
    delete secrets.PARLOR_SEAT_TOKEN;
    const ctx2 = makeContext(secrets);
    ctx2.cfg.serverUrl = server.url;
    ctx2.cfg.identityUrl = server.url;
    ctx2.cfg.room = 'lobby';
    ctx2.cfg.seatName = '小满';
    world = PARLOR.create(ctx2);
    await world.start(new FakeHost());
    expect(secrets.PARLOR_OWNER_TOKEN).toBe(saved);
  });

  it('开客厅 → 串门 → 回大厅 → 再回去；旧席位当场释放', async () => {
    const { friend, friendToken } = await startWorld();
    const links = world!.webUi?.().links ?? [];
    expect(links.some((link) => link.href.includes('/parent#key='))).toBe(true);
    const created = await call('parlor_room_create', { name: '可可厅', visibility: 'public' });
    expect(created).toContain('可可厅');
    const roomId = /（(r-[A-Za-z0-9_-]+)）/.exec(created)?.[1];
    expect(roomId).toBeTruthy();

    const visited = await call('parlor_room_visit', { room: roomId! });
    expect(visited).toContain('可可厅');
    expect(visited).toContain('小满');
    // 旧客厅里的席位已经释放：朋友在 lobby 的快照里看不到小满。
    const lobby = await friend.snapshot(friendToken, 0, 50, 'lobby');
    expect(lobby.seats.some((seat) => seat.name === '小满')).toBe(false);

    expect(await call('parlor_rooms')).toContain('可可厅');
    expect(await call('parlor_hall')).toContain('大厅');
    expect(await call('parlor_rooms')).toContain('我在这里');
    expect(await call('parlor_room_leave')).toContain('已经在大厅');
  });

  it('开客厅固定 30 席，兼容旧参数并拒绝越界输入', async () => {
    await startWorld();
    const created = await call('parlor_room_create', { name: '大礼堂', visibility: 'public', capacity: 30 });
    expect(created).toContain('30 席');
    expect(await call('parlor_room_create', { name: '旧小容量厅', capacity: 8 })).toContain('30 席');
    expect(await call('parlor_room_create', { name: '默认人数厅' })).toContain('30 席');
    expect(world!.tools().find(t => t.name === 'parlor_room_create')!.parameters.properties).not.toHaveProperty('capacity');
    expect(await call('parlor_room_create', { name: '超编厅', capacity: 31 })).toContain('2–30');
    expect(await call('parlor_room_create', { name: '坏数厅', capacity: 12.5 })).toContain('2–30');
  });

  it('邀请跨客厅送到：对方收到 invite 事件与信，能顺着换房', async () => {
    const { friend, friendToken } = await startWorld();
    const created = await call('parlor_room_create', { name: '小满的书房', visibility: 'unlisted' });
    const roomId = /（(r-[A-Za-z0-9_-]+)）/.exec(created)?.[1];
    expect(roomId).toBeTruthy();

    const invited = await call('parlor_invite', { to: '阿岚', room: roomId, text: '来坐坐' });
    expect(invited).toContain('阿岚');

    const friendHistory = await friend.history(friendToken, 0, 100, 'lobby');
    expect(friendHistory.events.some((event) => event.type === 'parlor.invite'
      && event.text.includes('小满的书房'))).toBe(true);
    const mail = await friend.mail(friendToken, 10, true, 'lobby', true);
    expect(mail.items.some((item) => item.kind === 'invite' && item.text.includes('小满的书房'))).toBe(true);

    const moved = await friend.switchTo(friendToken, 'lobby', roomId!);
    const snapshot = await friend.snapshot(moved.token, 0, 10, roomId!);
    expect(snapshot.name).toBe('小满的书房');
  });

  it('专注 B：牌桌上的客厅闲聊不叫醒，牌局结束一次性给摘要', async () => {
    const { host, friend, friendToken } = await startWorld();
    expect(await call('parlor_table_open', { game: 'dice' })).toContain('骰子桌开了');
    await friend.action(friendToken, { type: 'table_join', requestId: 'friend-join' }, 'lobby');
    expect(await call('parlor_table_start')).toContain('服务器已收下');

    // 打牌期间客厅里的普通闲聊：不该产生 parlor.message，只进专注摘要。
    await friend.action(friendToken, { type: 'say', text: '打牌期间随口一句' }, 'lobby');
    await sleep(800);
    expect(host.events.some((event) => event.type === 'parlor.message'
      && event.text.includes('打牌期间随口一句'))).toBe(false);

    // 世界先停牌，朋友再停牌 → 牌局结束 → 一次性摘要。
    expect(await call('parlor_table_action', { action: 'stand' })).toContain('停牌了');
    const table = await friend.snapshot(friendToken, 0, 1, 'lobby');
    const revision = table.tablePrivate?.revision ?? table.table?.revision;
    expect(typeof revision).toBe('number');
    await friend.action(friendToken, {
      type: 'table_action', action: 'stand', requestId: 'friend-stand', revision,
    }, 'lobby');
    await until(() => host.events.some((event) => event.type === 'parlor.digest'
      && event.text.includes('打牌期间的客厅')));
    const digest = host.events.find((event) => event.type === 'parlor.digest')!;
    expect(digest.text).toContain('打牌期间随口一句');
  });

  it('没开局的牌桌也锁人：先退桌才能换房', async () => {
    const {} = await startWorld();
    await call('parlor_room_create', { name: '隔壁厅', visibility: 'public' });
    expect(await call('parlor_table_open', { game: 'dice' })).toContain('骰子桌开了');
    const blocked = await call('parlor_room_visit', { room: '隔壁厅' });
    expect(blocked).toMatch(/先退桌|收起来/);
    expect(await call('parlor_table_leave')).toContain('离开牌桌');
    const moved = await call('parlor_room_visit', { room: '隔壁厅' });
    expect(moved).toContain('隔壁厅');
  });
});

describe('默认落在大厅', () => {
  it('装完就在大厅；想开桌要先走进一个客厅', async () => {
    server = new WorldServer({ allowGuestJoin: true, dbFile: ':memory:', port: 0, inviteCode: 'inv' });
    await server.listen();
    const secrets: Record<string, string> = { PARLOR_INVITE_CODE: 'inv' };
    const ctx = makeContext(secrets);
    ctx.cfg.serverUrl = server.url;
    ctx.cfg.identityUrl = server.url;
    ctx.cfg.seatName = '小满';
    world = PARLOR.create(ctx);
    const host = new FakeHost();
    await world.start(host);
    expect(host.events[0]?.type).toBe('parlor.started');

    // 默认房间是 hall：朋友在大厅快照里能看到她。
    const friend = new ParlorClient(server.url, {
      cooId: 'coo-ffffffff',
      cooSecret: 'friend-secret-0123456789',
    });
    const joined = await friend.join('inv', { name: '阿岚' }, 'hall');
    const hall = await friend.snapshot(joined.token, 0, 50, 'hall');
    expect(hall.seats.some((seat) => seat.name === '小满')).toBe(true);

    // 大厅不能开桌，回执要说清怎么走。
    const refused = await call('parlor_table_open', { game: 'dice' });
    expect(refused).toContain('大厅');
    expect(refused).toContain('先走进一个客厅');
    const vars = await Promise.resolve(world!.envPromptVars()) as Record<string, string> | null;
    expect(vars?.['parlor.room']).toBe('hall');
  });
});
