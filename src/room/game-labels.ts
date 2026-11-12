/** 多客厅玩法的显示名和图标，供服务端、World 和网页使用。 */
export const GAME_PRESENTATION = {
  dice: { label: '骰子', icon: 'dice' },
  ddz: { label: '斗地主', icon: 'cards' },
  werewolf: { label: '狼人杀', icon: 'moon' },
  gomoku: { label: '五子棋', icon: 'board' },
  xiangqi: { label: '中国象棋', icon: 'board' },
  monopoly2d: { label: '快局大富翁', icon: 'board' },
  aeroplane: { label: '飞行棋', icon: 'board' },
} as const;

export type GameId = keyof typeof GAME_PRESENTATION;

/** 旧账本可能只有游戏 id，单厅家长页也需要可直接序列化的名称表。 */
export const GAME_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(GAME_PRESENTATION).map(([id, { label }]) => [id, label]),
);

export function gameLabelOf(game: string, label?: string): string {
  if (label && label.length > 0 && label !== game) return label;
  return GAME_LABELS[game] ?? label ?? game;
}
