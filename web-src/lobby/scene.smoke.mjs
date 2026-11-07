/**
 * 冒烟：不开浏览器，用假 canvas 把茶馆画 200 帧。
 *
 * 目的只有一个 —— **抓 ReferenceError**。上一版把调色板 `C` 漏在提取范围外，
 * 浏览器里表现为「一块全黑的 canvas」，得靠截图才看出来；这里跑一遍就报行号。
 *
 * 用法：node web-src/lobby/scene.smoke.mjs [scene.js 路径]
 */
const file = process.argv[2] || 'web-src/lobby/scene.js';

function makeCtx() {
  const store = new Map();
  const gradient = { addColorStop() {} };
  const target = {
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => null,
    measureText: () => ({ width: 10 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
  return new Proxy(target, {
    get(obj, key) {
      if (key in obj) return obj[key];
      if (store.has(key)) return store.get(key);
      return () => {};
    },
    set(obj, key, value) {
      store.set(key, value);
      return true;
    },
    has: () => true,
  });
}

function makeCanvas() {
  return { width: 0, height: 0, style: {}, getContext: () => makeCtx() };
}

globalThis.document = { createElement: () => makeCanvas() };

const { pathToFileURL } = await import('node:url');
const { resolve } = await import('node:path');
const { createScene, SCENE_W, SCENE_H } = await import(pathToFileURL(resolve(file)).href);
const canvas = makeCanvas();
const scene = createScene({ canvas });

let frames = 0;
try {
  for (let t = 0; t < 20000; t += 16) {
    scene.frame(t);
    frames += 1;
  }
  /* 也走一遍「点灯」，那段有自己的一套坐标 */
  scene.frameBoot(4000, 1200);
} catch (error) {
  console.error('画崩了，第', frames, '帧：', error.message);
  console.error(error.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
}

console.log('ok', frames, '帧，逻辑尺寸', SCENE_W + 'x' + SCENE_H);
