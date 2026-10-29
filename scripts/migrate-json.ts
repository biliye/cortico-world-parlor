#!/usr/bin/env node
/**
 * 旧单客厅 JSON → 多客厅 SQLite（一次性）。
 *
 * node --experimental-strip-types scripts/migrate-json.ts \
 *   --data /var/lib/parlor --db /var/lib/parlor/parlor.db [--dry-run] [--abandon-monopoly]
 *
 * 迁移只写空库；核对（余额、未读、席位令牌）不过会回滚。
 * --dry-run 在内存库上跑一遍，不碰目标文件。
 */
import { migrateLegacyJson } from '../src/room/migrate-json.ts';

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index]!;
  if (!key.startsWith('--')) {
    console.error(`不认识的参数：${key}`);
    process.exit(2);
  }
  if (key === '--dry-run' || key === '--abandon-monopoly') {
    args.set(key, '1');
    continue;
  }
  const value = process.argv[index + 1];
  if (value === undefined) {
    console.error(`参数要成对：${key} <值>`);
    process.exit(2);
  }
  args.set(key, value);
  index += 1;
}

const dataDir = args.get('--data');
const dbFile = args.get('--db');
if (!dataDir || !dbFile) {
  console.error('用法：migrate-json.ts --data <旧数据目录> --db <新库文件> [--dry-run] [--abandon-monopoly]');
  process.exit(2);
}
const dryRun = args.has('--dry-run');

try {
  const report = migrateLegacyJson({
    dataDir,
    dbFile: dryRun ? ':memory:' : dbFile,
    ...(args.get('--room') ? { roomId: args.get('--room')! } : {}),
    ...(args.get('--name') ? { roomName: args.get('--name')! } : {}),
    abandonMonopoly: args.has('--abandon-monopoly'),
  });
  console.log(`迁移${dryRun ? '演练（内存库，没有写盘）' : '完成'}：客厅 ${report.roomId}`);
  console.log(JSON.stringify(report.counts, null, 2));
  console.log(`余额核对 ${report.balances.length} 个身份，全部通过：${
    report.balances.every((check) => check.match) ? '是' : '否'
  }`);
  console.log(`未读核对 ${report.unread.length} 个身份，全部通过：${
    report.unread.every((check) => check.match) ? '是' : '否'
  }`);
  console.log(`席位令牌核对 ${report.tokenChecks.length} 个，全部通过：${
    report.tokenChecks.every((check) => check.ok) ? '是' : '否'
  }`);
  if (report.warnings.length > 0) {
    console.log('警告：');
    for (const warning of report.warnings) console.log(`- ${warning}`);
  }
  if (!dryRun) console.log(`新库：${dbFile}（旧 JSON 保留在原处，先别删）`);
} catch (error) {
  console.error(`迁移失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
