import { defineConfig } from 'vite';

// 独立于会馆网页；只打包控制台面板，使用者安装后无需自行构建。
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    lib: { entry: 'src/webui/client.ts', formats: ['es'], fileName: () => 'webui.js', cssFileName: 'webui' },
  },
});
