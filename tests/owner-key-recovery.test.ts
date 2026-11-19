/**
 * 家长钥匙丢了（换机器 / 卸载重装 / 早期版本没落盘）：已有账户再入座不会补发 ownerKey，
 * 面板里「我下场玩」「家长页」两条带钥匙的链接就一直缺席。启动时应当自己在后台换一把；
 * 本机存着的那把被另一台同身份的 Coo 换掉时也要认得出来，而不是只看「有没有」。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pgServerStorage } from './helpers/pg.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { WorldContext } from 'cortico/world.ts';
import { PARLOR } from '../src/definition.ts';
import type { ParlorConfigSection } from '../src/config.ts';
import { ParlorClient } from '../src/room/client.ts';
import { IDENTITY_FILE } from '../src/room/identity.ts';
import { WorldServer } from '../src/room/world-server.ts';
import { FakeHost } from './helpers/fake-host.ts';

let scratchDir: string;
let server: WorldServer | undefined;
let world: ReturnType<typeof PARLOR.create> | undefined;
let dataDir = '';

beforeEach(() => { scratchDir = mkdtempSync(join(tmpdir(), 'parlor-owner-key-')); });
afterEach(async () => {
  await world?.stop();
  world = undefined;
  await server?.close();
  server = undefined;
  rmSync(scratchDir, { recursive: true, force: true });
});

const waitFor = async (check: () => boolean, what: string, ms = 8_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
};

const parentSession = async (key: string): Promise<number> => {
  const response = await fetch(`${server!.url}/v1/parent/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  return response.status;
};

/** 只读校验：不建会话、不下发 cookie。 */
const verifyKey = async (key: string): Promise<{ status: number; setCookie: string | null }> => {
  const response = await fetch(`${server!.url}/v1/me/owner-key/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  return { status: response.status, setCookie: response.headers.get('set-cookie') };
};

const linkLabels = (): string[] => (world?.webUi?.()?.links ?? []).map((link) => link.label ?? '');
let host: FakeHost | undefined;
const eventText = (): string => (host?.events ?? []).map((event) => event.text).join('\n');

describe('家长钥匙丢失后的启动自愈', () => {
  /** unified = 网关启用统一身份（Coo 用通行证而不是账本身份头），两条认证分支都要能补钥匙。 */
  const bootServer = async (unified = false): Promise<void> => {
    server = await WorldServer.create({
      allowGuestJoin: true, ...(await pgServerStorage(':memory:')), port: 0, inviteCode: 'inv',
      ...(unified ? { identityAuthority: 'self' } : {}),
    });
    await server.listen();
  };

  const boot = async (secrets: Record<string, string>): Promise<FakeHost> => {
    const ctx: WorldContext<ParlorConfigSection> = {
      ...fakeWorldContext(PARLOR, { scratchDir }),
      secret: (name) => secrets[name] ?? '',
      storeSecret: (name, value) => { secrets[name] = value; },
    };
    ctx.cfg.serverUrl = server!.url;
    ctx.cfg.identityUrl = server!.url;
    ctx.cfg.inviteCode = 'inv';
    ctx.cfg.room = 'lobby';
    ctx.cfg.seatName = '小满';
    dataDir = ctx.dataDir;
    host = new FakeHost();
    world = PARLOR.create(ctx);
    await world.start(host);
    return host;
  };

  /** 用本机身份文件另起一个客户端，模拟「另一台同身份的 Coo」。 */
  const sameIdentity = async (): Promise<ParlorClient> => {
    const identity = JSON.parse(readFileSync(join(dataDir, IDENTITY_FILE), 'utf8')) as
      { cooId: string; cooSecret: string };
    const client = new ParlorClient(server!.url, identity);
    await client.initializeIdentity(server!.url, 'inv', '小满');
    return client;
  };

  it.each([false, true])('本机钥匙丢了（统一身份=%s）：后台换一把新的，两条带钥匙的链接回来', async (unified) => {
    await bootServer(unified);
    const secrets: Record<string, string> = { PARLOR_INVITE_CODE: 'inv' };
    await boot(secrets);
    const first = secrets.PARLOR_OWNER_TOKEN ?? '';
    expect(first).toBeTruthy();
    expect(await parentSession(first)).toBe(200);
    expect(linkLabels()).toEqual(expect.arrayContaining([
      '客厅 · 我下场玩（带钥匙，勿转发）',
      '客厅 · 家长页（只读，带钥匙）',
    ]));

    await world!.stop();
    delete secrets.PARLOR_OWNER_TOKEN;
    await boot(secrets);
    await waitFor(() => Boolean(secrets.PARLOR_OWNER_TOKEN), '后台补回钥匙');
    await waitFor(() => linkLabels().includes('客厅 · 我下场玩（带钥匙，勿转发）'), '面板链接恢复');
    await waitFor(() => eventText().includes('换了一把新的'), '补钥匙事件说明结果');

    const repaired = secrets.PARLOR_OWNER_TOKEN ?? '';
    expect(repaired).not.toBe(first);
    expect(await parentSession(first)).toBe(401);
    expect(await parentSession(repaired)).toBe(200);
    expect(linkLabels()).toEqual(expect.arrayContaining([
      '客厅 · 我下场玩（带钥匙，勿转发）',
      '客厅 · 家长页（只读，带钥匙）',
    ]));
  });

  it('启动自检不占家长登录的试错额度', async () => {
    await bootServer();
    const secrets: Record<string, string> = { PARLOR_INVITE_CODE: 'inv' };
    await boot(secrets);
    const key = secrets.PARLOR_OWNER_TOKEN ?? '';
    expect(key).toBeTruthy();

    // 同一出口 IP 把「家长登录」额度打满（一小时 10 次）。
    for (let i = 0; i < 10; i += 1) expect(await parentSession('wrong-key-000000')).toBe(401);
    expect(await parentSession('wrong-key-000000')).toBe(429);

    // 只读校验走独立额度：多个 Coo 同时启动不会把家长本人挤成 429。
    expect((await verifyKey(key)).status).toBe(200);
    expect((await verifyKey(key)).status).toBe(200);
  });

  it('轮换挂起时启动照常完成，照样收得到消息', async () => {
    await bootServer();
    const secrets: Record<string, string> = { PARLOR_INVITE_CODE: 'inv' };
    await boot(secrets);
    expect(secrets.PARLOR_OWNER_TOKEN).toBeTruthy();
    await world!.stop();
    delete secrets.PARLOR_OWNER_TOKEN;

    const original = ParlorClient.prototype.rotateOwnerKey;
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    let asked = false;
    ParlorClient.prototype.rotateOwnerKey = async function (this: ParlorClient) {
      asked = true;
      await gate;
      return original.call(this);
    };
    try {
      const started = Date.now();
      const fake = await boot(secrets);
      // 轮换还挂着：启动已经返回、连接事件已经下来，钥匙还没换到。
      expect(asked).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(fake.events[0]?.type).toBe('parlor.started');
      expect(secrets.PARLOR_OWNER_TOKEN).toBeUndefined();

      // 补钥匙挂起期间，别的席位发来的私聊照样进 Coo。
      const friend = new ParlorClient(server!.url, { cooId: 'coo-friend-0001', cooSecret: 'friend-secret-0123456789' });
      await friend.initializeIdentity(server!.url, 'inv', '阿吉');
      const joined = await friend.join('inv', { name: '阿吉' });
      await friend.action(joined.token, { type: 'whisper', to: '小满', text: '轮换挂起时也能收到' });
      await waitFor(() => eventText().includes('轮换挂起时也能收到'), '挂起期间收到私聊');

      release();
      await waitFor(() => Boolean(secrets.PARLOR_OWNER_TOKEN), '解除挂起后补回钥匙');
    } finally {
      ParlorClient.prototype.rotateOwnerKey = original;
    }
  });

  it('本机钥匙还在：不轮换，原钥匙继续能开家长会话', async () => {
    await bootServer();
    const secrets: Record<string, string> = { PARLOR_INVITE_CODE: 'inv' };
    await boot(secrets);
    const first = secrets.PARLOR_OWNER_TOKEN ?? '';
    expect(first).toBeTruthy();

    await world!.stop();
    await boot(secrets);
    await new Promise((done) => setTimeout(done, 300));

    expect(secrets.PARLOR_OWNER_TOKEN).toBe(first);
    expect(await parentSession(first)).toBe(200);
    expect(linkLabels()).toContain('客厅 · 我下场玩（带钥匙，勿转发）');

    // 启动自检走只读校验：200 且不下发家长会话 cookie（不再多开一条会话）。
    const verified = await verifyKey(first);
    expect(verified.status).toBe(200);
    expect(verified.setCookie).toBeNull();
    expect((await verifyKey('not-a-real-key')).status).toBe(401);
  });

  it('钥匙被另一台同身份的 Coo 换掉：启动时认得出来，再换一把', async () => {
    await bootServer();
    const secrets: Record<string, string> = { PARLOR_INVITE_CODE: 'inv' };
    await boot(secrets);
    const stale = secrets.PARLOR_OWNER_TOKEN ?? '';
    expect(stale).toBeTruthy();

    await world!.stop();
    // 另一台设备用同一身份轮换：这台手里的钥匙就此作废，但本地值仍然非空。
    await (await sameIdentity()).rotateOwnerKey();
    expect(await parentSession(stale)).toBe(401);

    await boot(secrets);
    await waitFor(() => (secrets.PARLOR_OWNER_TOKEN ?? '') !== stale && linkLabels().includes('客厅 · 我下场玩（带钥匙，勿转发）'), '认出失效钥匙并换新');
    const fresh = secrets.PARLOR_OWNER_TOKEN ?? '';
    expect(await parentSession(fresh)).toBe(200);
    await waitFor(() => eventText().includes('换了一把新的'), '补钥匙事件说明结果');
  });

  it('刚换到就被作废：不反复打，给出恢复入口并退避', async () => {
    await bootServer();
    const secrets: Record<string, string> = { PARLOR_INVITE_CODE: 'inv' };
    await boot(secrets);
    expect(secrets.PARLOR_OWNER_TOKEN).toBeTruthy();
    await world!.stop();
    delete secrets.PARLOR_OWNER_TOKEN;

    const thief = await sameIdentity();
    const original = ParlorClient.prototype.rotateOwnerKey;
    ParlorClient.prototype.rotateOwnerKey = async function (this: ParlorClient) {
      const mine = await original.call(this);
      await original.call(thief); // 另一台同身份的 Coo 紧接着又把钥匙换走（直接走原实现，别再进这个补丁）
      return mine;
    };
    try {
      await boot(secrets);
      await waitFor(() => eventText().includes('另一台同身份的 Coo'), '识别出钥匙被同时轮换');
    } finally {
      ParlorClient.prototype.rotateOwnerKey = original;
    }
    // 拿到的是死钥匙：面板不再给带钥匙的链接，别让人点进一个进不去的页面。
    const dead = secrets.PARLOR_OWNER_TOKEN ?? '';
    expect(await parentSession(dead)).toBe(401);
    expect(linkLabels()).not.toContain('客厅 · 我下场玩（带钥匙，勿转发）');

    // 再重启一次：钥匙失效但刚换过，先退避，不跟另一台来回作废。
    await world!.stop();
    await boot(secrets);
    await waitFor(() => eventText().includes('分钟内先不再自动换'), '冷却期内不重复轮换');
    expect(secrets.PARLOR_OWNER_TOKEN).toBe(dead);
    // 冷却期也不能把两条死链接重新挂回面板：这一轮就当作没有钥匙。
    expect(linkLabels()).not.toContain('客厅 · 我下场玩（带钥匙，勿转发）');
    expect(linkLabels()).not.toContain('客厅 · 家长页（只读，带钥匙）');
  });

  it('停止后才返回的轮换结果：不覆盖新实例已经写入的钥匙', async () => {
    await bootServer();
    const secrets: Record<string, string> = { PARLOR_INVITE_CODE: 'inv' };
    await boot(secrets);
    expect(secrets.PARLOR_OWNER_TOKEN).toBeTruthy();
    await world!.stop();
    delete secrets.PARLOR_OWNER_TOKEN;
    delete secrets.PARLOR_OWNER_TOKEN_ISSUER;

    const original = ParlorClient.prototype.rotateOwnerKey;
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    let asked = false;
    ParlorClient.prototype.rotateOwnerKey = async function (this: ParlorClient) {
      asked = true;
      await gate;
      return original.call(this);
    };
    try {
      await boot(secrets);
      await waitFor(() => asked, '开始轮换');
      // 旧实例停掉之后，换了服务器的新实例已经把它自己的钥匙写进了同一个 .env。
      await world!.stop();
      secrets.PARLOR_OWNER_TOKEN = 'key-written-by-new-instance';
      secrets.PARLOR_OWNER_TOKEN_ISSUER = 'https://other.example|coo-other-0001';
      const before = secrets.PARLOR_OWNER_TOKEN;
      release();
      await new Promise((done) => setTimeout(done, 800));
      // 晚到的旧响应只能作废服务器上那把，不能把新实例的钥匙和冷却记录改回去。
      expect(secrets.PARLOR_OWNER_TOKEN).toBe(before);
      expect(secrets.PARLOR_OWNER_TOKEN_ISSUER).toBe('https://other.example|coo-other-0001');
    } finally {
      release();
      ParlorClient.prototype.rotateOwnerKey = original;
    }
  });
});
