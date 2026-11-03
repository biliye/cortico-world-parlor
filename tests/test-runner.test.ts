import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

// Computed imports keep Node-only TS checking independent of plain JS scripts.
const runnerPath = '../scripts/test.mjs';
const profilesPath = '../scripts/test-profiles.mjs';
const {scratchBase,checkFreeSpace,childEnvironment} = await import(runnerPath);
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
  const env=childEnvironment({TEMP:'old-system-temp'},dir,'test01',planTests('pg'));
  for(const key of ['TEMP','TMP','TMPDIR','PARLOR_TEST_TMP','PARLOR_TEST_RUN_ROOT']) expect(env[key]).toBe(dir);
  expect(env.PARLOR_TEST_RUN_ID).toBe('test01');
  expect(env.PARLOR_TEST_PG_URL).toBe('');
});
it('磁盘不足时提前拒绝，足够时通过，不通过放宽测试超时掩盖问题',()=>{
  expect(()=>checkFreeSpace(100,1024)).toThrow('空间不足');
  expect(()=>checkFreeSpace(1024,1024)).not.toThrow();
});
