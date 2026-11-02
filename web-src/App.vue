<script setup lang="ts">
/**
 * 迁移期的根组件：有席位就进大厅，没有就显示加入页。
 * 旧的 play.js 仍在同一页面运行；带 ?vue=1 时它照常起步，这一支只是叠在上面的新实现。
 */
import { onMounted, ref, watch } from 'vue';
import AppShell from './components/AppShell.vue';
import { boot, snapshot } from './stores/parlor.ts';
import { seat } from './stores/session.ts';
import JoinView from './views/JoinView.vue';
import LobbyView from './views/LobbyView.vue';
import RoomPlaceholder from './views/RoomPlaceholder.vue';

const ready = ref(false);
const failed = ref('');
let entering = false;

async function enter(): Promise<void> {
  if (entering) return;
  entering = true;
  failed.value = '';
  try {
    ready.value = await boot();
  } catch (error) {
    failed.value = (error as Error).message || String(error);
    ready.value = false;
  } finally {
    entering = false;
  }
}

onMounted(() => {
  if (seat.value || location.hash.includes('identity')) void enter();
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
    <RoomPlaceholder v-else />
  </AppShell>
  <div v-else class="join">
    <section class="panel">
      <h1>连不上客厅</h1>
      <p class="sub">{{ failed || '正在读取客厅状态…' }}</p>
      <button class="btn primary" type="button" @click="enter">重试</button>
    </section>
  </div>
</template>
