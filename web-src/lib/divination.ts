/** 签等 → 语气色。上签朱、下签竹青、中间两档走墨；下签不描黑，是不想让人一打开就沉下去。 */
export type LotTone = 'high' | 'mid' | 'low';

export function lotTone(grade: string): LotTone {
  if (grade === '上上' || grade === '上吉') return 'high';
  if (grade === '下下' || grade === '中下') return 'low';
  return 'mid';
}
