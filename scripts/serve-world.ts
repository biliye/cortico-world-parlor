#!/usr/bin/env node
/**
 * 独立运行多客厅网关：给 VPS / staging 用。
 *
 * 默认 SQLite（老部署零改动）：
 *   node --experimental-strip-types scripts/serve-world.ts \
 *     --host 0.0.0.0 --port 8790 --invite <邀请码> --db ./parlor.db --default-room lobby
 *
 * PostgreSQL：
 *   PARLOR_STORAGE=postgres PARLOR_DATABASE_URL=postgres://用户:密码@主机:5432/库名 \
 *     node --experimental-strip-types scripts/serve-world.ts --host 0.0.0.0 --port 8790 --invite <邀请码>
 * 也可以写成 --storage postgres --database-url postgres://…；--db 只属于 SQLite，
 * 两个同时给会报错（不猜、不悄悄退回 SQLite）。
 *
 * 网页「用户名 + 邀请码」的访客入口默认关闭。压测/本地需要它时加
 *   --allow-guest-join true   或   PARLOR_ALLOW_GUEST_JOIN=1
 *
 * 席位离线超过阈值自动释放：真人默认 6 小时，Coo 的 pet 席位默认 6 小时。要改：
 *   --offline-release-hours 12      或 PARLOR_OFFLINE_RELEASE_HOURS=12       （0 = 关）
 *   --coo-offline-release-hours 24  或 PARLOR_COO_OFFLINE_RELEASE_HOURS=24   （0 = 关）
 *
 * 牌桌时限基准（狼人杀各窗口、骰子每回合、斗地主每手都按它缩放；默认用各游戏正式值）。
 * staging / 本地测试想快点打完一局时用，生产别设：
 *   --table-turn-ms 2000   或 PARLOR_TABLE_TURN_MS=2000
 *
 * 连接池（只对 PostgreSQL 生效）：
 *   --pool-max 8   或 PARLOR_PG_POOL_MAX=8
 *   --statement-timeout-ms 30000   或 PARLOR_PG_STATEMENT_TIMEOUT_MS=30000
 *
 * Node >= 22.13（node:sqlite 免 flag）。Node 24 默认支持类型剥离，可以去掉 --experimental-strip-types。
 */
import { randomBytes } from 'node:crypto';
import { DEFAULT_SERVER_URL } from '../src/config.ts';
import { parseStorageKind } from '../src/room/storage/open.ts';
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
const dbFile = args.get('--db') ?? process.env.PARLOR_DB ?? './parlor.db';
const defaultRoomId = args.get('--default-room') ?? 'lobby';
const guestFlag = (args.get('--allow-guest-join') ?? process.env.PARLOR_ALLOW_GUEST_JOIN ?? '').toLowerCase();
const allowGuestJoin = ['1', 'true', 'yes', 'on'].includes(guestFlag);
const offlineHours = Number(
  args.get('--offline-release-hours') ?? process.env.PARLOR_OFFLINE_RELEASE_HOURS ?? '6',
);
if (!Number.isFinite(offlineHours) || offlineHours < 0) {
  console.error('离线释放小时数不对');
  process.exit(2);
}
const cooOfflineHours = Number(
  args.get('--coo-offline-release-hours') ?? process.env.PARLOR_COO_OFFLINE_RELEASE_HOURS ?? '6',
);
if (!Number.isFinite(cooOfflineHours) || cooOfflineHours < 0) {
  console.error('Coo 席位离线释放小时数不对');
  process.exit(2);
}
const tableTurnMsRaw = args.get('--table-turn-ms') ?? process.env.PARLOR_TABLE_TURN_MS;
let tableTurnMs: number | undefined;
if (tableTurnMsRaw !== undefined && tableTurnMsRaw !== '') {
  tableTurnMs = Number(tableTurnMsRaw);
  if (!Number.isFinite(tableTurnMs) || tableTurnMs <= 0) {
    console.error('牌桌时限基准要是一个正的毫秒数');
    process.exit(2);
  }
}

const storageRaw = args.get('--storage') ?? process.env.PARLOR_STORAGE ?? 'sqlite';
let storage: ReturnType<typeof parseStorageKind>;
try {
  storage = parseStorageKind(storageRaw);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
const databaseUrl = args.get('--database-url') ?? process.env.PARLOR_DATABASE_URL ?? '';
if (storage === 'postgres' && !databaseUrl) {
  console.error('PARLOR_STORAGE=postgres 时必须配 PARLOR_DATABASE_URL；不配不会退回 SQLite。');
  process.exit(2);
}
if (storage === 'postgres' && args.has('--db')) {
  console.error('--db 只用于 SQLite；PostgreSQL 用 --database-url 或 PARLOR_DATABASE_URL。');
  process.exit(2);
}
const poolMaxRaw = args.get('--pool-max') ?? process.env.PARLOR_PG_POOL_MAX;
const poolMax = poolMaxRaw ? Number(poolMaxRaw) : undefined;
if (poolMax !== undefined && (!Number.isInteger(poolMax) || poolMax <= 0)) {
  console.error('连接池上限要是一个正整数');
  process.exit(2);
}
const statementTimeoutRaw = args.get('--statement-timeout-ms') ?? process.env.PARLOR_PG_STATEMENT_TIMEOUT_MS;
const statementTimeoutMs = statementTimeoutRaw ? Number(statementTimeoutRaw) : undefined;
if (statementTimeoutMs !== undefined && (!Number.isFinite(statementTimeoutMs) || statementTimeoutMs <= 0)) {
  console.error('语句超时要是正的毫秒数');
  process.exit(2);
}

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('端口不对');
  process.exit(2);
}

/** 只显示「主机:端口/库名」，永远不打印密码。 */
const shownDatabase = ((): string => {
  if (storage === 'sqlite') return dbFile;
  try {
    const url = new URL(databaseUrl);
    return `${url.host}${url.pathname}（PostgreSQL）`;
  } catch {
    return '（PostgreSQL，地址格式没解析出来）';
  }
})();

let server: WorldServer;
try {
  server = await WorldServer.create({
    storage,
    ...(storage === 'sqlite' ? { dbFile } : { databaseUrl }),
    ...(poolMax !== undefined ? { poolMax } : {}),
    ...(statementTimeoutMs !== undefined ? { statementTimeoutMs } : {}),
    host,
    port,
    inviteCode: invite,
    operatorKey: process.env.PARLOR_OPERATOR_KEY,
    defaultRoomId,
    allowGuestJoin,
    identityAuthority: args.get('--identity-authority') ?? process.env.PARLOR_IDENTITY_AUTHORITY ?? DEFAULT_SERVER_URL,
    publicUrl: args.get('--public-url') ?? process.env.PARLOR_PUBLIC_URL,
    offlineReleaseHours: offlineHours,
    cooOfflineReleaseHours: cooOfflineHours,
    ...(tableTurnMs !== undefined ? { tableTurnMs } : {}),
  });
} catch (error) {
  console.error(`起不来：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

try {
  const address = await server.listen();
  const shown = address.host === '0.0.0.0' ? `${address.url}（局域网用本机 IP:${address.port}）` : address.url;
  console.log(`多客厅网关在 ${shown}`);
  console.log(`大厅：${server.hallId}；默认客厅：${defaultRoomId}`);
  console.log(`邀请码：${invite}`);
  console.log(`网页访客加入：${allowGuestJoin ? '开' : '关（只用带钥匙的下场玩链接）'}`);
  console.log(`真人席位离线释放：${offlineHours > 0 ? `${offlineHours} 小时` : '关'}`);
  console.log(`Coo 席位离线释放：${cooOfflineHours > 0 ? `${cooOfflineHours} 小时` : '关'}`);
  if (tableTurnMs !== undefined) console.log(`牌桌时限基准：${tableTurnMs} 毫秒（staging/测试用）`);
  console.log(`数据库：${shownDatabase}`);
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
