import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/check-release.mjs', import.meta.url));
const scratch = fileURLToPath(new URL('../.task-tmp/', import.meta.url));
const manifest = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
const { version } = JSON.parse(manifest) as { version: string };

it.each([
  { kind: 'world', page: 'play', asset: '/play/assets/brand-new.js', tag: '<script src="ASSET"></script>' },
  { kind: 'gateway', page: 'parent', asset: '/parent/assets/new-style.css', tag: "<link rel='stylesheet' href='ASSET'>" },
])('$kind 拒绝漏加版本的新资源，补齐后通过', ({ kind, page, asset, tag }) => {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'parlor-release-'));
  try {
    mkdirSync(join(root, 'src/room'), { recursive: true });
    mkdirSync(join(root, 'src/web'), { recursive: true });
    if (kind === 'world') {
      writeFileSync(join(root, 'package.json'), manifest);
      writeFileSync(join(root, 'src/room/client.ts'), `export const PARLOR_CLIENT_VERSION = ${JSON.stringify(version)};`);
      writeFileSync(join(root, 'src/room/server.ts'), 'export class ParlorServer {}');
    } else {
      const commands = ['parlor-gateway', 'parlor-migrate-json', 'parlor-migrate-pg', 'parlor-table-doctor'];
      const bin = Object.fromEntries(commands.map(command => [command, 'scripts/' + command + '.js']));
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        name: 'cortico-parlor-gateway', type: 'module', version, bin, dependencies: { pg: '*' },
      }));
      mkdirSync(join(root, 'scripts'));
      for (const entry of Object.values(bin)) writeFileSync(join(root, entry), '#!/usr/bin/env node\n');
      writeFileSync(join(root, 'src/room/world-server.js'), 'export const WorldServer = { create() {} };');
    }
    for (const name of kind === 'world' ? ['play'] : ['play', 'parent']) {
      const html = readFileSync(new URL(`../src/web/${name}.html`, import.meta.url), 'utf8');
      writeFileSync(join(root, `src/web/${name}.html`), html);
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
      mkdirSync(join(root, 'src/room/storage'));
      const bundledStorage = check(`${asset}?v=${version}`);
      expect(bundledStorage.status, bundledStorage.stderr).toBe(1);
      expect(bundledStorage.stderr).toContain('World 发布包含网关文件：src/room/storage');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
