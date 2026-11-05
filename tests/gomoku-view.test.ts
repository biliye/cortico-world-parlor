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

const render = (viewer: string, status = 'ended', winner: string | null = 'black') => renderToString(createSSRApp(component, {
  view: {
    table: { game: 'gomoku', status, board: Array(225).fill(0),
      seats: [{ id: 'black', name: '黑方', color: 1 }, { id: 'white', name: '白方', color: 2 }], winningLine: [], winner },
    priv: null, me: { id: viewer },
  },
  ctx: { showLobby() {} },
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
});
