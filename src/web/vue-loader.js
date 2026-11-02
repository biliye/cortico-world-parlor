/**
 * 网页客户端的唯一入口。
 *
 * 迁移期：带 ?vue=1 载入新应用，否则载入旧的 play.js。两支不会同时跑，
 * 所以同一个浏览器里只有一张 SSE 连接、一份席位状态。
 * 视图全部搬完后，这里只留 import('./vue/main.js')，play.html 也不用再改。
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
// 两个入口都带版本串：静态资源有 5 分钟缓存，改完不换串会吃到旧文件。
// 旧版沿用 play.html 原来的串；Vue 包每次构建后递增。
const LEGACY_VERSION = 'parent-link-20261102';
const VUE_VERSION = 'vue-slice2b-20261102';
const entry = params.has('vue')
  ? './vue/main.js?v=' + VUE_VERSION
  : './play.js?v=' + LEGACY_VERSION;
import(entry).catch((error) => {
  console.error('[parlor] 客户端载入失败', error);
});
