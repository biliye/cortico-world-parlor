/** 换席位判断：令牌、客厅或身份任一变化就视为换了席位。页面内换 `#key=` 时用。 */
export interface SeatLike {
  token?: string;
  room?: string;
  cooId?: string;
}

export function seatChanged(
  previous: SeatLike | null | undefined,
  next: SeatLike | null | undefined,
): boolean {
  if (!previous || !next) return false;
  return previous.token !== next.token || previous.room !== next.room || previous.cooId !== next.cooId;
}
