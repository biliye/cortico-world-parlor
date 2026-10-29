/**
 * 牌桌注册表：**加一张新桌子 = 写一个 GameDefinition，再在 GAME_LIST 里登记一行。**
 *
 * 一份定义同时管三件事，三处都从这里取，不再各写一份 if：
 * - 服务器：`TableHost` 用 `create()` 造引擎、用 `label` 写回执；`WorldServer` 用
 *   `actionType` / `toAction()` 把 `/v1/action` 的 body 变成引擎动作。
 * - World：工具声明（名字/描述/JSON Schema）与「参数 → body」的校验都在 `tool` 里，
 *   `world.ts` 只负责把它们登记出去。
 * - 网页：`icon` 与 `label` 给牌桌栏/大厅卡片用（网页那份清单在
 *   `src/web/games/registry.js`，加游戏时同样登记一行——两个运行时不能共享模块）。
 *
 * 旧单厅服务器（`kernel.ts`）仍只认 dice/ddz：它是自托管与回退用的老路，不跟着扩展。
 */
import type { TableEngine } from '../table-engine.ts';
import { DiceTable } from '../table.ts';
import { RANKS } from './doudizhu.ts';
import { DoudizhuTable } from './doudizhu-table.ts';

export interface GameCreateContext {
  host: { id: string; name: string };
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
  tool: {
    name: 'parlor_table_action',
    description: 'On your turn at the dice table: reroll one hidden die or stand. Highest total wins; the table reveals all dice at the end.',
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
  tool: {
    name: 'parlor_ddz_action',
    description: 'On your turn at 斗地主: bid for landlord (move "bid" with call true/false), play cards (move "play" with cards), or pass. Card names are 3,4,5,6,7,8,9,10,J,Q,K,A,2,SJ (small joker),BJ (big joker); there are no suits. The server judges every move and says why an illegal one was refused.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        move: { type: 'string', enum: ['bid', 'play', 'pass'], description: 'bid = call or decline landlord; play = put down cards; pass = skip.' },
        call: { type: 'boolean', description: 'When move is bid: true = become landlord, false = decline.' },
        cards: {
          type: 'array',
          items: { type: 'string', enum: [...RANKS] },
          description: 'When move is play: the exact cards from your hand, e.g. ["3","3"] or ["3","4","5","6","7"].',
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

/** 登记顺序 = World 工具与网页卡片的顺序。 */
export const GAME_LIST: readonly GameDefinition[] = [dice, ddz];

const BY_ID = new Map(GAME_LIST.map((game) => [game.id, game]));
const BY_ACTION = new Map(GAME_LIST.map((game) => [game.actionType, game]));

export const gameById = (id: string): GameDefinition | null => BY_ID.get(id) ?? null;

/** 动作类型 → 游戏；`/v1/action` 用它把 body 交给对的那张桌子。 */
export const gameByActionType = (type: string): GameDefinition | null => BY_ACTION.get(type) ?? null;

export const gameIds = (): string[] => GAME_LIST.map((game) => game.id);

export const gameLabelOf = (id: string): string => BY_ID.get(id)?.label ?? id;
