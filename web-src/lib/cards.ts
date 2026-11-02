/** 牌与时钟的小工具：规则与旧渲染器 src/web/common.js 保持一致，供 Vue 桌面组件使用。 */

export type CardArt = { rank?: string; suit?: string | null } | null;

const SPRITE_COLS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SPRITE_ROWS: Record<string, number> = { S: 0, H: 1, C: 2, D: 3 };

/** 手牌显示顺序：大牌在左（只改显示顺序，索引仍按服务器手牌）。 */
export const HAND_ORDER = ['BJ', 'SJ', '2', 'A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3'];

export function cardLabel(card: string): string {
  if (card === 'SJ') return '小王';
  if (card === 'BJ') return '大王';
  return String(card);
}

export function cardClass(card: string): string {
  if (card === 'SJ' || card === 'BJ') return 'joker';
  if (card === '2') return 'red';
  return '';
}

/** 牌面雪碧图的格子坐标；服务器没给花色（老回放）时返回空，只显示点数。 */
export function cardArtStyle(rank: string, suit: string | null): Record<string, string> {
  const rowNumber = suit && SPRITE_ROWS[suit] !== undefined ? SPRITE_ROWS[suit] : 4;
  const col = rowNumber === 4 ? (rank === 'BJ' ? 0 : 1) : SPRITE_COLS.indexOf(rank);
  if (col < 0) return {};
  return { '--c': String(col), '--r': String(rowNumber) };
}

export function sortHand(hand: string[]): Array<{ card: string; index: number }> {
  return hand
    .map((card, index) => ({ card, index }))
    .sort((left, right) => HAND_ORDER.indexOf(left.card) - HAND_ORDER.indexOf(right.card)
      || left.index - right.index);
}

let artState: 'idle' | 'loading' | 'ready' | 'missing' = 'idle';

/** 牌面雪碧图第一次真要画牌时才拉；和旧页共用 html.card-art-ready / no-card-art 两个类。 */
export function probeCardArt(): void {
  if (artState !== 'idle') return;
  artState = 'loading';
  const img = new Image();
  img.addEventListener('load', () => {
    artState = 'ready';
    document.documentElement.classList.add('card-art-ready');
  });
  img.addEventListener('error', () => {
    artState = 'missing';
    document.documentElement.classList.add('no-card-art');
  });
  img.src = '/play/assets/assets/cards/cards.webp';
}

export const pad = (value: number): string => String(value).padStart(2, '0');

/** 服务器时刻（UTC+8）的 HH:MM:SS。 */
export function fmtClock(ts: number): string {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(11, 19);
}

/** 距离截止还剩多久；到期写「已截止」。规则同 common.js 的 fmtLeft。 */
export function fmtLeft(deadline: number, now: number): string {
  if (!deadline) return '';
  const left = Math.max(0, deadline - now);
  if (left <= 0) return '已截止';
  const total = Math.ceil(left / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}
