/**
 * 把 `src/room/game-rules-doc.ts` 的两块内容写进 `src/web/welcome.html`：
 *
 *   rules:begin / rules:end                 玩法屏上的按钮
 *   rules-dialog:begin / rules-dialog:end   规则弹层（放在所有屏之后）
 *
 *   pnpm build:welcome           写入（生成物入库，和 src/web/vue/* 一样）
 *   pnpm build:welcome --check   只核，不一致时退出 1
 *
 * 规则只有这一份来源：改文案去 game-rules-doc.ts，别直接改 welcome.html 里那两段。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderRuleDialog, renderRulesMarkup } from '../src/room/game-rules-doc.ts';

export const RULES_BEGIN = '<!-- rules:begin -->';
export const RULES_END = '<!-- rules:end -->';
export const DIALOG_BEGIN = '<!-- rules-dialog:begin -->';
export const DIALOG_END = '<!-- rules-dialog:end -->';

const PAGE = new URL('../src/web/welcome.html', import.meta.url);

/** 把一对标记之间的内容换成新的渲染结果；标记本身留着，end 标记前的缩进也补回去。 */
const splice = (page: string, beginMark: string, endMark: string, markup: string, indent: string): string => {
  const begin = page.indexOf(beginMark);
  const end = page.indexOf(endMark);
  if (begin < 0 || end < begin) throw new Error(`welcome.html 里找不到 ${beginMark} / ${endMark} 标记`);
  return `${page.slice(0, begin + beginMark.length)}\n${markup}\n${indent}${page.slice(end)}`;
};

export function spliceRules(
  page: string,
  cards: string = renderRulesMarkup(),
  dialog: string = renderRuleDialog(),
): string {
  // 先换弹层再换按钮：两处标记各管各的，顺序不影响结果。
  const withDialog = splice(page, DIALOG_BEGIN, DIALOG_END, dialog, '      ');
  return splice(withDialog, RULES_BEGIN, RULES_END, cards, '        ');
}

function main(): void {
  const check = process.argv.includes('--check');
  const raw = readFileSync(PAGE, 'utf8');
  /* 换行按目标文件自己的风格走。工作树在 Windows 上是 CRLF、Linux 上是 LF，
     不归一就比不出内容差异（--check 永远报不一致），写回还会让文件变成半 CRLF 半 LF。 */
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const page = raw.replace(/\r\n/g, '\n');
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
  writeFileSync(PAGE, eol === '\n' ? next : next.replace(/\n/g, eol));
  console.log('已写入 src/web/welcome.html');
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invoked === import.meta.url) main();
