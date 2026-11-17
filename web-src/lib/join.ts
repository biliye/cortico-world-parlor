export const SEAT_EXPIRED_MESSAGE = '这台设备上的席位已经失效（可能被另一台设备顶掉了）。如果这台浏览器有家长会话，点下面的「以家长身份下场」重新进来。';

/** 旧访客开关只控制共享码表单。 */
export function guestJoinEnabled(health: { guestJoin?: boolean } | null | undefined): boolean {
  return health?.guestJoin !== false;
}
