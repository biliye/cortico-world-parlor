import { readFileSync, writeFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const { version } = JSON.parse(read('../package.json'));
const check = process.argv.includes('--check');
const targets = [
  ['../src/room/client.ts', /(?<=PARLOR_CLIENT_VERSION = ')[^']+/g],
  ['../src/web/play.html', /(?<=[?&]v=)[^"'&\s]+/g],
  ['../src/web/parent.html', /(?<=[?&]v=)[^"'&\s]+/g],
  ['../src/web/support.html', /(?<=[?&]v=)[^"'&\s]+/g],
  ['../src/web/identity.html', /(?<=[?&]v=)[^"'&\s]+/g],
  ['../src/web/welcome.html', /(?<=[?&]v=)[^"'&\s]+/g],
];

const assetPrefixes = ['/play/assets/', '/parent/assets/', '/welcome/assets/'];

for (const [path, pattern] of targets) {
  const before = read(path);
  const after = before.replace(pattern, version);
  if (after !== before) {
    if (check) {
      console.error(`${path} 与 package.json 的版本不同，请运行 pnpm sync:version`);
      process.exitCode = 1;
    } else {
      writeFileSync(new URL(path, import.meta.url), after);
    }
  }
  if (path.endsWith('.html')) {
    const html = (check ? before : after).replace(/<!--[\s\S]*?-->/g, '');
    for (const match of html.matchAll(/<(?:link|script)\b[^>]*?\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      const raw = match[1] ?? match[2] ?? match[3] ?? '';
      if (!assetPrefixes.some(prefix => raw.startsWith(prefix))) continue;
      const url = new URL(raw.replaceAll('&amp;', '&'), 'http://localhost');
      const versions = url.searchParams.getAll('v');
      if (versions.length !== 1 || versions[0] !== version) {
        console.error(`${path} 中的 ${url.pathname} 缺少或错配 ?v=${version}（实际：${versions.length ? versions.join(',') : '无'}）`);
        process.exitCode = 1;
      }
    }
  }
}
