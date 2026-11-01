import { defineConfig } from 'vitest/config';

/**
 * PostgreSQL 模式的全量测试。
 *
 * 用 `PARLOR_TEST_PG=1`（起工位内嵌入式 PG）或 `PARLOR_TEST_PG_URL=postgres://…`（外部 PG）。
 * 每个测试文件一个独立库，连接数按池算（每个 PgDb 2 条）；并行度压到 4，
 * 免得几十个文件同时开池把测试库的 max_connections 用完。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: { CORTICO_LANGUAGE: 'zh' },
    // 冷启动的嵌入式 PG（fsync + 空缓存）比常驻库慢很多，狼人杀整局这类测试要留足时间。
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: 'forks',
    globalSetup: ['tests/helpers/pg-global.ts'],
    poolOptions: { forks: { minForks: 1, maxForks: 4 } },
  },
});
