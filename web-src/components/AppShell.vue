<script setup lang="ts">
/**
 * 应用外壳：门牌栏、顶部工具、内容与聊天抽屉。
 * 三层结构不变：大厅 → 客厅 → 牌桌；门牌栏负责在会馆里走动，顶条负责工具。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ChatPanel from './ChatPanel.vue';
import DmWindow from './DmWindow.vue';
import Icon from './Icon.vue';
import RoomSwitcher from './RoomSwitcher.vue';
import ThemePicker from './ThemePicker.vue';
import { MAHJONG_GAMES } from '../../src/room/games/mahjong-rules.ts';
import RatingsPanel from './RatingsPanel.vue';
import GiftPanel from './GiftPanel.vue';
import { initialOf } from '../lib/text.ts';
import { chatExpanded, chooseTab, closeSheet, setFloatingChatTable, sheetOpen, TABLE_SOCIAL_GAMES, toggleChat } from '../stores/chat.ts';
import { loadThreads, toggle as toggleDm, unread as dmUnread } from '../stores/dm.ts';
import { hallSection, selectHallSection } from '../stores/hall.ts';
import { loadMail, setUnread, unread as mailUnread } from '../stores/mail.ts';
import { activeTable, connection, goRoom, hallSeats, leaveRoom, snapshot, tableChatAvailable, tableIdOf } from '../stores/parlor.ts';
import { seat } from '../stores/session.ts';
import { gateway } from '../stores/server.ts';
import { toastKind, toastText } from '../stores/ui.ts';
import { backToRoom, enterDivination, enterStory, view, watchTableId } from '../stores/view.ts';

defineProps<{ showStory: boolean; showDivination: boolean }>();

const name = computed(() => seat.value?.name || '');
const roomLabel = computed(() => (snapshot.value?.id === 'hall' ? '大厅' : snapshot.value?.name || '客厅'));
const inHall = computed(() => snapshot.value?.id === 'hall');
const specialView = computed(() => view.value === 'story' || view.value === 'divination');
const onWerewolf = computed(() => view.value === 'table' && !inHall.value && activeTable.value?.game === 'werewolf');
const onMahjong = computed(() => view.value === 'table'
  && MAHJONG_GAMES.some(game => game === activeTable.value?.game));
const onAeroplane = computed(() => view.value === 'table' && activeTable.value?.game === 'aeroplane');
const onFourColour = computed(() => view.value === 'table' && activeTable.value?.game === 'four-colour');
const switcherOpen = ref(false);
const ratingsOpen = ref(false);
const giftOpen = ref(false);
const leavingRoom = ref(false);
const toolsOpen = ref(false);
const toolsRegion = ref<HTMLElement | null>(null);
const toolsToggle = ref<HTMLButtonElement | null>(null);
const stageBody = ref<HTMLElement | null>(null);

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

watch([sheetOpen, specialView], ([open, special]) => {
  document.body.classList.toggle('sheet-open', open && !special);
}, { immediate: true });

const floatingChatTable = computed(() => onWerewolf.value || onMahjong.value || onAeroplane.value || onFourColour.value
  ? JSON.stringify([snapshot.value?.id, tableIdOf(activeTable.value)])
  : '');
watch(floatingChatTable, setFloatingChatTable, { immediate: true });
onBeforeUnmount(() => setFloatingChatTable(''));
watch([view, hallSection, watchTableId, () => snapshot.value?.id], () => {
  toolsOpen.value = false;
  if (stageBody.value && window.matchMedia('(max-width: 1100px)').matches) stageBody.value.scrollTop = 0;
}, { flush: 'post' });

// 快照里的未读是服务器算的总数；信箱列表本身按需刷新，角标始终跟快照走。
watch(() => snapshot.value?.mailUnread, (count) => {
  if (typeof count === 'number') setUnread(count);
}, { immediate: true });

function openMail(): void {
  chooseTab('mail');
  toggleChat(true);
  void loadMail(true);
}

function toggleMainChat(): void {
  if (chatExpanded()) {
    toggleChat(false);
    return;
  }
  const table = activeTable.value;
  if (view.value === 'table' && table?.status !== 'open' && tableChatAvailable.value
    && TABLE_SOCIAL_GAMES.includes(table?.game ?? '')) chooseTab('table');
  toggleChat(true);
}

/** 门牌栏的三项只在大厅里换目录范围；不在大厅就先回大厅。 */
async function goSection(id: 'all' | 'mine' | 'favorites'): Promise<void> {
  if (specialView.value) backToRoom();
  selectHallSection(id);
  if (!inHall.value) await goRoom('hall');
}

async function confirmLeaveRoom(): Promise<void> {
  if (leavingRoom.value || !window.confirm(`要离开「${roomLabel.value}」吗？`)) return;
  leavingRoom.value = true;
  try { await leaveRoom(); }
  finally { leavingRoom.value = false; }
}

function closeTools(restoreFocus = false): void {
  if (!toolsOpen.value) return;
  toolsOpen.value = false;
  if (restoreFocus) toolsToggle.value?.focus();
}

function dismissTools(event: Event): void {
  const target = event.target;
  if (!(target instanceof Node) || !toolsRegion.value?.contains(target)) closeTools();
}

onMounted(() => {
  if (!seat.value?.guest) void loadThreads();
  document.addEventListener('pointerdown', dismissTools);
  document.addEventListener('focusin', dismissTools);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', dismissTools);
  document.removeEventListener('focusin', dismissTools);
});
</script>

<template>
  <div class="shell" :class="{ 'chat-open': !specialView && chatExpanded(), 'in-hall': inHall }">
    <aside class="rail" aria-label="会馆门牌">
      <a class="rail-mark" href="/play" aria-label="鲸语会馆">
        <Icon name="whale" />
      </a>
      <nav class="rail-nav" aria-label="会馆导航">
        <button
          v-for="item in seat?.guest ? [] : sections"
          :key="item.id"
          class="rail-btn"
          type="button"
          :class="{ 'is-on': !specialView && inHall && hallSection === item.id }"
          :aria-current="!specialView && inHall && hallSection === item.id ? 'page' : undefined"
          :title="item.long"
          @click="goSection(item.id)"
        >
          <Icon :name="item.icon" />
          <span>{{ item.label }}</span>
        </button>
        <button v-if="showStory && !seat?.guest" class="rail-btn" type="button" :class="{ 'is-on': view === 'story' }" @click="enterStory">
          <Icon name="lamp" /><span>说书人</span>
        </button>
        <button v-if="showDivination && !seat?.guest" class="rail-btn" type="button" :class="{ 'is-on': view === 'divination' }" @click="enterDivination">
          <Icon name="spark" /><span>问卦阁</span>
        </button>
        <a class="rail-btn rail-support" href="/support" target="_blank" rel="noopener" title="反馈与公告" aria-label="反馈与公告">
          <Icon name="chat" />
          <span>反馈</span>
        </a>
      </nav>
      <span class="rail-sep" />
      <span class="rail-spacer" />
      <a v-if="!seat?.guest" class="rail-parent" href="/parent" target="_blank" rel="noopener" title="家长页">
        <Icon name="lock" />
        <span>家长</span>
      </a>
      <span class="rail-me rail-me-static" :class="{ 'is-guest': seat?.guest }" :title="name + ' · ' + roomLabel">{{ initialOf(name) }}</span>
      <a v-if="!seat?.guest" class="rail-me-link" href="/parent" target="_blank" rel="noopener" :title="name + ' · 家长页'">
        <span class="rail-me" aria-hidden="true">{{ initialOf(name) }}</span>
        <span>家长页</span>
      </a>
    </aside>

    <main id="main" class="stage" aria-label="大厅、客厅与牌桌">
      <header class="topbar">
        <a class="brand" href="/play"><b>鲸语</b><span>PARLOR CLUB</span></a>
        <span v-if="view === 'divination'" class="room-pill"><span class="room-pill-name">问卦阁</span></span>
        <span v-else-if="seat?.guest" class="room-pill"><span class="room-pill-name">{{ roomLabel }}</span></span>
        <button v-else class="room-pill" type="button" title="换客厅" :aria-label="'换客厅，当前在' + roomLabel" @click="switcherOpen = true">
          <i class="live-dot" :class="{ off: !connected }" />
          <span class="room-pill-name">{{ roomLabel }}</span>
          <span class="room-pill-arrow">▾</span>
        </button>
        <span v-if="!specialView" class="presence">
          <i class="pulse" :class="{ off: !connected }" />
          <b>{{ presence }}</b> 位朋友在这里
        </span>
        <span v-if="!specialView && !connected" class="conn-chip" role="status">{{ connectionText }}</span>
        <div class="top-right">
          <div ref="toolsRegion" class="extra-tools" :class="{ 'is-open': toolsOpen }"
            @keydown.esc="closeTools(true)">
            <button ref="toolsToggle" class="tool tools-toggle" type="button" aria-label="更多工具"
              aria-controls="extra-tools" :aria-expanded="toolsOpen" @click="toolsOpen = !toolsOpen">
              <Icon :name="toolsOpen ? 'close' : 'menu'" />
            </button>
            <div id="extra-tools" class="extra-tools-list">
              <button v-if="gateway && seat && view !== 'divination'" class="tool" type="button" title="离开客厅" aria-label="离开客厅"
                :disabled="leavingRoom" @click="closeTools(true); confirmLeaveRoom()">
                <Icon name="arrow" /><span class="tool-label">退厅</span>
              </button>
              <button class="tool" type="button" @click="closeTools(true); ratingsOpen = true" title="会馆等级分榜" aria-label="会馆等级分榜">
                <Icon name="board" /><span class="tool-label">榜单</span>
              </button>
              <button class="tool" type="button" @click="closeTools(true); giftOpen = true" title="茶点：送一份茶或小零食，也可以喝掉/吃掉">
                <Icon name="tea" /><span class="tool-label">茶点</span>
              </button>
              <ThemePicker />
            </div>
          </div>
          <button v-if="!specialView" class="tool" type="button" aria-label="信箱" @click="openMail">
            <Icon name="mail" /><span class="tool-label">信箱</span>
            <span v-if="mailUnread" class="tool-badge">{{ mailUnread }}</span>
          </button>
          <button v-if="!seat?.guest" class="tool" type="button" title="私聊" aria-label="私聊" @click="toggleDm">
            <Icon name="user" /><span class="tool-label">私聊</span>
            <span v-if="dmUnread" class="tool-badge">{{ dmUnread }}</span>
          </button>
          <button v-if="!specialView" class="tool dock" type="button"
            :aria-expanded="chatExpanded()" aria-label="有话慢慢聊" @click="toggleMainChat">
            <Icon name="chat" /><span class="tool-label">{{ chatExpanded() ? '收起聊天' : '有话慢慢聊' }}</span>
          </button>
        </div>
      </header>

      <div ref="stageBody" class="stage-body">
        <slot />
      </div>
    </main>

    <ChatPanel v-if="!specialView" />
    <DmWindow v-if="!seat?.guest" />
    <RoomSwitcher v-model:open="switcherOpen" />
    <RatingsPanel v-model:open="ratingsOpen" />
    <GiftPanel v-model:open="giftOpen" />
    <div v-if="!specialView" class="sheet-backdrop" :class="{ 'is-show': sheetOpen }" @click="closeSheet" />
    <div v-if="toastText" class="toast show" :class="{ bad: toastKind === 'bad' }" role="status">{{ toastText }}</div>
  </div>
</template>
