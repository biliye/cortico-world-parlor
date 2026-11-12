import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// These entry assets use the package version as their cache key.
const versionedAssets = {
  play: ['theme.js', 'club.css', 'appearance.css', 'night.css', 'vue-loader.js'],
  parent: ['parent.css', 'parent.js'],
};

function checkAssetVersions(root, version) {
  for (const [page, assets] of Object.entries(versionedAssets)) {
    const htmlPath = `src/web/${page}.html`;
    const html = readFileSync(join(root, htmlPath), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const prefix = `/${page}/assets/`;
    const requiredPaths = assets.map(asset => prefix + asset);
    const urls = [...html.matchAll(/<(?:script|link)\b[^>]*?\s(?:src|href)\s*=\s*(["'])(.*?)\1/gi)]
      .map(([, , value]) => value)
      .filter(value => value.startsWith(prefix))
      .map(value => new URL(value, 'http://localhost'));

    for (const path of requiredPaths) {
      if (!urls.some(url => url.pathname === path)) {
        throw new Error(`${htmlPath} 缺少资源引用 ${path}`);
      }
    }
    for (const url of urls) {
      const versions = url.searchParams.getAll('v');
      if (!requiredPaths.includes(url.pathname) && versions.length === 0) continue;
      if (versions.length !== 1 || versions[0] !== version) {
        const actual = versions.length === 0 ? '缺少 v' : JSON.stringify(versions);
        throw new Error(`${htmlPath} 的 ${url.pathname} 应带一个 v=${version}，实际为 ${actual}`);
      }
    }
  }
}

function checkRelease(packageDir) {
  const root = resolve(packageDir);
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (typeof version !== 'string' || !version) throw new Error('package.json 缺少版本号');
  checkAssetVersions(root, version);

  const probe = `
    import { pathToFileURL } from 'node:url';
    const [gatewayFile, clientFile, version] = process.argv.slice(1);
    const { WorldServer } = await import(pathToFileURL(gatewayFile).href);
    if (typeof WorldServer?.create !== 'function') throw new Error('网关缺少 WorldServer.create');
    const { PARLOR_CLIENT_VERSION } = await import(pathToFileURL(clientFile).href);
    if (PARLOR_CLIENT_VERSION !== version) {
      throw new Error('PARLOR_CLIENT_VERSION 应为 ' + version + '，实际为 ' + PARLOR_CLIENT_VERSION);
    }
  `;
  // A preload such as tsx can hide syntax rejected by the deployed Node loader.
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--input-type=module', '-e', probe, '--',
    join(root, 'src/room/world-server.ts'), join(root, 'src/room/client.ts'), version,
  ], { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('网关 strip-only 装载或客户端版本检查失败');

  console.log(`发布包检查通过（${version}）：网关 strip-only 装载、客户端和网页资源版本。`);
}

try {
  if (process.argv.length !== 3) throw new Error('用法：pnpm check:release <npm 包解包后的目录>');
  checkRelease(process.argv[2]);
} catch (error) {
  console.error(`[parlor release] ${error.message}`);
  process.exitCode = 1;
}
