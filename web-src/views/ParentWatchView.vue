<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { HallSeat, TableSummary } from '../api/types.ts';
import { componentFor } from '../lib/game-components.ts';
import { mountFor, type GameCtx, type GameInstance, type GameView } from '../lib/legacy-games.ts';

const props = defineProps<{ tableId: string }>();
const live = shallowRef<{ table: TableSummary; seats: HallSeat[]; online: string[]; now: number } | null>(null);
const table = computed(() => live.value?.table ?? null);
const status = ref('正在连接牌桌…');
const legacyRoot = ref<HTMLElement | null>(null);
const component = computed(() => table.value ? componentFor(table.value.game) : null);
const controller = new AbortController();
let timer: number | undefined;
let legacy: GameInstance | undefined;
let clockOffset = 0;

const me = { id: '', name: '观战' };
const ctx: GameCtx = {
  me,
  serverNow: () => Date.now() + clockOffset,
  act: async () => {},
  toast: () => {},
  showLobby: () => { location.href = '/parent'; },
  openDdz: () => {},
  openGame: () => {},
  rematch: () => {},
};

const gameView = computed<GameView | null>(() => {
  if (!live.value) return null;
  const names = new Map<string, string>();
  const classes = new Map<string, string>();
  for (const [index, seat] of (live.value.table.seats ?? []).entries()) {
    names.set(seat.id, seat.name);
    classes.set(seat.id, 's' + (index % 6));
  }
  const { table, seats, online } = live.value;
  return { table, priv: null, me, seats, names, classes, online, now: ctx.serverNow(), endEvent: null, recent: [] };
});

watch([gameView, legacyRoot], ([view, root]) => {
  if (!view || !root || component.value) {
    legacy?.destroy();
    legacy = undefined;
    return;
  }
  legacy ??= mountFor(view.table.game)?.(root, ctx);
  legacy?.update(view);
}, { flush: 'post' });

async function refresh(): Promise<void> {
  const query = new URLSearchParams({ table: props.tableId });
  try {
    const response = await fetch('/v1/parent/table?' + query, { signal: controller.signal });
    if (response.status === 401 || response.status === 404) {
      live.value = null;
      status.value = response.status === 401 ? '家长会话已失效，请返回家长页重新打开。' : '孩子已离开这张桌，或牌局已经结束。';
      return;
    }
    if (response.status === 409) {
      live.value = null;
      status.value = '这张牌桌已暂停，暂时无法观看。';
    } else {
      if (!response.ok) throw new Error('牌桌暂不可用');
      const data = await response.json() as NonNullable<typeof live.value>;
      clockOffset = data.now - Date.now();
      live.value = data;
      status.value = '';
    }
  } catch {
    status.value = '暂时无法更新牌桌，正在重试。';
  }
  if (!controller.signal.aborted) timer = window.setTimeout(() => void refresh(), 2500);
}

onMounted(() => void refresh());
onBeforeUnmount(() => {
  controller.abort();
  window.clearTimeout(timer);
  legacy?.destroy();
});
</script>

<template>
  <main class="parent-watch">
    <header class="parent-watch-header">
      <a class="btn ghost" href="/parent">返回家长页</a>
      <h1>{{ table?.label || '牌桌观战' }}</h1>
    </header>
    <p v-if="status" role="status">{{ status }}</p>
    <component :is="component" v-if="component && gameView" :view="gameView" :ctx="ctx" />
    <div v-else-if="gameView" ref="legacyRoot" class="game-root" />
  </main>
</template>

<style scoped>
.parent-watch { max-width: 1280px; margin: 0 auto; padding: 1rem; }
.parent-watch-header { display: flex; gap: 1rem; align-items: center; margin-bottom: 1rem; }
.parent-watch-header h1 { margin: 0; font-size: 1.25rem; }
</style>
