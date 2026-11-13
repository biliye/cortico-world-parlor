import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const requiredAssets = {
  play: ['theme.js', 'club.css', 'appearance.css', 'night.css', 'vue-loader.js'],
  parent: ['parent.css', 'parent.js'],
};
const assetPrefixes = ['/play/assets/', '/parent/assets/'];
const unversionedAssets = new Set(['/play/assets/play.css']);

function checkAssetVersions(root, version, pages) {
  for (const page of pages) {
    const assets = requiredAssets[page];
    const htmlPath = `src/web/${page}.html`;
    const html = readFileSync(join(root, htmlPath), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const prefix = `/${page}/assets/`;
    const requiredPaths = assets.map(asset => prefix + asset);
    const urls = [...html.matchAll(/<[a-z][\w:-]*\b[^>]*?\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
      .map(([, doubleQuoted, singleQuoted, unquoted]) => doubleQuoted ?? singleQuoted ?? unquoted)
      .filter(value => assetPrefixes.some(assetPrefix => value.startsWith(assetPrefix)))
      .map(value => new URL(value.replaceAll('&amp;', '&'), 'http://localhost'));

    for (const path of requiredPaths) {
      if (!urls.some(url => url.pathname === path)) {
        throw new Error(`${htmlPath} 缺少资源引用 ${path}`);
      }
    }
    for (const url of urls) {
      const versions = url.searchParams.getAll('v');
      if (versions.length === 0 && unversionedAssets.has(url.pathname)) continue;
      if (versions.length !== 1 || versions[0] !== version) {
        const actual = versions.length === 0 ? '缺少 v' : JSON.stringify(versions);
        throw new Error(`${htmlPath} 的 ${url.pathname} 应带一个 v=${version}，实际为 ${actual}`);
      }
    }
  }
}

function checkModules(root, entry, ...params) {
  const probe = `
    import { pathToFileURL } from 'node:url';
    const [file, version] = process.argv.slice(1);
    const url = pathToFileURL(file);
    const entry = await import(url);
    if (version) {
      if (entry.PARLOR_CLIENT_VERSION !== version) {
        throw new Error('PARLOR_CLIENT_VERSION 应为 ' + version + '，实际为 ' + entry.PARLOR_CLIENT_VERSION);
      }
      const { ParlorServer } = await import(new URL('./server.ts', url));
      if (typeof ParlorServer !== 'function') throw new Error('缺少本机单厅入口');
    } else if (typeof entry.WorldServer?.create !== 'function') {
      throw new Error('网关缺少 WorldServer.create');
    }
  `;
  const result = spawnSync(process.execPath, [
    ...(entry.endsWith('.ts') ? ['--experimental-strip-types'] : []),
    '--input-type=module', '-e', probe, '--', join(root, entry), ...params,
  ], { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('装载或版本检查失败：' + entry);
}

function checkRelease(packageDir) {
  const root = resolve(packageDir);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const { name, version } = manifest;
  if (typeof version !== 'string' || !version) throw new Error('package.json 缺少版本号');
  if (existsSync(join(root, 'src/web/assets/cards/cards.webp'))) throw new Error('发布包包含限制分发的牌面素材');

  if (name === 'cortico-world-parlor') {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      if (Object.hasOwn(manifest[field] ?? {}, 'pg')) throw new Error('World 安装依赖含 pg');
    }
    for (const path of [
      'src/room/world-server.ts', 'src/room/global-identity.ts', 'src/room/storage', 'src/room/migration',
      'scripts/serve-world.ts', 'scripts/migrate-json.ts', 'scripts/migrate-sqlite-to-pg.ts', 'scripts/table-doctor.ts',
      'src/web/parent.html', 'src/web/support.html', 'src/web/identity.html',
    ]) {
      if (existsSync(join(root, path))) throw new Error('World 发布包含网关文件：' + path);
    }
    checkAssetVersions(root, version, ['play']);
    checkModules(root, 'src/room/client.ts', version);
  } else if (name === 'cortico-parlor-gateway') {
    if (!manifest.dependencies?.pg || manifest.cortico) throw new Error('网关包清单缺少 pg 或包含 World 注册');
    checkAssetVersions(root, version, ['play', 'parent']);
    checkModules(root, 'src/room/world-server.js');
    for (const command of ['parlor-gateway', 'parlor-migrate-json', 'parlor-migrate-pg', 'parlor-table-doctor']) {
      const entry = manifest.bin?.[command];
      if (!entry?.endsWith('.js') || !readFileSync(join(root, entry), 'utf8').startsWith('#!/usr/bin/env node')) {
        throw new Error('网关缺少可直接运行的 Node 命令：' + command);
      }
    }
  } else {
    throw new Error('未知发布包：' + name);
  }
  console.log(`发布包检查通过：${name}@${version}`);
}

try {
  if (process.argv.length !== 3) throw new Error('用法：pnpm check:release <npm 包解包后的目录>');
  checkRelease(process.argv[2]);
} catch (error) {
  console.error(`[parlor release] ${error.message}`);
  process.exitCode = 1;
}
