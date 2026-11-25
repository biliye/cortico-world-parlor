export const FOUR_COLOURS = ['red', 'yellow', 'green', 'blue'] as const;
export type FourColour = typeof FOUR_COLOURS[number];
export const COLOUR_LABELS: Record<FourColour, string> = { red: '红', yellow: '黄', green: '绿', blue: '蓝' };
export const NUMBER_RANKS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
export type ColourRank = typeof NUMBER_RANKS[number] | 'skip' | 'reverse' | 'draw2';
export type FourColourFace =
  | { colour: FourColour; rank: ColourRank }
  | { colour: null; rank: 'wild' | 'draw4' };
export type FourColourCard = FourColourFace & { id: number };

export const FOUR_COLOUR_TURN_MS = 45_000;
export const FOUR_COLOUR_WIN_RULE = '先出完手牌者赢，剩一张时桌面会自动提示。';
export const FOUR_COLOUR_TIMING_RULE = `每回合 ${FOUR_COLOUR_TURN_MS / 1000} 秒，超时由服务器代打。`;
export const FOUR_COLOUR_PLAY_RULES = [
  '2–4 人，每人 7 张。按同色、同数字或同符号接牌。',
  '跳过让下一位停一轮，反转改变方向（两人时相当于跳过），+2 让下一位摸两张并停一轮。',
  '变色牌可指定任意颜色。手上没有当前颜色时才可打变色 +4，下一位摸四张并停一轮。罚牌不能叠加。',
  '每回合可摸一张。摸到可接的牌时可打出该牌或结束回合，摸到不能接的牌则自动结束。摸牌堆用完会重洗旧弃牌。',
];
export const FOUR_COLOUR_RULES = [...FOUR_COLOUR_PLAY_RULES, FOUR_COLOUR_WIN_RULE, FOUR_COLOUR_TIMING_RULE];

export function isFourColour(value: unknown): value is FourColour {
  return FOUR_COLOURS.some(colour => colour === value);
}

export function fourColourFaceText(face: FourColourFace): string {
  switch (face.rank) {
    case 'wild': return '变色';
    case 'draw4': return '变色 +4';
    case 'draw2': return COLOUR_LABELS[face.colour] + ' +2';
    case 'skip': return COLOUR_LABELS[face.colour] + ' 跳过';
    case 'reverse': return COLOUR_LABELS[face.colour] + ' 反转';
    default: return COLOUR_LABELS[face.colour] + ' ' + face.rank;
  }
}
