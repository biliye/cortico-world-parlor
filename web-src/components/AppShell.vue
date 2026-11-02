<script setup lang="ts">
/** 页面骨架：顶栏 + 左栏 + 中间内容 + 右栏聊天。内容由 App 通过默认插槽放进来。 */
import { computed, onMounted, watch } from 'vue';
import ChatPanel from './ChatPanel.vue';
import DmWindow from './DmWindow.vue';
import Icon from './Icon.vue';
import { initialOf } from '../lib/text.ts';
import { club } from '../stores/club.ts';
import { chatExpanded, closeSheet, sheetOpen, toggleChat } from '../stores/chat.ts';
import { loadThreads, toggle as toggleDm, unread as dmUnread } from '../stores/dm.ts';
import { hallSection, selectHallSection } from '../stores/hall.ts';
import { connection, snapshot } from '../stores/parlor.ts';
import { seat } from '../stores/session.ts';
import { toastKind, toastText } from '../stores/ui.ts';

const name = computed(() => seat.value?.name || '');
const roomLabel = computed(() => (snapshot.value?.id === 'hall' ? '大厅' : snapshot.value?.name || '客厅'));
const inHall = computed(() => snapshot.value?.id === 'hall');

const sections = [
  { id: 'all', label: '发现客厅', icon: 'lamp' },
  { id: 'mine', label: '我的客厅', icon: 'users' },
  { id: 'favorites', label: '收藏的地方', icon: 'spark' },
] as const;

watch(sheetOpen, (open) => { document.body.classList.toggle('sheet-open', open); }, { immediate: true });

onMounted(() => { void loadThreads(); });
</script>

<template>
  <header class="topbar">
    <p class="brand">鲸语 <small>PARLOR CLUB</small></p>
    <span class="conn" :class="connection">
      <span class="dot" />
      <span class="conn-text">{{ connection === 'on' ? '已连接' : connection === 'off' ? '重连中…' : '连接中…' }}</span>
    </span>
    <span class="muted top-me-text">{{ name }} · {{ roomLabel }}</span>
    <button class="ghost-btn dm-btn dm-toggle" type="button" @click="toggleDm">
      私聊<span v-if="dmUnread" class="badge">{{ dmUnread }}</span>
    </button>
    <button class="btn ghost small" type="button" :aria-expanded="chatExpanded()" @click="toggleChat()">
      {{ chatExpanded() ? '收起聊天' : '打开聊天' }}
    </button>
  </header>

  <DmWindow />

  <div class="layout" :class="{ 'chat-collapsed': !club.chatOpen }">
    <aside class="left-rail">
      <nav v-if="inHall" class="club-nav" aria-label="会馆导航">
        <button
          v-for="item in sections"
          :key="item.id"
          class="btn ghost"
          type="button"
          :class="{ 'is-active': hallSection === item.id }"
          :aria-current="hallSection === item.id ? 'page' : undefined"
          @click="selectHallSection(item.id)"
        >
          <Icon :name="item.icon" />{{ item.label }}
        </button>
      </nav>
      <section class="panel seat-card">
        <div class="seat-card-top">
          <span class="avatar avatar-sm">{{ initialOf(name) }}</span>
          <div class="seat-card-copy">
            <span class="eyebrow">我的席位</span>
            <h2 class="seat-card-name">{{ name }}</h2>
            <p class="seat-card-sub">{{ roomLabel }}</p>
          </div>
        </div>
      </section>
      <a class="ghost-btn" href="/parent" target="_blank" rel="noopener">家长页</a>
    </aside>

    <section class="center" aria-label="大厅、客厅与牌桌">
      <slot />
    </section>

    <ChatPanel />
  </div>

  <div class="sheet-backdrop" :class="{ 'is-show': sheetOpen }" @click="closeSheet" />

  <div v-if="toastText" class="toast show" :class="{ bad: toastKind === 'bad' }" role="status">{{ toastText }}</div>
</template>
