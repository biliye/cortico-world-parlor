/** 加入页的访客入口判断与关闭文案：healthz 说关了就不再画表单。 */

export const GUEST_CLOSED_MESSAGE = '这个入口已经关闭。请向房主要带钥匙的「下场玩」链接；有 Coo 的话也可以让 Coo 带你进客厅。';

export const SEAT_EXPIRED_MESSAGE = '这台设备上的席位已经失效（可能被另一台设备顶掉了）。如果这台浏览器有家长会话，点下面的「以家长身份下场」重新进来。';

export function guestJoinEnabled(health: { guestJoin?: boolean } | null | undefined): boolean {
  return health?.guestJoin !== false;
}
