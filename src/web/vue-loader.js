/**
 * 网页客户端的唯一入口。
 *
 * 默认载入 Vue 应用；带 ?legacy=1 时回到旧 play.js（排障与对照用，迁移完成后可删）。
 * 两支不会同时跑，所以同一个浏览器里只有一张 SSE 连接、一份席位状态。
 *
 * 同时收集 CSP 拦截：页面的 script-src / style-src 都是 'self'，Vue 产物一旦出现
 * eval 或内联样式就会在这里留下一条，验收时直接读 window.__parlorCsp。
 */
const violations = [];
window.__parlorCsp = violations;
document.addEventListener('securitypolicyviolation', (event) => {
  violations.push({
    directive: event.violatedDirective,
    blocked: event.blockedURI,
    sample: event.sample,
  });
  console.error('[parlor] CSP 拦截', event.violatedDirective, event.blockedURI);
});

const params = new URLSearchParams(location.search);
// 版本串只改 play.html 里这一处：loader 自己带什么版本，两个入口就跟着带什么。
// 静态资源有 5 分钟缓存，改了包却不换串，页面会继续跑旧文件。
const version = new URL(import.meta.url).searchParams.get('v') || '';
const withVersion = (path) => (version ? path + '?v=' + version : path);
const entry = withVersion(params.has('legacy') ? './play.js' : './vue/main.js');
if (!params.has('legacy')) {
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = new URL(withVersion('./vue/vue-style.css'), import.meta.url).href;
  document.head.append(style);
}
import(entry).catch((error) => {
  console.error('[parlor] 客户端载入失败', error);
});
