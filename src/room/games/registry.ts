/**
 * 牌桌注册表：**加一张新桌子 = 写一个 GameDefinition，再在 GAME_LIST 里登记一行。**
 *
 * 一份定义同时管三件事，三处都从这里取，不再各写一份 if：
 * - 服务器：`TableHost` 用 `create()` 造引擎、用 `label` 写回执；`WorldServer` 用
 *   `actionType` / `toAction()` 把 `/v1/action` 的 body 变成引擎动作。
 * - 通用 HTTP/World：动作说明、参数 Schema 与转换放在 `action` 里，
 *   `availableActions()` 根据本人私视图提供当前动作。新游戏不再添加工具。
 *   游戏目录与动作说明按需返回，不登记专属工具。
 * - 网页：`icon` 与 `label` 给牌桌栏/大厅卡片用（网页那份清单在
 *   `src/web/games/registry.js`，加游戏时同样登记一行——两个运行时不能共享模块）。
 *
 * 旧单厅服务器（`kernel.ts`）仍只认 dice/ddz：它是自托管与回退用的老路，不跟着扩展。
 */
import type { TableEngine, TableLogQuery } from '../table-engine.ts';
import { DiceTable } from '../table.ts';
import { RANKS } from './doudizhu.ts';
import { DoudizhuTable } from './doudizhu-table.ts';
import { Monopoly2dTable } from './monopoly2d-table.ts';
import { GOMOKU_SIZE, GomokuTable } from './gomoku-table.ts';
import { WerewolfTable, WEREWOLF_MIN_CLIENT } from './werewolf-table.ts';
import type { WerewolfSeatCount } from './werewolf.ts';

export interface GameCreateContext {
  /** 开桌者：id/name 之外带服务端席位类型与客户端能力版本（狼人杀开局校验用）。 */
  host: { id: string; name: string; kind?: 'pet' | 'human'; clientVersion?: string };
  now: number;
  requireHuman?: boolean;
  seatCount?: WerewolfSeatCount;
  /** 开桌时给的「每回合多久」（测试里调短）；只有用得上它的游戏才读。 */
  turnMs?: number;
}

export interface GameActionDecl {
  description: string;
  parameters: Record<string, unknown>;
  /** 游戏协议参数 → 兼容动作 body（含 type）；不对时抛 Error，由网关或 World 返回失败。 */
  toBody(args: Record<string, unknown>): Record<string, unknown>;
  /** 回执里那句「做了什么」。 */
  done(body: Record<string, unknown>): string;
}



export interface GameDefinition {
  id: string;
  /** 给人看的游戏名，账本也用它。 */
  label: string;
  /** 网页图标名（见 `src/web/common.js` 的 icon 集合）。 */
  icon: string;
  /** 开桌回执里的补充说明。 */
  openHint: string;
  /** 按需查询的玩法说明，不加入常驻工具描述。 */
  rules: string[];
  create(ctx: GameCreateContext): TableEngine;
  /** `/v1/action` 的动作类型；旧 World 也按这个名字发。 */
  actionType: string;
  /** `/v1/action` body → 引擎动作。 */
  toAction(body: Record<string, unknown>): unknown;
  /** 游戏协议，不依赖 Coo 工具名；新游戏只实现这一份定义。 */
  action: GameActionDecl;
  /** 多动作游戏的判别字段；单动作游戏不填，动作名用 singleAction。 */
  actionKey?: 'action' | 'move';
  singleAction?: string;
  /** 从已按本人身份投影的私视图取得当前可用动作名。 */
  availableActions(view: Record<string, unknown>): string[];
  /**
   * 动作并发策略：
   * - `strict`（骰子/斗地主）：整桌 revision 乐观锁，旧视图一律打不进新回合；
   * - `window`（狼人杀）：多人同窗口各自有动作槽；revision 只当参考，
   *   引擎在事务里用最新快照校验 windowId 与槽位。
   */
  revisionMode: 'strict' | 'window';
  /**
   * 动作回执是否附上本人的最新私视图。狼人杀与快局大富翁需要：
   * 一个动作之后紧接着要在同一回合里做下一步，不能让 Coo 干等下一次叫醒。
   */
  attachPrivateOnAct?: boolean;
}

const dice: GameDefinition = {
  id: 'dice',
  label: '骰子',
  icon: 'dice',
  openHint: '等人坐下后用 parlor_table {op:"start"} 开始。',
  rules: ['每人两颗暗骰，回合中可重掷一颗或停牌，每人最多重掷两次。', '结束后揭晓骰子，点数和最高者获胜，同分并列；超时自动停牌。'],
  create: (ctx) => new DiceTable({
    host: ctx.host,
    now: ctx.now,
    ...(ctx.turnMs ? { turnMs: ctx.turnMs } : {}),
  }),
  actionType: 'table_action',
  toAction: (body) => ({ type: String(body.action ?? ''), die: body.die }),
  revisionMode: 'strict',
  actionKey: 'action',
  availableActions: (view) => view.yourTurn === true
    ? (Number(view.rerollsLeft) > 0 ? ['roll', 'stand'] : ['stand']) : [],
  action: {
    description: '骰子桌轮到你时，重掷一颗骰子或停牌。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['roll', 'stand'], description: 'roll = reroll one die, stand = keep your total.' },
        die: { type: 'integer', enum: [0, 1], description: 'Which die to reroll when action is roll.' },
      },
      required: ['action'],
    },
    toBody: (args) => {
      const action = String(args.action ?? '');
      if (action !== 'roll' && action !== 'stand') throw new Error('action 只能是 roll 或 stand');
      const die = action === 'roll' ? Number(args.die ?? 0) : undefined;
      if (die !== undefined && die !== 0 && die !== 1) throw new Error('die 只能是 0 或 1');
      return { type: 'table_action', action, die };
    },
    done: (body) => (body.action === 'roll' ? '重掷了一颗骰子。' : '停牌了。'),
  },
};

const ddz: GameDefinition = {
  id: 'ddz',
  label: '斗地主',
  icon: 'cards',
  openHint: '（3 席，空位由脚本陪练补）用 parlor_table {op:"start"} 开始；叫地主时会叫你。',
  rules: ['三席斗地主，先叫地主，再轮流出牌；地主独自对抗两名农民，先出完手牌的一方获胜。', '同型同长度比主牌，炸弹压普通牌，王炸最大；领出不能过牌。牌用点数表示，小王 SJ、大王 BJ。', '本人桌面提供手牌、可过判断及合法出牌建议，超时按服务端规则代打。'],
  create: (ctx) => new DoudizhuTable({ host: ctx.host, now: ctx.now }),
  actionType: 'ddz_action',
  toAction: (body) => ({ move: body.move, call: body.call, cards: body.cards }),
  revisionMode: 'strict',
  actionKey: 'move',
  availableActions: (view) => view.yourTurn !== true ? [] : view.status === 'bidding'
    ? ['bid'] : view.status === 'playing' ? (view.canPass === true ? ['play', 'pass'] : ['play']) : [],
  action: {
    description: '斗地主轮到你时叫地主、出牌或过。牌只写点数，SJ 是小王，BJ 是大王。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        move: { type: 'string', enum: ['bid', 'play', 'pass'], description: 'bid = call or decline landlord; play = put down cards; pass = skip.' },
        call: { type: 'boolean', description: 'When move is bid: true = become landlord, false = decline.' },
        cards: {
          type: 'array',
          items: { type: 'string', enum: [...RANKS] },
          description: 'play 时给出要打的牌，例如 ["3","3"]。',
        },
      },
      required: ['move'],
    },
    toBody: (args) => {
      const move = String(args.move ?? '');
      if (move === 'bid') return { type: 'ddz_action', move: 'bid', call: args.call === true };
      if (move === 'play') {
        const cards = Array.isArray(args.cards) ? args.cards.map((card) => String(card)) : [];
        if (cards.length === 0) throw new Error('出牌要给 cards，例如 ["3","3"]');
        return { type: 'ddz_action', move: 'play', cards };
      }
      if (move === 'pass') return { type: 'ddz_action', move: 'pass' };
      throw new Error('move 只能是 bid、play 或 pass');
    },
    done: (body) => {
      if (body.move === 'bid') return body.call === true ? '叫了地主。' : '不叫。';
      if (body.move === 'play') return `出了 ${(body.cards as string[]).join(' ')}。`;
      return '过了。';
    },
  },
};

const werewolf: GameDefinition = {
  id: 'werewolf',
  label: '狼人杀',
  icon: 'moon',
  openHint: `开桌可选 6／9／12 席（默认 9），至少一只 Coo。坐满后用 parlor_table {op:"start"} 开局，届时会校验每只 Coo 的扩展版本 ≥ ${WEREWOLF_MIN_CLIENT}。`,
  rules: ['六、九或十二席狼人杀，服务端分配身份；本人桌面只显示获准知道的身份、查验与队内消息。', '夜晚按角色操作，白天按顺序发言、投票放逐；操作只能使用当前窗口，已经提交的槽不能重复提交。', '发言与狼聊走游戏动作；目标用桌内座号。每个角色的技能、可用药与当前行动，以本人桌面为准。'],
  create: (ctx) => new WerewolfTable({
    host: ctx.host,
    now: ctx.now,
    requireHuman: ctx.requireHuman,
    seatCount: ctx.seatCount,
    ...(ctx.turnMs ? { turnMs: ctx.turnMs } : {}),
  }),
  actionType: 'werewolf_action',
  toAction: (body) => ({
    move: body.move,
    windowId: body.windowId,
    text: body.text,
    target: body.target,
    choice: body.choice,
  }),
  revisionMode: 'window',
  attachPrivateOnAct: true,
  actionKey: 'move',
  availableActions: (view) => view.canAct !== true || typeof view.myMove !== 'string' ? []
    : view.myMove === 'speak' ? ['speak', 'pass_speech'] : [view.myMove],
  action: {
    description: '提交狼人杀本人桌面列出的当前窗口动作，每个动作槽只提交一次。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        windowId: { type: 'string', description: '最新桌面给出的窗口号。' },
        move: {
          type: 'string',
          enum: ['speak', 'pass_speech', 'vote', 'wolf_chat', 'wolf_kill', 'inspect', 'guard', 'witch', 'shoot'],
        },
        text: { type: 'string', description: 'For speak (≤300 chars, one message) or wolf_chat (≤150 chars).' },
        target: { type: 'integer', description: 'Seat number within the current table capacity. Omit to skip. Guard can target themselves.' },
        choice: { type: 'string', enum: ['none', 'save', 'poison'], description: 'Only for witch: use nothing, save the kill victim, or poison.' },
      },
      required: ['windowId', 'move'],
    },
    toBody: (args) => {
      const move = String(args.move ?? '');
      const legal = ['speak', 'pass_speech', 'vote', 'wolf_chat', 'wolf_kill', 'inspect', 'guard', 'witch', 'shoot'];
      if (!legal.includes(move)) throw new Error(`move 只能是 ${legal.join(' / ')}`);
      const windowId = String(args.windowId ?? '').trim();
      if (!windowId) throw new Error('要带上桌面给你的 windowId（先 parlor_game_info {op:"state"} 看一眼）');
      const body: Record<string, unknown> = { type: 'werewolf_action', move, windowId };
      if (args.text !== undefined) {
        if (move !== 'speak' && move !== 'wolf_chat') throw new Error('text 只用于 speak 或 wolf_chat');
        body.text = String(args.text);
      }
      if (args.target !== undefined) {
        const target = Number(args.target);
        if (!Number.isSafeInteger(target)) throw new Error('target 要是座号（整数）');
        body.target = target;
      }
      if (args.choice !== undefined) {
        if (move !== 'witch') throw new Error('choice 只用于 witch');
        body.choice = String(args.choice);
      }
      if (move === 'witch' && args.choice === undefined) throw new Error('witch 要给 choice：none / save / poison');
      if ((move === 'inspect' || move === 'shoot') && args.target === undefined) {
        // 显式放弃也是合法选择：不带 target 即可。
      }
      return body;
    },
    done: (body) => {
      switch (body.move) {
        case 'speak': return '发言提交了；这一条机会用完，大家进入阅读时间。';
        case 'pass_speech': return '过麦了；发言机会让给下一位。';
        case 'vote': return body.target === undefined || body.target === null ? '弃票交了；到点统一揭晓。' : `投给 ${body.target} 号了；到点统一揭晓。`;
        case 'wolf_chat': return '狼队的话交了；同伴能看到。';
        case 'wolf_kill': return body.target === undefined || body.target === null ? '弃刀交了。' : `刀票投给 ${body.target} 号了；到点锁定刀口。`;
        case 'inspect': return body.target === undefined ? '今夜不查验，槽已交。' : `已查验 ${body.target} 号；可在 state 查看本人查验记录。`;
        case 'guard': return body.target == null ? '今夜空守，动作已提交。' : `已守护 ${body.target} 号。`;
        case 'witch': return body.choice === 'save' ? '解药用掉了。' : body.choice === 'poison' ? '毒药用掉了。' : '今夜不用药，槽已交。';
        case 'shoot': return body.target === undefined ? '放弃开枪了。' : `开枪带走 ${body.target} 号了。`;
        default: return '动作交了。';
      }
    },
  },

};

const monopoly2d: GameDefinition = {
  id: 'monopoly2d',
  label: '快局大富翁',
  icon: 'board',
  openHint: '（4 席，坐满后由开桌的人开始）四人 6 轮 24 手，掷骰、买地、收租、抽事件卡，最后按金币加地产估值排名。',
  rules: ['四人六轮共二十四手，轮到本人先掷骰，落在无主地产后决定购买或放弃，其他落点按服务端规则收租或触发事件。', '动作必须带本人桌面的 turnNo；购买与掷骰是两个操作阶段。', '终局按现金加地产原价 85% 的合计估值排名，同分并列。'],
  create: (ctx) => new Monopoly2dTable({
    host: ctx.host,
    now: ctx.now,
    ...(ctx.turnMs ? { rollMs: ctx.turnMs } : {}),
  }),
  actionType: 'monopoly2d_action',
  toAction: (body) => ({ move: body.move, turnNo: body.turnNo }),
  revisionMode: 'strict',
  attachPrivateOnAct: true,
  actionKey: 'move',
  availableActions: (view) => view.canAct === true && Array.isArray(view.moves)
    ? view.moves.filter((move): move is string => typeof move === 'string'
      && (move !== 'buy' || (view.pending as { affordable?: boolean } | null)?.affordable === true)) : [],
  action: {
    description: '快局大富翁轮到你时掷骰，或在买地阶段决定买下 / 放弃。只按自己桌面上的 turnNo 行动。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        move: {
          type: 'string',
          enum: ['roll', 'buy', 'pass'],
          description: 'roll = 掷骰；buy = 买下脚下的地产；pass = 放弃购买。',
        },
        turnNo: {
          type: 'integer',
          description: '你桌面上给出的当前回合号（从 1 开始，最多 24）。照抄，别自己算。',
        },
      },
      required: ['move', 'turnNo'],
    },
    toBody: (args) => {
      const move = String(args.move ?? '');
      if (move !== 'roll' && move !== 'buy' && move !== 'pass') throw new Error('move 只能是 roll、buy 或 pass');
      const turnNo = Number(args.turnNo);
      if (!Number.isSafeInteger(turnNo) || turnNo < 1) throw new Error('turnNo 要照抄桌面给出的正整数（从 1 开始）');
      return { type: 'monopoly2d_action', move, turnNo };
    },
    done: (body) => {
      if (body.move === 'roll') return '掷了骰子；可在 state 查看落点与结算。';
      if (body.move === 'buy') return '买下了脚下的地产。';
      return '放弃了购买。';
    },
  },
};

/** 登记顺序 = World 工具与网页卡片的顺序。 */
const gomoku: GameDefinition = {
  id: 'gomoku',
  label: '五子棋',
  icon: 'board',
  openHint: '两席坐满后开局，桌主执黑先行。',
  rules: ['十五乘十五棋盘，桌主执黑先行，双方轮流在空格落子；行列从 0 到 14。', '横、竖或斜向连续至少五子获胜，棋盘下满仍无赢家则和棋；本人桌面提供落点建议。'],
  create: ({ host, turnMs }) => new GomokuTable(host, turnMs),
  actionType: 'gomoku_action',
  revisionMode: 'strict',
  toAction: ({ row, col }) => ({ row, col }),
  singleAction: 'place',
  availableActions: (view) => view.canAct === true ? ['place'] : [],
  action: {
    description: '五子棋轮到你时落子，行列从 0 到 14。用 parlor_game_info {op:"state"} 看棋盘和下一步建议。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        row: { type: 'integer', minimum: 0, maximum: GOMOKU_SIZE - 1 },
        col: { type: 'integer', minimum: 0, maximum: GOMOKU_SIZE - 1 },
      },
      required: ['row', 'col'],
    },
    toBody: ({ row, col }) => ({ type: 'gomoku_action', row, col }),
    done: ({ row, col }) => `落子 ${row},${col}。`,
  },
};

export const GAME_LIST: readonly GameDefinition[] = [dice, ddz, werewolf, monopoly2d, gomoku];

const BY_ID = new Map(GAME_LIST.map((game) => [game.id, game]));
const BY_ACTION = new Map(GAME_LIST.map((game) => [game.actionType, game]));

export const gameById = (id: string): GameDefinition | null => BY_ID.get(id) ?? null;

/** 动作类型 → 游戏；`/v1/action` 用它把 body 交给对的那张桌子。 */
export const gameByActionType = (type: string): GameDefinition | null => BY_ACTION.get(type) ?? null;

export const gameIds = (): string[] => GAME_LIST.map((game) => game.id);

export const gameLabelOf = (id: string): string => BY_ID.get(id)?.label ?? id;

export type { TableLogQuery };
