/** 席位失效的纯判断：给 401 处理与测试共用，不碰 localStorage、DOM 或网络。 */

export type ExpiredDecision = 'ignore' | 'reload' | 'clear';

/**
 * - 存着的令牌就是失败的那个 → 真失效：清席位回加入页（clear）；
 * - 存着的已经换了（别的标签页换过席位）→ 这一页只是旧了：重载（reload），不能删新令牌；
 * - 本页已经用上新令牌 → 什么都不做（ignore）；
 * - 加入页本来就没有席位 → 什么都不做（ignore）。
 */
export function decideExpiredSeat(
  failedToken: string,
  storedToken: string | null,
  currentToken: string | null,
): ExpiredDecision {
  if (storedToken && failedToken && storedToken !== failedToken) {
    if (currentToken && currentToken === storedToken) return 'ignore';
    return 'reload';
  }
  if (!storedToken && !currentToken) return 'ignore';
  return 'clear';
}

/** 失败回包要带「发起请求时」的令牌，而不是回包时的当前令牌。 */
export function seatTokenFrom(headers: { get(name: string): string | null }): string {
  return (headers.get('authorization') || '').replace(/^Bearer /, '');
}
