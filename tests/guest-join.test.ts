import { afterEach, describe, expect, it } from 'vitest';
import { WorldServer } from '../src/room/world-server.ts';

let server: WorldServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const join = (url: string) => fetch(url + '/v1/player/join', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-parlor-invite': 'inv' },
  body: JSON.stringify({ name: '访客', room: 'hall' }),
});

describe('网页访客入口开关', () => {
  it('默认关闭：healthz 报 false，/v1/player/join 回 403', async () => {
    server = new WorldServer({ dbFile: ':memory:', port: 0, inviteCode: 'inv' });
    const address = await server.listen();
    const health = await (await fetch(address.url + '/healthz')).json() as { guestJoin: boolean };
    expect(health.guestJoin).toBe(false);
    const response = await join(address.url);
    expect(response.status).toBe(403);
    expect((await response.json() as { error?: string }).error).toContain('入口已经关闭');
  });

  it('打开时能正常加入，healthz 报 true', async () => {
    server = new WorldServer({
      dbFile: ':memory:', port: 0, inviteCode: 'inv', allowGuestJoin: true,
    });
    const address = await server.listen();
    const health = await (await fetch(address.url + '/healthz')).json() as { guestJoin: boolean };
    expect(health.guestJoin).toBe(true);
    const response = await join(address.url);
    expect(response.status).toBe(200);
  });
});
