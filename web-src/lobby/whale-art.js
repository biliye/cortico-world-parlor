/* 鲸鱼娘的贴图：两张雪碧图，进大厅时悄悄加载。
   加载失败不是错误 —— 画师不在，屋子照开，只是少一个人。       */

import { WHALE_CLIPS, WHALE_SHEETS } from './whale-clips.js';

/** scene.js 要的形状：{ clips: { 'room/idle/east': {...} } } */
export const WHALE = { version: 'whale-girl-native-v1', clips: WHALE_CLIPS };

/* 贴图放在 src/web/assets/whale/ 下，和 cards、table-bg 同一个目录。
   注意 URL 里是**两个 assets**：前一个是服务端路由前缀（/play/assets/ 映射到 src/web/），
   后一个是仓库里的目录名。写成 /play/assets/whale/ 会 404 —— 已经踩过一次。 */
const BASE = '/play/assets/assets/whale/';

/**
 * 把两张雪碧图都解码完再返回；任何一张失败就跳过它。
 * @param {string} [base]
 * @returns {Promise<Record<string, HTMLImageElement>>}
 */
export function loadWhaleImages(base = BASE) {
  const jobs = WHALE_SHEETS.map((file) => new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve({ file, img });
    img.onerror = () => resolve({ file, img: null });
    img.src = base + file;
  }));

  return Promise.all(jobs).then((done) => {
    const byFile = new Map();
    for (const item of done) if (item.img) byFile.set(item.file, item.img);

    /** 清单里每个 clip 的 sheet 字段是 'sheet/xxx.png'，取出文件名去配。 */
    const images = {};
    for (const [key, clip] of Object.entries(WHALE_CLIPS)) {
      const file = String(clip.sheet).split('/').pop();
      const img = byFile.get(file);
      if (img) images[key] = img;
    }
    return images;
  });
}
