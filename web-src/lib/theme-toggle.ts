/**
 * 外观按钮的纯规则：只在深色与浅色两套之间来回。
 *
 * 页面里真正换色的是 `src/web/theme.js`（window.parlorTheme）。这里只决定按钮
 * 该写什么、图标用哪颗、点一下切到哪套，方便单测；奶油那套外观在 2026-11-02
 * 的视觉里已经下线，浏览器里存着的旧值统一折到浅色。
 */
export type ToggleTheme = 'dark' | 'light';

export const THEME_LABELS: Record<ToggleTheme, string> = { dark: '深色', light: '浅色' };

/** 旧浏览器的存储里可能是 cream；按钮只认深色/浅色，一律折到浅色。 */
export function normalizeTheme(value: string | null | undefined): ToggleTheme {
  return value === 'light' || value === 'cream' ? 'light' : 'dark';
}

/** 点一下要切到的那套。 */
export function otherTheme(value: string | null | undefined): ToggleTheme {
  return normalizeTheme(value) === 'light' ? 'dark' : 'light';
}

export function themeLabel(value: string | null | undefined): string {
  return THEME_LABELS[normalizeTheme(value)];
}

/** 顶条小按钮的图标：浅色用太阳，深色用月亮。 */
export function themeIcon(value: string | null | undefined): 'sun' | 'moon' {
  return normalizeTheme(value) === 'light' ? 'sun' : 'moon';
}

/** 悬停与读屏用的说明，直接说当前和点一下之后。 */
export function themeHint(value: string | null | undefined): string {
  return `外观：${themeLabel(value)}。点一下切到${THEME_LABELS[otherTheme(value)]}。`;
}
