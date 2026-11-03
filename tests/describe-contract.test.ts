import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { PARLOR } from '../src/definition.ts';

it('随包 describe 的工具、事件和提示与源码一致，不再宣传已停用的承诺能力', () => {
  const shipped = JSON.parse(readFileSync(new URL('../describe.json',import.meta.url),'utf8'));
  expect(shipped.tools).toEqual(JSON.parse(JSON.stringify(PARLOR.describe!.tools)));
  expect(shipped.events).toEqual(JSON.parse(JSON.stringify(PARLOR.describe!.events)));
  expect(shipped.prompts.find((row:{role:string})=>row.role==='envPrompt').content)
    .toBe(readFileSync(new URL('../src/ENV_PROMPT.md',import.meta.url),'utf8'));
  expect(shipped.tools.some((row:{name:string})=>['parlor_promise','parlor_respond'].includes(row.name))).toBe(false);
  for (const tool of shipped.tools) {expect(tool.summary.zh).toBeTruthy();expect(tool.summary.en).toBeTruthy();}
  const ledger = shipped.tools.find((row:{name:string})=>row.name==='parlor_ledger');
  expect(JSON.stringify(ledger)).not.toMatch(/未了结承诺|open promises/);
  expect(JSON.stringify(shipped.events.find((row:{type:string})=>row.type==='parlor.ledger'))).not.toMatch(/承诺|失约|promise|default/);
});
