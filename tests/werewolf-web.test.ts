/**
 * 狼人杀网页层：werewolf.js 的语法、角色牌路由、源码静态断言与打包完整性。
 * 不碰浏览器，只走 HTTP 与源码文本；页面本身由浏览器冒烟另行目击。
 *
 * 路径前缀的规则在 src/room/world-server.ts 的 serveWeb：只剥一层 /play/assets/，
 * 剩下的部分相对 src/web/ 解析。所以角色牌的真实 URL 是
 * /play/assets/assets/werewolf/roles/*.jpg（双层 assets/，与 coo-chip.png 同形）；
 * 少写一层 assets 的 /play/assets/werewolf/... 会落在 src/web/werewolf/ 上，404。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ParlorServer } from '../src/room/server.ts';

const ROLES = ['wolf', 'villager', 'seer', 'witch', 'hunter'] as const;
const MIN_ROLE_JPG_BYTES = 10 * 1024;
const roleArtUrl = (role: string) => `/play/assets/assets/werewolf/roles/${role}.jpg`;

const werewolfJs = () => readFileSync(new URL('../src/web/games/werewolf.js', import.meta.url), 'utf8');
const commonJs = () => readFileSync(new URL('../src/web/common.js', import.meta.url), 'utf8');
const pkgFiles = () => (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { files: string[] }).files;

describe('狼人杀网页：角色牌路由', () => {
  let scratch: string;
  let server: ParlorServer;

  beforeEach(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'parlor-ww-web-'));
    server = new ParlorServer({ id: 'lobby', inviteCode: 'inv', port: 0, dataFile: join(scratch, 'room.json') });
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('五张角色牌走 /play/assets/assets/werewolf/roles/ 能整张取回：200、image/jpeg、超过 10KB', async () => {
    for (const role of ROLES) {
      const response = await fetch(server.url + roleArtUrl(role));
      expect(response.status, role + '.jpg 的 HTTP 状态').toBe(200);
      expect(response.headers.get('content-type'), role + '.jpg 的 content-type').toContain('image/jpeg');
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.length, role + '.jpg 只有 ' + bytes.length + ' 字节，小于 10KB').toBeGreaterThan(MIN_ROLE_JPG_BYTES);
    }
  });

  it('guard.jpg 不进包：守卫不在角色牌库里，请求直接 404', async () => {
    expect((await fetch(server.url + roleArtUrl('guard'))).status).toBe(404);
  });

  it('单层 assets 的路径取不到：前缀剥一层，剩下的相对 src/web/ 解析', async () => {
    // /play/assets/ 剥掉后剩 werewolf/roles/wolf.jpg，落在 src/web/werewolf/ 下——不存在。
    expect((await fetch(server.url + '/play/assets/werewolf/roles/wolf.jpg')).status).toBe(404);
  });
});

describe('狼人杀网页：werewolf.js 静态断言与打包完整性', () => {
  it('werewolf.js 语法正确（node --check）', () => {
    const file = fileURLToPath(new URL('../src/web/games/werewolf.js', import.meta.url));
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    expect(result.status, result.stderr || '').toBe(0);
  });

  it('磁盘上五张角色牌都在、都超过 10KB；manifest 出现时哈希一致', () => {
    const rolesDir = fileURLToPath(new URL('../src/web/assets/werewolf/roles/', import.meta.url));
    for (const role of ROLES) {
      const file = join(rolesDir, role + '.jpg');
      expect(existsSync(file), '缺角色牌：' + role + '.jpg').toBe(true);
      const size = statSync(file).size;
      expect(size, role + '.jpg 只有 ' + size + ' 字节，小于 10KB').toBeGreaterThan(MIN_ROLE_JPG_BYTES);
    }
    const manifestFile = join(rolesDir, 'manifest.json');
    if (!existsSync(manifestFile)) return; // 还没有 manifest：哈希这级先不比，存在与大小已在上面断过。
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, string>;
    for (const role of ROLES) {
      const expected = manifest[role] ?? manifest[role + '.jpg'];
      expect(expected, 'manifest.json 里没有 ' + role + ' 的哈希').toBeTruthy();
      const actual = createHash('sha256').update(readFileSync(join(rolesDir, role + '.jpg'))).digest('hex');
      expect(actual, role + '.jpg 的 SHA256 与 manifest 不一致').toBe(expected);
    }
  });

  it('打包 files 覆盖 src/ 且没有排除规则挡角色牌，五张 jpg 会进 npm 包', () => {
    const files = pkgFiles();
    expect(files, 'files 里要有 src（角色牌都在 src/ 下）').toContain('src');
    for (const role of ROLES) {
      const rel = 'src/web/assets/werewolf/roles/' + role + '.jpg';
      const covered = files.some((entry) => {
        if (entry.startsWith('!')) return false;
        const pattern = entry.replace(/\/+$/, '');
        return pattern === rel || rel.startsWith(pattern + '/');
      });
      expect(covered, rel + ' 不在 files 覆盖范围内').toBe(true);
      // 现有的排除（如 !src/web/assets/cards/cards.webp）不许波及角色牌。
      const excluded = files.some((entry) => entry.startsWith('!') && rel.startsWith(entry.slice(1).replace(/\/+$/, '')));
      expect(excluded, rel + ' 被 files 的排除规则挡住').toBe(false);
    }
  });

  it('五个角色的牌图都预加载，路径只从 roleArtUrl 一处出', () => {
    const js = werewolfJs();
    const roster = js.match(/const ROLES = \[([^\]]+)\]/)?.[1] ?? '';
    for (const role of ROLES) {
      expect(roster, 'ROLES 名单里缺 ' + role).toContain("'" + role + "'");
    }
    // 挂桌就预载五种角色牌（不代表谁是什么）；路径模板只出现一次，改形状只改一处。
    expect(js).toContain('for (const role of ROLES)');
    expect(js).toContain('new Image()');
    expect(js).toContain('img.src = roleArtUrl(role);');
    expect(js.match(/\/play\/assets\/assets\/werewolf\/roles\//g) ?? []).toHaveLength(1);
    expect(js).toContain('/play/assets/assets/werewolf/roles/${role}.jpg');
  });

  it('身份牌加载失败有兜底：每张上屏的 img 都有 error 监听，失败后角色名与技能文字还在', () => {
    const js = werewolfJs();
    // 上屏的 <img> 一共三处（身份牌、终局卡、放大层），每一处都要有 error 兜底；
    // 预载的 new Image() 不算——它只是暖缓存，真上屏时另有兜底。
    const imgCount = (js.match(/el\('img'/g) ?? []).length;
    const errorCount = (js.match(/addEventListener\('error'/g) ?? []).length;
    expect(imgCount, 'werewolf.js 里上屏的 <img> 数量变了，检查每处是否都有 error 兜底').toBe(3);
    expect(errorCount, '有 <img> 没挂 error 监听，破图时会无限加载').toBe(imgCount);
    expect(js).toContain("classList.add('is-missing')");
    expect(js).toContain('img.remove()');
    // 身份牌正面：图挂了也只是移除破图，角色名、阵营、技能是文字，始终渲染。
    const face = js.match(/function identityFace\([\s\S]*?\n  \}/)?.[0] ?? '';
    expect(face, 'identityFace 函数体没抽出来，正则要跟上源码').toContain("addEventListener('error'");
    expect(face).toContain("el('div', 'wf-role-name'");
    expect(face).toContain('ROLE_SKILLS[priv.role]');
  });

  it('发言与狼聊正文走 textContent，werewolf.js 里没有 innerHTML 拼接', () => {
    const js = werewolfJs();
    // el() 的第三参一律 textContent（common.js）；正文只许从这条路进 DOM。
    expect(commonJs()).toMatch(/node\.textContent = text/);
    expect(js).not.toContain('innerHTML');
    expect(js).not.toContain('insertAdjacentHTML');
    expect(js).not.toContain('document.write');
    // 发言正文：过麦占位或玩家原文，经 el() 落进 textContent。
    expect(js).toContain("el('p', 'wf-speech-text', entry.passed ? '（过麦，没有发言）' : entry.text)");
    // 狼聊正文同样经 el() 渲染，不拼 HTML。
    expect(js).toContain('${chat.name}：「${chat.text}」');
  });

  it('草稿键带上 tableId 与 scope，狼聊草稿和公开发言草稿互不串', () => {
    const js = werewolfJs();
    // 键形：ww.draft.<host>.<me>.<tableId>.<scope> —— 同一台机器不同桌、不同栏各存各的。
    expect(js).toContain('ww.draft.${location.host}');
    expect(js).toContain('.${tableId}.${scope}');
    expect(js).toContain("draftBox('speech'");
    expect(js).toContain("draftBox('wolf'");
  });

  it('切后台自动盖牌：visibilitychange 收起翻牌，销毁时解绑', () => {
    const js = werewolfJs();
    expect(js).toContain("document.addEventListener('visibilitychange', onVisibility)");
    const onVisibility = js.match(/const onVisibility = \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? '';
    expect(onVisibility, 'onVisibility 函数体没抽出来，正则要跟上源码').toContain('document.hidden && revealed');
    expect(onVisibility).toContain("flip.classList.remove('is-open')");
    expect(js).toContain("document.removeEventListener('visibilitychange', onVisibility)");
    // 看身份阶段过去也盖：phase 不是 reveal 就把 revealed 收回去。
    expect(js).toContain("if (phase !== 'reveal') revealed = false;");
  });
});
