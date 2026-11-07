/* ===========================================================================
   大厅内景 · 一间中式茶馆（576×324）

   这一份**不是新写的**：画法、坐标、踩过的坑全部来自
   `prototypes/parlor-pixel/assets/lobby-v3.js`，搬进来时只做三件事：
     1. 把 IIFE 摊成一个 `createScene()`，canvas / 鲸鱼娘贴图 / 座位由外面注入；
     2. 去掉页面外壳（海报墙、详情卡、皮肤切换），只管画画；
     3. 时间去掉了「开屏点灯」的默认值 —— 真前端进大厅不该再等 3.4 秒。

   想改画面请改这里；原型那边同步改的话，用同样方式再搬一次。

   画法约束（照抄原文件，别推翻）：
     · canvas 内部就是 576×324，CSS 放大，所以所有坐标都是整数逻辑像素
     · 阴影/光晕一律逐行 fillRect（ctx.ellipse 会抗锯齿，在那之前就糊了）
     · 环境动画周期都能整除 LOOP，所以循环接手时看不出接缝
     · 人物和 Coo 用 T 直接算状态，所以定格可复现
   =========================================================================== */

export const SCENE_W = 576;
export const SCENE_H = 324;
export const SCENE_LOOP = 9600;

/** 点灯开屏的四个时刻（毫秒）。默认不用；留着手动开启或做「点一下把灯点上」。 */
export const BOOT_PH = {
  match: 800,
  ignite: 1180,
  spreadEnd: 2500,
  fadeEnd: 3020,
  text1: 2180,
  text2: 2560,
  text3: 2900,
};

/**
 * 建一间茶馆。
 *
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.canvas   576×324 的画布
 * @param {object}  [opts.whale]            鲸鱼娘的 clips 清单（见 whale-clips.js）
 * @param {object}  [opts.images]           已解码的 Image，键是 clip key
 * @param {Array}   [opts.seats]            真实座位（可选，用来替换背景里那 22 只）
 * @param {boolean} [opts.light=true]       打暖光；false 只用于对比
 */
export function createScene(opts = {}) {
  const W = SCENE_W;
  const H = SCENE_H;
  const LOOP = SCENE_LOOP;
  const TAU = Math.PI * 2;
  const BOOT_DUR = 3400;
  const PH = BOOT_PH;

  const canvas = opts.canvas;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  /* 地板透视：所有纵向线都从这一点发散出去 */
  const VPX = 288;
  const VPY = 150;

  /* 地平线（后墙与地面的交界）。
     196 这个数是被「人站在屋里哪个位置」倒推出来的：
       · 她 111px 高，真人约 165cm → 1px ≈ 1.5cm
       · 她站在案子后面，脚底 268 —— 比案子前沿（294）更靠里，
         所以桌面 232 正好切在她大腿根，是「柜台后的人」而不是「贴在桌上」
       · 268 再往下还有 56px 地面当前景，屋子才有「她站在屋子中间」的纵深
     改地板就不只是改一条线：她、案子、小马扎、地上的 Coo 全要跟着走。 */
  const FLOOR_Y = 196;

  let T = 0;
  let LIGHT_OFF = opts.light === false;
  let NO_WHALE = false;
  let NO_COO = false;
  let DBG_CORNER = false;

  /* ------------------------------------------------------------ 调色板 */
  const C = {
    // 木构
    ceil: '#221812',
    beam: '#3d2b21',
    beamHi: '#553b2c',
    beamLow: '#291b14',
    post: '#4a3428',
    postHi: '#5f4534',
    postLow: '#33231a',

    // 墙
    wall: '#5a4133',
    wallSeam: '#4d3628',
    wallLow: '#4a3427',
    wains: '#3b2a20',
    skirt: '#2b1e17',

    // 地板
    floor: '#583d2c',
    floorSeam: '#3b271c',
    floorHi: '#6b4c36',
    floorFar: '#46301f',

    // 窗
    night: '#1a2136',
    nightFar: '#26304a',
    snow: '#e6ecff',
    paper: '#ddcfae',
    lattice: '#5c412f',
    frame: '#6e4d37',

    // 茶柜与罐
    cab: '#523829',
    cabDark: '#3a2619',
    cabHi: '#6b4a34',

    // 茶案
    wood: '#6b4832',
    woodHi: '#8a6644',
    woodDark: '#48301f',

    // 器物
    celadon: '#8fb4a0',
    celadonDk: '#678d77',
    porc: '#efe7d6',
    porcDk: '#cdbfa6',
    brass: '#c89846',
    brassHi: '#f2d182',
    tea: '#b05f2c',
    clay: '#8c5a44',

    // 光
    lamp: '#f2bd5e',
    lampHi: '#ffe8b0',
    lampRim: '#8b4526',
    fire: '#ff8f42',
    ember: '#bf3f1c',
    gold: '#ffcd83',

    // 角色
    ink: '#2a1e1a',
  };

  /* ------------------------------------------------------------ 画图工具 */
  function box(color, x, y, w, h) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }

  /* 实心圆（逐行 fillRect，绝不抗锯齿） */
  function disc(cx, cy, r, color) {
    ctx.fillStyle = color;
    const R = Math.round(r);
    const X = Math.round(cx);
    const Y = Math.round(cy);
    for (let dy = -R; dy <= R; dy += 1) {
      const w = Math.round(Math.sqrt(Math.max(0, R * R - dy * dy)));
      if (w <= 0) continue;
      ctx.fillRect(X - w, Y + dy, w * 2, 1);
    }
  }

  function ellipse(cx, cy, rx, ry, color) {
    ctx.fillStyle = color;
    const RX = Math.round(rx);
    const RY = Math.round(ry);
    const X = Math.round(cx);
    const Y = Math.round(cy);
    for (let dy = -RY; dy <= RY; dy += 1) {
      const w = Math.round(RX * Math.sqrt(Math.max(0, 1 - (dy * dy) / (RY * RY))));
      if (w <= 0) continue;
      ctx.fillRect(X - w, Y + dy, w * 2, 1);
    }
  }

  /* 至少占 1px 的软点。ellipse() 在半径 <1.5 时宽度会 round 成 0，
     细的汽柱/光点会被静默吞掉 —— 细的一律走这里。 */
  function dot(x, y, r, color) {
    const rr = Math.max(0.7, r);
    ctx.fillStyle = color;
    for (let dy = -rr; dy <= rr; dy += 1) {
      const w = Math.max(0.5, rr * Math.sqrt(Math.max(0, 1 - (dy * dy) / (rr * rr))));
      ctx.fillRect(Math.round(x - w), Math.round(y + dy), Math.max(1, Math.round(w * 2)), 1);
    }
  }

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOut(t, p) { return 1 - Math.pow(1 - clamp01(t), p || 2); }

  /* 所有环境动画的相位：一圈里转 k 整圈，k 取整数 → 循环无缝 */
  function ph(k) { return (T / LOOP) * k * TAU; }

  /* ------------------------------------------------------------ 天花板 */
  const LANTERNS = [
    { x: 108, y: 52, r: 15, sway: 0.0 },
    { x: 288, y: 46, r: 18, sway: 1.9 },
    { x: 452, y: 52, r: 15, sway: 3.7 },
  ];

  function drawCeiling() {
    box(C.ceil, 0, 0, W, 28);

    /* 两根大梁：粗的那根压在前面 */
    box(C.beam, 0, 0, W, 15);
    box(C.beamHi, 0, 0, W, 2);
    box(C.beam, 0, 13, W, 4);
    box(C.beamLow, 0, 15, W, 2);

    /* 梁上的一点木纹，别让那 15px 死板 */
    for (let x = 0; x < W; x += 46) {
      box(C.beamLow, x, 3, 22, 1);
      box(C.beamHi, x + 12, 8, 30, 1);
    }

    /* 左右两根立柱 —— 茶馆的骨架。它们同时把画面左右各框住一点 */
    for (const px0 of [12, W - 26]) {
      box(C.post, px0, 15, 14, FLOOR_Y - 15);
      box(C.postHi, px0, 15, 2, FLOOR_Y - 15);
      box(C.postLow, px0 + 12, 15, 2, FLOOR_Y - 15);
      /* 柱础 */
      box(C.postLow, px0 - 2, FLOOR_Y - 10, 18, 10);
      box(C.post, px0 - 1, FLOOR_Y - 12, 16, 3);
    }
  }

  /* --------------------------------------------------------- 吊灯（灯笼） */
  /* 灯笼是全场唯一的暖光源，所以它自己要先亮起来，再往四面漏光。
     灯绳一直吊到梁下，灯身在 SWAY 里左右摆一点点 —— 幅度大了像秋千。 */
  function drawLanterns() {
    for (const L of LANTERNS) {
      const sw = Math.sin(ph(2) + L.sway) * 2.2;
      const cy = L.y + Math.round(sw * 0.4);
      const cx = Math.round(L.x + sw * 0.6);

      // 灯绳
      box('#2a1d16', cx, 15, 1, cy - L.r - 15);
      box('#3a2a20', cx - 0, 15, 1, 6);

      // 灯身：上下收口，中间鼓
      const r = L.r;
      ellipse(cx, cy, r * 0.86, r, C.lampRim);
      ellipse(cx, cy, r * 0.74, r * 0.9, C.lamp);
      ellipse(cx - r * 0.16, cy - r * 0.2, r * 0.42, r * 0.5, C.lampHi);

      // 竹骨：竖着两条暗线，灯才不是一颗球
      box('rgba(120,60,30,.35)', cx - Math.round(r * 0.5), cy - r + 2, 1, r * 2 - 4);
      box('rgba(120,60,30,.35)', cx + Math.round(r * 0.5), cy - r + 2, 1, r * 2 - 4);

      // 上下口（木/铜的圈）
      box(C.lampRim, cx - Math.round(r * 0.42), cy - r - 2, Math.round(r * 0.84), 3);
      box(C.lampRim, cx - Math.round(r * 0.42), cy + r - 1, Math.round(r * 0.84), 3);

      // 流苏
      box('#a8452c', cx, cy + r + 1, 1, 7);
      box('#a8452c', cx - 1, cy + r + 7, 3, 1);
    }
  }

  /* 灯的光：三团柔和的暖，压在所有东西上面（lighter）。
     这不是「加亮」，是「这屋子被灯照着」—— 没有它，所有道具都像贴纸。 */
  function drawLampGlow() {
    ctx.globalCompositeOperation = 'lighter';
    for (const L of LANTERNS) {
      const sw = Math.sin(ph(2) + L.sway) * 2.2;
      const cx = L.x + sw * 0.6;
      const cy = L.y + sw * 0.4;
      const f = 0.88 + 0.12 * Math.sin(ph(7) + L.sway * 2.1);

      // 灯本身的晕
      for (let i = 3; i >= 1; i -= 1) {
        disc(cx, cy, L.r + i * 5, `rgba(255,196,110,${(0.030 * f).toFixed(3)})`);
      }
      // 往下投的一片光锥
      const g = ctx.createLinearGradient(0, cy, 0, cy + 150);
      g.addColorStop(0, `rgba(255,190,110,${(0.085 * f).toFixed(3)})`);
      g.addColorStop(0.45, `rgba(255,170,90,${(0.032 * f).toFixed(3)})`);
      g.addColorStop(1, 'rgba(255,150,80,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(cx - L.r * 0.8, cy);
      ctx.lineTo(cx + L.r * 0.8, cy);
      ctx.lineTo(cx + L.r * 4.4, cy + 150);
      ctx.lineTo(cx - L.r * 4.4, cy + 150);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /* --------------------------------------------------------------- 后墙 */
  function drawWall() {
    box(C.wall, 0, 28, W, FLOOR_Y - 28);

    /* 竖向木板：每 28px 一条缝，别做太密，密了像牢房 */
    for (let x = 28; x < W; x += 28) box(C.wallSeam, x, 28, 1, FLOOR_Y - 28);
    /* 上暗下亮：光从下面来 */
    box('rgba(20,10,6,.30)', 0, 28, W, 24);

    /* 护墙板 + 踢脚 */
    box(C.wains, 0, 174, W, 18);
    box('#4a3326', 0, 174, W, 2);
    for (let x = 0; x < W; x += 34) box('#33241b', x, 176, 1, 16);
    box(C.skirt, 0, 190, W, 6);
    box('#38261c', 0, 190, W, 1);
  }

  /* --------------------------------------------------------------- 纸窗 */
  /* 不是玻璃窗，是糊纸的木格窗：外面夜色透进来，纸是半透的，
     所以先画夜，再蒙一层纸，最后压木格。这样窗外是「模糊的冷」，屋里是「暖」。 */
  const SNOW = [];
  for (let i = 0; i < 46; i += 1) {
    SNOW.push({
      ox: (i * 37) % 128,
      off: (i * 23) % 100,
      sp: 1 + (i % 3),
      s: i % 7 === 0 ? 2 : 1,
    });
  }

  const WIN = { x: 54, y: 44, w: 132, h: 128 };

  function drawWindow() {
    const { x, y, w, h } = WIN;

    /* 外框 */
    box(C.frame, x - 6, y - 6, w + 12, h + 12);
    box(C.lattice, x - 4, y - 4, w + 8, h + 8);

    /* 夜色：从上到下慢慢变深，远处有一线屋檐 */
    box(C.night, x, y, w, h);
    box(C.nightFar, x, y + h - 46, w, 46);
    box('#1d2438', x, y + h - 30, w, 30);

    /* 对面的屋檐剪影：两撇瓦，一撇比一撇低 */
    box('#141a2b', x - 2, y + h - 34, w + 4, 4);
    box('#141a2b', x + 6, y + h - 40, 44, 4);
    box('#141a2b', x + 58, y + h - 38, 40, 4);
    box('#0f1424', x + 22, y + h - 30, 3, 12);
    box('#0f1424', x + 78, y + h - 30, 3, 12);

    /* 雪：三层景深，近的快、远的慢，落在窗里就消失 */
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    SNOW.forEach((f, i) => {
      const p = ((T / LOOP) * f.sp + i / SNOW.length) % 1;
      const sy = Math.round(y + p * h);
      const sx = Math.round(x + f.ox + Math.sin((T / LOOP) * 2 * TAU + i * 0.7) * 1.6);
      ctx.globalAlpha = 0.35 + 0.55 * Math.sin(p * Math.PI);
      box(C.snow, sx, sy, f.s, f.s);
    });
    ctx.globalAlpha = 1;
    ctx.restore();

    /* 蒙一层纸：暖一点、灰一点，把窗外压成“看不太清” */
    ctx.fillStyle = 'rgba(214,196,158,.20)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(150,120,88,.10)';
    ctx.fillRect(x, y, w, h);

    /* 木格：3 列 × 4 行 */
    for (let i = 1; i < 3; i += 1) box(C.lattice, x + Math.round((w / 3) * i) - 1, y, 2, h);
    for (let i = 1; i < 4; i += 1) box(C.lattice, x, y + Math.round((h / 4) * i) - 1, w, 2);
    /* 格心的内亮边：纸被外面的雪映了一点白 */
    for (let i = 1; i < 3; i += 1) {
      box('rgba(230,215,180,.14)', x + Math.round((w / 3) * i) + 1, y, 1, h);
    }

    /* 窗台 */
    box('#6a4a34', x - 10, y + h + 6, w + 20, 5);
    box('#7d5a40', x - 10, y + h + 6, w + 20, 1);
    box('#3d281c', x - 10, y + h + 11, w + 20, 2);
  }

  /* --------------------------------------------------------------- 茶柜 */
  /* 一柜茶罐是「这是茶馆」最快的一眼信号 —— 比写「茶」字还快。
     每个罐子形状一样、颜色不同，排在一起就有了「很多种茶」的意思。 */
  const JARS = ['#7d9c86', '#9c5a46', '#5f6f8c', '#b08d5a', '#7a6a9c', '#8c9c5a', '#a8703f'];

  function drawCabinet() {
    const x = 376;
    const y = 44;
    const w = 128;
    const h = 130;

    box(C.cab, x, y, w, h);
    box(C.cabHi, x, y, w, 3);
    box(C.cabDark, x, y + h - 4, w, 4);

    /* 4 列 × 3 行 */
    const gx = 5;
    const gy = 7;
    const cw = 30;
    const ch = 38;
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 4; c += 1) {
        const bx = x + gx + c * cw;
        const by = y + gy + r * ch;
        const inner = cw - 6;
        const innerH = ch - 6;

        /* 格内：暗，越靠上越暗（灯从下面来，格子里是深的） */
        box(C.cabDark, bx, by, inner, innerH);
        box('rgba(0,0,0,.25)', bx, by, inner, 4);

        /* 茶罐 */
        const idx = (r * 4 + c) % JARS.length;
        const jw = 13 + ((r + c) % 2) * 2;
        const jh = 17 + ((r * 3 + c) % 4) * 2;
        const jx = bx + Math.round((inner - jw) / 2);
        const jy = by + innerH - jh - 2;

        box(JARS[idx], jx, jy, jw, jh);
        box('rgba(255,255,255,.16)', jx, jy, jw, 1);
        box('rgba(0,0,0,.22)', jx + jw - 2, jy + 1, 2, jh - 1);
        /* 罐口 + 盖子 */
        box('rgba(0,0,0,.35)', jx, jy, jw, 2);
        box('#d8c9a8', jx - 1, jy - 2, jw + 2, 2);
        box('#a89372', jx - 1, jy, jw + 2, 1);
        /* 罐身一道纸签 */
        box('rgba(240,232,210,.55)', jx + 2, jy + 6, jw - 4, 3);
      }
      /* 层板 */
      box('#3a2619', x + 3, y + gy + (r + 1) * ch - 3, w - 6, 3);
      box('#6b4a34', x + 3, y + gy + (r + 1) * ch - 3, w - 6, 1);
    }

    /* 柜脚 */
    box(C.cabDark, x + 4, y + h, 6, 8);
    box(C.cabDark, x + w - 10, y + h, 6, 8);
  }

  /* --------------------------------------------------------------- 匾额 */
  /* 写「茶」字比画任何图形都快 —— 用项目自己的像素中文字体，
     1x canvas 下 24px 正好是设计尺寸，边上不会有一圈灰。 */
  function glyph(text, x, y, px, color) {
    ctx.save();
    ctx.font = `${px}px FusionPixel, monospace`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function drawPlaque() {
    const x = 198;
    const y = 46;
    const w = 74;
    const h = 46;

    box('#6b4a34', x, y, w, h);
    box('#8a6644', x, y, w, 2);
    box('#3d281c', x, y + h - 2, w, 2);
    box('#33201a', x + 4, y + 4, w - 8, h - 8);
    box('#3d2822', x + 5, y + 5, w - 10, h - 10);

    glyph('茶', x + w / 2, y + h / 2 + 1, 24, '#e8bf74');

    /* 匾下两条挂穗 */
    box('#8b4732', x + 10, y + h, 1, 8);
    box('#8b4732', x + w - 11, y + h, 1, 8);
  }

  /* ------------------------------------------------ 右墙角：一摞竹蒸笼 */
  /* 铜壶是「在烧水」，蒸笼是「在出餐」—— 两个热源，屋子才像在做生意。 */
  function drawSteamer() {
    const cx = 527;
    const baseY = 196;

    /* 陶炉 */
    box('#402a19', cx - 18, baseY - 3, 36, 3);
    box('#6b4028', cx - 17, baseY - 24, 34, 21);
    box('#8a5233', cx - 17, baseY - 24, 34, 2);
    box('#4d2c1b', cx - 17, baseY - 6, 34, 3);
    /* 炉膛里的火：一条被风箱吹得忽明忽暗的橙线 */
    const fl = 0.72 + 0.28 * Math.sin(ph(13)) * Math.sin(ph(29) + 1.4);
    ctx.globalAlpha = fl;
    box(C.fire, cx - 8, baseY - 14, 16, 3);
    box('#ffd9a0', cx - 5, baseY - 13, 10, 1);
    ctx.globalAlpha = 1;

    /* 两屉蒸笼：竹黄，跟旁边的茶柜（深红木）一眼就分得开 */
    for (let i = 0; i < 2; i += 1) {
      const y = baseY - 24 - 12 * (i + 1);
      box('#c9a06a', cx - 20, y, 40, 12);
      box('#e3c08c', cx - 20, y, 40, 2);
      box('#9a7444', cx - 20, y + 10, 40, 2);
      /* 竹篾接口 */
      box('#8a6636', cx - 20, y + 3, 2, 7);
      box('#8a6636', cx + 18, y + 3, 2, 7);
      box('rgba(90,60,26,.20)', cx - 15, y + 5, 30, 1);
      box('rgba(255,238,200,.16)', cx - 15, y + 2, 30, 1);
    }
    /* 笼盖：比屉略宽一圈 */
    const lidY = baseY - 48;
    box('#d8b47e', cx - 22, lidY, 44, 5);
    box('#f0d2a0', cx - 22, lidY, 44, 1);
    box('#9a7444', cx - 22, lidY + 4, 44, 1);
    box('#b08a52', cx - 3, lidY - 3, 6, 3);

    /* 汽：三股细柱叠成一蓬。单股是钢丝，三股才是蒸汽 */
    drawSteam(cx - 13, lidY - 3, 58, 1.1, 0.75);
    drawSteam(cx - 3, lidY - 3, 70, 2.7, 0.95);
    drawSteam(cx + 9, lidY - 3, 52, 4.3, 0.65);
  }

  /* ------------------------------------------------------- 墙上：菜单木牌 */
  /* 只挂一个「茶」字是招牌，把茶名都列出来才是「在营业」。
     三块小木牌用绳子吊在匾额下沿，各自晃的相位不同 —— 一起晃就是一块黑板。 */
  const MENU = [
    { t: '龙井', x: 200, y: 100, seed: 0.0 },
    { t: '菊普', x: 226, y: 96, seed: 1.7 },
    { t: '桂花', x: 252, y: 102, seed: 3.1 },
  ];

  function drawMenuPlanks() {
    for (const m of MENU) {
      const sw = Math.sin(ph(3) + m.seed) * 1.2;
      const x = Math.round(m.x + sw);
      const top = m.y;
      const pw = 22;
      const ph2 = 38;

      /* 两根挂绳，一直吊到匾额下沿 */
      box('#6f4d2f', x + 4, 92, 1, top - 92);
      box('#6f4d2f', x + pw - 5, 92, 1, top - 92);
      box('rgba(30,18,10,.35)', x + 4, 92, 1, 4);

      /* 木牌：深一档的木头，才从墙上跳出来 */
      box('#33210f', x, top, pw, ph2);
      box('#553a26', x, top, pw, 1);
      box('#6d4b32', x + 1, top + 1, pw - 2, 1);
      box('#452e1e', x + 1, top + 2, pw - 2, ph2 - 4);
      box('#2b1a10', x, top + ph2 - 1, pw, 1);

      /* 竖排茶名 */
      for (let i = 0; i < m.t.length; i += 1) {
        glyph(m.t[i], x + pw / 2, top + 12 + i * 14, 11, '#dfb87c');
      }

      /* 牌角的铜钉 */
      box('rgba(214,168,96,.45)', x + 2, top + 2, 1, 1);
      box('rgba(214,168,96,.45)', x + pw - 3, top + 2, 1, 1);
    }
  }

  /* ------------------------------------------------------------ 鲸鱼画 */
  function drawWhaleArt() {
    const x = 288;
    const y = 48;
    const w = 76;
    const h = 46;

    box('#6b4a34', x, y, w, h);
    box('#8a6644', x, y, w, 1);
    box('#c9b48a', x + 3, y + 3, w - 6, h - 6);
    box('#b9a077', x + 3, y + 3, w - 6, 1);
    /* 画心：一抹深蓝的海 */
    box('#2b3a55', x + 5, y + 5, w - 10, h - 10);
    box('#22304a', x + 5, y + h - 14, w - 10, 9);

    /* 鲸：身子 + 尾 + 一小柱水 */
    const bx = x + 20;
    const by = y + 26;
    box('#7fa2cc', bx, by, 24, 7);
    box('#94b6dc', bx, by, 24, 2);
    box('#7fa2cc', bx + 24, by + 1, 3, 2);
    box('#7fa2cc', bx + 26, by - 3, 3, 4);
    box('#7fa2cc', bx + 26, by + 5, 3, 3);
    box('#6b8bb4', bx + 6, by + 7, 12, 2);
    /* 眼 */
    box('#16203a', bx + 4, by + 2, 1, 1);
    /* 水柱 */
    box('#a8c6e8', bx + 10, by - 3, 1, 3);
    box('#a8c6e8', bx + 9, by - 5, 1, 2);
    box('#a8c6e8', bx + 12, by - 4, 1, 2);
  }

  /* --------------------------------------------------------------- 地板 */
  /* 透视地板：横线越往下越疏（近大远小），竖线从消失点发散。
     两头都要算对 —— 只做横线是斑马，只做竖线是放射状，都不像地板。 */
  function drawFloor() {
    box(C.floor, 0, FLOOR_Y, W, H - FLOOR_Y);

    /* 远端压暗：屋子深处本来就比脚下暗 */
    const g = ctx.createLinearGradient(0, FLOOR_Y, 0, FLOOR_Y + 60);
    g.addColorStop(0, 'rgba(20,10,8,.42)');
    g.addColorStop(1, 'rgba(20,10,8,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, FLOOR_Y, W, 60);

    /* 横缝：间距按 1.22 递增，越近越疏 */
    let y = FLOOR_Y;
    let step = 7;
    while (y < H) {
      box(C.floorSeam, 0, y, W, 1);
      /* 缝下面一 px 亮一点 = 木条的前缘 */
      box('rgba(120,88,64,.14)', 0, y + 1, W, 1);
      y += step;
      step *= 1.22;
    }

    /* 竖缝：从消失点放射，落在画面下沿。k 的范围只要覆盖到画面底就够，
       多了全是画外的线，算它干嘛。 */
    ctx.strokeStyle = C.floorSeam;
    ctx.lineWidth = 1;
    for (let k = -5; k <= 5; k += 1) {
      const bx = VPX + k * 88;
      ctx.beginPath();
      ctx.moveTo(VPX + (bx - VPX) * 0.30, FLOOR_Y + 5);
      ctx.lineTo(bx, H);
      ctx.stroke();
    }

    /* 地板上的三团灯光暖斑 —— 灯笼照下来的，位置和灯对齐。
       没有这三片，灯只是「挂着的两个黄球」，屋子一点都不暖。 */
    ctx.globalCompositeOperation = 'lighter';
    for (const L of LANTERNS) {
      const p = clamp01((L.y + 40) / H);
      ellipse(L.x, FLOOR_Y + 48 + p * 26, 62, 20, 'rgba(255,176,92,.055)');
      ellipse(L.x, FLOOR_Y + 44 + p * 26, 34, 11, 'rgba(255,196,120,.05)');
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /* ------------------------------------------------------------- 长茶案 */
  /* 桌面 232、桌面下沿 242、脚底 294。
     这几个数是被「她站在案子后面」反推出来的：她 111px 高、脚底 268，
     桌面 232 正好切在大腿根 —— 这就是「柜台后面的人」，不是「站在画里」。 */
  const TB = { x: 170, y: 232, w: 246, h: 10, legY: 242, legH: 52 };

  function drawTable() {
    const { x, y, w, h } = TB;

    /* 桌下的暗：不画这层，桌子像浮在地板上 */
    ctx.fillStyle = 'rgba(12,6,4,.45)';
    ctx.fillRect(x + 4, y + h, w - 8, TB.legH);

    /* 桌腿（前腿两根，后腿在桌下淡一点） */
    box('#3a2617', x + 20, y + h, 8, TB.legH);
    box('#4d331f', x + 20, y + h, 2, TB.legH);
    box('#3a2617', x + w - 28, y + h, 8, TB.legH);
    box('#4d331f', x + w - 28, y + h, 2, TB.legH);
    box('#2b1a0e', x + w - 22, y + h, 2, TB.legH);

    /* 横枨 */
    box('#3a2617', x + 24, y + h + 28, w - 52, 3);

    /* 桌裙：桌面下那道横木，有了它桌子才「厚」 */
    box('#452e1d', x + 2, y + h, w - 4, 7);
    box('#5e3f28', x + 2, y + h, w - 4, 1);

    /* 桌面：上亮下暗，顶边一道高光 */
    box(C.wood, x, y, w, h);
    box(C.woodHi, x, y, w, 2);
    box('#9c7752', x, y, w, 1);
    box(C.woodDark, x, y + h - 2, w, 2);

    /* 木纹：几条断续的深线，长短不一 */
    for (let i = 0; i < 13; i += 1) {
      const gx = x + 8 + ((i * 41) % (w - 24));
      const gw = 16 + ((i * 17) % 30);
      box('rgba(60,38,22,.32)', gx, y + 4 + (i % 3) * 2, gw, 1);
    }
  }

  /* 桌上的东西：一把铜壶（蒸汽的源头）+ 三个盖碗 + 两碟点心 + 一盏油灯。
     摆得不要太匀 —— 匀了就是「样品陈列」，歪一点才像刚有人动过。 */
  function drawTableItems() {
    const topY = TB.y;

    /* ——— 铜壶（右侧） ——— */
    const kx = 386;
    const ky = topY + 1;
    ellipse(kx, ky - 1, 15, 4, 'rgba(10,5,3,.35)');
    /* 壶身 */
    ellipse(kx, ky - 12, 14, 12, C.brass);
    ellipse(kx - 2, ky - 13, 12, 10, '#d9a852');
    ellipse(kx - 4, ky - 15, 6, 6, C.brassHi);
    /* 底 */
    box('#8a6a2c', kx - 7, ky - 2, 14, 2);
    /* 盖 */
    box('#b8873a', kx - 6, ky - 24, 12, 3);
    box(C.brassHi, kx - 4, ky - 26, 8, 2);
    box('#f7e2a8', kx - 1, ky - 28, 3, 2);
    /* 壶嘴（朝左，蒸汽从这儿出去） */
    box(C.brass, kx - 16, ky - 18, 4, 4);
    box(C.brass, kx - 19, ky - 20, 4, 3);
    box(C.brassHi, kx - 19, ky - 20, 3, 1);
    /* 提梁 */
    box('#9a7430', kx - 10, ky - 32, 2, 7);
    box('#9a7430', kx + 8, ky - 32, 2, 7);
    box('#b8873a', kx - 10, ky - 33, 20, 2);

    /* ——— 盖碗 ×3（左半桌） ——— */
    const bowls = [
      { x: 262, y: topY + 1, ph: 0.0 },
      { x: 284, y: topY + 2, ph: 1.7 },
      { x: 306, y: topY + 1, ph: 3.4 },
    ];
    for (const b of bowls) {
      ellipse(b.x, b.y - 1, 9, 3, 'rgba(10,5,3,.3)');
      /* 托碟 */
      ellipse(b.x, b.y - 2, 9, 3.4, C.porcDk);
      ellipse(b.x, b.y - 3, 8, 2.6, C.porc);
      /* 碗身 */
      ellipse(b.x, b.y - 6, 7, 4, C.celadon);
      ellipse(b.x - 1, b.y - 7, 5, 2.4, '#a3c6b1');
      /* 碗口 + 茶汤 */
      ellipse(b.x, b.y - 9, 7, 2.4, C.celadonDk);
      ellipse(b.x, b.y - 9, 5.6, 1.7, C.tea);
      /* 盖（斜搁在碗边） */
      box(C.porc, b.x - 4, b.y - 13, 9, 2);
      box(C.porcDk, b.x - 4, b.y - 12, 9, 1);
      box(C.porc, b.x - 1, b.y - 15, 3, 2);
    }

    /* ——— 点心碟 ×2 ——— */
    const plates = [
      { x: 334, y: topY + 2, c: '#c98a5a' },
      { x: 354, y: topY + 1, c: '#e0b878' },
    ];
    for (const p of plates) {
      ellipse(p.x, p.y - 1, 10, 3, 'rgba(10,5,3,.3)');
      ellipse(p.x, p.y - 2, 10, 3.6, C.porcDk);
      ellipse(p.x, p.y - 3, 8.6, 2.8, C.porc);
      /* 三块点心 */
      box(p.c, p.x - 5, p.y - 6, 3, 3);
      box(p.c, p.x - 1, p.y - 7, 3, 4);
      box(p.c, p.x + 3, p.y - 5, 3, 2);
      box('rgba(255,240,210,.5)', p.x - 1, p.y - 7, 3, 1);
    }

    /* ——— 油灯（桌子最左端） ——— */
    const lx = 240;
    const fl = 0.82 + 0.18 * Math.sin(ph(9)) * Math.sin(ph(23));
    box('#5a3f28', lx - 3, topY - 5, 7, 5);
    box('#8a6644', lx - 2, topY - 6, 5, 2);
    ctx.globalAlpha = fl;
    box(C.gold, lx, topY - 9, 2, 4);
    box('#fff3c8', lx, topY - 10, 1, 2);
    ctx.globalAlpha = 1;
    /* 灯本身的一小团晕 */
    ctx.globalCompositeOperation = 'lighter';
    disc(lx + 1, topY - 9, 4, `rgba(255,200,120,${(0.10 * fl).toFixed(3)})`);
    disc(lx + 1, topY - 9, 2, `rgba(255,232,180,${(0.14 * fl).toFixed(3)})`);
    ctx.globalCompositeOperation = 'source-over';
  }

  /* --------------------------------------------------------- 铜壶的蒸汽 */
  /* 场景大了，这里终于可以做「雾团」而不是「一缕线」：
     汽柱 80px 高、壶口 8px 宽，够铺五层不同大小的汽团。
     每团走自己的一条路（出口速度、上浮快慢、左右摆的幅度与相位全不同），
     全一样就是一柱整齐的烟 —— 那是这效果最难看的样子。 */
  function drawSteam(sx, sy, hgt, seed, thick) {
    const SX = sx;
    const SY = sy;
    const HGT = hgt;
    const SE = seed || 0;
    const TH = thick || 1;

    const wob = (u, o) => Math.sin(ph(2) + u * 3.4 + o + SE) * 4.2 * TH * u * u
      + Math.sin(ph(3) - u * 6.2 + o + SE) * 1.8 * TH * u;

    /* ① 主线：从壶口一路连着往上，靠密度成一条 */
    for (let s = 0; s < 3; s += 1) {
      const o = s * 0.9;
      for (let i = 0; i <= 52; i += 1) {
        const u = i / 52;
        if (Math.sin(ph(5) + u * 11 + o) > 0.86) continue;   // 偶尔断一小截，不然像钢丝
        const x = SX + wob(u, o) + o * 1.1 - u * 6;
        const y = SY - HGT * Math.pow(u, 0.88);
        const a = Math.pow(1 - u, 0.62) * 0.5;
        if (a < 0.03) continue;
        /* 靠近壶口那一段被茶汤映暖，越往上越冷 */
        const w = 1 - Math.min(1, u * 1.5);
        ctx.fillStyle = `rgba(${Math.round(240 + 12 * w)},${Math.round(228 + 16 * w)},${Math.round(214 + 20 * w)},${a.toFixed(3)})`;
        ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
        if (u < 0.3) ctx.fillRect(Math.round(x) + 1, Math.round(y), 1, 1);
      }
    }

    /* ② 厚度：七团，位置错开、压得极淡，只为了让那条线有体积 */
    for (let i = 0; i < 7; i += 1) {
      const u = ((T / LOOP) * 2 + i / 7) % 1;
      const o = i * 1.31;
      const x = SX + wob(u, o) + o * 0.8 - u * 6;
      const y = SY - HGT * Math.pow(u, 0.88);
      const a = Math.pow(1 - u, 1.1) * 0.16;
      if (a < 0.02) continue;
      dot(x, y, 1.6 + u * 3.4, `rgba(246,236,222,${a.toFixed(3)})`);
    }
  }

  /* ------------------------------------------------------------ 鲸鱼娘 */

  /* 播放器：照 whale.js 的做法，但状态由 T 直接算 ——
     这样 ?t= 定格出来的帧是可复现的，不用额外记时钟。 */
  const WHALE = opts.whale || { clips: {} };
  /* 贴图由外面加载好再注入（没有就只是屋里没人，屋子照画）。 */
  const whaleImgs = opts.images || {};
  const off = document.createElement('canvas');
  off.width = W;
  off.height = H;
  const octx = off.getContext('2d');
  octx.imageSmoothingEnabled = false;

  /* 她站在案子后面、靠左那一头。脚底 268 比案子前沿更靠里 ——
     所以她被桌面切在大腿根，而不是站在桌子前面挡住一桌茶。 */
  const WG = { x: 202, footY: 268 };

  function frameAt(clip, t) {
    if (clip.is_static || clip.count <= 1) return 0;
    if (clip.frame_ms) return Math.min(clip.count - 1, Math.floor(t / clip.frame_ms) % clip.count);
    const tt = clip.loop ? t % clip.total_ms : Math.min(t, clip.total_ms - 1);
    let acc = 0;
    for (let i = 0; i < clip.count; i += 1) {
      acc += clip.durations[i];
      if (tt < acc) return i;
    }
    return clip.count - 1;
  }

  /* 她的日程（一圈 9.6 秒）：
       0 – 4000      站着看店（idle，56 帧，本身就有呼吸和轻摆）
       4000 – 8667   抬手整理一下发饰（hair-adjust，107 帧）
       8667 – 9600   收手，回到站姿
     idle 的最后几帧和 hair-adjust 的第一帧姿势接近，所以接得上。 */
  function whaleState() {
    const cyc = T % LOOP;
    if (cyc >= 4000 && cyc < 8667) {
      return { key: 'room/hair-adjust/east', t: cyc - 4000 };
    }
    return { key: 'room/idle/east', t: cyc < 4000 ? cyc : cyc - 8667 };
  }

  function drawWhale() {
    const st = whaleState();
    const clip = WHALE.clips[st.key];
    const img = whaleImgs[st.key];
    if (!clip || !img) return;

    const idx = frameAt(clip, st.t);
    const tw = clip.tile[0];
    const th = clip.tile[1];
    const sx = (idx % clip.cols) * tw;
    const sy = Math.floor(idx / clip.cols) * th;
    const dx = Math.round(WG.x - clip.anchor[0]);
    const dy = Math.round(WG.footY - clip.anchor[1]);

    /* 落地影 */
    ctx.save();
    ctx.globalAlpha = 0.34;
    ctx.fillStyle = '#140b08';
    ctx.beginPath();
    ctx.ellipse(WG.x, WG.footY - 1, 26, 7, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    /* 离屏：先把她画上去，再用 source-atop 只给她本人上光。
       直接在主画布上盖一层渐变会把背景也染了，那就不是「她被照着」。 */
    octx.clearRect(0, 0, W, H);
    octx.drawImage(img, sx, sy, tw, th, dx, dy, tw, th);

    if (!LIGHT_OFF) {
      octx.globalCompositeOperation = 'source-atop';
      /* 整体压一档：屋子是暗的，她不该是全场最亮的 */
      octx.fillStyle = 'rgba(30,16,10,.12)';
      octx.fillRect(dx, dy, tw, th);

      /* 左半边吃灯（暖黄），右半边吃茶柜那边的反光（偏冷一点） */
      const lg = octx.createLinearGradient(dx, dy, dx + tw, dy + th * 0.3);
      lg.addColorStop(0, 'rgba(255,186,104,.34)');
      lg.addColorStop(0.45, 'rgba(255,170,90,.10)');
      lg.addColorStop(1, 'rgba(180,150,120,.14)');
      octx.fillStyle = lg;
      octx.fillRect(dx, dy, tw, th);

      /* 头顶再压一道灯下的暖（灯在她正上方偏左） */
      const tg = octx.createLinearGradient(0, dy, 0, dy + th * 0.42);
      tg.addColorStop(0, 'rgba(255,206,130,.26)');
      tg.addColorStop(1, 'rgba(255,206,130,0)');
      octx.fillStyle = tg;
      octx.fillRect(dx, dy, tw, th * 0.42);

      /* 脚下一道地板反上来的暖，不然像剪纸 */
      const bg = octx.createLinearGradient(0, dy + th - 24, 0, dy + th);
      bg.addColorStop(0, 'rgba(255,150,80,0)');
      bg.addColorStop(1, 'rgba(255,164,96,.26)');
      octx.fillStyle = bg;
      octx.fillRect(dx, dy + th - 24, tw, 24);

      octx.globalCompositeOperation = 'source-over';
    }

    ctx.drawImage(off, 0, 0);
  }

  /* ----------------------------------------------------------------- Coo */
  /* 形象：一团圆滚滚的小东西，顶上一撮呆毛、身后一条小鲸尾、两只黑眼。
     18px 直径 —— 她 111px，所以 Coo 差不多是「一只猫那么大」。
     这是占位设计（真项目里 Coo 应该有正式立绘），但它已经在传达两件事：
     小、圆、成群。 */
  const COO_PAL = [
    { body: '#e8dcc0', hi: '#f8f0dc', tail: '#d2c2a0', blush: '#e0a890' },
    { body: '#a8c4b0', hi: '#c4dcc8', tail: '#8fa896', blush: '#d8a89a' },
    { body: '#e0b0a8', hi: '#f0ccc4', tail: '#c89490', blush: '#c88878' },
    { body: '#c8c0dc', hi: '#dcd6ec', tail: '#ada6c2', blush: '#c89ab0' },
    { body: '#f0d090', hi: '#ffe6b8', tail: '#d4b478', blush: '#e0a878' },
  ];

  /* 每只 Coo 的「性格参数」全部预先算好，不在这里用随机数 ——
     随机数每帧不同，它们就会抽搐。 */
  function mkCoo(x, y, kind, i) {
    const h = (n) => {
      const s = Math.sin((i + 1) * 12.9898 + n * 78.233) * 43758.5453;
      return s - Math.floor(s);
    };
    return {
      x, y, kind,
      r: 7 + Math.round(h(1) * 2),
      pal: COO_PAL[Math.floor(h(2) * COO_PAL.length)],
      bobA: 0.8 + h(3) * 1.1,          // 浮动幅度
      bobF: 1 + Math.floor(h(4) * 3),  // 浮动圈数（整数 → 循环无缝）
      bobP: h(5) * TAU,
      blinkF: 2 + Math.floor(h(6) * 4),
      blinkP: h(7) * TAU,
      bubbleF: 1 + Math.floor(h(8) * 2),
      bubbleP: h(9) * TAU,
      driftA: 10 + h(10) * 16,         // 在地上走动的幅度
      driftP: h(11) * TAU,
      face: h(12) > 0.5 ? 1 : -1,
    };
  }

  /* 22 只，分四层放：
       桌上 3（坐桌沿）· 长凳 6（背对观众）· 地上 4（会走）· 远处 9
     热闹不是「数量多」，是「同一层里挤」—— 所以长凳放了六只，
     它们肩并肩坐着，画面中段才有一团人味。 */
  /* 坐席：x 不按等距排（等距就成了货架），y 也差 1~3px。
     小马扎和坐着的 Coo 用同一张表，改一处两边都在。 */
  const SIT = [
    [250, 255], [272, 258], [296, 254], [320, 257],
    [344, 255], [368, 258], [390, 255], [412, 257],
  ];

  const COOS = [
    // 桌面上（坐在桌沿，只露上半身）
    ...[[298, 224], [318, 225], [370, 224]].map(([x, y], i) => mkCoo(x, y, 'table', i)),
    // 案子前面：一人一个小马扎，坐得高低不齐
    ...SIT.map(([x, y], i) => mkCoo(x, y, 'bench', i + 10)),
    // 地上（会走动）
    ...[[160, 288], [196, 291], [236, 292], [344, 289], [404, 292]]
      .map(([x, y], i) => mkCoo(x, y, 'floor', i + 20)),
    // 茶柜前（远景）
    ...[[418, 178], [476, 178]].map(([x, y], i) => mkCoo(x, y, 'shelf', i + 30)),
    // 窗台
    mkCoo(152, 188, 'sill', 40),
    // 蒸笼边上蹲着的一只
    mkCoo(496, 190, 'sill', 41),
    // 半空飘着
    ...[[224, 152], [440, 126]].map(([x, y], i) => mkCoo(x, y, 'float', i + 50)),
  ];

  function drawOneCoo(coo, alpha) {
    const t = T / 1000;
    /* 浮动：整数圈 → 循环无缝 */
    const bob = Math.sin((T / LOOP) * TAU * coo.bobF + coo.bobP) * coo.bobA;

    let x = coo.x;
    let y = coo.y + bob;

    /* 地上那几只来回走：正弦位移，走到头自然折返，不用状态机 */
    if (coo.kind === 'floor') {
      x = coo.x + Math.sin((T / LOOP) * TAU * 2 + coo.driftP) * coo.driftA;
      coo.face = Math.cos((T / LOOP) * TAU * 2 + coo.driftP) > 0 ? 1 : -1;
    }

    const r = coo.r;
    const P = coo.pal;

    /* 影 */
    if (coo.kind !== 'float') {
      ctx.globalAlpha = 0.26 * alpha;
      ellipse(x, y + r + 1, r * 0.86, 2.4, '#120a06');
      ctx.globalAlpha = 1;
    }

    ctx.globalAlpha = alpha;

    /* 尾巴：身后一小片鲸尾，朝向决定在左还是在右 */
    const tx = x - coo.face * (r - 1);
    box(P.tail, tx, y + r * 0.45, 3, 2);
    box(P.tail, tx - coo.face * 1, y + r * 0.2, 2, 2);
    box(P.tail, tx - coo.face * 1, y + r * 0.8, 2, 2);

    /* 身子 */
    disc(x, y, r, P.body);
    /* 上亮下暗 */
    disc(x - r * 0.22, y - r * 0.26, r * 0.66, P.hi);
    box(P.tail, x - r + 1, y + r - 2, r * 2 - 2, 1);

    /* 呆毛 */
    box(P.body, x + coo.face * 1, y - r - 2, 1, 3);
    box(P.body, x + coo.face * 1 + 1, y - r - 3, 1, 2);

    /* 眼：每只的眨眼周期不同，闭眼那一下只有 1/8 的时间 */
    const blinking = Math.sin((T / LOOP) * TAU * coo.blinkF + coo.blinkP) > 0.93;
    const ex = r * 0.38;
    if (blinking) {
      box(C.ink, x - ex - 1, y - 1, 2, 1);
      box(C.ink, x + ex - 1, y - 1, 2, 1);
    } else {
      box(C.ink, x - ex - 1, y - 2, 2, 3);
      box(C.ink, x + ex - 1, y - 2, 2, 3);
      box('#fffdf4', x - ex - 1, y - 2, 1, 1);
      box('#fffdf4', x + ex - 1, y - 2, 1, 1);
    }

    /* 腮红 */
    ctx.globalAlpha = 0.45 * alpha;
    box(P.blush, x - ex - 3, y + 1, 2, 1);
    box(P.blush, x + ex + 1, y + 1, 2, 1);
    ctx.globalAlpha = alpha;

    /* 对话气泡：三个小点，飘在头顶右上。热闹感的来源之一 ——
       一屋子都不说话，人就只是一排摆件。 */
    const bk = Math.sin((T / LOOP) * TAU * coo.bubbleF + coo.bubbleP);
    if (bk > 0.5 && coo.kind !== 'shelf') {
      const a2 = (bk - 0.5) / 0.5;
      const bx = x + r + 3;
      const by = y - r - 6 - Math.round(a2 * 3);
      ctx.globalAlpha = a2 * alpha;
      box('#f4e6d0', bx, by, 9, 6);
      box('#f4e6d0', bx, by + 6, 2, 1);
      box('#b08a5c', bx + 2, by + 2, 1, 1);
      box('#b08a5c', bx + 4, by + 2, 1, 1);
      box('#b08a5c', bx + 6, by + 2, 1, 1);
      ctx.globalAlpha = alpha;
    }

    ctx.globalAlpha = 1;
  }

  function drawCoos() {
    for (const coo of COOS) drawOneCoo(coo, 1);
  }

  /* ------------------------------------------------------------- 长凳 */
  /* 桌子前面那条长凳：画在 Coo 之前，这样坐着的 Coo 是「坐在它上面」 */
  /* 每人一个小马扎，而不是一条长凳 ——
     一条长凳会把六个人串成货架的一格；分开坐、高度错开 1px，
     才像各自找位置坐下的。 */
  function drawStools() {
    for (const [x, sy] of SIT) {
      const y = sy + 9;
      /* 凳面 */
      box('#3a2617', x - 7, y, 15, 4);
      box('#6f4c33', x - 7, y, 15, 2);
      box('#8a6644', x - 6, y, 13, 1);
      /* 四条短腿 */
      box('#2b1a0e', x - 6, y + 4, 2, 9);
      box('#2b1a0e', x + 5, y + 4, 2, 9);
      box('#33210f', x - 1, y + 4, 2, 8);
      /* 落地影 */
      ctx.fillStyle = 'rgba(12,6,4,.3)';
      ctx.fillRect(x - 7, y + 12, 15, 3);
    }
  }

  /* ------------------------------------------------------------- 浮尘 */
  /* 灯下那点飘着的东西。数量要少（十几粒），多了就是下雪。 */
  function drawDust() {
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 16; i += 1) {
      const p = ((T / LOOP) * (1 + (i % 2)) + i / 16) % 1;
      const x = 90 + ((i * 67) % 400) + Math.sin((T / LOOP) * TAU + i) * 6;
      const y = 60 + p * 190;
      const a = 0.16 * Math.sin(p * Math.PI);
      if (a < 0.01) continue;
      box(`rgba(255,226,180,${a.toFixed(3)})`, x, y, 1, 1);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /* --------------------------------------------------------- 主绘制 */

  function draw(t, bootEl) {
    T = t;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = 1;

    /* —— 屋子 —— */
    drawCeiling();
    drawWall();
    drawWindow();
    drawPlaque();
    drawMenuPlanks();
    drawWhaleArt();
    drawCabinet();
    drawSteamer();
    drawFloor();

    /* —— 人 —— 她站在案子后面，所以必须先画她、再画案子，
       案子才会挡在她前面，把她从大腿处切开。 */
    if (!NO_WHALE) drawWhale();

    /* —— 案上 + 案前 —— */
    drawTable();
    drawTableItems();
    drawSteam(386, TB.y - 20, 84, 0, 1);
    drawStools();
    if (!NO_COO) drawCoos();

    /* —— 光 —— */
    drawLanterns();
    drawLampGlow();
    drawDust();

    /* 全屋暖罩 + 暗角：让整块画面像被灯烤过，而不是一堆平涂的色块 */
    const g = ctx.createRadialGradient(288, 74, 20, 288, 130, 330);
    g.addColorStop(0, 'rgba(255,186,110,.10)');
    g.addColorStop(0.42, 'rgba(255,150,80,.035)');
    g.addColorStop(0.78, 'rgba(40,18,12,.16)');
    g.addColorStop(1, 'rgba(22,10,7,.52)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    if (DBG_CORNER) {            // DBG_CORNER：四角洋红，用来量画面边界
      ctx.fillStyle = '#ff00ff';
      ctx.fillRect(0, 0, 4, 4);
      ctx.fillRect(W - 4, 0, 4, 4);
      ctx.fillRect(0, H - 4, 4, 4);
      ctx.fillRect(W - 4, H - 4, 4, 4);
    }

    if (bootEl < BOOT_DUR) drawBoot(bootEl);
  }

  /* --------------------------------------------------------- 开屏：点灯 */
  /* 和 v2 的「开灯」是同一套思路，但光源换成中间那盏灯笼：
       0 – 800      黑屋。只有窗外的雪还在落（所以不是一块死黑）
       800 – 1180   火柴划亮，在灯笼下方 30px 的地方
       1180         灯笼点着。灯那一下先亮，再带着光往外扩
       1180 – 2500  光从灯笼铺到四面墙：中心透明的径向遮罩当黑暗，半径一直涨
       2500 – 3000  剩下的暗角退回黑位
     底下的画面从头到尾都在正常播放，结束时不交接，只是最后一层暗没了。 */

  function drawBoot(el) {
    const L = LANTERNS[1];
    const ignited = el >= PH.ignite;
    const fade = ignited ? 1 - clamp01((el - PH.spreadEnd) / (PH.fadeEnd - PH.spreadEnd)) : 1;

    if (!ignited) {
      box('rgba(3,2,6,.99)', 0, 0, W, H);
    } else {
      const sp = Math.pow(clamp01((el - PH.ignite) / (PH.spreadEnd - PH.ignite)), 1.2);
      const r = 18 + sp * 520;
      const a = 0.99 * fade;
      if (a > 0.004) {
        const g = ctx.createRadialGradient(L.x, L.y, 0, L.x, L.y, r);
        g.addColorStop(0, 'rgba(3,2,6,0)');
        g.addColorStop(0.48, `rgba(3,2,6,${(a * 0.34).toFixed(3)})`);
        g.addColorStop(0.76, `rgba(3,2,6,${(a * 0.74).toFixed(3)})`);
        g.addColorStop(1, `rgba(3,2,6,${a.toFixed(3)})`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      }
    }

    /* 火柴 */
    if (el >= PH.match && el < PH.ignite + 50) {
      const m = clamp01((el - PH.match) / (PH.ignite - PH.match));
      const fl = 0.6 + 0.4 * Math.sin(el / 21) * Math.sin(el / 53);
      ctx.globalCompositeOperation = 'lighter';
      ellipse(L.x, L.y + 26, 26, 18, `rgba(255,150,70,${(0.06 * m * fl).toFixed(3)})`);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.85 * m * fl;
      box('#ff9a52', L.x - 1, L.y + 20 - Math.round(fl * 2), 2, 6);
      ctx.globalAlpha = m;
      box('#ffd9a0', L.x - 2, L.y + 24, 4, 4);
      box('#fff4d8', L.x - 1, L.y + 24, 2, 2);
      ctx.globalAlpha = 1;
    }

    /* 点着那一下的光炸 */
    if (el >= PH.ignite && el < PH.ignite + 520) {
      const k = (el - PH.ignite) / 520;
      ctx.globalCompositeOperation = 'lighter';
      ellipse(L.x, L.y + 6, Math.round(30 + k * 150), Math.round(22 + k * 96),
        `rgba(255,180,100,${(0.11 * (1 - k)).toFixed(3)})`);
      ctx.globalCompositeOperation = 'source-over';
    }

    /* 黑屋里的窗：唯一还能看见的东西 */
    if (fade > 0.03) {
      const { x, y, w, h } = WIN;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.globalAlpha = 0.6 * fade;
      box('#1c2338', x, y, w, h);
      SNOW.forEach((f, i) => {
        const p = ((el / 3400) * f.sp + i / SNOW.length) % 1;
        const sy = Math.round(y + p * h);
        const sx = Math.round(x + f.ox + Math.sin(el / 900 + i * 0.7) * 1.6);
        ctx.globalAlpha = (0.45 + 0.5 * Math.sin(p * Math.PI)) * fade;
        box(C.snow, sx, sy, f.s, f.s);
      });
      ctx.globalAlpha = 1;
      ctx.restore();

      ctx.globalAlpha = 0.75 * fade;
      box(C.lattice, x, y, 2, h);
      box(C.lattice, x + Math.round(w / 3), y, 2, h);
      box(C.lattice, x + Math.round((w / 3) * 2), y, 2, h);
      box(C.lattice, x, y + Math.round(h / 4), w, 2);
      box(C.lattice, x, y + Math.round(h / 2), w, 2);
      box(C.lattice, x, y + Math.round((h / 4) * 3), w, 2);
      ctx.globalAlpha = 1;
    }
  }

  /* ------------------------------------------------------------------ 出口 */
  return {
    canvas,
    /** 画一帧。t 是毫秒，外部只管累加。 */
    frame(t) {
      draw(t || 0, BOOT_DUR);
    },
    /** 画一帧，并把「点灯」叠在上面。el 是开屏已经走了多少毫秒。 */
    frameBoot(t, el) {
      draw(t || 0, el);
    },
    /** 门帘开关：调试和「只看屋子」时用。 */
    set(opts2 = {}) {
      if ('whale' in opts2) NO_WHALE = !opts2.whale;
      if ('coo' in opts2) NO_COO = !opts2.coo;
      if ('light' in opts2) LIGHT_OFF = !opts2.light;
      if ('dbg' in opts2) DBG_CORNER = !!opts2.dbg;
    },
    W,
    H,
    LOOP,
  };
}
