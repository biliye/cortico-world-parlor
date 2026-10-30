/**
 * 网页邀请：Coo 可以邀请已有家长账户的人，人不在座也能邀请（信留在信箱里，下次打开网页
 * 还能看到）。没有家长账户的群友席不接受邀请；还没下过场的家长没有可收信的身份。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldServer } from '../src/room/world-server.ts';

const A = 'coo-inviteaaa1';
const B = 'coo-invitebbb1';

let dir: string | undefined;
let server: WorldServer | undefined;

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const start = async (): Promise<WorldServer> => {
  dir = mkdtempSync(join(tmpdir(), 'parlor-invite-'));
  server = new WorldServer({
    allowGuestJoin: true,
    dbFile: join(dir, 'parlor.db'),
    port: 0,
    inviteCode: 'inv',
    defaultRoomId: 'lobby',
  });
  await server.listen();
  return server;
};

const cooHeaders = (cooId: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-parlor-coo': cooId,
  'x-parlor-coo-secret': `secret-${cooId}-0123456789`,
});

type Json = Record<string, unknown>;

const post = async (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Json, headers: response.headers };
};

const get = async (base: string, path: string, token: string) => {
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() as Json };
};

const cookieOf = (response: Response): string => (response.headers.get('set-cookie') || '').split(';')[0];

/** A 先进场（负责发邀请）；B 是孩子，返回它的 ownerKey 与家长会话 cookie。 */
const enterAs = async (app: WorldServer, cooId: string, name: string): Promise<{ token: string; ownerKey?: string }> => {
  const joined = await post(app.url, '/v1/rooms/lobby/join', { name }, { ...cooHeaders(cooId), 'x-parlor-invite': 'inv' });
  expect(joined.status).toBe(200);
  return { token: joined.body.token as string, ownerKey: joined.body.ownerKey as string | undefined };
};

const parentSession = async (app: WorldServer, ownerKey: string): Promise<string> => {
  const response = await fetch(`${app.url}/v1/parent/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: ownerKey }),
  });
  expect(response.status).toBe(200);
  return cookieOf(response);
};

const parentPlay = async (app: WorldServer, cookie: string): Promise<{ token: string; name: string }> => {
  const played = await post(app.url, '/v1/parent/play', {}, { cookie });
  expect(played.status).toBe(200);
  const seat = played.body.seat as { name: string };
  return { token: played.body.token as string, name: seat.name };
};

const invites = (mail: Json): { kind: string; room: string; text: string }[] => (
  mail.items as { kind: string; room: string; text: string }[]
).filter((item) => item.kind === 'invite');

describe('网页邀请（只对已有家长账户的人）', () => {
  it('邀请在场家长：信里有目的地，能直接换过去', async () => {
    const app = await start();
    await enterAs(app, A, '阿岚');
    const child = await enterAs(app, B, '小满');
    const cookie = await parentSession(app, child.ownerKey!);
    const parent = await parentPlay(app, cookie);

    const created = await post(app.url, '/v1/rooms', { name: '可可厅' }, cooHeaders(A));
    const roomId = (created.body.room as { id: string }).id;

    const invited = await post(app.url, '/v1/invite', { to: parent.name, room: roomId }, cooHeaders(A));
    expect(invited.status).toBe(200);
    expect(invited.body.to).toBe(parent.name);

    const mail = await get(app.url, '/v1/mail?all=1', parent.token);
    const letters = invites(mail.body);
    expect(letters.length).toBe(1);
    expect(letters[0].room).toBe(roomId);
    expect(letters[0].text).toContain('可可厅');
    expect(letters[0].text).toContain('信箱');

    const moved = await post(app.url, '/v1/rooms/lobby/switch', { to: roomId }, {
      authorization: `Bearer ${parent.token}`,
    });
    expect(moved.status).toBe(200);
    expect(moved.body.room).toBe(roomId);
  });

  it('人不在座也能邀请：信留在信箱里，下次下场还看得到', async () => {
    const app = await start();
    await enterAs(app, A, '阿岚');
    const child = await enterAs(app, B, '小满');
    const cookie = await parentSession(app, child.ownerKey!);
    const parent = await parentPlay(app, cookie);

    expect((await post(app.url, '/v1/rooms/lobby/leave', {}, {
      authorization: `Bearer ${parent.token}`,
    })).status).toBe(200);

    const created = await post(app.url, '/v1/rooms', { name: '晚风厅' }, cooHeaders(A));
    const roomId = (created.body.room as { id: string }).id;
    const invited = await post(app.url, '/v1/invite', { to: parent.name, room: roomId }, cooHeaders(A));
    expect(invited.status).toBe(200);

    // 重新下场（默认回大厅），信箱里那封还在。
    const again = await parentPlay(app, cookie);
    const mail = await get(app.url, '/v1/mail?all=1', again.token);
    const letters = invites(mail.body);
    expect(letters.some((item) => item.room === roomId && item.text.includes('晚风厅'))).toBe(true);
  });

  it('没有家长账户的席位不接受邀请', async () => {
    const app = await start();
    await enterAs(app, A, '阿岚');
    const guest = await post(app.url, '/v1/player/join', { name: '路人' }, { 'x-parlor-invite': 'inv' });
    expect(guest.status).toBe(200);

    const invited = await post(app.url, '/v1/invite', { to: '路人' }, cooHeaders(A));
    expect(invited.status).toBe(403);
    expect(String(invited.body.message ?? invited.body.error ?? '')).toContain('家长账户');
  });

  it('还没下过场的家长没有可收信的身份', async () => {
    const app = await start();
    await enterAs(app, A, '阿岚');
    await enterAs(app, B, '小满');

    const invited = await post(app.url, '/v1/invite', { to: '小满的家长' }, cooHeaders(A));
    expect(invited.status).toBe(409);
    expect(String(invited.body.message ?? invited.body.error ?? '')).toContain('下场玩');
  });
});
