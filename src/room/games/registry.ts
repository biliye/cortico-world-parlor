/**
 * 牌桌注册表：**加一张新桌子 = 写一个 GameDefinition，再在 GAME_LIST 里登记一行。**
 *
 * 一份定义同时管三件事，三处都从这里取，不再各写一份 if：
 * - 服务器：`TableHost` 用 `create()` 造引擎、用 `label` 写回执；`WorldServer` 用
 *   `actionType` / `toAction()` 把 `/v1/action` 的 body 变成引擎动作。
 * - World：工具声明（名字/描述/JSON Schema）与「参数 → body」的校验都在 `tool` 里，
 *   `world.ts` 只负责把它们登记出去（`extraTools` 一并登记）。
 * - 网页：`icon` 与 `label` 给牌桌栏/大厅卡片用（网页那份清单在
 *   `src/web/games/registry.js`，加游戏时同样登记一行——两个运行时不能共享模块）。
 *
 * 旧单厅服务器（`kernel.ts`）仍只认 dice/ddz：它是自托管与回退用的老路，不跟着扩展。
 */
import type { TableEngine, TableLogQuery } from '../table-engine.ts';
import { DiceTable } from '../table.ts';
import { RANKS } from './doudizhu.ts';
import { DoudizhuTable } from './doudizhu-table.ts';
import { WerewolfTable, WEREWOLF_MIN_CLIENT } from './werewolf-table.ts';

export interface GameCreateContext {
  /** 开桌者：id/name 之外带服务端席位类型与客户端能力版本（狼人杀开局校验用）。 */
  host: { id: string; name: string; kind?: 'pet' | 'human'; clientVersion?: string };
  now: number;
  /** 开桌时给的「每回合多久」（测试里调短）；只有用得上它的游戏才读。 */
  turnMs?: number;
}

export interface GameToolDecl {
  /** World 里这张桌子的动作工具名。 */
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 工具参数 → `/v1/action` body（含 type）。参数不对时抛 Error，World 原样转成失败回执。 */
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
  create(ctx: GameCreateContext): TableEngine;
  /** `/v1/action` 的动作类型；旧 World 也按这个名字发。 */
  actionType: string;
  /** `/v1/action` body → 引擎动作。 */
  toAction(body: Record<string, unknown>): unknown;
  tool: GameToolDecl;
  /**
   * 动作并发策略：
   * - `strict`（骰子/斗地主）：整桌 revision 乐观锁，旧视图一律打不进新回合；
   * - `window`（狼人杀）：多人同窗口各自有动作槽；revision 只当参考，
   *   引擎在事务里用最新快照校验 windowId 与槽位。
   */
  revisionMode: 'strict' | 'window';
  /** 同一游戏除 `tool` 之外的查询工具（狼人杀的历史/复盘）。 */
  extraTools?: GameToolDecl[];
}

const dice: GameDefinition = {
  id: 'dice',
  label: '骰子',
  icon: 'dice',
  openHint: '等人坐下后用 parlor_table_start 开始。',
  create: (ctx) => new DiceTable({
    host: ctx.host,
    now: ctx.now,
    ...(ctx.turnMs ? { turnMs: ctx.turnMs } : {}),
  }),
  actionType: 'table_action',
  toAction: (body) => ({ type: String(body.action ?? ''), die: body.die }),
  revisionMode: 'strict',
  tool: {
    name: 'parlor_table_action',
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
  openHint: '（3 席，空位由脚本陪练补）用 parlor_table_start 开始；叫地主时会叫你。',
  create: (ctx) => new DoudizhuTable({ host: ctx.host, now: ctx.now }),
  actionType: 'ddz_action',
  toAction: (body) => ({ move: body.move, call: body.call, cards: body.cards }),
  revisionMode: 'strict',
  tool: {
    name: 'parlor_ddz_action',
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
  openHint: `（固定 ${9} 席、至少一名真人与一只 Coo）坐满后用 parlor_table_start 开局；开局前会校验每只 Coo 的扩展版本 ≥ ${WEREWOLF_MIN_CLIENT}。`,
  create: (ctx) => new WerewolfTable({
    host: ctx.host,
    now: ctx.now,
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
  tool: {
    name: 'parlor_werewolf_action',
    description: '提交狼人杀本人桌面列出的当前窗口动作，每个动作槽只提交一次。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        windowId: { type: 'string', description: '最新桌面给出的窗口号。' },
        move: {
          type: 'string',
          enum: ['speak', 'pass_speech', 'vote', 'wolf_chat', 'wolf_kill', 'inspect', 'witch', 'shoot'],
        },
        text: { type: 'string', description: 'For speak (≤300 chars, one message) or wolf_chat (≤150 chars).' },
        target: { type: 'integer', description: 'Seat number (1-9). Omit for abstain/skip/none. Not allowed to target yourself (except witch save on night 1).' },
        choice: { type: 'string', enum: ['none', 'save', 'poison'], description: 'Only for witch: use nothing, save the kill victim, or poison.' },
      },
      required: ['windowId', 'move'],
    },
    toBody: (args) => {
      const move = String(args.move ?? '');
      const legal = ['speak', 'pass_speech', 'vote', 'wolf_chat', 'wolf_kill', 'inspect', 'witch', 'shoot'];
      if (!legal.includes(move)) throw new Error(`move 只能是 ${legal.join(' / ')}`);
      const windowId = String(args.windowId ?? '').trim();
      if (!windowId) throw new Error('要带上桌面给你的 windowId（先 parlor_table_view 看一眼）');
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
        case 'inspect': return body.target === undefined ? '今夜不查验，槽已交。' : `已查验 ${body.target} 号；结果与历史见下方本人私视图。`;
        case 'witch': return body.choice === 'save' ? '解药用掉了。' : body.choice === 'poison' ? '毒药用掉了。' : '今夜不用药，槽已交。';
        case 'shoot': return body.target === undefined ? '放弃开枪了。' : `开枪带走 ${body.target} 号了。`;
        default: return '动作交了。';
      }
    },
  },
  extraTools: [
    {
      name: 'parlor_werewolf_log',
      description: '看狼人杀历史发言、票型和死亡记录。终局后参与者可查看夜间复盘。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          table: { type: 'string', description: 'Table id; defaults to your current table.' },
          day: { type: 'integer', description: 'Filter by day number.' },
          seatNo: { type: 'integer', description: 'Filter by seat number.' },
          limit: { type: 'integer', description: 'Max speeches to return (1-200, default 100).' },
          review: { type: 'boolean', description: 'After the game ended: include the internal night record.' },
        },
      },
      toBody: (args) => ({ type: 'werewolf_log', ...(args.table ? { table: String(args.table) } : {}), ...(args.day !== undefined ? { day: Number(args.day) } : {}), ...(args.seatNo !== undefined ? { seatNo: Number(args.seatNo) } : {}), ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}), ...(args.review === true ? { review: true } : {}) }),
      done: () => '查完了。',
    },
  ],
};

/** 登记顺序 = World 工具与网页卡片的顺序。 */
export const GAME_LIST: readonly GameDefinition[] = [dice, ddz, werewolf];

const BY_ID = new Map(GAME_LIST.map((game) => [game.id, game]));
const BY_ACTION = new Map(GAME_LIST.map((game) => [game.actionType, game]));

export const gameById = (id: string): GameDefinition | null => BY_ID.get(id) ?? null;

/** 动作类型 → 游戏；`/v1/action` 用它把 body 交给对的那张桌子。 */
export const gameByActionType = (type: string): GameDefinition | null => BY_ACTION.get(type) ?? null;

export const gameIds = (): string[] => GAME_LIST.map((game) => game.id);

export const gameLabelOf = (id: string): string => BY_ID.get(id)?.label ?? id;

export type { TableLogQuery };
