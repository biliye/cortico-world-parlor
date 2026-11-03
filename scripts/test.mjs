import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planTests } from './test-profiles.mjs';

export function scratchBase(root, requested) {
  const allowed = resolve(root, '.task-tmp');
  const path = resolve(root, requested || '.task-tmp/test-runs');
  const within = relative(allowed, path);
  if (!within || isAbsolute(within) || within.startsWith('..')) throw new Error('测试临时目录必须在本包 .task-tmp 子目录内；不会回退到C盘或系统TEMP');
  // Check existing ancestors too, before mkdir follows any junction/symlink.
  let ancestor = path;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const physical = relative(realpathSync(root), realpathSync(ancestor));
  if (isAbsolute(physical) || physical.startsWith('..')) throw new Error('测试临时目录的链接目标越出包目录');
  return path;
}

export function checkFreeSpace(available, needed) {
  if (available < needed) throw new Error(`测试盘剩余空间不足：${(available/2**30).toFixed(2)} GiB；本模式至少需要 ${(needed/2**30).toFixed(2)} GiB。停止，不创建PG或自动重试。`);
}

export function childEnvironment(env, runDir, runId, plan) {
  return {...env, TEMP:runDir, TMP:runDir, TMPDIR:runDir, PARLOR_TEST_TMP:runDir,
    PARLOR_TEST_RUN_ROOT:runDir, PARLOR_TEST_RUN_ID:runId, PARLOR_TEST_MODE:plan.mode,
    PARLOR_TEST_TARGETED:plan.include[0] === 'tests/**/*.test.ts' ? '1' : '0',
    PARLOR_TEST_PG:plan.pg ? '1' : '0', PARLOR_TEST_PG_URL:'',
  };
}

const freePort = () => new Promise((done, reject) => {
  const server = createServer();
  server.once('error',reject);
  server.listen(0,'127.0.0.1',() => {const port=server.address().port;server.close(error=>error?reject(error):done(port));});
});

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const [mode = 'unit', ...raw] = process.argv.slice(2);
  const filters = raw.filter(value => value !== '--' && value !== '--plan');
  const plan = planTests(mode, filters);
  if (raw.includes('--plan')) {console.log(JSON.stringify(plan,null,2));return;}
  if (process.env.PARLOR_TEST_PG_URL) throw new Error('简化入口只启动本机隔离PG；请先取消外部 PARLOR_TEST_PG_URL，避免连接业务数据库');
  const base = scratchBase(root, process.env.PARLOR_TEST_TMP);
  mkdirSync(base,{recursive:true});
  const space = statfsSync(base);
  checkFreeSpace(space.bavail*space.bsize, (plan.mode==='all'?4:plan.pg?1:.25)*2**30);
  const runDir = mkdtempSync(join(base,'run-'));
  const runId = runDir.slice(-6).toLowerCase();
  const marker = {kind:'parlor-test-run',id:runId,pid:process.pid,mode:plan.mode,startedAt:new Date().toISOString()};
  writeFileSync(join(runDir,'owner.json'),JSON.stringify(marker));
  const resultDir = join(root,'.task-tmp/test-results');
  mkdirSync(resultDir,{recursive:true});
  let code = 1;
  let cleaned = false;
  let child;
  const interrupted = () => { child?.kill('SIGINT'); };
  try {
    // PG and Vite both need rename/unlink. Fail here rather than accumulating a
    // half-initialised cluster or silently switching back to the system drive.
    writeFileSync(join(runDir,'probe'),'test');
    renameSync(join(runDir,'probe'),join(runDir,'probe-renamed'));
    rmSync(join(runDir,'probe-renamed'));
    const env = childEnvironment(process.env,runDir,runId,plan);
    if (plan.pg) env.PARLOR_TEST_PG_PORT = String(await freePort());
    console.log(`[parlor test] ${plan.label}；默认单进程；临时目录 ${runDir}`);
    process.once('SIGINT',interrupted);process.once('SIGTERM',interrupted);
    code = await new Promise((done,reject) => {
      child = spawn(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','--config',plan.pg?'vitest.pg.config.ts':'vitest.config.ts',...filters],{cwd:root,env,stdio:'inherit'});
      child.once('error',reject);child.once('exit',(status)=>done(status ?? 1));
    });
  } finally {
    process.removeListener('SIGINT',interrupted);process.removeListener('SIGTERM',interrupted);
    try {
      const owner = JSON.parse(readFileSync(join(runDir,'owner.json'),'utf8'));
      if (owner.kind!=='parlor-test-run'||owner.id!==runId||owner.pid!==process.pid) throw new Error('目录所有权记录不匹配');
      const stateFile = join(runDir,'pg-state.json');
      if (existsSync(stateFile) && JSON.parse(readFileSync(stateFile,'utf8')).running) throw new Error('PG尚未确认停止，保留数据目录');
      scratchBase(root,runDir);
      rmSync(runDir,{recursive:true,force:true,maxRetries:5,retryDelay:200});
      cleaned = true;
    } catch(error) {console.error(`[parlor test] 清理未完成：${error.message}；检查 ${runDir}`);code=1;}
    writeFileSync(join(resultDir,`${Date.now()}-${runId}.json`),JSON.stringify({...marker,finishedAt:new Date().toISOString(),exitCode:code,cleaned,runDir},null,2));
  }
  console.log(`[parlor test] exit=${code}；临时目录${cleaned?'已清理':'保留待检查'}`);
  process.exitCode = code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error=>{console.error(`[parlor test] ${error.message}`);process.exitCode=1;});
}
