/** 牌桌 Vue 组件共用的视图与操作上下文契约。 */
import type { ChatEvent, HallSeat, TableSummary } from '../api/types.ts';

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
