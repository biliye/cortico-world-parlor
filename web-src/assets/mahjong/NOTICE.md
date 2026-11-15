# 牌面美术来源

`*.svg` 34 张牌面（Man/Pin/Sou 1–9 + Ton/Nan/Shaa/Pei/Chun/Hatsu/Haku）来自
[FluffyStuff/riichi-mahjong-tiles](https://github.com/FluffyStuff/riichi-mahjong-tiles) 的 `Regular` 目录。

该仓库的 `LICENSE.md` 原文：

> This work is in the public domain. For more information, visit
> https://creativecommons.org/publicdomain/zero/1.0/.

即 CC0 1.0 公共领域贡献，可商用、可修改、无需署名。本目录的文件相对上游做了两处改动：

1. 用 SVGO 3 的 `preset-default` 压缩（去掉 Inkscape/RDF 元数据、合并路径、缩短数值），
   并显式保留 `viewBox="0 0 300 400"` 与元素 id（`removeViewBox: false`、`cleanupIds.minify: false`）。
   体积 788 KB → 341 KB，gzip 后合计约 25 KB。
2. 未使用上游的 `Front.svg` / `Back.svg` / `Blank.svg`：牌身、厚度、阴影与牌背由组件样式绘制，
   这里只取「牌面图案」这一层，都是透明底。

上游另有 `Man5-Dora` / `Pin5-Dora` / `Sou5-Dora`（赤宝牌）未取用——本地规则（四川血战、广东推倒胡）没有赤牌。

运行时使用由这 34 张 SVG 绘制的透明 WebP 图集 `faces.webp`。每格 84×112，前三行依次为万、筒、条（每行 1–9），末行依次为东、南、西、北、红中、发、白，最后两格留空。牌面图集解码前先显示文字牌名。

重新生成时，在包目录运行 `pnpm exec vite --host 127.0.0.1 --base /`。用 Chromium 打开本地地址下的 `/src/web/play.html`，在控制台执行下面的代码，然后把下载的 `faces.webp` 保存到本目录。Canvas 的透明背景会保留，WebP 质量为 0.78。

```js
const tiles = [
  ...['Man', 'Pin', 'Sou'].flatMap(suit => Array.from({ length: 9 }, (_, i) => suit + (i + 1))),
  'Ton', 'Nan', 'Shaa', 'Pei', 'Chun', 'Hatsu', 'Haku',
];
const canvas = document.createElement('canvas');
canvas.width = 84 * 9;
canvas.height = 112 * 4;
const context = canvas.getContext('2d');
const images = await Promise.all(tiles.map(async tile => {
  const image = new Image();
  image.src = '/web-src/assets/mahjong/' + tile + '.svg';
  await image.decode();
  return image;
}));
images.forEach((image, i) => context.drawImage(image, (i % 9) * 84, Math.floor(i / 9) * 112, 84, 112));
const download = document.createElement('a');
download.download = 'faces.webp';
download.href = canvas.toDataURL('image/webp', 0.78);
download.click();
```
