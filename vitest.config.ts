import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
// @ts-expect-error plain Node launcher module, shared with package scripts
import { unitTests } from './scripts/test-profiles.mjs';

if (!process.env.PARLOR_TEST_RUN_ROOT) throw new Error('不支持IDE直接启动Vitest；请在终端运行 pnpm test，确保启动前设置工位临时目录');

export default defineConfig({
  cacheDir:resolve(process.env.PARLOR_TEST_RUN_ROOT || '.task-tmp/vite-unit','vite'),
  test:{include:unitTests,env:{CORTICO_LANGUAGE:'zh'},pool:'forks',
    testTimeout:120_000,hookTimeout:60_000,
    poolOptions:{forks:{minForks:1,maxForks:1}},
  },
});
