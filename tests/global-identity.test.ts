import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldServer } from '../src/room/world-server.ts';
import { ParlorClient } from '../src/room/client.ts';
import { IdentityRegistry, GLOBAL_HEADER, IDENTITY_TTL } from '../src/room/global-identity.ts';
import { mentionsInText } from '../src/room/mentions.ts';
import { migrate, openDb } from '../src/room/db.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { PARLOR } from '../src/definition.ts';
import { FakeHost } from './helpers/fake-host.ts';

const servers: WorldServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const start = async (authority = 'self', dbFile?: string, now?: () => number) => {
  const s = new WorldServer({ identityAuthority: authority, dbFile, now, allowGuestJoin: true });
  servers.push(s); await s.listen(); return s;
};
const id = (suffix: string) => ({ cooId: `12345678-${suffix}-4000-8000-000000000000`, cooSecret: `secret-${suffix}-01234567890123456789` });
const session = async (s: WorldServer, identity: ReturnType<typeof id>, audience = s.url, name = '小明') => {
  const res = await fetch(s.url + '/v1/identity/session', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...identity, audience, name }) });
  return { status: res.status, body: await res.json() as any };
};

describe('全局身份', () => {
  it('两台服务器沿用身份/唯一短号，昵称可重复；目标不保存长期凭证', async () => {
    const authority = await start(); const other = await start(authority.url);
    const a = new ParlorClient(authority.url, id('aaaa'));
    const b = new ParlorClient(authority.url, id('bbbb'));
    await a.initializeIdentity(authority.url, '', '小明');
    await b.initializeIdentity(authority.url, '', '小明');
    const ja = await a.join('', { name: '小明' }); const jb = await b.join('', { name: '小明' });
    expect(ja.seat.name).toBe('小明'); expect(jb.seat.name).toBe('小明');
    expect(ja.seat.handle).toBe('12345678'); expect(jb.seat.handle).toBe('12345678-');
    const remote = new ParlorClient(other.url, id('bbbb'));
    await remote.initializeIdentity(authority.url, '', '小明');
    const joined = await remote.join('', { name: '小明' });
    expect(joined.seat.handle).toBe(jb.seat.handle);
    expect((await remote.me()).cooId).toBe(id('bbbb').cooId);
    expect(other.dbHandle.prepare('SELECT secret_hash FROM coos WHERE id=?').get(id('bbbb').cooId)).toEqual({ secret_hash: null });
    // 这台只有第二位：不能让第一位的全局短号被当成第二位的 ID 前缀。
    await expect(remote.invite('#12345678')).rejects.toThrow('尚不认识');
    const snap = await a.snapshot(ja.token);
    expect(snap.seats.map(s => s.name)).toEqual(['小明', '小明']);
    await expect(a.action(ja.token, { type: 'whisper', to: '小明', text: '不能猜' })).rejects.toThrow('同名');
    await a.action(ja.token, { type: 'whisper', to: '小明 #12345678-', text: '只给第二位' });
    const mail = await b.mail(jb.token);
    expect(mail.items.some(m => m.text.includes('只给第二位') && m.fromHandle === '12345678')).toBe(true);
    // 已分配的 8 位短号优先于其他人的更长前缀。
    const invite = await session(authority, id('aaaa'));
    const search = await fetch(authority.url + '/v1/people?q=%2312345678', { headers: { [GLOBAL_HEADER]: invite.body.token } });
    expect(search.status).toBe(200);
  });

  it('错凭证、错目标、伪造通行证和已过期通行证均拒绝', async () => {
    let now = Date.now(); const authority = await start('self', undefined, () => now);
    const remote = await start(authority.url);
    const good = await session(authority, id('aaaa'));
    expect((await session(authority, { ...id('aaaa'), cooSecret: 'wrong-secret-012345678901234567' })).status).toBe(403);
    const headers = { [GLOBAL_HEADER]: good.body.token };
    expect((await fetch(remote.url + '/v1/me', { headers })).status).toBe(401);
    expect((await fetch(authority.url + '/v1/me', { headers: { [GLOBAL_HEADER]: 'forged' } })).status).toBe(401);
    now += IDENTITY_TTL + 1;
    expect((await fetch(authority.url + '/v1/me', { headers })).status).toBe(401);
    expect((await fetch(remote.url + '/v1/me', { headers: { 'x-parlor-coo': id('aaaa').cooId, 'x-parlor-coo-secret': id('aaaa').cooSecret } })).status).toBe(401);
  });

  it('旧身份原号接入；昵称改变后短号固定；重启/迁移保留短号和同名席位', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'global-identity-')); dirs.push(dir);
    const file = join(dir, 'parlor.db'); const authority = await start('self', file);
    const a = new ParlorClient(authority.url, id('aaaa'));
    await a.initializeIdentity(authority.url, '', '旧名字'); await a.join('', { name: '旧名字' });
    const first = await session(authority, id('aaaa'), authority.url, '新名字');
    expect(first.body.person.handle).toBe('12345678');
    const b = new ParlorClient(authority.url, id('bbbb'));
    await b.initializeIdentity(authority.url, '', '旧名字'); await b.join('', { name: '旧名字' });
    await authority.close(); servers.splice(servers.indexOf(authority), 1);
    const again = await start('self', file);
    expect((await session(again, id('bbbb'))).body.person.handle).toBe('12345678-');
    expect(again.dbHandle.prepare("SELECT COUNT(*) AS n FROM room_seats WHERE name='旧名字' AND released_at IS NULL").get()).toEqual({ n: 2 });
  });

  it('同名裸 @ 不误叫；@#号 和 @名字 #号 只叫对应的人', () => {
    const seats = [{ id: 'a', name: '小明', handle: '12345678' }, { id: 'b', name: '小明', handle: '12345678-' }];
    expect(mentionsInText('@小明 你好', seats)).toEqual([]);
    expect(mentionsInText('@#12345678- 你好', seats)).toEqual(['b']);
    expect(mentionsInText('@小明 #12345678 你好', seats)).toEqual(['a']);
  });

  it('分配使用唯一约束；同一个 ID 不能改凭证认领', () => {
    const db = openDb(); migrate(db);
    try {
      const registry = new IdentityRegistry(db);
      const person = registry.enroll(id('aaaa').cooId, id('aaaa').cooSecret, '小明');
      expect(registry.enroll(id('aaaa').cooId, id('aaaa').cooSecret, '改名').handle).toBe(person.handle);
      expect(() => registry.enroll(id('aaaa').cooId, 'other-secret-012345678901234', '冒名')).toThrow('凭证');
    } finally { db.close(); }
  });

  it('网页同一浏览器进入两台服务器，沿用玩家身份；跳转链接不携带长期密钥', async () => {
    const authority = await start(); const remote = await start(authority.url);
    const storage = new Map<string, string>();
    const script = readFileSync(new URL('../src/web/identity.js', import.meta.url), 'utf8').replace('enter();', 'globalThis.done = enter();');
    const enter = async (target: WorldServer) => {
      let destination = '';
      const sandbox: any = {
        document: { getElementById: () => ({ addEventListener() {}, hidden: false, textContent: '' }) },
        localStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) },
        location: { search: '?'+new URLSearchParams({ returnTo: target.url + '/play', state: 'a'.repeat(32), name: '家长' }),
          replace: (url: string) => { destination = url; } },
        crypto: webcrypto, URL, URLSearchParams, Uint8Array, AbortSignal,
        fetch: (path: string, init: RequestInit) => fetch(authority.url + path, init),
      };
      runInNewContext(script, sandbox); await sandbox.done;
      expect(destination).not.toContain('cooSecret');
      const args = new URLSearchParams(new URL(destination).hash.slice(1));
      expect(args.get('state')).toBe('a'.repeat(32));
      const response = await fetch(target.url + '/v1/global/player/join', { method: 'POST',
        headers: { 'content-type': 'application/json', [GLOBAL_HEADER]: args.get('identity')! }, body: JSON.stringify({ room: 'hall' }) });
      expect(response.status).toBe(200);
      return response.json() as Promise<any>;
    };
    const first = await enter(authority); const second = await enter(remote);
    expect(first.identity.cooId).toBe(second.identity.cooId);
    expect(first.seat.handle).toBe(second.seat.handle);
    expect(second.identity.cooSecret).toBe('seat-only');
    const me = await fetch(remote.url + '/v1/me', { headers: { authorization: 'Bearer ' + second.token } });
    expect(me.status).toBe(200);
    expect((await fetch(authority.url + '/identity')).status).toBe(200);
  });

  it('家长下场保持全局短号；浏览器不再收到长期凭证', async () => {
    const authority = await start();
    const child = new ParlorClient(authority.url, id('cccc'));
    await child.initializeIdentity(authority.url, '', '小满');
    const joined = await child.join('', { name: '小满' });
    const postPlay = async () => {
      const res = await fetch(authority.url + '/v1/parent/play', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: joined.ownerKey }) });
      expect(res.status).toBe(200); return await res.json() as any;
    };
    const first = await postPlay(), second = await postPlay();
    expect(first.identity.cooId).toBe(second.identity.cooId);
    expect(first.seat.handle).toBe(second.seat.handle);
    expect(first.identity.cooSecret).toBe('seat-only');
    expect(first.identity.cooId).not.toBe(id('cccc').cooId);
  });

  it('客户端拒绝不同的身份域；停用与系统身份无法被重新认领', async () => {
    const authority = await start(); const stranger = await start();
    const client = new ParlorClient(stranger.url, id('aaaa'));
    await expect(client.initializeIdentity(authority.url, '', '小明')).rejects.toThrow('不一致');
    expect((await session(authority, { cooId: 'system-owner', cooSecret: id('aaaa').cooSecret })).status).toBe(403);
    const valid = await session(authority, id('aaaa'));
    authority.dbHandle.prepare("UPDATE coos SET status='disabled' WHERE id=?").run(id('aaaa').cooId);
    expect((await fetch(authority.url + '/v1/me', { headers: { [GLOBAL_HEADER]: valid.body.token } })).status).toBe(401);
    expect((await session(authority, id('aaaa'))).status).toBe(403);
  });

  it('其他服务器的家长入口沿用统一玩家身份，关闭访客入口时仍可下场', async () => {
    const authority = await start();
    const remote = new WorldServer({ identityAuthority: authority.url, allowGuestJoin: false });
    servers.push(remote); await remote.listen();
    const child = new ParlorClient(remote.url, id('cccc'));
    await child.initializeIdentity(authority.url, '', '小满');
    const joined = await child.join('', { name: '小满' });
    const entry = await fetch(remote.url + '/v1/parent/play', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: joined.ownerKey }) });
    expect(entry.status).toBe(200);
    expect((await entry.json() as any).globalEntry).toBe(authority.url);
    const cookie = entry.headers.get('set-cookie')!.split(';')[0];
    const ticket = await fetch(authority.url + '/v1/identity/session', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...id('dddd'), kind: 'human', name: '家长', audience: remote.url }) });
    const passport = await ticket.json() as any;
    const play = await fetch(remote.url + '/v1/global/player/join', { method: 'POST',
      headers: { 'content-type': 'application/json', cookie, [GLOBAL_HEADER]: passport.token },
      body: JSON.stringify({ parent: true, room: 'lobby' }) });
    expect(play.status).toBe(200);
    const played = await play.json() as any;
    expect(played.identity.cooId).toBe(id('dddd').cooId);
    expect(played.seat.handle).toBe(passport.person.handle);
  });

  it('World 首次启用自动登记、持久保存身份，并连接第二台服务器', async () => {
    const authority = await start(); const remote = await start(authority.url);
    const scratchDir = mkdtempSync(join(tmpdir(), 'global-world-')); dirs.push(scratchDir);
    const ctx = fakeWorldContext(PARLOR, { scratchDir });
    ctx.cfg.serverUrl = remote.url; ctx.cfg.identityUrl = authority.url; ctx.cfg.seatName = '小明';
    const world = PARLOR.create(ctx); const host = new FakeHost();
    try {
      await world.start(host);
      expect(host.events[0]?.type).toBe('parlor.started');
      expect(host.events[0]?.text).toMatch(/#[a-f0-9]{8}/);
      const saved = JSON.parse(readFileSync(join(ctx.dataDir, 'parlor-identity.json'), 'utf8'));
      expect(saved.authority).toBe(authority.url);
      expect(remote.dbHandle.prepare('SELECT secret_hash FROM coos WHERE id=?').get(saved.cooId)).toEqual({ secret_hash: null });
    } finally { await world.stop(); }
  });
});
