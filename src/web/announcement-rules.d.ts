/** 网页那边的纯规则模块是原生 JS；这里给测试一份形状声明，不参与打包。 */
export interface AnnouncementLike {
  id?: unknown;
  text?: unknown;
  created_at?: unknown;
}

export function pickAnnouncement<T extends AnnouncementLike>(
  list: readonly T[] | null | undefined,
  dismissed: readonly unknown[] | null | undefined,
): T | null;

export function rememberDismissed(
  dismissed: readonly unknown[] | null | undefined,
  id: string,
  cap?: number,
): string[];

export function excerpt(text: unknown, max?: number): string;
