import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/web/theme.js', import.meta.url), 'utf8');
const boot = (storage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void }) => {
  const root = { dataset: {} as Record<string, string> };
  const meta = { content: '', setAttribute(_key: string, value: string) { this.content = value; } };
  const events: unknown[] = [];
  const window = {} as { parlorTheme: { readonly value: string; toggle(): void } };
  runInNewContext(source, { window, localStorage: storage,
    document: { documentElement: root, querySelector: () => meta, dispatchEvent: (event: unknown) => events.push(event) },
    CustomEvent: class { constructor(public type: string, public options: unknown) {} },
  });
  return { root, meta, window, events };
};

describe('会馆深浅主题偏好', () => {
  it('首次默认深色，开关切换且刷新恢复选择', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const first = boot(storage);
    expect(first.root.dataset.theme).toBe('dark');
    first.window.parlorTheme.toggle();
    expect(first.root.dataset.theme).toBe('light');
    expect(first.meta.content).toBe('#f5f7ef');
    const refreshed = boot(storage);
    expect(refreshed.root.dataset.theme).toBe('light');
    refreshed.window.parlorTheme.toggle();
    expect(boot(storage).root.dataset.theme).toBe('dark');
  });

  it('存储不可用时仍能双向切换，不影响页面启动', () => {
    const app = boot({ getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } });
    app.window.parlorTheme.toggle();
    expect(app.window.parlorTheme.value).toBe('light');
    app.window.parlorTheme.toggle();
    expect(app.window.parlorTheme.value).toBe('dark');
    expect(app.events).toHaveLength(3);
  });
});
