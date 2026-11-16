/**
 * 生成对外页的分享图（1200×630 PNG）。
 *
 * 为什么要有这个脚本：分享卡片要求位图，而牌面素材 `cards/cards.webp` 有分发限制、
 * 也不能当作宣传图用。所以这张图是纯几何拼出来的：纸色底、三色条、墨色条、一块强调色，
 * 配上中文字标。没有引用任何游戏素材。
 *
 * 用法：node scripts/build-welcome-og.mjs
 * 依赖：本机有 ffmpeg（带 drawtext，即 libfreetype）和中文字体。
 * 字体可用环境变量换：OG_FONT_CJK（粗体中文字体）、OG_FONT_LATIN（宽体拉丁字体）。
 * 换字体或改文案后重跑一次，产物提交到 src/web/welcome-og.png。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../src/web/welcome-og.png', import.meta.url));
const cjk = process.env.OG_FONT_CJK ?? 'C:/Windows/Fonts/msyhbd.ttc';
const latin = process.env.OG_FONT_LATIN ?? 'C:/Windows/Fonts/bahnschrift.ttf';

for (const [name, file] of [['OG_FONT_CJK', cjk], ['OG_FONT_LATIN', latin]]) {
  if (!existsSync(file)) throw new Error(`找不到字体文件：${name}=${file}`);
}

// 滤镜参数里的 `:` 是分隔符，而 Windows 字体路径自带 `C:`。
// 与其和 ffmpeg 的转义规则较劲，不如把字体复制进临时目录、用相对文件名引用。
const scratch = mkdtempSync(join(tmpdir(), 'parlor-og-'));
const fonts = { cjk: join(scratch, basename(cjk)), latin: join(scratch, basename(latin)) };
copyFileSync(cjk, fonts.cjk);
copyFileSync(latin, fonts.latin);

const paper = '0xf3f1ea';
const ink = '0x161616';
const ink2 = '0x5c5c5c';
const amber = '0xffb31f';

const filters = [
  // 顶部三色条（品红 / 强调色 / 薄荷绿）与底部墨色条
  'drawbox=x=0:y=0:w=400:h=3:color=0xff00f0:t=fill',
  `drawbox=x=400:y=0:w=400:h=3:color=${amber}:t=fill`,
  'drawbox=x=800:y=0:w=400:h=3:color=0x00ffa2:t=fill',
  `drawbox=x=0:y=560:w=1200:h=70:color=${ink}:t=fill`,
  // 右侧一块强调色：只做填充，不压字
  `drawbox=x=1000:y=150:w=128:h=128:color=${amber}:t=fill`,
  `drawtext=fontfile=${basename(fonts.latin)}:text='PARLOR CLUB':fontsize=26:fontcolor=${ink2}:x=72:y=96`,
  `drawtext=fontfile=${basename(fonts.cjk)}:text='鲸语会馆':fontsize=148:fontcolor=${ink}:x=72:y=140`,
  `drawbox=x=72:y=352:w=568:h=2:color=${ink}:t=fill`,
  `drawtext=fontfile=${basename(fonts.cjk)}:text='一桌人，慢慢来':fontsize=46:fontcolor=${ink2}:x=72:y=382`,
  `drawtext=fontfile=${basename(fonts.cjk)}:text='Coo 与真人坐在同一张桌上':fontsize=30:fontcolor=${ink2}:x=72:y=466`,
  // 底部墨条上的一行浅色字
  `drawtext=fontfile=${basename(fonts.cjk)}:text='九种玩法 │ 需要房主发的钥匙 │ 不开放注册':fontsize=26:fontcolor=${paper}:x=72:y=583`,
];

try {
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${paper}:s=1200x630:d=1`,
    '-vf', filters.join(','),
    '-frames:v', '1',
    output,
  ], { cwd: scratch, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('ffmpeg 生成分享图失败，退出码 ' + result.status);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`已写入 ${output}`);
