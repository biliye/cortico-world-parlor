/**
 * 狼人杀网页层：角色牌路由、磁盘素材与打包完整性。
 * 不碰浏览器，只走 HTTP 与源码文本；页面本身由浏览器冒烟另行目击。
 *
 * 路径前缀的规则在 src/room/world-server.ts 的 serveWeb：只剥一层 /play/assets/，
 * 剩下的部分相对 src/web/ 解析。所以角色牌的真实 URL 是
 * /play/assets/assets/werewolf/roles/*.jpg（双层 assets/，与 coo-chip.png 同形）；
 * 少写一层 assets 的 /play/assets/werewolf/... 会落在 src/web/werewolf/ 上，404。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ParlorServer } from '../src/room/server.ts';

const ROLES = ['wolf', 'villager', 'seer', 'witch', 'hunter', 'guard'] as const;
const MIN_ROLE_JPG_BYTES = 10 * 1024;
const roleArtUrl = (role: string) => `/play/assets/assets/werewolf/roles/${role}.jpg`;
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

  it('六张角色牌走 /play/assets/assets/werewolf/roles/ 能整张取回：200、image/jpeg、超过 10KB', async () => {
    for (const role of ROLES) {
      const response = await fetch(server.url + roleArtUrl(role));
      expect(response.status, role + '.jpg 的 HTTP 状态').toBe(200);
      expect(response.headers.get('content-type'), role + '.jpg 的 content-type').toContain('image/jpeg');
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.length, role + '.jpg 只有 ' + bytes.length + ' 字节，小于 10KB').toBeGreaterThan(MIN_ROLE_JPG_BYTES);
    }
  });

  it('单层 assets 的路径取不到：前缀剥一层，剩下的相对 src/web/ 解析', async () => {
    // /play/assets/ 剥掉后剩 werewolf/roles/wolf.jpg，落在 src/web/werewolf/ 下——不存在。
    expect((await fetch(server.url + '/play/assets/werewolf/roles/wolf.jpg')).status).toBe(404);
  });
});

describe('狼人杀网页：素材与打包完整性', () => {
  it('磁盘上六张角色牌都在、都超过 10KB；manifest 出现时哈希一致', () => {
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

  it('打包 files 覆盖 src/ 且没有排除规则挡角色牌，六张 jpg 会进 npm 包', () => {
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

  it('Vue 客户端仍从同一路径取角色牌，挂桌时预载六张', () => {
    const vue = readFileSync(new URL('../web-src/components/games/WerewolfGame.vue', import.meta.url), 'utf8');
    expect(vue).toContain('/play/assets/assets/werewolf/roles/${role}.jpg');
    expect(vue).toContain('new Image()');
  });
});
