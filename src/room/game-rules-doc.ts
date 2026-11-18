/**
 * 对外页「八种玩法」右侧规则面板的内容源。
 *
 * 这是给玩家读的规则，不是给 Coo 的动作说明（后者在 `registry.ts` 的 `rules` 里）。
 * 能引用实现的地方一律引用：秒数、人数、天数、牌张数、发牌配置都从 `src/room/games/*` 取，
 * 改规则时不会只改一边。生成物写在 `src/web/welcome.html` 的 rules 标记之间，
 * 由 `scripts/build-welcome-rules.ts` 写入，`tests/welcome.test.ts` 盯住漂移。
 *
 * 为什么先生成再入库、而不是请求时渲染：首页是静态文件，走的是带 CSP 的直发路径，
 * 不在请求里拼 HTML；生成物入库也和 `src/web/vue/*` 的既有做法一致。
 */
import { GAME_PRESENTATION } from './game-labels.ts';
import {
  ROLE_CARD_LABELS,
  ROLE_COUNTS_BY_SIZE,
  ROLE_SKILLS,
  WEREWOLF_MAX_DAYS,
  type WerewolfRole,
  type WerewolfSeatCount,
} from './games/werewolf.ts';
import { DEFAULT_DURATIONS } from './games/werewolf-table.ts';
import { DEFAULT_BID_MS, DEFAULT_TURN_MS as DDZ_TURN_MS } from './games/doudizhu-table.ts';
import { GOMOKU_SIZE, GOMOKU_TURN_MS } from './games/gomoku-table.ts';
import { XIANGQI_COO_MS, XIANGQI_HUMAN_MS } from './games/xiangqi-table.ts';
import { XIANGQI_COLS, XIANGQI_ROWS } from './games/xiangqi.ts';
import { AEROPLANE_RULES, MAX_SEATS as AEROPLANE_MAX_SEATS, PLANES_PER_SEAT } from './games/aeroplane-rules.ts';
import { AEROPLANE_TURN_MS } from './games/aeroplane-table.ts';
import {
  BUY_MS as MONOPOLY_BUY_MS,
  DEFAULT_RULES as MONOPOLY_RULES,
  EVENT_CARDS as MONOPOLY_CARDS,
  PASS_START_CASH,
  ROLL_MS as MONOPOLY_ROLL_MS,
  SEAT_COUNT as MONOPOLY_SEATS,
  START_CASH,
} from './games/monopoly2d-rules.ts';
import { MAHJONG_RULES } from './games/mahjong-rules.ts';
import { MAHJONG_REPLY_MS, MAHJONG_TURN_MS } from './games/mahjong-table.ts';

/** 一条规则：字符串排成列表项，`{ name, text }` 排成「名字 + 说明」的两列。 */
export type RuleEntry = string | { readonly name: string; readonly text: string };

export interface RuleBlock {
  readonly title: string;
  readonly items: readonly RuleEntry[];
}

export interface RulePage {
  readonly id: string;
  /** 页面上的编号 01–08，和首屏跑马灯、左列按钮是同一个号。 */
  readonly no: string;
  readonly label: string;
  /** 一句话定位，放在玩法名下面。 */
  readonly kicker: string;
  /** 字段条：席位 / 规模 / 时长这类数字。 */
  readonly facts: readonly string[];
  readonly blocks: readonly RuleBlock[];
}

const sec = (ms: number): string => `${Math.round(ms / 1000)} 秒`;
const span = (ms: number): string => (ms % 60_000 === 0 ? `${ms / 60_000} 分钟` : sec(ms));

/** 「2 狼人、2 平民、预言家、女巫」——单张不写 1。 */
const roleMix = (seats: WerewolfSeatCount): string => ROLE_COUNTS_BY_SIZE[seats]
  .map(({ role, count }) => `${count > 1 ? `${count} ` : ''}${ROLE_CARD_LABELS[role]}`)
  .join('、');

const roleEntry = (role: WerewolfRole): RuleEntry => ({ name: ROLE_CARD_LABELS[role], text: ROLE_SKILLS[role] });

const cardRange = (): string => MONOPOLY_CARDS
  .map((card) => `${card.amount > 0 ? '+' : ''}${card.amount}`)
  .join(' / ');

const label = (id: keyof typeof GAME_PRESENTATION): string => GAME_PRESENTATION[id].label;

/**
 * 顺序就是页面上 01–08 的顺序，和首屏跑马灯一致。
 * 每一条都要能在 `src/room/games/*` 里找到出处，改动前先去那边核一遍。
 */
export const RULE_PAGES: readonly RulePage[] = [
  {
    id: 'ddz',
    no: '01',
    label: label('ddz'),
    kicker: '三个人一副牌，谁先出完谁赢。',
    facts: ['3 席', '54 张', `叫地主 ${sec(DEFAULT_BID_MS)} / 出牌 ${sec(DDZ_TURN_MS)}`],
    blocks: [
      {
        title: '怎么打',
        items: [
          '三人一桌，空位由脚本陪练补，一个人也能开。',
          '开局随机决定谁先叫地主，不再由开桌的人固定先叫。',
          '地主拿三张底牌，独自对抗两名农民。',
          '牌型按点数比大小：单张、对子、三张、三带一或三带二、顺子、连对、飞机、四带二。普通牌型要同型同长度才能比。',
          '炸弹压所有普通牌，王炸最大；领出不能过牌。',
        ],
      },
      {
        title: '胜负与收尾',
        items: [
          '谁先出完手牌谁赢：地主出完地主胜，任一农民出完农民方胜。',
          '每打出一次炸弹或王炸，倍数翻一番。',
          '春天：地主赢且两名农民一手没出；反春：农民赢且地主只出过一手。两者各再翻一番。',
        ],
      },
      {
        title: '时长与超时',
        items: [
          `叫地主 ${sec(DEFAULT_BID_MS)}、出牌 ${sec(DDZ_TURN_MS)}；出牌超时由服务器按最小合法出牌代打。`,
          '叫地主超时按「不叫」处理，不会把底牌塞给不在的人。',
        ],
      },
    ],
  },
  {
    id: 'werewolf',
    no: '02',
    label: label('werewolf'),
    kicker: '按分到的身份说话：夜里动手，白天发言，投票放逐。',
    facts: ['6 / 9 / 12 席', `真人发言 ${span(DEFAULT_DURATIONS.humanSpeechMs)}`, `最多 ${WEREWOLF_MAX_DAYS} 个白天`],
    blocks: [
      {
        title: '角色与技能',
        items: [
          roleEntry('wolf'),
          roleEntry('villager'),
          roleEntry('seer'),
          roleEntry('witch'),
          roleEntry('hunter'),
          roleEntry('guard'),
        ],
      },
      {
        title: '人数与发牌',
        items: [
          `6 人：${roleMix(6)}。`,
          `9 人：${roleMix(9)}。`,
          `12 人：${roleMix(12)}；守卫只在 12 人局出现。`,
          '至少一只 Coo 才能开局；可以要求本桌至少有一名真人。',
        ],
      },
      {
        title: '一夜怎么走',
        items: [
          '前半段同时开：狼队交刀票、预言家查验、守卫守护。每个人都只看得到自己那一格。',
          '刀票取唯一最高票；平票或没有有效票就是空刀。狼人可以刀自己，也可以刀队友。',
          '刀口锁定后女巫用药：解药只抵消狼刀，毒药直接带走。',
          '守护挡狼刀、不挡毒药；同一个人既被守又被救时，狼刀仍然生效。',
        ],
      },
      {
        title: '白天与投票',
        items: [
          '按座位顺序发言，每人一条、最多 300 字；提交或过麦后全桌阅读 20 秒。',
          '投票 60 秒，到点统一揭晓。可以弃票，不能投自己。',
          '平票进入 PK：只有不在 PK 名单里的存活者能投，且只能投给 PK 席位或弃票；复投再平，当天无人出局。',
          '被刀或被放逐的猎人能开枪带走一人；中毒（含刀毒同中）不能开枪。出局者留在座位上观战。',
        ],
      },
      {
        title: '胜负与收尾',
        items: [
          '狼人全灭，好人胜。',
          '村民全灭，或神职全灭（屠边），狼人胜。残局里狼多、但平民与神职各还活着一人时，屠边没达成，对局继续。',
          '场上全员出局判平局。',
          `打到第 ${WEREWOLF_MAX_DAYS} 个白天结束仍未分胜负，强制平局收场，不会无限循环。`,
        ],
      },
      {
        title: '时长与超时',
        items: [
          `身份确认 ${sec(DEFAULT_DURATIONS.revealMs)}、夜晚 ${sec(DEFAULT_DURATIONS.nightMs)}、投票 ${sec(DEFAULT_DURATIONS.voteMs)}、开枪 ${sec(DEFAULT_DURATIONS.shootMs)}。`,
          `真人发言 ${span(DEFAULT_DURATIONS.humanSpeechMs)}、Coo ${sec(DEFAULT_DURATIONS.cooSpeechMs)}；发言超时按过麦处理，开枪超时按放弃处理。`,
          '狼队私聊每人每夜两条，每条最多 150 字；刀口锁定前都能发。',
        ],
      },
    ],
  },
  {
    id: 'gomoku',
    no: '03',
    label: label('gomoku'),
    kicker: '两人对下，先连成五个。',
    facts: ['2 席', `${GOMOKU_SIZE} × ${GOMOKU_SIZE} 棋盘`, `每手 ${sec(GOMOKU_TURN_MS)}`],
    blocks: [
      {
        title: '怎么打',
        items: [
          '两席坐满开局，真人和 Coo 可以自由组合。',
          '开局随机决定谁执黑先行，不是开桌的人固定执黑。',
          '无禁手；横、竖、斜任意方向连成五子或更多即胜。',
        ],
      },
      {
        title: '胜负与收尾',
        items: [
          '连成五子立即结束；棋盘下满仍无赢家判和棋。',
          '轮到自己时可以认输，对手直接获胜并正常结算。',
        ],
      },
      {
        title: '时长与超时',
        items: [
          `每手 ${sec(GOMOKU_TURN_MS)}，超时由服务器代下一步（用本人桌面给出的推荐点）。`,
          '本人桌面会轮流虚显三个推荐点，点虚子即选中。',
        ],
      },
    ],
  },
  {
    id: 'xiangqi',
    no: '04',
    label: label('xiangqi'),
    kicker: '两人对下，红先黑后，将死对方为胜。',
    facts: ['2 席', `${XIANGQI_COLS} 列 × ${XIANGQI_ROWS} 行`, `真人 ${span(XIANGQI_HUMAN_MS)} / Coo ${sec(XIANGQI_COO_MS)}`],
    blocks: [
      {
        title: '怎么打',
        items: [
          '两席坐满后由桌主开局，随机分红黑，红方先行。',
          '按象棋棋子走法行棋；被将军必须应将，禁止将帅照面。',
          '选棋子、选落点再确认；也可以从「下一步建议」选一着。',
        ],
      },
      {
        title: '胜负与收尾',
        items: [
          '将死或困毙均判负；轮到自己时可以认输。',
          '同一局面和行棋方第三次出现时，单方长将判负，其余判和。',
          '连续 60 回合不吃子判和。',
        ],
      },
      {
        title: '时长与超时',
        items: [`真人每手 ${span(XIANGQI_HUMAN_MS)}，Coo 每手 ${sec(XIANGQI_COO_MS)}；超时由服务器代走。`],
      },
    ],
  },
  {
    id: 'aeroplane',
    no: '05',
    label: label('aeroplane'),
    kicker: '掷六起飞，穿过四色航线，先把四架飞机送到终点。',
    facts: [`2–${AEROPLANE_MAX_SEATS} 人`, `每人 ${PLANES_PER_SEAT} 架`, `每手 ${sec(AEROPLANE_TURN_MS)}`],
    blocks: [
      { title: '怎么打', items: AEROPLANE_RULES.slice(0, 4) },
      {
        title: '胜负与收尾',
        items: [
          '四架飞机全部抵达终点的人获胜。',
          '被撞只回机库，不淘汰玩家，可以接着起飞。',
        ],
      },
      {
        title: '时长与超时',
        items: [
          `每手 ${sec(AEROPLANE_TURN_MS)}。`,
          '掷骰或选飞机超时后，服务器按合法走法代走。',
        ],
      },
    ],
  },
  {
    id: 'monopoly2d',
    no: '06',
    label: label('monopoly2d'),
    kicker: '掷骰、买地、收租，十二轮定输赢。',
    facts: [
      `${MONOPOLY_SEATS} 席`,
      `${MONOPOLY_RULES.board.length} 格 × ${MONOPOLY_RULES.rounds} 轮`,
      `掷骰 ${sec(MONOPOLY_ROLL_MS)} / 买地 ${sec(MONOPOLY_BUY_MS)}`,
    ],
    blocks: [
      {
        title: '怎么打',
        items: [
          '固定四席，坐满后由开桌的人开始；真人和 Coo 可以自由组合。',
          `起步 ${START_CASH} 金币；路过或停在起点领 ${PASS_START_CASH} 金币。`,
          '落在无主地产可以买下或放弃；踩到别人的地产按固定租金付钱，最多付到 0。',
          `落在街区消息格抽一张事件卡：${cardRange()}。`,
        ],
      },
      {
        title: '胜负与收尾',
        items: [
          `${MONOPOLY_RULES.rounds} 轮共 ${MONOPOLY_RULES.rounds * MONOPOLY_SEATS} 手，走完后按「剩余金币 + 地产原价的 85%」估值排名，同分并列。`,
          '地产不升级、不抵押，也没有玩家之间的交易。',
        ],
      },
      {
        title: '时长与超时',
        items: [
          `每手掷骰 ${sec(MONOPOLY_ROLL_MS)}，买地另有 ${sec(MONOPOLY_BUY_MS)}。`,
          '超时按「代掷骰并跳过购买」处理。',
        ],
      },
    ],
  },
  {
    id: 'mahjong-sichuan',
    no: '07',
    label: label('mahjong-sichuan'),
    kicker: '换三张、定缺，一家胡牌后其余人接着打。',
    facts: ['4 席', '108 张', `出牌 ${sec(MAHJONG_TURN_MS)} / 响应 ${sec(MAHJONG_REPLY_MS)}`],
    blocks: [
      { title: '怎么打', items: MAHJONG_RULES['mahjong-sichuan'].slice(0, 3) },
      {
        title: '胜负与收尾',
        items: [
          '血战到底：一家胡牌不结束，胡者退出摸打，其余人接着打。',
          '三家胡牌，或牌墙摸完，即结算。',
        ],
      },
      { title: '计分', items: [MAHJONG_RULES['mahjong-sichuan'][3]!] },
      {
        title: '时长与超时',
        items: [`出牌 ${sec(MAHJONG_TURN_MS)}；碰、杠、胡的响应窗口 ${sec(MAHJONG_REPLY_MS)}，超时按「过」处理。`],
      },
    ],
  },
  {
    id: 'mahjong-guangdong',
    no: '08',
    label: label('mahjong-guangdong'),
    kicker: '红中当百搭，只认自摸。',
    facts: ['4 席', '136 张', `出牌 ${sec(MAHJONG_TURN_MS)} / 响应 ${sec(MAHJONG_REPLY_MS)}`],
    blocks: [
      { title: '怎么打', items: MAHJONG_RULES['mahjong-guangdong'].slice(0, 3) },
      {
        title: '胜负与收尾',
        items: ['推倒胡：首家胡牌即结算，不接着打；牌墙摸完也结算。'],
      },
      { title: '计分', items: [MAHJONG_RULES['mahjong-guangdong'][3]!] },
      {
        title: '时长与超时',
        items: [`出牌 ${sec(MAHJONG_TURN_MS)}；碰、杠、胡的响应窗口 ${sec(MAHJONG_REPLY_MS)}，超时按「过」处理。`],
      },
    ],
  },
];

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (text: string): string => text.replace(/[&<>"]/g, (ch) => ESCAPES[ch]!);

const renderEntries = (items: readonly RuleEntry[]): string => {
  if (items.every((item) => typeof item === 'string')) {
    return [
      '                <ul>',
      ...items.map((item) => `                  <li>${esc(item as string)}</li>`),
      '                </ul>',
    ].join('\n');
  }
  // 「名字 + 说明」的两列：角色技能用它，名字一列对齐，扫读快。
  return [
    '                <dl class="rule-roles">',
    ...items.map((item) => {
      const entry = item as { name: string; text: string };
      return `                  <dt>${esc(entry.name)}</dt>\n                  <dd>${esc(entry.text)}</dd>`;
    }),
    '                </dl>',
  ].join('\n');
};

/**
 * 生成 `welcome.html` 里 rules 标记之间的整块 HTML。
 * 只用 class，不写内联 style —— 页面 CSP 是 `style-src 'self'`。
 */
export function renderRulesMarkup(pages: readonly RulePage[] = RULE_PAGES): string {
  const tabs = pages.map((page, index) => [
    `          <button class="rule-tab" type="button" role="tab" id="rule-tab-${page.id}"`,
    ` aria-controls="rule-${page.id}" aria-selected="${index === 0 ? 'true' : 'false'}"`,
    ` tabindex="${index === 0 ? '0' : '-1'}">`,
    `<span class="n">${page.no}</span><span class="g">${esc(page.label)}</span>`,
    '</button>',
  ].join('')).join('\n');

  const panels = pages.map((page) => [
    `          <article class="rule" id="rule-${page.id}" role="tabpanel" aria-labelledby="rule-tab-${page.id}" tabindex="0">`,
    '            <header class="rule-head">',
    `              <p class="ef-field rule-facts">${page.facts.map((fact) => `<span>${esc(fact)}</span>`).join('')}</p>`,
    `              <h3 class="rule-name">${esc(page.label)}</h3>`,
    `              <p class="rule-kicker">${esc(page.kicker)}</p>`,
    '            </header>',
    '            <div class="rule-body">',
    ...page.blocks.map((block) => [
      '              <section class="rule-block">',
      `                <h4>${esc(block.title)}</h4>`,
      renderEntries(block.items),
      '              </section>',
    ].join('\n')),
    '            </div>',
    '          </article>',
  ].join('\n')).join('\n');

  return [
    '      <div class="rules">',
    '        <div class="rules-tabs" role="tablist" aria-label="选一种玩法看规则" aria-orientation="vertical">',
    tabs,
    '        </div>',
    '        <div class="rules-panels">',
    panels,
    '        </div>',
    '      </div>',
  ].join('\n');
}
