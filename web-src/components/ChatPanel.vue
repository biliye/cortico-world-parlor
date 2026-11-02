<script setup lang="ts">
/**
 * 聊天侧栏：客厅/牌桌/信箱三个频道。
 * 这一刀只接客厅（大厅）频道；牌桌与信箱是占位，第 3 刀接。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { clockText, initialOf, readable } from '../lib/text.ts';
import {
  chooseTab, closeSheet, draftFor, draftKey, saveDraftFor, sheetOpen, tab, toggleChat, unread,
} from '../stores/chat.ts';
import { act, activeTable, log, myTable, snapshot, tableIdOf } from '../stores/parlor.ts';

interface Line {
  key: number;
  kind: 'system' | 'msg';
  time: string;
  name: string;
  text: string;
  tag: string;
}

const inHall = computed(() => snapshot.value?.id === 'hall');
const roomLabel = computed(() => (inHall.value ? '大厅' : '客厅'));
const myTableId = computed(() => tableIdOf(myTable.value));

/** 与旧版 tableChatOpen 一致：桌还在、我坐在这张桌上、看着的就是这张桌。 */
const tableOpen = computed(() => {
  const table = myTable.value;
  if (!table || table.status === 'ended') return false;
  if (tableIdOf(activeTable.value) !== tableIdOf(table)) return false;
  if (table.game === 'werewolf' && table.status !== 'open') return false;
  const me = snapshot.value?.seat?.id;
  return !!me && (table.seats || []).some((person) => person.id === me);
});

function nameOf(from?: string): string {
  const seats = snapshot.value?.seats || [];
  return seats.find((person) => person.id === from)?.name || from || '？';
}

const lines = computed<Line[]>(() => {
  const out: Line[] = [];
  const channel = tab.value;
  for (const event of log.value) {
    const type = event.type || '';
    if (type === 'parlor.whisper' || type === 'parlor.table.turn' || type === 'parlor.digest') continue;
    if (type.startsWith('parlor.table.') && type !== 'parlor.table.say') continue;
    if (type.startsWith('parlor.monopoly.')) continue;
    if (channel === 'room' && type === 'parlor.table.say') continue;
    if (channel === 'table') {
      if (type !== 'parlor.table.say') continue;
      // 只认自己这张桌的话；没有桌号的老事件按「是」处理。
      const eventId = event.data && typeof event.data.tableId === 'string' ? event.data.tableId : '';
      if (eventId && myTableId.value && eventId !== myTableId.value) continue;
    }
    if (channel === 'mail') continue;
    const time = clockText(event.ts);
    if (event.from === 'system' || !event.from) {
      const tag = type.startsWith('parlor.table.') ? '牌桌' : type === 'parlor.ledger' ? '账本' : '';
      out.push({ key: event.seq ?? out.length, kind: 'system', time, name: '', text: readable(event.text), tag });
      continue;
    }
    const tableTalk = type === 'parlor.table.say';
    const name = (event.data && typeof event.data.name === 'string' ? event.data.name : '') || nameOf(event.from);
    out.push({
      key: event.seq ?? out.length,
      kind: 'msg',
      time,
      name,
      text: (tableTalk ? '（只有同桌看得见）' : '') + readable(event.text || ''),
      tag: tableTalk ? '牌桌私聊' : roomLabel.value,
    });
  }
  return out;
});

const logBox = ref<HTMLElement | null>(null);

function nearBottom(): boolean {
  const node = logBox.value;
  if (!node) return true;
  return node.scrollHeight - node.scrollTop - node.clientHeight < 80;
}

function toBottom(): void {
  const node = logBox.value;
  if (node) node.scrollTop = node.scrollHeight;
}

// 只在原本就在底部时才跟到底；往回翻历史时不抢滚动位置。
watch(() => lines.value.length, () => {
  const stick = nearBottom();
  void nextTick(() => { if (stick) toBottom(); });
});

watch(tab, () => { void nextTick(toBottom); });

const input = ref('');
const notice = ref('');
const scopeKey = computed(() => draftKey(tab.value === 'table' ? 'table' : 'room', tab.value === 'table' ? myTableId.value : ''));

watch(scopeKey, (next) => { input.value = draftFor(next); }, { immediate: true });

const scopeText = computed(() => {
  if (tab.value === 'mail') return '';
  if (tab.value === 'table') {
    if (tableOpen.value) {
      const watching = activeTable.value;
      const mine = myTable.value;
      const elsewhere = !!watching && !!mine && tableIdOf(watching) !== tableIdOf(mine);
      return elsewhere ? '只发到我的桌 · 你现在看的是另一桌' : '只发到这一桌 · 客厅和不在桌上的人看不见';
    }
    return activeTable.value?.game === 'werewolf' && activeTable.value?.status !== 'open'
      ? '狼人杀进行中 · 发言和狼聊请使用游戏内面板'
      : '围观只读 · 聊天请切到「客厅」';
  }
  return inHall.value ? '发到大厅 · 大厅里的人都看得见' : '发到客厅 · 房间里的人都看得见';
});

const placeholder = computed(() => {
  if (tab.value === 'table') return tableOpen.value ? '对同桌说点什么…' : '当前桌聊不可用';
  return inHall.value ? '在大厅说点什么…' : '在客厅说点什么…';
});

const canSend = computed(() => tab.value === 'room' || (tab.value === 'table' && tableOpen.value));

function onInput(): void {
  saveDraftFor(scopeKey.value, input.value);
}

function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return;
  // 中文输入法里回车是确认候选词；确认那一下有的浏览器 isComposing 已是 false，只剩 keyCode 229。
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  void submit();
}

async function submit(): Promise<void> {
  if (!canSend.value || !input.value.trim()) return;
  const text = input.value.trim();
  notice.value = '';
  input.value = '';
  saveDraftFor(scopeKey.value, '');
  try {
    await act(tab.value === 'table' ? { type: 'table_say', text } : { type: 'say', text });
  } catch (error) {
    notice.value = (error as Error).message || '没发出去';
    if (!draftFor(scopeKey.value)) {
      input.value = text;
      saveDraftFor(scopeKey.value, text);
    }
  }
}

function collapse(): void {
  toggleChat(false);
}

function closeDrawer(): void {
  closeSheet();
}
</script>

<template>
  <aside class="right-rail" aria-label="聊天与牌桌信息">
    <section class="panel chat-panel" :class="{ 'is-open': sheetOpen }">
      <div class="sheet-grip" />
      <div class="chat-head">
        <div>
          <span class="eyebrow">{{ inHall ? '大厅' : '客厅 · 牌桌' }}</span>
          <h2>有话慢慢聊</h2>
        </div>
        <div class="chat-head-actions">
          <button class="btn ghost small" type="button" aria-label="收起聊天" @click="collapse">收起</button>
          <button class="btn ghost small sheet-close" type="button" aria-label="关闭聊天" @click="closeDrawer">✕</button>
        </div>
      </div>

      <div class="chat-tabs" role="tablist" aria-label="聊天频道">
        <button class="chat-tab" :class="{ 'is-active': tab === 'room' }" type="button" role="tab"
          :aria-selected="tab === 'room'" @click="chooseTab('room')">
          {{ inHall ? '大厅' : '客厅' }}
          <span v-if="unread.room" class="tab-count">{{ unread.room }}</span>
        </button>
        <button class="chat-tab" :class="{ 'is-active': tab === 'table' }" type="button" role="tab"
          :aria-selected="tab === 'table'" @click="chooseTab('table')">
          牌桌
          <span v-if="unread.table" class="tab-count">{{ unread.table }}</span>
        </button>
        <button class="chat-tab" :class="{ 'is-active': tab === 'mail' }" type="button" role="tab"
          :aria-selected="tab === 'mail'" @click="chooseTab('mail')">信箱</button>
      </div>

      <div class="chat-body">
        <div v-if="tab !== 'mail'" ref="logBox" class="chat-log">
          <p v-if="!lines.length" class="chat-empty">
            <template v-if="tab === 'table'">
              {{ tableOpen ? '同桌的话，留在这一桌。' : '围观不开放同桌聊天。' }}
            </template>
            <template v-else>这里还没人说话。</template>
          </p>
          <template v-for="line in lines" :key="line.key">
            <div v-if="line.kind === 'system'" class="system-line">
              <span v-if="line.tag" class="tag tag-table">{{ line.tag }}</span>
              <span>{{ line.text }}</span>
              <time>{{ line.time }}</time>
            </div>
            <article v-else class="msg">
              <span class="avatar avatar-sm">{{ initialOf(line.name) }}</span>
              <div class="msg-body">
                <div class="msg-meta">
                  <span class="msg-name">{{ line.name }}</span>
                  <span class="tag tag-room">{{ line.tag }}</span>
                  <time>{{ line.time }}</time>
                </div>
                <p>{{ line.text }}</p>
              </div>
            </article>
          </template>
        </div>
        <div v-else class="mail-list">
          <p class="chat-empty">信箱还在迁移中（第 3 刀接）。</p>
        </div>
      </div>

      <div v-if="tab !== 'mail'" class="composer">
        <div class="composer-scope">
          <span class="scope-dot" />
          <span>{{ scopeText }}</span>
        </div>
        <div class="composer-row">
          <input
            v-model="input"
            type="text"
            maxlength="400"
            autocomplete="off"
            :disabled="!canSend"
            :placeholder="placeholder"
            :aria-label="scopeText"
            @input="onInput"
            @keydown="onKey"
          >
          <button class="send-btn" type="button" aria-label="发送" :disabled="!canSend" @click="submit">
            <svg class="icon" aria-hidden="true"><use href="#i-send" /></svg>
          </button>
        </div>
        <p v-if="notice" class="warn">{{ notice }}</p>
      </div>
    </section>
  </aside>
</template>
