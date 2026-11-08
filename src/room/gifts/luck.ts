/**
 * 喝掉 / 吃掉之后的「运气」文案。
 *
 * 刻意不产生任何效果：不进账本、不改概率、不影响牌局与任何结算。
 * 运气只是气氛——所以这里全是纯函数，没有写库、没有可被利用的状态。
 *
 * 规则：两小时内第 1、2 份是「运气上升」；第 3 份起算过量，改成随机的
 * 过量场景（晕茶 / 晕碳 / 睡不着），文案转成「运气下降」。
 */
import type { GiftItem } from './catalog.ts';

/** 统计「吃喝了多少」的时间窗：两小时内连喝连吃才算过量。 */
export const LUCK_WINDOW_MS = 2 * 60 * 60 * 1000;
/** 窗口内第几份起算过量。 */
export const BINGE_AT = 3;

export interface LuckOutcome {
  tone: 'up' | 'down';
  /** 场景叙述，带物品名。 */
  text: string;
  /** 可直接整句输出的那行，含「运气 ±1（只是说说）」。 */
  line: string;
  /** 窗口内这一份是第几份（1 起）。 */
  nth: number;
  /** 只用于前端上色：+1 / -1。不参与任何计算。 */
  delta: number;
}

const TEA_UP: readonly string[] = [
  '一杯{name}下去，喉咙里回出一丝甜。',
  '茶汤很稳，心也跟着静下来了。',
  '{name}的香气慢慢散开，像有什么好事正在靠近。',
  '你捧着杯子暖了暖手，觉得今天说话都会好听一点。',
  '杯底见了月，你莫名觉得接下来会有件小事是好的。',
];

const TEA_DOWN: readonly string[] = [
  '又是一杯{name}，手有点抖。',
  '连着灌了几杯，你开始怀疑今晚睡不着了。',
  '茶是好茶，喝法是错的，你现在有点晕茶。',
  '肚子里全是水声，坐着都能听见。',
];

const SNACK_UP: readonly string[] = [
  '{name}甜得刚好，心情一下子亮了。',
  '咬了一口{name}，碎屑掉在桌上，像小小的彩头。',
  '{name}很好吃，你决定相信今天会顺利。',
  '这一口{name}让你想起小时候，嘴角自己翘起来。',
  '手上还留着{name}的甜味，你觉得待会儿会有人夸你。',
];

const SNACK_DOWN: readonly string[] = [
  '{name}吃太多了，碳水把你按在椅子上——你有点晕碳。',
  '胃里沉甸甸的，脑子转不动了。',
  '又是{name}……你开始怀疑自己。',
  '甜过头了，牙有点酸，心情跟着发酸。',
];

const pick = (pool: readonly string[], rng: () => number): string => (
  pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))] ?? pool[0]
);

/**
 * 掷一次运气文案。`recent` 是窗口内已经喝掉/吃掉的份数（不含这一次）。
 * rng 可注入，测试才能断言具体走了哪条池子。
 */
export function rollLuck(input: { item: GiftItem; recent: number; rng?: () => number }): LuckOutcome {
  const rng = input.rng ?? Math.random;
  const nth = Math.max(1, Math.trunc(input.recent) + 1);
  const binge = nth >= BINGE_AT;
  const isTea = input.item.kind === 'tea';
  const pool = binge ? (isTea ? TEA_DOWN : SNACK_DOWN) : (isTea ? TEA_UP : SNACK_UP);
  const text = pick(pool, rng).replaceAll('{name}', input.item.name);
  const delta = binge ? -1 : 1;
  const verb = isTea ? '喝' : '吃';
  const head = binge ? `${verb}太多了。` : '';
  return {
    tone: binge ? 'down' : 'up',
    text,
    line: `${head}${text}运气 ${delta > 0 ? '+' : ''}${delta}（只是说说，不影响任何结果）。`,
    nth,
    delta,
  };
}
