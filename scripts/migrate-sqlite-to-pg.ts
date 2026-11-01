/**
 * SQLite → PostgreSQL 的迁移/核验工具（M3）。
 *
 * 用法：
 *   pnpm migrate:pg --source <备份.db> --target 'postgres://用户:密码@主机:5432/空库' [--dry-run]
 *   pnpm migrate:pg --source <备份.db> --dry-run            # 只审计来源，不连目标
 *
 * 选项：
 *   --dry-run       只审计与预估，不写任何东西
 *   --force         仅清理同一失败批次的审计记录；已完成或有业务数据时拒绝覆盖
 *   --batch <n>     每条 INSERT 带多少行（默认 500）
 *   --shallow       跳过逐行 JSON 检查（大库用；不推荐）
 *
 * 来源必须是一致性备份（停写后 Backup API 或完全关闭连接后的状态），
 * 旁边还有非空 WAL 文件会直接拒绝。工具只读来源，绝不在来源上跑 migrate/recover。
 */
import { runMigration } from '../src/room/migration/run.ts';

interface Args {
  source?: string;
  target?: string;
  dryRun?: boolean;
  force?: boolean;
  batch?: number;
  shallow?: boolean;
}

const parseArgs = (argv: string[]): Args => {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = (): string => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 后面要跟一个值`);
      index += 1;
      return value;
    };
    if (arg === '--source') args.source = next();
    else if (arg === '--target') args.target = next();
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--batch') args.batch = Number(next());
    else if (arg === '--shallow') args.shallow = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: --source <备份.db> [--target postgres://…] [--dry-run] [--force] [--batch 500] [--shallow]');
      process.exit(0);
    } else {
      throw new Error(`不认识的参数：${arg}`);
    }
  }
  return args;
};

const main = async (): Promise<number> => {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (!args.source) {
    console.error('缺 --source（来源 SQLite 备份文件）');
    return 2;
  }
  const started = Date.now();
  const report = await runMigration({
    source: args.source,
    ...((args.target ?? process.env.PARLOR_DATABASE_URL)
      ? { targetUrl: args.target ?? process.env.PARLOR_DATABASE_URL } : {}),
    ...(args.dryRun ? { dryRun: true } : {}),
    ...(args.force ? { force: true } : {}),
    ...(args.batch !== undefined && Number.isFinite(args.batch) ? { batch: args.batch } : {}),
    ...(args.shallow ? { deep: false } : {}),
    version: '1',
    log: (line) => console.log(line),
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (!report.ok) {
    console.error(`\n没有完成（${report.stage}）：${report.error ?? '见上面的审计结果'}（${seconds}s）`);
    return 1;
  }
  if (args.dryRun) {
    console.log(`\ndry-run 完成：来源可搬，${seconds}s。`);
    return 0;
  }
  const total = Object.values(report.counts ?? {}).reduce((sum, value) => sum + value, 0);
  console.log(`\n迁移完成：${total} 行、批次 ${report.runId}、${seconds}s。`);
  return 0;
};

process.exitCode = await main();
