/**
 * 对外页唯一的一段脚本：首屏画框的指针视差。
 *
 * 只有这一个动效需要脚本——入场、悬停、滚动条都是 welcome-kit.css 里的纯 CSS。
 * 系统开了「减少动态效果」就完全不注册，页面直接是静止的最终状态。
 * 位移量写在 welcome.css 里（≤ 12px），这里只把指针位置换算成 -0.5 ~ 0.5。
 */
(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const hero = document.querySelector('.hero');
  if (!hero) return;
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  let queued = 0;
  hero.addEventListener('pointermove', (event) => {
    if (queued) return;
    queued = requestAnimationFrame(() => {
      queued = 0;
      const box = hero.getBoundingClientRect();
      if (!box.width || !box.height) return;
      hero.style.setProperty('--mx', ((event.clientX - box.left) / box.width - 0.5).toFixed(3));
      hero.style.setProperty('--my', ((event.clientY - box.top) / box.height - 0.5).toFixed(3));
    });
  });
})();
