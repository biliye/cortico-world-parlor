/** 已经迁到 Vue 的桌面组件；没列进来的（骰子、旧大富翁）仍走 legacy-games.ts 的旧挂载。 */
import { defineAsyncComponent, type Component } from 'vue';
import DdzGame from '../components/games/DdzGame.vue';
import WerewolfGame from '../components/games/WerewolfGame.vue';

/**
 * 快局大富翁的棋盘与素材只在真正进桌时才请求：入口只留一个异步壳，
 * 冷进桌的额外传输量按这个 chunk 加美术算（预算 500 KB）。
 */
const Monopoly2dGame = defineAsyncComponent(() => import('../components/games/Monopoly2dGame.vue'));

const COMPONENTS: Record<string, Component> = {
  ddz: DdzGame,
  werewolf: WerewolfGame,
  monopoly2d: Monopoly2dGame,
  gomoku: defineAsyncComponent(() => import('../components/games/GomokuGame.vue')),
};

export function componentFor(game: string): Component | null {
  return COMPONENTS[game] || null;
}
