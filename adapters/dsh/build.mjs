import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const adapter = new URL('.', import.meta.url);
const absWorkingDir = fileURLToPath(adapter);
const dist = new URL('dist/', adapter);

await mkdir(dist, { recursive: true });
await Promise.all([
  build({
    absWorkingDir, entryPoints: ['src/host.ts'], bundle: true,
    platform: 'node', target: 'node22', format: 'esm', outfile: 'dist/host.js',
  }),
  build({
    absWorkingDir, entryPoints: ['src/client.js'], bundle: true,
    format: 'iife', outfile: 'dist/client.js',
  }),
  copyFile(new URL('../../LICENSE', adapter), new URL('LICENSE', dist)),
  copyFile(new URL('../../assets/icon.webp', adapter), new URL('icon.webp', dist)),
]);
