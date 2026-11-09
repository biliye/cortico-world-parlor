/**
 * 网页客户端的唯一入口：载入 Vue 应用。
 *
 * 旧 play.js 已在 0.40.0 下线；带 ?legacy=1 的旧链接由服务器 302 回 /play，
 * 这里不再分派第二支，也就不会同时跑两张 SSE 连接、两份席位状态。
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

// 版本串只改 play.html 里这一处：loader 自己带什么版本，Vue 包与样式就跟着带什么。
// 静态资源有 5 分钟缓存，改了包却不换串，页面会继续跑旧文件。
const version = new URL(import.meta.url).searchParams.get('v') || '';
const withVersion = (path) => (version ? path + '?v=' + version : path);
const style = document.createElement('link');
style.rel = 'stylesheet';
style.href = new URL(withVersion('./vue/vue-style.css'), import.meta.url).href;
document.head.append(style);

import(withVersion('./vue/main.js')).catch((error) => {
  console.error('[parlor] 客户端载入失败', error);
  const box = document.getElementById('boot-note');
  if (box) box.textContent = '页面载入失败，请刷新重试。';
});
