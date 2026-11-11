<script setup lang="ts">
/**
 * 牌桌渲染器的宿主：斗地主、狼人杀已经是 Vue 组件；骰子、大富翁仍把旧版
 * `mountX(root, ctx)` 原样挂进来，状态到了就 update。换桌（桌号变了）会销毁重建，
 * 和旧版 play.js 的挂载 key 一样。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ChatEvent, HallSeat } from '../api/types.ts';
import { gameOf } from '../lib/games.ts';
import { componentFor } from '../lib/game-components.ts';
import { mountFor, type GameCtx, type GameInstance, type GameView } from '../lib/legacy-games.ts';
import {
  activePrivate, activeTable, act, log, openRoomTable, rematchRoomTable, serverNow, snapshot, tableIdOf, tableList,
} from '../stores/parlor.ts';
import { showToast } from '../stores/ui.ts';
import { backToRoom } from '../stores/view.ts';

const host = ref<HTMLElement | null>(null);
const table = activeTable;
const def = computed(() => (table.value ? gameOf(table.value.game) : null));

const mountable = computed(() => {
  const current = table.value;
  if (!current || !def.value) return false;
  return current.status === 'bidding' || current.status === 'playing'
    || (current.status === 'ended' && def.value.endScreen);
});

const componentGame = computed(() => {
  const current = table.value;
  if (!current || !mountable.value) return null;
  return componentFor(current.game);
});

const mountKey = computed(() => {
  const current = table.value;
  return current ? current.game + ':' + tableIdOf(current) : '';
});

let instance: GameInstance | null = null;
let key = '';

function matchesTable(event: ChatEvent, tableId: string): boolean {
  if (!tableId) return true;
  const id = (event.data as Record<string, unknown> | undefined)?.tableId;
  return typeof id !== 'string' || !id || id === tableId;
}

function buildView(): GameView {
  const snap = snapshot.value;
  const current = table.value as GameView['table'];
  const tableId = tableIdOf(current);
  const names = new Map<string, string>();
  const classes = new Map<string, string>();
  (snap?.seats || []).forEach((person, index) => {
    names.set(person.id, person.name);
    classes.set(person.id, 's' + (index % 6));
  });
  for (const entry of tableList()) {
    (entry.seats || []).forEach((person, index) => {
      if (!names.has(person.id)) names.set(person.id, person.name);
      if (!classes.has(person.id)) classes.set(person.id, 's' + (index % 6));
    });
  }
  const endEvent = [...log.value].reverse().find((event) => event.type === 'parlor.table.end'
    && (event.data as Record<string, unknown> | undefined)?.game === current.game
    && Array.isArray((event.data as Record<string, unknown> | undefined)?.revealed)
    && matchesTable(event, tableId)) || null;
  const recent = log.value.filter((event) => matchesTable(event, tableId)
    && (String(event.type || '').startsWith('parlor.table.') || String(event.type || '').startsWith('parlor.monopoly.')))
    .slice(-4);
  return {
    table: current,
    priv: activePrivate(),
    me: (snap?.seat || { id: '', name: '' }) as { id: string; name: string },
    seats: (snap?.seats || []) as HallSeat[],
    names,
    classes,
    online: snap?.online || [],
    now: serverNow(),
    endEvent,
    recent,
  };
}

const gameView = computed<GameView | null>(() => (table.value && mountable.value ? buildView() : null));

const gameCtx = {
  get me() { return (snapshot.value?.seat || { id: '', name: '' }) as { id: string; name: string }; },
  act: (body: Record<string, unknown>) => act(body),
  toast: (message: string, kind?: string) => showToast(message, kind),
  serverNow,
  showLobby: () => backToRoom(),
  openDdz: () => { void openRoomTable('ddz'); },
  openGame: (game: string) => { void openRoomTable(game); },
  rematch: () => {
    const current = table.value;
    if (!current) return;
    // 狼人杀按当前这局的人数重开：6／9／12 之外的不传，让服务端用默认席数。
    const seats = Array.isArray(current.seats) ? current.seats.length : 0;
    const seatCount = current.game === 'werewolf' && (seats === 6 || seats === 9 || seats === 12) ? seats : undefined;
    void rematchRoomTable(current.game, seatCount);
  },
} as GameCtx;

function context(): GameCtx {
  return gameCtx;
}

function destroy(): void {
  if (instance) {
    try {
      instance.destroy();
    } catch {
      /* 渲染器自己清理失败不该拖住换桌 */
    }
  }
  instance = null;
  key = '';
}

function sync(): void {
  const current = table.value;
  if (!current || !mountable.value || !host.value || componentGame.value) {
    destroy();
    return;
  }
  const nextKey = current.game + ':' + tableIdOf(current);
  if (!instance || key !== nextKey) {
    destroy();
    const factory = mountFor(current.game);
    if (!factory) return;
    key = nextKey;
    instance = factory(host.value, context());
  }
  instance?.update(buildView());
}

onMounted(sync);
onBeforeUnmount(destroy);
watch([table, snapshot, () => log.value.length, componentGame], sync);
</script>

<template>
  <component
    :is="componentGame"
    v-if="componentGame && gameView"
    :key="mountKey"
    :view="gameView"
    :ctx="gameCtx"
  />
  <div v-else ref="host" class="game-root" />
</template>
