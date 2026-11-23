<script setup lang="ts">
/**
 * 牌桌渲染器的宿主：全部玩法都已组件化为 Vue 桌面组件，
 * 换桌（桌号变化）按 mountKey 重建实例。
 */
import { computed } from 'vue';
import type { ChatEvent, HallSeat } from '../api/types.ts';
import { gameOf } from '../lib/games.ts';
import { componentFor } from '../lib/game-components.ts';
import type { GameCtx, GameView } from '../lib/game-types.ts';
import {
  activePrivate, activeTable, act, log, openRoomTable, rematchRoomTable, serverNow, snapshot, tableIdOf, tableList,
} from '../stores/parlor.ts';
import { showToast } from '../stores/ui.ts';
import { backToRoom } from '../stores/view.ts';

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
</script>

<template>
  <component
    :is="componentGame"
    v-if="componentGame && gameView"
    :key="mountKey"
    :view="gameView"
    :ctx="gameCtx"
  />
</template>
