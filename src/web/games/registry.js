/**
 * 网页这侧的游戏清单：**加一张桌子在这里登记一行**（服务器那份在
 * `src/room/games/registry.ts`，两个运行时不能共享模块，所以各登记一次）。
 *
 * - `label` / `icon` 与服务器保持一致；
 * - `mount` 是这个游戏的桌面渲染器（`games/<id>.js`）；
 * - `enabled` 决定它在大厅与牌桌栏里看不看得见（服务器仍能开它，旧桌也仍渲染）；
 * - `endScreen` 表示结束后还要留在桌面渲染器里（斗地主要展示三家剩牌）；
 * - `minPlayers` / `botFill` 是开局人数与「空位脚本补」；
 * - `blurb` / `foot` / `guide` 是大厅卡片的文案与玩法说明。
 */
import { mountDice } from './dice.js';
import { mountDdz } from './ddz.js';
import { mountMonopoly } from './monopoly.js';

export const GAMES = {
  dice: {
    label: '骰子',
    icon: 'dice',
    enabled: false,
    endScreen: false,
    minPlayers: 2,
    botFill: false,
    mount: mountDice,
    blurb: '两到四人，暗骰、可重掷两次，合计最高者赢。',
    foot: '暗骰 · 重掷 · 比点数',
  },
  ddz: {
    label: '斗地主',
    icon: 'cards',
    enabled: true,
    endScreen: true,
    minPlayers: 1,
    botFill: true,
    mount: mountDdz,
    blurb: '三人一桌，空位由脚本陪练补；一个人也能开。',
    foot: '叫地主 · 出牌 · 脚本补位',
    guide: [
      '三人一桌；空位由脚本陪练补，一个人也能开。',
      '叫地主 30 秒、出牌 60 秒；超时由服务器代打。',
      '点牌选中，出牌 / 不要 / 提示；提示来自服务器，出的牌一定合法。',
      '地主拿 3 张底牌；炸弹、王炸翻倍；春天 / 反春再翻。',
    ],
  },
  monopoly: {
    label: '大富翁',
    icon: 'board',
    enabled: false,
    endScreen: false,
    minPlayers: 2,
    botFill: true,
    mount: mountMonopoly,
    blurb: '四到六人的长局，买地、升级、道具；这一版先收起来了。',
    foot: '买地 · 升级 · 道具',
  },
};

/** 大厅与牌桌栏里露出来的游戏（顺序跟这里一致）。 */
export const ENABLED_GAMES = Object.keys(GAMES).filter((id) => GAMES[id].enabled);

export const gameOf = (id) => GAMES[id] || null;

export const gameLabel = (id) => (GAMES[id] && GAMES[id].label) || id;

export const gameIcon = (id) => (GAMES[id] && GAMES[id].icon) || 'board';

/** 大厅的主推游戏：第一个启用的；都没有就退回斗地主。 */
export const heroGame = () => ENABLED_GAMES[0] || 'ddz';
