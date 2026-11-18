/**
 * 把 `src/room/game-rules-doc.ts` 的规则渲染进 `src/web/welcome.html` 的 rules 标记之间。
 *
 *   pnpm build:welcome           写入（生成物入库，和 src/web/vue/* 一样）
 *   pnpm build:welcome --check   只核，不一致时退出 1
 *
 * 规则只有这一份来源：改文案去 game-rules-doc.ts，别直接改 welcome.html 里那一段。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderRulesMarkup } from '../src/room/game-rules-doc.ts';

export const RULES_BEGIN = '<!-- rules:begin -->';
export const RULES_END = '<!-- rules:end -->';

const PAGE = new URL('../src/web/welcome.html', import.meta.url);
/** 标记前的缩进：end 标记前面也要补回同样的空格。 */
const INDENT = '      ';

/** 把标记之间的内容换成新的渲染结果；标记本身留着。 */
export function spliceRules(page: string, markup: string = renderRulesMarkup()): string {
  const begin = page.indexOf(RULES_BEGIN);
  const end = page.indexOf(RULES_END);
  if (begin < 0 || end < begin) throw new Error('welcome.html 里找不到 rules:begin / rules:end 标记');
  return `${page.slice(0, begin + RULES_BEGIN.length)}\n${markup}\n${INDENT}${page.slice(end)}`;
}

function main(): void {
  const check = process.argv.includes('--check');
  const page = readFileSync(PAGE, 'utf8');
  const next = spliceRules(page);
  if (next === page) {
    console.log('欢迎页规则已是最新');
    return;
  }
  if (check) {
    console.error('欢迎页规则与 game-rules-doc.ts 不一致：跑一次 pnpm build:welcome');
    process.exitCode = 1;
    return;
  }
  writeFileSync(PAGE, next);
  console.log('已写入 src/web/welcome.html');
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invoked === import.meta.url) main();
