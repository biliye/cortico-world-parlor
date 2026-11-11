/** 渲染真实组件验证本人/旁观者文案；不连接服务器，不启动 PG。 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse, compileScript } from 'vue/compiler-sfc';
import ts from 'typescript';
import { createSSRApp, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';

let component: Component;
beforeAll(async () => {
  const source = readFileSync(new URL('../web-src/components/games/GomokuGame.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: 'test-gomoku', inlineTemplate: true });
  let code = ts.transpileModule(script.content, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const vueUrl = new URL('index.mjs', pathToFileURL(createRequire(import.meta.url).resolve('vue/package.json'))).href;
  code = code.replace(/from\s+['"]vue['"]/g, `from ${JSON.stringify(vueUrl)}`);
  const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  component = (await import(/* @vite-ignore */ url)).default;
});

const render = (viewer: string, status = 'ended', winner: string | null = 'black', priv: unknown = null, cause?: string) => renderToString(createSSRApp(component, {
  view: {
    table: { game: 'gomoku', status, board: Array(225).fill(0),
      seats: [{ id: 'black', name: '黑方', color: 1 }, { id: 'white', name: '白方', color: 2 }], winningLine: [], winner,
      ...(cause ? { cause } : {}) },
    priv, me: { id: viewer },
  },
  ctx: { showLobby() {}, rematch() {} },
}));

describe('五子棋玩家与旁观者身份', () => {
  it('旁观者只显示观战和实际赢家，没有个人执棋或输赢', async () => {
    const html = await render('spectator');
    expect(html).toContain('观战');
    expect(html).toContain('黑方获胜');
    expect(html).not.toMatch(/你执黑|你执白|你输了|你赢了/);
    expect(html).not.toContain('gomoku-result lose');
  });
  it('双方仍显示自己的颜色和输赢', async () => {
    expect(await render('black')).toContain('你赢了');
    const white = await render('white');
    expect(white).toContain('你输了');
    expect(white).toContain('你执白');
    expect(white).not.toContain('观战');
  });
  it('未结束的旁观和终局和棋都不显示错误输赢', async () => {
    expect(await render('spectator', 'playing', null)).not.toMatch(/你输了|你赢了|黑方获胜/);
    const draw = await render('spectator', 'ended', null);
    expect(draw).toContain('和棋');
    expect(draw).toContain('观战');
    expect(draw).not.toMatch(/你输了|你执黑|你执白/);
  });
  it('未点建议时就单独显示威胁，只有双威胁使用红色样式', async () => {
    const single = await render('white', 'playing', null, {
      canAct: true, warning: { level: 'block', text: '对方有活三。不堵就被连成五，有冲四时可抢先手。' },
    });
    expect(single).toContain('class="gomoku-tip block"');
    expect(single).toContain('不堵就被连成五');
    expect(single).not.toContain('gomoku-tip danger');
    const double = await render('white', 'playing', null, {
      canAct: true, warning: { level: 'danger', text: '对方双活三，单手封堵挡不住两路。' },
    });
    expect(double).toContain('class="gomoku-tip danger"');
    expect(double).toContain('对方双活三');
  });
  it('结算页统一给「再来一局」，认输的局把胜负原因写成认输', async () => {
    const line = await render('black');
    expect(line).toContain('再来一局');
    expect(line).toContain('返回客厅');
    expect(line).not.toContain('认输');
    const opponentResigned = await render('black', 'ended', 'black', null, 'resign');
    expect(opponentResigned).toContain('对手认输');
    expect(opponentResigned).toContain('再来一局');
    expect(await render('white', 'ended', 'black', null, 'resign')).toContain('你认输了');
  });
  it('轮到自己时给认输按钮，没轮到就不给', async () => {
    expect(await render('white', 'playing', null, { canAct: true })).toContain('认输');
    expect(await render('white', 'playing', null, { canAct: false })).not.toContain('认输');
  });
});
