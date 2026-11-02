/**
 * 还没迁到 Vue 的桌面渲染器桥：骰子、大富翁仍是 `mountX(root, ctx) -> {update(view), destroy()}`，
 * 与 Vue 无关，可以原样挂进牌桌壳；斗地主与狼人杀已经换成 web-src/components/games/ 下的组件。
 */
import type { ChatEvent, HallSeat, TableSummary } from '../api/types.ts';

// @ts-ignore 旧渲染器是 JS，没有类型声明；迁移完成后这段会删掉。
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
