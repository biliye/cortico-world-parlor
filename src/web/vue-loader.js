/**
 * Vue 迁移期的入口开关。
 *
 * 迁移期间带 ?vue=1 才载入新包，正常访问仍走旧的 play.js，所以线上行为不变。
 * 视图全部搬完后，这里改成无条件 import('./vue/main.js')，play.html 只留这一支脚本。
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
if (params.has('vue')) {
  import('./vue/main.js').catch((error) => {
    console.error('[parlor] Vue 包载入失败', error);
  });
}
