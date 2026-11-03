/** Node 侧执行真实 SFC 的 script/template；不模拟浏览器布局、网络或子组件。 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';
import { renderToString } from 'vue/server-renderer';
import * as vue from 'vue';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const runtime = { ...vue, onMounted: () => {}, onBeforeUnmount: () => {} };

function evaluate(source: string, filename: string): any {
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (name: string): any => {
    if (name === 'vue') return runtime;
    if (name.endsWith('.vue')) return { __esModule: true, default: { render: () => null } };
    if (name.startsWith('.')) {
      const target = resolve(dirname(filename), name);
      return evaluate(readFileSync(target, 'utf8'), target);
    }
    return require(name);
  };
  new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
  return module.exports;
}

export function gameComponent(name: string) {
  const filename = resolve('web-src/components/games', name);
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
  const script = compileScript(descriptor, { id: name });
  const component = evaluate(script.content, filename).default;
  const template = compileTemplate({
    source: descriptor.template!.content, filename, id: name,
    compilerOptions: { bindingMetadata: script.bindings },
  });
  if (template.errors.length) throw new Error(template.errors.map(String).join('\n'));
  component.render = evaluate(template.code, filename).render;
  return {
    logic(props: Record<string, unknown>) {
      const scope = vue.effectScope();
      const state = scope.run(() => component.setup(vue.reactive(props), { expose() {} }));
      return { state, stop: () => scope.stop() };
    },
    html: (props: Record<string, unknown>) => renderToString(vue.createSSRApp(component, props)),
  };
}

/** 执行 legacy/store 中的真实函数体，给不可导出的闭包函数提供最小依赖。 */
export function sourceFunction(path: string, name: string, bindings: Record<string, unknown>) {
  const source = readFileSync(path, 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true);
  let declaration: ts.FunctionDeclaration | undefined;
  const find = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration ??= node;
    ts.forEachChild(node, find);
  };
  find(file);
  if (!declaration) throw new Error(`Missing function ${name}: ${path}`);
  const fn = declaration.getText(file).replace(/^export\s+/, '');
  const code = ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), `return (${code});`)(...Object.values(bindings));
}
