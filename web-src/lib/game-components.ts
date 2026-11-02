/** 已经迁到 Vue 的桌面组件；没列进来的（骰子、大富翁）仍走 legacy-games.ts 的旧挂载。 */
import type { Component } from 'vue';
import DdzGame from '../components/games/DdzGame.vue';
import WerewolfGame from '../components/games/WerewolfGame.vue';

const COMPONENTS: Record<string, Component> = {
  ddz: DdzGame,
  werewolf: WerewolfGame,
};

export function componentFor(game: string): Component | null {
  return COMPONENTS[game] || null;
}
