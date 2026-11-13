import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const requiredAssets = {
  play: ['theme.js', 'club.css', 'appearance.css', 'night.css', 'vue-loader.js'],
  parent: ['parent.css', 'parent.js'],
};
const assetPrefixes = ['/play/assets/', '/parent/assets/'];
const unversionedAssets = new Set(['/play/assets/play.css']);
const localServerScript = 'node --experimental-strip-types scripts/serve.ts';
const cliProbes = [
  { command: 'parlor-gateway', args: ['--database-url', ''], status: 2, message: '必须配 PARLOR_DATABASE_URL' },
  { command: 'parlor-migrate-json', args: [], status: 2, message: '用法：parlor-migrate-json' },
  { command: 'parlor-migrate-pg', args: ['--help'], status: 0, message: '用法: --source' },
  { command: 'parlor-table-doctor', args: ['--list'], status: 1, message: '必须配 PARLOR_DATABASE_URL' },
];

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
      const file = url.pathname.replace(/^\/(?:play|parent)\/assets\//, '');
      if (!statSync(join(root, 'src/web', file), { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`${htmlPath} 引用的资源未打包：${url.pathname}`);
      }
      const versions = url.searchParams.getAll('v');
      if (versions.length === 0 && unversionedAssets.has(url.pathname)) continue;
      if (versions.length !== 1 || versions[0] !== version) {
        const actual = versions.length === 0 ? '缺少 v' : JSON.stringify(versions);
        throw new Error(`${htmlPath} 的 ${url.pathname} 应带一个 v=${version}，实际为 ${actual}`);
      }
    }
  }
}

function checkWorldModules(root, entry) {
  const seen = new Set();
  const pending = [resolve(root, entry), join(root, 'scripts/serve.ts')];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
      throw new Error('World 缺少引用文件：' + relative(root, file));
    }
    const { importedFiles } = ts.preProcessFile(readFileSync(file, 'utf8'), true);
    for (const { fileName } of importedFiles) {
      if (fileName.startsWith('./') || fileName.startsWith('../')) pending.push(resolve(dirname(file), fileName));
      if (fileName === 'pg' || fileName.startsWith('pg/')) throw new Error('World 模块引用 pg：' + relative(root, file));
    }
  }
}

function checkGatewayCommands(root, bin) {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(?:PARLOR_|NODE_OPTIONS$)/i.test(key)));
  for (const { command, args, status, message } of cliProbes) {
    const entry = bin?.[command];
    if (!entry?.endsWith('.js') || !readFileSync(join(root, entry), 'utf8').startsWith('#!/usr/bin/env node')) {
      throw new Error('网关缺少可直接运行的 Node 命令：' + command);
    }
    const result = spawnSync(process.execPath, [join(root, entry), ...args], {
      cwd: root, env, encoding: 'utf8', timeout: 15_000,
    });
    if (result.error) throw result.error;
    const output = result.stdout + result.stderr;
    if (result.status !== status || !output.includes(message)) {
      throw new Error(`网关命令 ${command} 装载检查失败（退出码 ${result.status}）：${output.trim()}`);
    }
  }
  if (!existsSync(join(root, 'src/room/ratings/worker.js'))) throw new Error('网关缺少排行榜 worker.js');
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
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
      if (Object.hasOwn(manifest[field] ?? {}, 'pg')) throw new Error('World 安装依赖含 pg');
    }
    if (Object.keys(manifest.scripts ?? {}).length !== 1 || manifest.scripts.serve !== localServerScript) {
      throw new Error('World 包脚本应只保留本机单厅 serve');
    }
    for (const path of [
      'src/room/world-server.ts', 'src/room/global-identity.ts', 'src/room/storage', 'src/room/migration',
      'scripts/serve-world.ts', 'scripts/migrate-json.ts', 'scripts/migrate-sqlite-to-pg.ts', 'scripts/table-doctor.ts',
      'src/web/parent.html', 'src/web/support.html', 'src/web/identity.html',
    ]) {
      if (existsSync(join(root, path))) throw new Error('World 发布包含网关文件：' + path);
    }
    if (typeof manifest.main !== 'string') throw new Error('World 缺少入口 main');
    checkWorldModules(root, manifest.main);
    checkAssetVersions(root, version, ['play']);
    checkModules(root, 'src/room/client.ts', version);
  } else if (name === 'cortico-parlor-gateway') {
    if (!manifest.dependencies?.pg || manifest.cortico) throw new Error('网关包清单缺少 pg 或包含 World 注册');
    checkAssetVersions(root, version, ['play', 'parent']);
    checkModules(root, 'src/room/world-server.js');
    checkGatewayCommands(root, manifest.bin);
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
