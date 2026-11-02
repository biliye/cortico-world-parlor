/**
 * 网页客户端的构建链（Vue 迁移期）。
 *
 * 产物写回 src/web/vue/，仍由现有的静态文件服务读盘、gzip、算 ETag，
 * 所以服务端逻辑与 npm 打包规则都不用改。发布包只带构建结果，使用者不需要自己 build。
 *
 * base 必须与 vue-loader.js 里的相对路径对得上：/play/assets/vue/。
 */
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  base: '/play/assets/vue/',
  build: {
    outDir: 'src/web/vue',
    emptyOutDir: true,
    target: 'es2022',
    // 页面 CSP 是 script-src 'self' / style-src 'self'：产物里不能出现内联脚本、内联样式或 eval。
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: 'web-src/main.ts',
      output: {
        entryFileNames: 'main.js',
        chunkFileNames: 'chunk-[hash].js',
        assetFileNames: 'vue-[name][extname]',
      },
    },
  },
  define: {
    // 只写 <script setup>，用不到 Options API；关掉能少一截运行时。
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
});
