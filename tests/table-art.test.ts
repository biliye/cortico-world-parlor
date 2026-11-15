import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

// 测试在 Node 下执行，网页模块仍由带 DOM 的 tsconfig.web.json 检查。
const { decodeImage, tableImage } = await vi.importActual<{
  decodeImage(url: string): Promise<void>;
  tableImage(url: string, ready: () => void, options?: { onError: () => void }): (inUse?: boolean) => void;
}>('../web-src/lib/image.ts');

function mockImages(decode?: () => Promise<void>) {
  const images: MockImage[] = [];
  class MockImage {
    src = '';
    onload?: () => void;
    onerror?: () => void;
    decode = decode;

    constructor() {
      images.push(this);
    }
  }
  vi.stubGlobal('Image', MockImage);
  return images;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('没有 decode 的内核用 load 和 error 完成图片加载', async () => {
  const images = mockImages();
  const loaded = decodeImage('/table.webp');
  expect(images[0].src).toBe('/table.webp');
  images[0].onload?.();
  await expect(loaded).resolves.toBeUndefined();

  const failed = decodeImage('/missing.webp');
  images[1].onerror?.();
  await expect(failed).rejects.toThrow('图片加载失败');
});

it('等人时的失败在进桌后退避重试一次，多张牌不会重复触发', async () => {
  vi.useFakeTimers();
  const decode = vi.fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error('暂时无法解码'))
    .mockResolvedValue(undefined);
  const images = mockImages(decode);
  const ready = vi.fn();
  const load = tableImage('/faces.webp', ready);

  load();
  load();
  await vi.advanceTimersByTimeAsync(1000);
  expect(images).toHaveLength(1);
  expect(ready).not.toHaveBeenCalled();

  load(true);
  load(true);
  expect(images).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(500);
  expect(images).toHaveLength(2);
  expect(ready).toHaveBeenCalledOnce();
  load(true);
  expect(images).toHaveLength(2);
});

it('进桌时首个请求还在途，失败后仍只重试一次', async () => {
  vi.useFakeTimers();
  let failFirst!: (reason: Error) => void;
  const first = new Promise<void>((_, reject) => { failFirst = reject; });
  const decode = vi.fn<() => Promise<void>>()
    .mockReturnValueOnce(first)
    .mockRejectedValue(new Error('仍然失败'));
  const images = mockImages(decode);
  const ready = vi.fn();
  const onError = vi.fn();
  const load = tableImage('/cards.webp', ready, { onError });

  load();
  load(true);
  expect(images).toHaveLength(1);
  failFirst(new Error('首个请求失败'));
  await vi.advanceTimersByTimeAsync(2000);
  load(true);
  await vi.advanceTimersByTimeAsync(2000);
  expect(images).toHaveLength(2);
  expect(ready).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledTimes(2);
});

it('Vite 分包和网页 loader 使用同一个带版本号的入口地址', () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const bundle = new URL('../src/web/vue/', import.meta.url);
  for (const file of readdirSync(bundle).filter(name => /^chunk-.+\.js$/.test(name))) {
    const js = readFileSync(new URL(file, bundle), 'utf8');
    for (const [, , entryUrl] of js.matchAll(/\b(?:from|import)\s*(["'])(\.\/main\.js[^"']*)\1/g)) {
      expect(entryUrl, file).toBe('./main.js?v=' + encodeURIComponent(version));
    }
  }
});
