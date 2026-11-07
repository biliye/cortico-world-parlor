<script setup lang="ts">
/**
 * 大厅那面墙上的「画」：一间真的在动的中式茶馆。
 *
 * 画法一行都不在这里 —— 全在 `../lobby/scene.js`（从像素原型整段搬来的 canvas 代码）。
 * 这个组件只负责四件事：
 *   1. 起停时钟（不可见、切到后台就停，别让一个背景动画一直吃电）；
 *   2. 贴图异步到位后重画，失败就安静地少一个人；
 *   3. 尊重 `prefers-reduced-motion`：不动的版本也给一张能看的画；
 *   4. 把 canvas 的逻辑分辨率钉死 576×324，放大交给 CSS 的最近邻。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { createScene, SCENE_H, SCENE_W } from '../lobby/scene.js';
import type { SceneHandle } from '../lobby/scene.js';
import { loadWhaleImages, WHALE } from '../lobby/whale-art.js';

const root = ref<HTMLDivElement | null>(null);
const box = ref<HTMLCanvasElement | null>(null);

let scene: SceneHandle | null = null;
let raf = 0;
let last = 0;
let clock = 0;
let onScreen = true;
let disposed = false;

/** 定格在一个「人站着、茶在冒汽」的时刻，给不想看动效的人。 */
const STILL_AT = 3200;

/** 卸载时要逐个撤掉的东西（观察器、事件监听）。 */
const cleanup: Array<() => void> = [];

function stop(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  last = 0;
}

function tick(now: number): void {
  raf = requestAnimationFrame(tick);
  if (!scene || !onScreen) {
    last = now;
    return;
  }
  /* 从后台回来时 now 会跳掉几秒，夹一下，否则一进大厅就是「跳了一帧」。 */
  const dt = last ? Math.min(120, now - last) : 16;
  last = now;
  clock += dt;
  scene.frame(clock);
}

function play(): void {
  if (disposed || raf || !scene) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    scene.frame(STILL_AT);
    return;
  }
  last = 0;
  raf = requestAnimationFrame(tick);
}

onMounted(async () => {
  const canvas = box.value;
  if (!canvas) return;

  canvas.width = SCENE_W;
  canvas.height = SCENE_H;

  /* 先画屋子再等人 —— 贴图那两张一共 240KB，慢网下不该空着一块。 */
  scene = createScene({ canvas, whale: WHALE });
  scene.frame(STILL_AT);

  const images = await loadWhaleImages();
  if (disposed) return;
  scene = createScene({ canvas, whale: WHALE, images });
  clock = STILL_AT;
  play();

  /* 离开视口就停：这个动画只是背景，不该在用户滚到下面看卡片时还满帧跑。 */
  if ('IntersectionObserver' in window && root.value) {
    const io = new IntersectionObserver((entries) => {
      onScreen = entries.some((e) => e.isIntersecting);
      if (onScreen) play();
      else stop();
    }, { threshold: 0.05 });
    io.observe(root.value);
    cleanup.push(() => io.disconnect());
  }

  const onHide = (): void => {
    if (document.hidden) stop();
    else play();
  };
  document.addEventListener('visibilitychange', onHide);
  cleanup.push(() => document.removeEventListener('visibilitychange', onHide));
});

onBeforeUnmount(() => {
  disposed = true;
  stop();
  for (const off of cleanup) off();
  cleanup.length = 0;
  scene = null;
});
</script>

<template>
  <div ref="root" class="tea-scene">
    <canvas ref="box" :width="SCENE_W" :height="SCENE_H" aria-hidden="true" />
  </div>
</template>

<style scoped>
.tea-scene {
  position: relative;
  display: block;
  width: 100%;
  overflow: hidden;
}

.tea-scene canvas {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 16 / 9;
  /* 一整格一整格地放大，不要浏览器插值 */
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}
</style>
