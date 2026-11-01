import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/web/theme.js', import.meta.url), 'utf8');
const boot = (storage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void }) => {
  const root = { dataset: {} as Record<string, string> };
  const meta = { content: '', setAttribute(_key: string, value: string) { this.content = value; } };
  const events: unknown[] = [];
  const window = {} as { parlorTheme: { readonly value: string; themes: string[]; set(next: string): void; toggle(): void } };
  runInNewContext(source, { window, localStorage: storage,
    document: { documentElement: root, querySelector: () => meta, dispatchEvent: (event: unknown) => events.push(event) },
    CustomEvent: class { constructor(public type: string, public options: unknown) {} },
  });
  return { root, meta, window, events };
};
const memory = () => {
  const values = new Map<string, string>();
  return { values, storage: { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); } } };
};

describe('会馆外观偏好', () => {
  it('三套外观：默认深色，按顺序切换，刷新恢复选择', () => {
    const { values, storage } = memory();
    const first = boot(storage);
    expect(first.root.dataset.theme).toBe('dark');
    first.window.parlorTheme.toggle();
    expect(first.root.dataset.theme).toBe('light');
    expect(first.meta.content).toBe('#f5f7ef');
    first.window.parlorTheme.toggle();
    expect(first.root.dataset.theme).toBe('cream');
    expect(first.meta.content).toBe('#fff8ee');
    expect(values.get('parlor-theme-v1')).toBe('cream');
    const refreshed = boot(storage);
    expect(refreshed.root.dataset.theme).toBe('cream');
    refreshed.window.parlorTheme.toggle();
    expect(boot(storage).root.dataset.theme).toBe('dark');
  });

  it('选单可以直接选任意一套，重复选同一套不广播', () => {
    const { storage } = memory();
    const app = boot(storage);
    app.window.parlorTheme.set('cream');
    expect(app.root.dataset.theme).toBe('cream');
    const before = app.events.length;
    app.window.parlorTheme.set('cream');
    app.window.parlorTheme.set('sepia');
    expect(app.root.dataset.theme).toBe('cream');
    expect(app.events).toHaveLength(before);
    app.window.parlorTheme.set('dark');
    expect(app.root.dataset.theme).toBe('dark');
  });

  it('存储不可用时仍能切换，不影响页面启动', () => {
    const app = boot({ getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } });
    app.window.parlorTheme.toggle();
    expect(app.window.parlorTheme.value).toBe('light');
    app.window.parlorTheme.toggle();
    expect(app.window.parlorTheme.value).toBe('cream');
    expect(app.events).toHaveLength(3);
  });
});
