<script setup lang="ts">
/**
 * 根组件：没有席位显示加入页；有席位按「大厅 / 客厅 / 牌桌」三层渲染。
 * 由 vue-loader 载入；网页只剩这一套客户端（旧 play.js 已在 0.40.0 下线）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppShell from './components/AppShell.vue';
import RoomTransition from './components/RoomTransition.vue';
import { startAnnouncementWatch } from './stores/announcements.ts';
import { boot, snapshot, syncRouteRoom, syncLocation, connect, connection, scheduleRefresh, roomTransition, finishRoomTransition, onSeatStorage } from './stores/parlor.ts';
import { IdentityExpiredError } from './api/client.ts';
import { entryNotice, seat } from './stores/session.ts';
import { readView, view, wantHall } from './stores/view.ts';
import JoinView from './views/JoinView.vue';
import LobbyView from './views/LobbyView.vue';
import RoomView from './views/RoomView.vue';
import TableView from './views/TableView.vue';
import StoryView from './views/StoryView.vue';

const ready = ref(false);
const failed = ref('');
/** 票据本身失效时不给「再试一次」——那只会重复同一句，得回上一页重新授权。 */
const retryable = ref(false);
const storyJoining = () => new URLSearchParams(location.search).get('join') === '1';
let entering = false;
const destination = computed(() => roomTransition.value?.name ||
  ((new URLSearchParams(location.search).get('room') || seat.value?.room) === 'hall' ? '大厅' : '客厅'));

async function retry(): Promise<void> {
  if (!roomTransition.value) return enter();
  if (await finishRoomTransition()) {
    ready.value = true;
    readView();
    startAnnouncementWatch();
  }
}

async function enter(): Promise<void> {
  if (entering) return;
  entering = true;
  failed.value = '';
  retryable.value = false;
  try {
    ready.value = await boot();
    if (ready.value) {
      readView();
      startAnnouncementWatch();
    }
  } catch (error) {
    failed.value = (error as Error).message || String(error);
    retryable.value = !(error instanceof IdentityExpiredError);
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
  readView();
  window.addEventListener('storage', onSeatStorage);
  document.addEventListener('visibilitychange', restoreForeground);
  window.addEventListener('pageshow', restoreForeground);
  window.addEventListener('focus', restoreForeground);
  if (seat.value || location.hash.includes('identity') || location.hash.includes('key')) void enter();
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('popstate', onPopState);
});

onBeforeUnmount(() => {
  window.removeEventListener('storage', onSeatStorage);
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
  <StoryView v-if="!seat && view === 'story' && !storyJoining()" />
  <JoinView v-else-if="!seat" :initial-error="failed || entryNotice" :can-retry="!!failed && retryable" @entered="enter" @retry="enter" />
  <AppShell v-else-if="ready && !roomTransition">
    <StoryView v-if="view === 'story'" />
    <LobbyView v-else-if="snapshot && (snapshot.id === 'hall' || wantHall())" />
    <TableView v-else-if="view === 'table'" />
    <RoomView v-else />
  </AppShell>
  <RoomTransition
    v-else
    :destination="destination"
    :from="roomTransition?.from || ''"
    :returning="roomTransition?.to === 'hall'"
    :error="roomTransition ? roomTransition.error : failed"
    @retry="retry"
  />
</template>
