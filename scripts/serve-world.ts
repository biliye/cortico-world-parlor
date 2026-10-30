#!/usr/bin/env node
/**
 * 独立运行多客厅网关（SQLite）：给 VPS / staging 用。
 *
 * node --experimental-strip-types scripts/serve-world.ts \
 *   --host 0.0.0.0 --port 8790 --invite <邀请码> --db ./parlor.db --default-room lobby
 *
 * 网页「用户名 + 邀请码」的访客入口默认关闭。压测/本地需要它时加
 *   --allow-guest-join true   或   PARLOR_ALLOW_GUEST_JOIN=1
 *
 * Node >= 22.13（node:sqlite 免 flag）。Node 24 默认支持类型剥离，可以去掉 --experimental-strip-types。
 */
import { randomBytes } from 'node:crypto';
import { WorldServer } from '../src/room/world-server.ts';

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith('--') || value === undefined) {
    console.error('参数要成对：--host --port --invite --db --default-room');
    process.exit(2);
  }
  args.set(key, value);
}

const host = args.get('--host') ?? '127.0.0.1';
const port = Number(args.get('--port') ?? 8790);
const invite = args.get('--invite') ?? process.env.PARLOR_INVITE_CODE ?? randomBytes(9).toString('base64url');
const dbFile = args.get('--db') ?? './parlor.db';
const defaultRoomId = args.get('--default-room') ?? 'lobby';
const guestFlag = (args.get('--allow-guest-join') ?? process.env.PARLOR_ALLOW_GUEST_JOIN ?? '').toLowerCase();
const allowGuestJoin = ['1', 'true', 'yes', 'on'].includes(guestFlag);

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('端口不对');
  process.exit(2);
}

const server = new WorldServer({
  dbFile, host, port, inviteCode: invite, defaultRoomId, allowGuestJoin,
});

try {
  const address = await server.listen();
  const shown = address.host === '0.0.0.0' ? `${address.url}（局域网用本机 IP:${address.port}）` : address.url;
  console.log(`多客厅网关在 ${shown}`);
  console.log(`大厅：${server.hallId}；默认客厅：${defaultRoomId}`);
  console.log(`邀请码：${invite}`);
  console.log(`网页访客加入：${allowGuestJoin ? '开' : '关（只用带钥匙的下场玩链接）'}`);
  console.log(`数据库：${dbFile}`);
  console.log(`网页：${address.url}/play`);
} catch (error) {
  console.error(`起不来：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

let closing = false;
const shutdown = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  console.log('正在关闭...');
  await server.close();
  process.exit(0);
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void shutdown(); });
