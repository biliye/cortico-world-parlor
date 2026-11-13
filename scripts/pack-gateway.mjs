import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const [destination = '.', ...extra] = process.argv.slice(2);
const pnpm = process.env.npm_execpath;
if (extra.length || !pnpm) {
  throw new Error('用法：pnpm pack:gateway [产物目录]');
}
const output = resolve(destination);
mkdirSync(output, { recursive: true });
const scratch = join(root, '.task-tmp');
mkdirSync(scratch, { recursive: true });
const stage = mkdtempSync(join(scratch, 'gateway-pack-'));

try {
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.gateway.json', '--outDir', stage], {
    cwd: root, stdio: 'inherit',
  });
  const web = join(root, 'src/web');
  const excluded = new Set([
    'assets/cards/cards.webp', 'local-history.html', 'local-history.js',
  ]);
  cpSync(web, join(stage, 'src/web'), {
    recursive: true,
    filter: (source) => !excluded.has(relative(web, source).split(sep).join('/')),
  });
  for (const file of ['LICENSE', 'docs/storage-migration.md', 'src/room/ratings/LICENSE']) {
    cpSync(join(root, file), join(stage, file));
  }
  const readme = readFileSync(join(root, 'docs/gateway.md'), 'utf8');
  writeFileSync(join(stage, 'README.md'), readme.replace('(storage-migration.md)', '(docs/storage-migration.md)'));

  const world = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const commands = {
    'parlor-gateway': 'scripts/serve-world.js',
    'parlor-migrate-json': 'scripts/migrate-json.js',
    'parlor-migrate-pg': 'scripts/migrate-sqlite-to-pg.js',
    'parlor-table-doctor': 'scripts/table-doctor.js',
  };
  const manifest = {
    name: 'cortico-parlor-gateway',
    version: world.version,
    description: '鲸语茶室 PostgreSQL 多客厅网关与迁移工具',
    type: 'module',
    author: world.author,
    license: world.license,
    repository: world.repository,
    publishConfig: world.publishConfig,
    engines: world.engines,
    bin: commands,
    scripts: {
      'serve:world': 'node ' + commands['parlor-gateway'],
      'migrate:json': 'node ' + commands['parlor-migrate-json'],
      'migrate:pg': 'node ' + commands['parlor-migrate-pg'],
    },
    files: ['src', 'scripts', 'docs/storage-migration.md'],
    dependencies: { pg: world.devDependencies.pg },
  };
  writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const javascriptLauncher = /\.[cm]?js$/i.test(pnpm);
  const args = ['pack', '--pack-destination', output];
  execFileSync(javascriptLauncher ? process.execPath : pnpm, javascriptLauncher ? [pnpm, ...args] : args, {
    cwd: stage, stdio: 'inherit',
  });
} finally {
  const within = relative(scratch, stage);
  if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('网关打包临时目录越界');
  rmSync(stage, { recursive: true, force: true });
}
