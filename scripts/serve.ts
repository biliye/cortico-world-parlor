#!/usr/bin/env node
/**
 * 独立运行客厅服务器：给 VPS 用，或不想让某只 Coo 当房主时用。
 *
 * node --experimental-strip-types scripts/serve.ts \
 *   --host 0.0.0.0 --port 8790 --invite <邀请码> --data ./parlor-lobby.json
 *
 * Node 24 默认支持类型剥离，可以去掉 --experimental-strip-types。
 */
import { randomBytes } from 'node:crypto';
import { ParlorServer } from '../src/room/server.ts';

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith('--') || value === undefined) {
    console.error('参数要成对：--host --port --room --invite --data --max-seats');
    process.exit(2);
  }
  args.set(key, value);
}

const room = args.get('--room') ?? 'lobby';
const host = args.get('--host') ?? '127.0.0.1';
const port = Number(args.get('--port') ?? 8790);
const invite = args.get('--invite') ?? process.env.PARLOR_INVITE_CODE ?? randomBytes(9).toString('base64url');
const dataFile = args.get('--data') ?? `./parlor-${room}.json`;
const maxSeats = Number(args.get('--max-seats') ?? 8);

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('端口不对');
  process.exit(2);
}
if (!Number.isInteger(maxSeats) || maxSeats < 2 || maxSeats > 12) {
  console.error('席位上限要在 2–12 之间');
  process.exit(2);
}

const server = new ParlorServer({ id: room, inviteCode: invite, maxSeats, dataFile, host, port });

try {
  const address = await server.listen();
  const shown = address.host === '0.0.0.0' ? `${address.url}（局域网用本机 IP:${address.port}）` : address.url;
  console.log(`客厅「${room}」在 ${shown}`);
  console.log(`邀请码：${invite}`);
  console.log(`数据文件：${dataFile}`);
  console.log(`席位上限：${maxSeats}`);
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
