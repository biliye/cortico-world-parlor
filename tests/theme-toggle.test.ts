import { describe, expect, it } from 'vitest';
import { normalizeTheme, otherTheme, themeHint, themeIcon, themeLabel } from '../web-src/lib/theme-toggle.ts';

describe('外观按钮：点一下就切', () => {
  it('只认深色 / 浅色，旧存储里的 cream 折到浅色', () => {
    expect(normalizeTheme('light')).toBe('light');
    expect(normalizeTheme('cream')).toBe('light');
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('')).toBe('dark');
    expect(normalizeTheme(undefined)).toBe('dark');
    expect(normalizeTheme(null)).toBe('dark');
  });

  it('点一下切到另一套，来回两次回到原样', () => {
    expect(otherTheme('dark')).toBe('light');
    expect(otherTheme('light')).toBe('dark');
    expect(otherTheme('cream')).toBe('dark');
    expect(otherTheme(otherTheme('dark'))).toBe('dark');
    expect(otherTheme(otherTheme('light'))).toBe('light');
  });

  it('按钮文字与图标跟着当前那套走', () => {
    expect(themeLabel('dark')).toBe('深色');
    expect(themeLabel('light')).toBe('浅色');
    expect(themeLabel('cream')).toBe('浅色');
    expect(themeIcon('dark')).toBe('moon');
    expect(themeIcon('light')).toBe('sun');
    expect(themeIcon('cream')).toBe('sun');
  });

  it('悬停与读屏说明写清当前和下一套', () => {
    expect(themeHint('light')).toBe('外观：浅色。点一下切到深色。');
    expect(themeHint('dark')).toBe('外观：深色。点一下切到浅色。');
    expect(themeHint('cream')).toBe('外观：浅色。点一下切到深色。');
  });
});
