import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { PARLOR } from '../src/definition.ts';
import { FakeHost } from '../tests/helpers/fake-host.ts';
import { toolForOperation } from '../tests/helpers/tool-operations.ts';
import { qaRequest } from './release-qa-room.ts';

export function qaRun(): { base: string; scratch: string } {
  if (!process.env.PARLOR_QA_URL) throw new Error('运行真机验收前请显式设置 PARLOR_QA_URL');
  const target = new URL(process.env.PARLOR_QA_URL);
  if (target.href !== target.origin + '/' || (target.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(target.hostname))) {
    throw new Error('PARLOR_QA_URL 必须是显式提供的 HTTPS 源或本地回环源');
  }
  const root = resolve('.task-tmp');
  mkdirSync(root, { recursive: true });
  return { base: target.origin, scratch: mkdtempSync(join(root, 'release-qa-')) };
}

export async function makeQaClient(base: string, scratch: string, name: string) {
  const dir = join(scratch, name);
  mkdirSync(dir);
  const secretPath = join(dir, 'qa-secrets.json');
  const secrets: Record<string, string> = {};
  const context = fakeWorldContext(PARLOR, { scratchDir: dir });
  context.cfg.serverUrl = base;
  context.cfg.identityUrl = base;
  context.cfg.inviteCode = process.env.PARLOR_QA_INVITE ?? '';
  context.cfg.seatName = name;
  context.cfg.room = 'hall';
  const world = PARLOR.create({
    ...context,
    secret: (key: string) => secrets[key] ?? '',
    storeSecret: (key: string, value: string) => {
      secrets[key] = value;
      writeFileSync(secretPath, JSON.stringify(secrets), { mode: 0o600 });
    },
  });
  await world.start(new FakeHost());
  return {
    name, secrets, token: () => secrets.PARLOR_SEAT_TOKEN ?? '',
    async stop() { await world.stop(); },
    async call(op: string, args: Record<string, unknown> = {}): Promise<string> {
      const out = await toolForOperation(world, op).handler(args, {} as ToolCallContext);
      return typeof out === 'string' ? out : JSON.stringify(out);
    },
  };
}

/** 只清理由本轮签发并仍绑定到同一席位的临时入场凭据。 */
export async function leaveQaSeat(base: string, token: string, expected?: string): Promise<void> {
  if (!token) return;
  const response = await fetch(new URL('/v1/me/location', base), {
    headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401) return;
  if (!response.ok) throw new Error(`QA 席位位置检查返回 HTTP ${response.status}`);
  const location = await response.json() as { seat: { id: string } | null };
  if (!location.seat) return;
  const seatId = location.seat.id;
  if (expected && seatId !== expected) throw new Error('临时席位已变化，停止退厅');
  const result = await qaRequest<{ ok: boolean; left: boolean }>(base, token, '/v1/me/leave', { seatId });
  if (!result.ok || !result.left) throw new Error('临时席位未确认退厅');
}
