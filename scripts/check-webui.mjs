import { readFileSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

// 可传实际 tarball 的解包目录，检查发布物，而不只检查源码树。
const root = resolve(process.argv[2] || '.');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
if (!manifest.files?.includes('dist')) throw new Error('npm files 清单缺少 dist，面板产物不会随包发布');
for (const field of ['webUiClient', 'webUiStyle']) {
  const entry = manifest.cortico?.[field];
  if (typeof entry !== 'string' || !entry) throw new Error(`缺少 cortico.${field}`);
  const file = resolve(root, entry);
  const within = relative(root, file);
  if (isAbsolute(within) || within.startsWith('..')) throw new Error(`面板产物越出包目录：${entry}`);
  if (!statSync(file).isFile()) throw new Error(`缺少面板产物：${entry}`);
}
const bundle = await import(pathToFileURL(resolve(root, manifest.cortico.webUiClient)).href);
if (typeof bundle.default?.panels?.history?.mount !== 'function') {
  throw new Error('面板产物缺少 panels.history.mount(ctx)');
}
console.log('WebUI package check passed: history panel JS/CSS and mount(ctx).');
