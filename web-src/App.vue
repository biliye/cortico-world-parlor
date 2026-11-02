<script setup lang="ts">
/**
 * 迁移期的根组件：没有席位显示加入页；有席位按「大厅 / 客厅 / 牌桌」三层渲染。
 * 带 ?vue=1 时才由 vue-loader 载入；正常访问仍走旧的 play.js。
 */
import { onMounted, ref, watch } from 'vue';
import AppShell from './components/AppShell.vue';
import { boot, snapshot } from './stores/parlor.ts';
import { seat } from './stores/session.ts';
import { readView, view } from './stores/view.ts';
import JoinView from './views/JoinView.vue';
import LobbyView from './views/LobbyView.vue';
import RoomView from './views/RoomView.vue';
import TableView from './views/TableView.vue';

const ready = ref(false);
const failed = ref('');
let entering = false;

async function enter(): Promise<void> {
  if (entering) return;
  entering = true;
  failed.value = '';
  try {
    ready.value = await boot();
    if (ready.value) readView();
  } catch (error) {
    failed.value = (error as Error).message || String(error);
    ready.value = false;
  } finally {
    entering = false;
  }
}

onMounted(() => {
  if (seat.value || location.hash.includes('identity')) void enter();
  window.addEventListener('popstate', () => readView());
});

// 加入页拿到席位后自己会被卸载，靠事件回来可能太晚；盯住席位本身更稳。
watch(seat, (next) => {
  if (next && !ready.value) void enter();
});
</script>

<template>
  <JoinView v-if="!seat" @entered="enter" />
  <AppShell v-else-if="ready">
    <LobbyView v-if="snapshot && snapshot.id === 'hall'" />
    <TableView v-else-if="view === 'table'" />
    <RoomView v-else />
  </AppShell>
  <div v-else class="join">
    <section class="panel">
      <h1>连不上客厅</h1>
      <p class="sub">{{ failed || '正在读取客厅状态…' }}</p>
      <button class="btn primary" type="button" @click="enter">重试</button>
    </section>
  </div>
</template>
