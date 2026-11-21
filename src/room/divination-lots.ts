import type { DivinationLot } from './divination-protocol.ts';

export const DIVINATION_LOTS: readonly DivinationLot[] = [
  {
    number: 1, grade: "中吉",
    poem: "一盏新茶未及温\n檐前已报故人门\n话到三分留七分\n茶烟散处是春痕",
    advice: "会客", note: "今天适合见人，话别说满。",
  },
  {
    number: 2, grade: "中平",
    poem: "案上残棋未肯收\n一着犹疑一着休\n莫嫌此局无胜负\n且看灯花落几筹",
    advice: "收尾", note: "有件事拖了很久，今天适合收个尾，不必求赢。",
  },
  {
    number: 3, grade: "上上",
    poem: "炉火初红水正鸣\n松风忽起满庭清\n好茶须趁当时饮\n莫待凉来味已轻",
    advice: "趁热", note: "今天有件正合适的事，别等「再准备准备」。",
  },
  {
    number: 4, grade: "中下",
    poem: "路近偏逢雨脚斜\n桥头水涨没蒹葭\n宁绕三里平安道\n不争一步险中花",
    advice: "绕行", note: "今天别抄近路，多花的那点时间买的是安稳。",
  },
  {
    number: 5, grade: "中吉",
    poem: "旧书翻到第三行\n忽有微光透纸凉\n莫笑陈言多旧话\n一句能省半年忙",
    advice: "翻旧", note: "答案可能在你早就看过的东西里。",
  },
  {
    number: 6, grade: "上吉",
    poem: "雨过檐牙滴未停\n阶前苔色一时青\n不须扫尽门前水\n留与来人照影行",
    advice: "留客", note: "别急着把场面收拾干净，有人要来。",
  },
  {
    number: 7, grade: "中平",
    poem: "风过茶棚半卷帘\n一炉微火自生烟\n客来不问前程事\n只说今年雨水甜",
    advice: "闲坐", note: "今天没什么大事，正好歇一歇。",
  },
  {
    number: 8, grade: "中吉",
    poem: "隔墙听得一声棋\n恰是当年未落时\n欲问输赢都不必\n此局输赢局外知",
    advice: "观局", note: "有件事你不必下场，看着比参与清楚。",
  },
  {
    number: 9, grade: "上吉",
    poem: "灯花昨夜落双蕊\n今早枝头报一声\n莫道此间无喜事\n喜从寻常小事生",
    advice: "留意", note: "今天的好消息很小，别错过。",
  },
  {
    number: 10, grade: "下下",
    poem: "舟到中流风忽转\n橹声乱了水声喧\n此时莫问岸远近\n先稳船身再看天",
    advice: "稳住", note: "今天别赶路，先把手上的事稳住。",
  },
  {
    number: 11, grade: "上上",
    poem: "一壶春水初煎雪\n恰有知音叩竹门\n莫问此来何所事\n茶烟起处即乾坤",
    advice: "会友", note: "今天遇到的人，可能比计划的事更要紧。",
  },
  {
    number: 12, grade: "中平",
    poem: "日影移墙一寸长\n案头茶冷未曾尝\n不是主人多怠慢\n只因闲事太寻常",
    advice: "慢饮", note: "忙得连茶都凉了，今天给自己留一刻钟。",
  },
  {
    number: 13, grade: "中吉",
    poem: "小雨如丝不湿衣\n正好撑伞过桥西\n桥西有客多年别\n一见还如初见时",
    advice: "重逢", note: "有个很久没联系的人，今天适合打个招呼。",
  },
  {
    number: 14, grade: "中下",
    poem: "檐前滴水不成线\n阶下苔痕一夜深\n且闭闲门温旧火\n等它云破月来斟",
    advice: "闭门", note: "今天出门不顺，不如在家把一件事做完。",
  },
  {
    number: 15, grade: "中平",
    poem: "案上一枝瓶里花\n开时无语落无涯\n莫问此花开几日\n开时看过便由它",
    advice: "随它", note: "有些事看过就好，不必追问结果。",
  },
  {
    number: 16, grade: "上吉",
    poem: "昨夜炉中留一火\n今朝拨出满堂红\n莫言此火寻常物\n暖到人心便不同",
    advice: "添火", note: "你之前留下的那点东西，今天能派上用场。",
  },
  {
    number: 17, grade: "下下",
    poem: "风打船窗雨打篷\n一江秋水两头空\n此时莫问鱼多少\n收网归家且避风",
    advice: "收网", note: "今天不适合硬撑，收手不是认输。",
  },
  {
    number: 18, grade: "中吉",
    poem: "竹影横斜过粉墙\n一庭清露湿衣裳\n莫嫌此夜无人过\n月在檐头自举觞",
    advice: "独处", note: "今晚一个人待着，比凑热闹舒服。",
  },
  {
    number: 19, grade: "中平",
    poem: "棋到中盘势未分\n一子犹疑一子沉\n莫急落子争先后\n且留余地与来人",
    advice: "留白", note: "今天别把话说死，留个余地。",
  },
  {
    number: 20, grade: "中下",
    poem: "小舟系在柳阴边\n缆未系牢风又牵\n莫笑此翁手脚慢\n慢中自有一分安",
    advice: "系牢", note: "有件小事没做扎实，今天回去补一遍。",
  },
  {
    number: 21, grade: "中吉",
    poem: "新茶旧客两相宜\n说到当年话就迟\n莫怪主人频换水\n淡到无味始知奇",
    advice: "久坐", note: "今天适合跟熟人没话找话地坐着。",
  },
  {
    number: 22, grade: "上上",
    poem: "多年未种庭前树\n今日抬头已过檐\n莫问何人手所栽\n乘凉时节自了然",
    advice: "乘凉", note: "你早先做的一件小事，今天正好护着你。",
  },
  {
    number: 23, grade: "中平",
    poem: "半窗明月半窗风\n一盏残茶一盏空\n莫问今宵何所事\n茶凉月落各西东",
    advice: "早睡", note: "今天想不明白的事，明天多半就不用想了。",
  },
  {
    number: 24, grade: "上吉",
    poem: "雪后初晴日色柔\n檐前冰化水声稠\n莫嫌此水无人看\n滴到春深自满沟",
    advice: "等春", note: "眼下还冷，但你做的事正在慢慢化开。",
  },
];

const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
const HEAD_LOTS = [3, 11, 22] as const;

export function divinationDay(time: number): { key: string; head: number } {
  const day = Math.floor((time + SHANGHAI_OFFSET_MS) / DAY_MS);
  const index = ((day % HEAD_LOTS.length) + HEAD_LOTS.length) % HEAD_LOTS.length;
  return { key: new Date(day * DAY_MS).toISOString().slice(0, 10), head: HEAD_LOTS[index] };
}
