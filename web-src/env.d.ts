declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

declare module '*.webp' {
  const url: string;
  export default url;
}

declare module '*.svg?url' {
  const url: string;
  export default url;
}

/**
 * 只声明本项目实际用到的那一种 glob 形态（`eager` + `query: '?url'`）。
 * 没有整体引入 vite/client 类型：那份类型会顺手把 node 侧的全局塞进来，
 * 与 tsconfig.web.json「网页端不放 node 类型」的划分冲突。
 */
interface ImportMeta {
  glob<T = string>(
    pattern: string | string[],
    options: { eager: true; query: string; import: string },
  ): Record<string, T>;
}
