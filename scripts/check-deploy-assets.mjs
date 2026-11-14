import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [mode, directory, ...extra] = process.argv.slice(2);
if (!['--record', '--check'].includes(mode) || !directory || extra.length) {
  throw new Error('用法：node scripts/check-deploy-assets.mjs --record|--check <部署目录>');
}

const root = resolve(directory);
const manifestPath = join(root, 'deploy-manifest.json');
const files = ['src/web/assets/cards/cards.webp'];
const hash = file => createHash('sha256').update(readFileSync(join(root, file))).digest('hex');

if (mode === '--record') {
  const assets = Object.fromEntries(files.map(file => [file, hash(file)]));
  writeFileSync(manifestPath, JSON.stringify({ assets }, null, 2) + '\n', { flag: 'wx' });
} else {
  const { assets } = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const file of files) {
    if (!/^[a-f0-9]{64}$/.test(assets?.[file] ?? '') || hash(file) !== assets[file]) {
      throw new Error(`部署素材缺少有效的 SHA-256 或校验失败：${file}`);
    }
  }
  console.log('部署素材 SHA-256 校验通过');
}
