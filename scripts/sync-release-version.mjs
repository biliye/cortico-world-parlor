import { readFileSync, writeFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const { version } = JSON.parse(read('../package.json'));
const check = process.argv.includes('--check');
const targets = [
  ['../src/room/client.ts', /(?<=PARLOR_CLIENT_VERSION = ')[^']+/g],
  ['../src/web/play.html', /(?<=[?&]v=)[^"'&\s]+/g],
  ['../src/web/parent.html', /(?<=[?&]v=)[^"'&\s]+/g],
];

for (const [path, pattern] of targets) {
  const before = read(path);
  const after = before.replace(pattern, version);
  if (after === before) continue;
  if (check) {
    console.error(`${path} 与 package.json 的版本不同，请运行 pnpm sync:version`);
    process.exitCode = 1;
  } else {
    writeFileSync(new URL(path, import.meta.url), after);
  }
}
