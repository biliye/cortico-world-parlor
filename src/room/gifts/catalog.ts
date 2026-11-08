/**
 * 茶单与零食单：赠礼只能从这份目录里选。
 *
 * 目录随包发布（改它要发版），v1 不做运营后台配置——多一个可写配置源就多一处
 * 需要跟账本对齐的状态，而礼物本来就没有价签，够用即可。
 */

export type GiftKind = 'tea' | 'snack';

export interface GiftItem {
  id: string;
  kind: GiftKind;
  /** 显示名，也是 parlor_gift 可以按名字填的值。 */
  name: string;
  /** 一句话，用在礼品卡片与通知里。 */
  desc: string;
  /** 单个字符，前端直接当图标用（纯文本，不引外部资源）。 */
  icon: string;
}

export const GIFT_KIND_LABEL: Record<GiftKind, string> = { tea: '茶', snack: '小零食' };

export const GIFTS: readonly GiftItem[] = [
  { id: 'longjing', kind: 'tea', name: '龙井', desc: '豆花香，回甘快。', icon: '🍵' },
  { id: 'biluochun', kind: 'tea', name: '碧螺春', desc: '一口春天，微涩后转甜。', icon: '🌿' },
  { id: 'yinzhen', kind: 'tea', name: '白毫银针', desc: '清淡，像晒过太阳的水。', icon: '🫖' },
  { id: 'tieguanyin', kind: 'tea', name: '铁观音', desc: '兰花香，耐泡。', icon: '🍃' },
  { id: 'puer', kind: 'tea', name: '普洱', desc: '陈香厚重，适合坐久一点。', icon: '🍂' },
  { id: 'moli', kind: 'tea', name: '茉莉花茶', desc: '香得直接，不绕弯。', icon: '🌼' },
  { id: 'guihuagao', kind: 'snack', name: '桂花糕', desc: '一口一个，桂花味先到。', icon: '🍡' },
  { id: 'lvdougao', kind: 'snack', name: '绿豆糕', desc: '绵，甜得克制。', icon: '🍥' },
  { id: 'shanzhapian', kind: 'snack', name: '山楂片', desc: '酸得让人清醒。', icon: '🍬' },
  { id: 'lizi', kind: 'snack', name: '糖炒栗子', desc: '烫手，剥开很甜。', icon: '🌰' },
  { id: 'guazi', kind: 'snack', name: '瓜子', desc: '一嗑就停不下来。', icon: '🥜' },
  { id: 'mijian', kind: 'snack', name: '蜜饯', desc: '齁甜，但就是想吃。', icon: '🍯' },
];

export const giftById = (id: string): GiftItem | undefined => GIFTS.find((item) => item.id === id);

export interface GiftLookup {
  item?: GiftItem;
  /** 没找到时给调用方的中文原因；找到了就是 undefined。 */
  error?: string;
}

/**
 * 按 id / 全名 / 唯一前缀找一件礼物。
 * 撞名不猜：宁可让调用方重填，也不要送错东西——礼物送出去就收不回来了。
 */
export function resolveGift(query: unknown): GiftLookup {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!needle) {
    return { error: `礼物要选一件：用 parlor_query {op:"gifts"} 看茶单，可选 ${GIFTS.map((item) => item.id).join(' / ')}` };
  }
  const exact = GIFTS.find((item) => item.id === needle || item.name.toLowerCase() === needle);
  if (exact) return { item: exact };
  const hits = GIFTS.filter((item) => item.id.startsWith(needle) || item.name.toLowerCase().startsWith(needle));
  if (hits.length === 1) return { item: hits[0] };
  if (hits.length > 1) {
    return { error: `「${query}」不唯一，可能是：${hits.map((item) => `${item.id}（${item.name}）`).join('、')}` };
  }
  return { error: `茶单里没有「${query}」：可选 ${GIFTS.map((item) => item.id).join(' / ')}` };
}

/** 目录的对外视图：给 Coo 与网页共用同一份形状。 */
export const giftCatalog = (): Array<{ id: string; kind: GiftKind; kindLabel: string; name: string; desc: string; icon: string }> => (
  GIFTS.map((item) => ({ ...item, kindLabel: GIFT_KIND_LABEL[item.kind] }))
);
