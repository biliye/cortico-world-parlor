#!/usr/bin/env node
/**
 * PostgreSQL-only 多客厅网关。设置 PARLOR_DATABASE_URL 后运行：
 * node --experimental-strip-types scripts/serve-world.ts --host 127.0.0.1 --port 8790 --invite <码>
 * --coo-idle-minutes 60 / PARLOR_COO_IDLE_MINUTES，0 关闭闲置回大厅。
 * --room-archive-hours 48 / PARLOR_ROOM_ARCHIVE_HOURS，0 关闭自动归档。
 * --pool-max 8 / PARLOR_PG_POOL_MAX；--statement-timeout-ms 30000。
 * --account-limit 5000 / PARLOR_ACCOUNT_LIMIT；家长账户（家人）容量上限，满了新的 Coo 进不来。
 * --offline-release-hours / --coo-offline-release-hours 仍是独立的离线回收策略。
 * Coo 本机消息档案继续使用 SQLite；本服务拒绝 --db/PARLOR_DB，不自动建库。
 */
import { randomBytes } from 'node:crypto';
import { DEFAULT_SERVER_URL } from '../src/config.ts';
import { DEFAULT_ACCOUNT_LIMIT } from '../src/room/coo-account-db.ts';
import { parseStorageKind } from '../src/room/storage/open.ts';
import { WorldServer } from '../src/room/world-server.ts';

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith('--') || value === undefined) {
    console.error('参数要成对：--host --port --invite --database-url --default-room');
    process.exit(2);
  }
  args.set(key, value);
}

const host = args.get('--host') ?? '127.0.0.1';
const port = Number(args.get('--port') ?? 8790);
const invite = args.get('--invite') ?? process.env.PARLOR_INVITE_CODE ?? randomBytes(9).toString('base64url');
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
const cooIdleMinutes = Number(args.get('--coo-idle-minutes') ?? process.env.PARLOR_COO_IDLE_MINUTES ?? 300);
const roomArchiveHours = Number(args.get('--room-archive-hours') ?? process.env.PARLOR_ROOM_ARCHIVE_HOURS ?? 48);
if (![cooIdleMinutes, roomArchiveHours].every(n => Number.isFinite(n) && n >= 0)) {
  console.error('闲置/归档时限须为非负数，0 表示关闭'); process.exit(2);
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

const storageRaw = args.get('--storage') ?? process.env.PARLOR_STORAGE ?? 'postgres';
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
if (args.has('--db') || process.env.PARLOR_DB) {
  console.error('--db 只用于 SQLite；PostgreSQL 用 --database-url 或 PARLOR_DATABASE_URL。');
  process.exit(2);
}
const poolMaxRaw = args.get('--pool-max') ?? process.env.PARLOR_PG_POOL_MAX;
const poolMax = poolMaxRaw ? Number(poolMaxRaw) : undefined;
if (poolMax !== undefined && (!Number.isInteger(poolMax) || poolMax <= 0)) {
  console.error('连接池上限要是一个正整数');
  process.exit(2);
}
// 家长账户上限：应用层容量，满了新的 Coo 就进不来。默认取库里的 DEFAULT_ACCOUNT_LIMIT。
const accountLimitRaw = args.get('--account-limit') ?? process.env.PARLOR_ACCOUNT_LIMIT;
let accountLimit: number | undefined;
if (accountLimitRaw !== undefined && accountLimitRaw !== '') {
  accountLimit = Number(accountLimitRaw);
  if (!Number.isInteger(accountLimit) || accountLimit <= 0) {
    console.error('家长账户上限要是一个正整数');
    process.exit(2);
  }
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
    databaseUrl,
    ...(poolMax !== undefined ? { poolMax } : {}),
    ...(statementTimeoutMs !== undefined ? { statementTimeoutMs } : {}),
    ...(accountLimit !== undefined ? { accountLimit } : {}),
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
    cooIdleMinutes, roomArchiveHours,
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
  console.log(`家长账户上限：${accountLimit ?? `${DEFAULT_ACCOUNT_LIMIT}（默认）`}`);
  if (tableTurnMs !== undefined) console.log(`牌桌时限基准：${tableTurnMs} 毫秒（staging/测试用）`);
  console.log(`Coo 闲置 ${cooIdleMinutes} 分钟回大厅；客厅闲置 ${roomArchiveHours} 小时归档（0 为关闭）。`);
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
