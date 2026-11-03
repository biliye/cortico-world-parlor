<script setup lang="ts">
/**
 * 根组件：没有席位显示加入页；有席位按「大厅 / 客厅 / 牌桌」三层渲染。
 * 默认由 vue-loader 载入；?legacy=1 回退旧的 play.js（排障用）。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppShell from './components/AppShell.vue';
import { startAnnouncementWatch } from './stores/announcements.ts';
import { boot, snapshot, syncRouteRoom, syncLocation, connect, connection, scheduleRefresh } from './stores/parlor.ts';
import { entryNotice, seat } from './stores/session.ts';
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
    if (ready.value) {
      readView();
      startAnnouncementWatch();
    }
  } catch (error) {
    failed.value = (error as Error).message || String(error);
    ready.value = false;
  } finally {
    entering = false;
  }
}

/** 页面开着时又粘贴了 #key= 或身份回跳链接：重新走一次入场。 */
function onHashChange(): void {
  if (location.hash.includes('identity') || location.hash.includes('key')) void enter();
}

/** 前进/后退改了 ?room= 或 ?view=：视图先跟上；客厅不一样就整页换过去。 */
function onPopState(): void {
  readView();
  void syncRouteRoom();
}

function restoreForeground(): void {
  if (document.visibilityState !== 'hidden' && seat.value) void syncLocation().then(() => {
    if (connection.value !== 'on') connect(); else scheduleRefresh(0);
  });
}
onMounted(() => {
  document.addEventListener('visibilitychange', restoreForeground);
  window.addEventListener('pageshow', restoreForeground);
  window.addEventListener('focus', restoreForeground);
  if (seat.value || location.hash.includes('identity') || location.hash.includes('key')) void enter();
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('popstate', onPopState);
});

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', restoreForeground);
  window.removeEventListener('pageshow', restoreForeground);
  window.removeEventListener('focus', restoreForeground);
  window.removeEventListener('hashchange', onHashChange);
  window.removeEventListener('popstate', onPopState);
});

// 加入页拿到席位后自己会被卸载，靠事件回来可能太晚；盯住席位本身更稳。
watch(seat, (next) => {
  if (next && !ready.value) void enter();
});
</script>

<template>
  <JoinView v-if="!seat" :initial-error="failed || entryNotice" @entered="enter" />
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
