import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/check-release.mjs', import.meta.url));
const manifest = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
const { version } = JSON.parse(manifest) as { version: string };

it.each([
  { page: 'play', asset: '/play/assets/brand-new.js', tag: '<script src="ASSET"></script>' },
  { page: 'parent', asset: '/parent/assets/new-style.css', tag: "<link rel='stylesheet' href='ASSET'>" },
])('$page 拒绝漏加版本的新资源，补齐后通过', ({ page, asset, tag }) => {
  const root = mkdtempSync(join(tmpdir(), 'parlor-release-'));
  try {
    mkdirSync(join(root, 'src/room'), { recursive: true });
    mkdirSync(join(root, 'src/web'), { recursive: true });
    writeFileSync(join(root, 'package.json'), manifest);
    writeFileSync(join(root, 'src/room/world-server.ts'), 'export const WorldServer = { create() {} };');
    writeFileSync(join(root, 'src/room/client.ts'), `export const PARLOR_CLIENT_VERSION = ${JSON.stringify(version)};`);
    for (const name of ['play', 'parent']) {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
