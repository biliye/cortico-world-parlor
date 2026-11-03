import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

// Computed imports keep Node-only TS checking independent of plain JS scripts.
const runnerPath = '../scripts/test.mjs';
const profilesPath = '../scripts/test-profiles.mjs';
const {scratchBase,checkFreeSpace,childEnvironment,resultStatus,pendingCleanup,probeTemporaryDirectory} = await import(runnerPath);
const {planTests,unitTests,pgSmokeTests} = await import(profilesPath);
const dir = mkdtempSync(join(tmpdir(),'runner-check-'));
afterAll(()=>rmSync(dir,{recursive:true,force:true}));

it('默认快测没有PG；完整回归必须显式选择all，PG默认只选核心文件',()=>{
  expect(planTests().pg).toBe(false);
  expect(planTests().include).toEqual(unitTests);
  expect(planTests('pg').include).toEqual(pgSmokeTests);
  expect(planTests('all').include).toEqual(['tests/**/*.test.ts']);
  expect(()=>planTests('all',['tests/ledger-db.test.ts'])).toThrow('不接受');
  expect(unitTests).not.toContain('tests/lifecycle-account.test.ts');
});
it('明确的PG文件自动使用PG，按文件过滤，不把指定回归变成全量',()=>{
  const plan=planTests('unit',['tests/ledger-db.test.ts']);
  expect(plan.pg).toBe(true);
  expect(plan.filters).toEqual(['tests/ledger-db.test.ts']);
  expect(planTests('unit',['tests/doudizhu.test.ts']).pg).toBe(false);
  expect(()=>planTests('pg',['--config=other.config.ts'])).toThrow('不覆盖');
});
it('拒绝系统TEMP或越出包目录的scratch，不为省事转到别的盘',()=>{
  mkdirSync(join(dir,'.task-tmp'));
  expect(scratchBase(dir)).toBe(join(dir,'.task-tmp','test-runs'));
  expect(()=>scratchBase(dir,tmpdir())).toThrow('本包');
  expect(()=>scratchBase(dir,dir)).toThrow('本包');
  expect(()=>scratchBase(dir,'.task-tmp')).toThrow('本包');
});
it('父进程在启动Vitest前把所有子进程临时位置设在同一个独占目录',()=>{
  const env=childEnvironment({TEMP:'old-system-temp',NODE_OPTIONS:'--require guarded-shim.cjs',CODEBUDDY_SAFE_DELETE_BULK_GUARD:'1'},dir,'test01',planTests('pg'));
  for(const key of ['TEMP','TMP','TMPDIR','PARLOR_TEST_TMP','PARLOR_TEST_RUN_ROOT']) expect(env[key]).toBe(dir);
  expect(env.PARLOR_TEST_RUN_ID).toBe('test01');
  expect(env.PARLOR_TEST_PG_URL).toBe('');
  expect(env.NODE_OPTIONS).toBe('--require guarded-shim.cjs');
  expect(env.CODEBUDDY_SAFE_DELETE_BULK_GUARD).toBe('1');
});
it('磁盘不足时提前拒绝，足够时通过，不通过放宽测试超时掩盖问题',()=>{
  expect(()=>checkFreeSpace(100,1024)).toThrow('空间不足');
  expect(()=>checkFreeSpace(1024,1024)).not.toThrow();
});

it('测试通过但清理失败返回2；测试本身失败保留其退出码，两类结果分别记录',()=>{
  expect(resultStatus(0,0)).toEqual({testExitCode:0,cleanupExitCode:0,exitCode:0});
  expect(resultStatus(0,2)).toEqual({testExitCode:0,cleanupExitCode:2,exitCode:2});
  expect(resultStatus(1,2)).toEqual({testExitCode:1,cleanupExitCode:2,exitCode:1});
  expect(resultStatus(null,2)).toEqual({testExitCode:null,cleanupExitCode:2,exitCode:2});
});
it('基本探针验证递归目录删除，完成后不留下探针子目录',()=>{
  probeTemporaryDirectory(dir);
});
it('只有已记录失败且仍存在、所有权匹配的运行目录阻止再次堆积；不删除残留',async()=>{
  const {writeFileSync}=await import('node:fs');
  const root=join(dir,'pending-check');
  const runDir=join(root,'.task-tmp/test-runs/run-orphan');
  const results=join(root,'.task-tmp/test-results');
  mkdirSync(runDir,{recursive:true});mkdirSync(results);
  writeFileSync(join(runDir,'owner.json'),JSON.stringify({kind:'parlor-test-run',id:'orphan'}));
  const receipt={kind:'parlor-test-run',id:'orphan',runDir,cleaned:false,exitCode:1};
  writeFileSync(join(results,'failed.json'),JSON.stringify(receipt));
  expect(pendingCleanup(root)).toEqual([runDir]);
  writeFileSync(join(results,'failed.json'),JSON.stringify({...receipt,cleaned:true}));
  expect(pendingCleanup(root)).toEqual([]);
});
