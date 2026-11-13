import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/check-release.mjs', import.meta.url));
const scratch = fileURLToPath(new URL('../.task-tmp/', import.meta.url));
const { version, scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const gatewayProbes = [
  { command: 'parlor-gateway', status: 2, message: '必须配 PARLOR_DATABASE_URL' },
  { command: 'parlor-migrate-json', status: 2, message: '用法：parlor-migrate-json' },
  { command: 'parlor-migrate-pg', status: 0, message: '用法: --source' },
  { command: 'parlor-table-doctor', status: 1, message: '必须配 PARLOR_DATABASE_URL' },
];

it.each([
  { kind: 'world', page: 'play', asset: '/play/assets/brand-new.js', tag: '<script src="ASSET"></script>' },
  { kind: 'gateway', page: 'parent', asset: '/parent/assets/new-style.css', tag: "<link rel='stylesheet' href='ASSET'>" },
])('$kind 拒绝漏加版本的新资源，补齐后通过', ({ kind, page, asset, tag }) => {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'parlor-release-'));
  try {
    mkdirSync(join(root, 'src/room'), { recursive: true });
    mkdirSync(join(root, 'src/web'), { recursive: true });
    mkdirSync(join(root, 'scripts'));
    if (kind === 'world') {
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        name: 'cortico-world-parlor', type: 'module', version, main: './src/index.ts', scripts: { serve: scripts.serve },
      }));
      writeFileSync(join(root, 'src/index.ts'), "export { PARLOR_CLIENT_VERSION } from './room/client.ts';");
      writeFileSync(join(root, 'scripts/serve.ts'), "import '../src/room/server.ts';");
      writeFileSync(join(root, 'src/room/client.ts'), `export const PARLOR_CLIENT_VERSION = ${JSON.stringify(version)};`);
      writeFileSync(join(root, 'src/room/server.ts'), 'export class ParlorServer {}');
    } else {
      const bin = Object.fromEntries(gatewayProbes.map(({ command }) => [command, 'scripts/' + command + '.js']));
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        name: 'cortico-parlor-gateway', type: 'module', version, bin, dependencies: { pg: '*' },
      }));
      for (const { command, status, message } of gatewayProbes) {
        writeFileSync(join(root, bin[command]), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(message)}); process.exitCode = ${status};\n`);
      }
      mkdirSync(join(root, 'src/room/ratings'));
      writeFileSync(join(root, 'src/room/ratings/worker.js'), '');
      writeFileSync(join(root, 'src/room/world-server.js'), 'export const WorldServer = { create() {} };');
    }
    for (const name of kind === 'world' ? ['play'] : ['play', 'parent']) {
      const html = readFileSync(new URL(`../src/web/${name}.html`, import.meta.url), 'utf8');
      writeFileSync(join(root, `src/web/${name}.html`), html);
    }
    for (const file of ['theme.js', 'play.css', 'club.css', 'appearance.css', 'night.css', 'vue-loader.js',
      'parent.css', 'parent.js', 'brand-new.js', 'new-style.css']) {
      writeFileSync(join(root, 'src/web', file), '');
    }

    const target = join(root, `src/web/${page}.html`);
    const html = readFileSync(target, 'utf8');
    const check = (url: string) => {
      writeFileSync(target, html.replace('</head>', `${tag.replace('ASSET', url)}\n</head>`));
      return spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
    };
    const missing = check(asset);
    expect(missing.status, missing.stderr).toBe(1);
    expect(missing.stderr).toContain(`${asset} 应带一个 v=${version}，实际为 缺少 v`);

    const correct = check(`${asset}?v=${version}`);
    expect(correct.status, correct.stderr).toBe(0);

    if (kind === 'world') {
      writeFileSync(join(root, 'src/index.ts'), "import type { Missing } from './missing.ts';");
      const missingImport = check(`${asset}?v=${version}`);
      expect(missingImport.status, missingImport.stderr).toBe(1);
      expect(missingImport.stderr).toMatch(/World 缺少引用文件：src[\\/]missing\.ts/);

      mkdirSync(join(root, 'src/room/storage'));
      const bundledStorage = check(`${asset}?v=${version}`);
      expect(bundledStorage.status, bundledStorage.stderr).toBe(1);
      expect(bundledStorage.stderr).toContain('World 发布包含网关文件：src/room/storage');
    } else {
      unlinkSync(join(root, 'src/web/new-style.css'));
      const missingAsset = check(`${asset}?v=${version}`);
      expect(missingAsset.status, missingAsset.stderr).toBe(1);
      expect(missingAsset.stderr).toContain('引用的资源未打包');
      writeFileSync(join(root, 'src/web/new-style.css'), '');
      writeFileSync(join(root, 'scripts/parlor-migrate-json.js'), "#!/usr/bin/env node\nimport './missing.js';\n");
      const missingImport = check(`${asset}?v=${version}`);
      expect(missingImport.status, missingImport.stderr).toBe(1);
      expect(missingImport.stderr).toContain('网关命令 parlor-migrate-json 装载检查失败');
      expect(missingImport.stderr).toContain('ERR_MODULE_NOT_FOUND');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
