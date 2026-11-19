/**
 * 家长钥匙丢了（换机器 / 卸载重装 / 早期版本没落盘）：已有账户再入座不会补发 ownerKey，
 * 面板里「我下场玩」「家长页」两条带钥匙的链接就一直缺席。启动时应当自己换一把。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pgServerStorage } from './helpers/pg.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { WorldContext } from 'cortico/world.ts';
import { PARLOR } from '../src/definition.ts';
import type { ParlorConfigSection } from '../src/config.ts';
import { WorldServer } from '../src/room/world-server.ts';
import { FakeHost } from './helpers/fake-host.ts';

let scratchDir: string;
let server: WorldServer | undefined;
let world: ReturnType<typeof PARLOR.create> | undefined;

beforeEach(() => { scratchDir = mkdtempSync(join(tmpdir(), 'parlor-owner-key-')); });
afterEach(async () => {
  await world?.stop();
  world = undefined;
  await server?.close();
  server = undefined;
  rmSync(scratchDir, { recursive: true, force: true });
});

const parentSession = async (key: string): Promise<number> => {
  const response = await fetch(`${server!.url}/v1/parent/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  return response.status;
};

const linkLabels = (): string[] => (world?.webUi?.()?.links ?? []).map((link) => link.label ?? '');

describe('家长钥匙丢失后的启动自愈', () => {
  const boot = async (secrets: Record<string, string>): Promise<{ ctx: WorldContext<ParlorConfigSection>; host: FakeHost }> => {
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
    const host = new FakeHost();
    world = PARLOR.create(ctx);
    await world.start(host);
    return { ctx, host };
  };

  const bootServer = async (): Promise<void> => {
    server = await WorldServer.create({
      allowGuestJoin: true, ...(await pgServerStorage(':memory:')), port: 0, inviteCode: 'inv',
    });
    await server.listen();
  };

  it('本机钥匙丢了：重入时换一把新的，两条带钥匙的链接回来，旧钥匙同时失效', async () => {
    await bootServer();
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
    const { host } = await boot(secrets);

    const repaired = secrets.PARLOR_OWNER_TOKEN ?? '';
    expect(repaired).toBeTruthy();
    expect(repaired).not.toBe(first);
    expect(await parentSession(first)).toBe(401);
    expect(await parentSession(repaired)).toBe(200);
    expect(linkLabels()).toEqual(expect.arrayContaining([
      '客厅 · 我下场玩（带钥匙，勿转发）',
      '客厅 · 家长页（只读，带钥匙）',
    ]));
    expect(host.events.map((event) => event.text).join('\n')).toContain('换了一把新的');
  });

  it('本机钥匙还在：不轮换，原钥匙继续能开家长会话', async () => {
    await bootServer();
    const secrets: Record<string, string> = { PARLOR_INVITE_CODE: 'inv' };
    await boot(secrets);
    const first = secrets.PARLOR_OWNER_TOKEN ?? '';
    expect(first).toBeTruthy();

    await world!.stop();
    await boot(secrets);

    expect(secrets.PARLOR_OWNER_TOKEN).toBe(first);
    expect(await parentSession(first)).toBe(200);
    expect(linkLabels()).toContain('客厅 · 我下场玩（带钥匙，勿转发）');
  });
});
