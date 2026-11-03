import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
// @ts-expect-error plain Node launcher module, shared with package scripts
import { pgSmokeTests } from './scripts/test-profiles.mjs';

if (!process.env.PARLOR_TEST_RUN_ROOT) throw new Error('不支持IDE直接启动Vitest；请在终端运行 pnpm test:pg 或 pnpm test:all，使用受管隔离PG');

/**
 * PostgreSQL 模式的全量测试。
 *
 * 用 scripts/test.mjs 在启动Node前设置临时目录；一轮一个隔离集群，
 * 每次fixture请求独立库、已关闭的临时库按项回收。默认单进程，
 * 日常只选核心5文件，只有显式all才包含完整套件。
 */
export default defineConfig({
  test: {
    include: process.env.PARLOR_TEST_MODE==='all' || process.env.PARLOR_TEST_TARGETED==='1' ? ['tests/**/*.test.ts'] : pgSmokeTests,
    env: { CORTICO_LANGUAGE: 'zh' },
    // 冷启动的嵌入式 PG（fsync + 空缓存）比常驻库慢很多，狼人杀整局这类测试要留足时间。
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: 'forks',
    globalSetup: ['tests/helpers/pg-session.ts'],
    setupFiles: ['tests/helpers/pg-cleanup.ts'],
    poolOptions: { forks: { minForks: 1, maxForks: 1 } },
  },
  cacheDir:resolve(process.env.PARLOR_TEST_RUN_ROOT || '.task-tmp/vite-pg','vite'),
});
