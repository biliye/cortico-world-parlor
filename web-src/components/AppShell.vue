<script setup lang="ts">
/**
 * 应用外壳：左侧窄门牌栏 + 顶部细条 + 内容 + 浮起来的「有话慢慢聊」。
 * 三层结构不变：大厅 → 客厅 → 牌桌；门牌栏负责在会馆里走动，顶条负责工具。
 */
import { computed, onMounted, ref, watch } from 'vue';
import ChatPanel from './ChatPanel.vue';
import DmWindow from './DmWindow.vue';
import Icon from './Icon.vue';
import RoomSwitcher from './RoomSwitcher.vue';
import ThemePicker from './ThemePicker.vue';
import AccountPanel from './AccountPanel.vue';
import { initialOf } from '../lib/text.ts';
import { chatExpanded, chooseTab, closeSheet, sheetOpen, toggleChat } from '../stores/chat.ts';
import { loadThreads, toggle as toggleDm, unread as dmUnread } from '../stores/dm.ts';
import { hallSection, selectHallSection } from '../stores/hall.ts';
import { loadMail, setUnread, unread as mailUnread } from '../stores/mail.ts';
import { connection, goRoom, hallSeats, snapshot } from '../stores/parlor.ts';
import { seat } from '../stores/session.ts';
import { toastKind, toastText } from '../stores/ui.ts';

const name = computed(() => seat.value?.name || '');
const roomLabel = computed(() => (snapshot.value?.id === 'hall' ? '大厅' : snapshot.value?.name || '客厅'));
const inHall = computed(() => snapshot.value?.id === 'hall');
const switcherOpen = ref(false);
const accountOpen = ref(false);

const sections = [
  { id: 'all', label: '发现', long: '发现客厅', icon: 'lamp' },
  { id: 'mine', label: '我的', long: '我的客厅', icon: 'users' },
  { id: 'favorites', label: '收藏', long: '收藏的地方', icon: 'spark' },
] as const;

/** 顶条上的在线数：大厅看名单，客厅看快照里的在线集合。 */
const presence = computed(() => {
  if (inHall.value) return hallSeats.value.length;
  const online = new Set(snapshot.value?.online || []);
  return (snapshot.value?.seats || []).filter((person) => online.has(person.id)).length;
});
const connected = computed(() => connection.value === 'on');
const connectionText = computed(() => (connection.value === 'off' ? '重连中…' : '连接中…'));

watch(sheetOpen, (open) => { document.body.classList.toggle('sheet-open', open); }, { immediate: true });

// 快照里的未读是服务器算的总数；信箱列表本身按需刷新，角标始终跟快照走。
watch(() => snapshot.value?.mailUnread, (count) => {
  if (typeof count === 'number') setUnread(count);
}, { immediate: true });

function openMail(): void {
  chooseTab('mail');
  toggleChat(true);
  void loadMail(true);
}

/** 门牌栏的三项只在大厅里换目录范围；不在大厅就先回大厅。 */
async function goSection(id: 'all' | 'mine' | 'favorites'): Promise<void> {
  selectHallSection(id);
  if (!inHall.value) await goRoom('hall');
}

onMounted(() => {
  void loadThreads();
});
</script>

<template>
  <div class="shell" :class="{ 'chat-open': chatExpanded(), 'in-hall': inHall }">
    <aside class="rail" aria-label="会馆门牌">
      <a class="rail-mark" href="/play" aria-label="鲸语会馆">
        <Icon name="whale" />
      </a>
      <nav class="rail-nav" aria-label="会馆导航">
        <button
          v-for="item in sections"
          :key="item.id"
          class="rail-btn"
          type="button"
          :class="{ 'is-on': inHall && hallSection === item.id }"
          :title="item.long"
          @click="goSection(item.id)"
        >
          <Icon :name="item.icon" />
          <span>{{ item.label }}</span>
        </button>
        <a class="rail-btn rail-support" href="/support" target="_blank" rel="noopener" title="反馈与公告" aria-label="反馈与公告">
          <Icon name="chat" />
          <span>反馈</span>
        </a>
      </nav>
      <span class="rail-sep" />
      <span class="rail-spacer" />
      <a class="rail-parent" href="/parent" target="_blank" rel="noopener" title="家长页">
        <Icon name="lock" />
        <span>家长</span>
      </a>
      <span class="rail-me" :title="name + ' · ' + roomLabel">{{ initialOf(name) }}</span>
    </aside>

    <main class="stage" aria-label="大厅、客厅与牌桌">
      <header class="topbar">
        <a class="brand" href="/play"><b>鲸语</b><span>PARLOR CLUB</span></a>
        <button class="room-pill" type="button" title="换客厅" @click="switcherOpen = true">
          <i class="live-dot" :class="{ off: !connected }" />
          <span class="room-pill-name">{{ roomLabel }}</span>
          <span class="room-pill-arrow">▾</span>
        </button>
        <span class="presence">
          <i class="pulse" :class="{ off: !connected }" />
          <b>{{ presence }}</b> 位朋友在这里
        </span>
        <span v-if="!connected" class="conn-chip">{{ connectionText }}</span>
        <div class="top-right">
          <button class="tool" type="button" @click="accountOpen = true" title="我的筹码、战绩与历史对局">
            <Icon name="users" /><span class="tool-label">账户</span>
          </button>
          <button class="tool" type="button" @click="openMail">
            <Icon name="mail" /><span class="tool-label">信箱</span>
            <span v-if="mailUnread" class="tool-badge">{{ mailUnread }}</span>
          </button>
          <button class="tool" type="button" @click="toggleDm">
            <Icon name="chat" /><span class="tool-label">私聊</span>
            <span v-if="dmUnread" class="tool-badge">{{ dmUnread }}</span>
          </button>
          <ThemePicker />
          <button class="tool dock" type="button" :aria-expanded="chatExpanded()" @click="toggleChat()">
            <Icon name="chat" /><span class="tool-label">{{ chatExpanded() ? '收起聊天' : '有话慢慢聊' }}</span>
          </button>
        </div>
      </header>

      <div class="stage-body">
        <slot />
      </div>
    </main>

    <ChatPanel />
    <DmWindow />
    <RoomSwitcher v-model:open="switcherOpen" />
    <AccountPanel v-model:open="accountOpen" />
    <div class="sheet-backdrop" :class="{ 'is-show': sheetOpen }" @click="closeSheet" />
    <button v-if="!chatExpanded()" class="chat-fab" type="button" @click="toggleChat(true)">
      <Icon name="chat" />有话慢慢聊
    </button>
    <div v-if="toastText" class="toast show" :class="{ bad: toastKind === 'bad' }" role="status">{{ toastText }}</div>
  </div>
</template>
