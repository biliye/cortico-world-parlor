/**
 * 还没迁到 Vue 的牌桌渲染器桥：骰子与旧大富翁仍是 `mountX(root, ctx) -> {update(view), destroy()}`，
 * 与 Vue 无关，可以原样挂进牌桌壳。两款都已在大厅收起，但存量桌仍要能看能玩；
 * 斗地主、狼人杀、快局大富翁与五子棋已经是 web-src/components/games/ 下的 Vue 组件。
 */
import type { ChatEvent, HallSeat, TableSummary } from '../api/types.ts';

// @ts-ignore 旧渲染器是 JS，没有类型声明；这两款迁到 Vue 后这段会删掉。
import { mountDice } from '../../src/web/games/dice.js';
// @ts-ignore
import { mountMonopoly } from '../../src/web/games/monopoly.js';

export interface GameView {
  table: TableSummary;
  priv: Record<string, unknown> | null;
  me: { id: string; name: string };
  seats: HallSeat[];
  names: Map<string, string>;
  classes: Map<string, string>;
  online: string[];
  now: number;
  endEvent: unknown;
  recent: ChatEvent[];
}

export interface GameCtx {
  me: { id: string; name: string };
  act: (body: Record<string, unknown>) => Promise<unknown>;
  toast: (message: string, kind?: string) => void;
  serverNow: () => number;
  showLobby: () => void;
  openDdz: () => void;
  openGame: (game: string) => void;
  /** 再来一局：并进本厅同玩法的空桌，没有就开一张新的。 */
  rematch: () => void;
}

export interface GameInstance {
  update(view: GameView): void;
  destroy(): void;
}

export type GameFactory = (root: HTMLElement, ctx: GameCtx) => GameInstance;

const MOUNTS: Record<string, GameFactory> = {
  dice: mountDice,
  monopoly: mountMonopoly,
};

export function mountFor(game: string): GameFactory | null {
  return MOUNTS[game] || null;
}
