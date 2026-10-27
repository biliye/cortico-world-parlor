/**
 * 游戏 id → 给人看的名字。只用于显示：新条目自带游戏在结束事件里给的 `data.gameLabel`，
 * 这张表只兜底老条目（第一版账本里只有 `data.game` 的 id）。
 * 账本与内核都不读这张表；加新游戏时补一行即可，或者让新游戏自己在牌桌上给 label。
 */
export const GAME_LABELS: Readonly<Record<string, string>> = {
  dice: '骰子',
  ddz: '斗地主',
};

export function gameLabelOf(game: string, label?: string): string {
  if (label && label.length > 0 && label !== game) return label;
  return GAME_LABELS[game] ?? label ?? game;
}
