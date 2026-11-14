export const MAHJONG_GAMES = ['mahjong-sichuan', 'mahjong-guangdong'] as const;
export type MahjongGame = typeof MAHJONG_GAMES[number];
export const SUITS = ['万', '筒', '条'] as const;
export const TILES = [
  ...SUITS.flatMap(suit => Array.from({ length: 9 }, (_, rank) => (rank + 1) + suit)),
  '东', '南', '西', '北', '红中', '发', '白',
];
export const RED = 31;
export const tileKinds = (game: MahjongGame): number => game === 'mahjong-sichuan' ? 27 : 34;
export const suitOf = (tile: number): number => tile < 27 ? Math.floor(tile / 9) : -1;
export const isTile = (tile: unknown, kinds = TILES.length): tile is number =>
  typeof tile === 'number' && Number.isInteger(tile) && tile >= 0 && tile < kinds;

export const MAHJONG_RULES: Record<MahjongGame, string[]> = {
  'mahjong-sichuan': [
    '四人，万筒条 108 张。每人先换同一门的三张，本局随机顺换、对换或逆换；再各自定缺。有缺门牌时优先打完，缺门牌不能碰、杠或胡。',
    '可碰、杠、自摸、点炮和一炮多响。胡者退出摸打，三家胡牌或牌墙耗尽后结算。四面子一对或七对可胡。',
    '自摸由其余仍在打的玩家各付 1 分；点炮由出牌者向每位胡家付 1 分。直杠由出牌者付 2 分；补杠、暗杠由其余仍在打的玩家各付 1 分、2 分。',
  ],
  'mahjong-guangdong': [
    '四人，万筒条、东南西北和中发白共 136 张。四张红中在组胡牌时可替任意牌，可打出，不能碰杠。',
    '可碰、杠，只自摸；四面子一对或七对可胡。首家胡牌或牌墙耗尽即结算。',
    '自摸其余三家各付 1 分。直杠由出牌者付 2 分；补杠、暗杠由其余三家各付 1 分、2 分。',
  ],
};

export function tileCounts(tiles: readonly number[], kinds: number): number[] {
  const counts = Array<number>(kinds).fill(0);
  for (const tile of tiles) counts[tile]++;
  return counts;
}

/** 固定已副露的面子，只拆未公开的手牌。红中可补将、顺子或刻子。 */
export function canHu(game: MahjongGame, hand: readonly number[], melds: number, missing: number | null): boolean {
  if (hand.length !== (4 - melds) * 3 + 2) return false;
  if (game === 'mahjong-sichuan' && (missing === null || hand.some(tile => suitOf(tile) === missing))) return false;
  const counts = tileCounts(hand, tileKinds(game));
  const wild = game === 'mahjong-guangdong' ? counts[RED] : 0;
  if (wild) counts[RED] = 0;
  if (melds === 0 && counts.reduce((odd, count) => odd + count % 2, 0) <= wild) return true;

  const failed = new Set<string>();
  function groups(jokers: number): boolean {
    const first = counts.findIndex(count => count > 0);
    if (first < 0) return jokers % 3 === 0;
    const key = counts.join('') + '/' + jokers;
    if (failed.has(key)) return false;
    for (let size = Math.min(3, counts[first]); size >= Math.max(1, 3 - jokers); size--) {
      if (consume(Array<number>(size).fill(first), jokers - (3 - size))) return true;
    }
    if (first < 27) {
      const base = suitOf(first) * 9;
      for (let start = Math.max(base, first - 2); start <= Math.min(first, base + 6); start++) {
        const others = [start, start + 1, start + 2].filter(tile => tile !== first);
        for (const use of [[...others], [others[0]], [others[1]], []]) {
          if (use.every(tile => counts[tile] > 0) && consume([first, ...use], jokers - (2 - use.length))) return true;
        }
      }
    }
    failed.add(key);
    return false;
  }

  function consume(natural: readonly number[], jokers: number): boolean {
    if (jokers < 0) return false;
    for (const tile of natural) counts[tile]--;
    const complete = groups(jokers);
    for (const tile of natural) counts[tile]++;
    return complete;
  }

  if (consume([], wild - 2)) return true;
  return counts.some((count, tile) => {
    if (!count) return false;
    return (count >= 2 && consume([tile, tile], wild)) || consume([tile], wild - 1);
  });
}
