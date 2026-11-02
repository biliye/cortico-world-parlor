<script setup lang="ts">
/** 私聊浮窗：会话列表 + 找人 + 当前对话。桌面可拖，手机全屏；Esc 或点窗外关闭。 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { clockText, readable } from '../lib/text.ts';
import {
  close, error, loading, messages, open, openThread, peer, people, pos, query, savePos,
  send, setQuery, threads, unread,
} from '../stores/dm.ts';

const win = ref<HTMLElement | null>(null);
const msgs = ref<HTMLElement | null>(null);
const draft = ref('');
const dragging = ref<{ dx: number; dy: number } | null>(null);
const live = ref<{ left: number; top: number } | null>(null);

const winStyle = computed(() => {
  const spot = live.value || pos.value;
  return spot ? { left: spot.left + 'px', top: spot.top + 'px', right: 'auto' } : {};
});

const peerHandle = computed(() => {
  const target = peer.value;
  if (!target) return '';
  return target.handle || threads.value.find((thread) => thread.peer === target.cooId)?.handle || '';
});

const peerOnline = computed(() => {
  const target = peer.value;
  return !!target && !!threads.value.find((thread) => thread.peer === target.cooId)?.online;
});

function onSearch(event: Event): void {
  setQuery((event.target as HTMLInputElement).value);
}

function startDrag(event: PointerEvent): void {
  if ((event.target as HTMLElement).closest('.dm-close')) return;
  if (window.matchMedia('(max-width: 820px)').matches || !win.value) return;
  const rect = win.value.getBoundingClientRect();
  dragging.value = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
  try {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  } catch {
    /* 合成事件没有真实指针 */
  }
}

function moveDrag(event: PointerEvent): void {
  if (!dragging.value || !win.value) return;
  const width = win.value.offsetWidth;
  const height = win.value.offsetHeight;
  const left = Math.min(Math.max(0, event.clientX - dragging.value.dx), Math.max(0, window.innerWidth - width));
  const top = Math.min(Math.max(0, event.clientY - dragging.value.dy), Math.max(0, window.innerHeight - height));
  live.value = { left, top };
}

function endDrag(): void {
  if (!dragging.value) return;
  dragging.value = null;
  if (live.value) savePos(live.value.left, live.value.top);
}

async function submit(): Promise<void> {
  if (!peer.value || !draft.value.trim()) return;
  const text = draft.value;
  if (await send(text)) draft.value = '';
}

function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return;
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  void submit();
}

function outside(event: PointerEvent): void {
  if (!open.value || !win.value) return;
  const target = event.target as HTMLElement;
  if (win.value.contains(target) || target.closest('.dm-toggle')) return;
  close();
}

function onEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) close();
}

watch(() => messages.value.length, () => {
  const node = msgs.value;
  if (!node) return;
  const stick = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
  if (stick) void nextTick(() => { node.scrollTop = node.scrollHeight; });
});

onMounted(() => {
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', onEscape);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('keydown', onEscape);
});
</script>

<template>
  <aside
    v-if="open"
    ref="win"
    class="dm"
    role="dialog"
    aria-label="私聊"
    :style="winStyle"
  >
    <header class="dm-head" @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="endDrag">
      <span class="dm-title">私聊</span>
      <button class="dm-close" type="button" aria-label="关闭私聊" @click="close">×</button>
    </header>
    <div class="dm-body">
      <div class="dm-list">
        <input class="dm-search" :value="query" placeholder="搜名字、#号 或会话" aria-label="搜索用户" @input="onSearch">
        <div class="dm-threads">
          <p v-if="!threads.length" class="chat-empty">还没有私聊。上面搜个名字开始。</p>
          <button
            v-for="thread in threads"
            :key="thread.peer"
            class="dm-thread"
            :class="{ 'is-active': peer?.cooId === thread.peer }"
            type="button"
            @click="openThread(thread.peer, thread.name, thread.handle)"
          >
            <span class="dm-who">
              <span class="dm-name">{{ thread.name || '某人' }}</span>
              <span v-if="thread.handle" class="dm-handle">#{{ thread.handle }}</span>
              <span v-if="thread.online" class="dm-online">在线</span>
              <span v-if="thread.unread" class="badge">{{ thread.unread }}</span>
            </span>
            <span class="dm-last">{{ thread.lastFromMe ? '我：' : '' }}{{ readable(thread.lastText) }}</span>
            <time class="dm-time">{{ clockText(thread.lastTs) }}</time>
          </button>
        </div>
        <div class="dm-people">
          <template v-if="query.trim()">
            <p v-if="!people.length" class="chat-empty">没有找到（名字只搜在线或聊过的人；有 #号 可以直接搜）</p>
            <p v-else class="dm-hint">找人</p>
            <button
              v-for="person in people"
              :key="person.cooId"
              class="dm-thread dm-person"
              type="button"
              @click="setQuery(''); openThread(person.cooId, person.name, person.handle)"
            >
              <span class="dm-who">
                <span class="dm-name">{{ person.name || '某人' }}</span>
                <span v-if="person.handle" class="dm-handle">#{{ person.handle }}</span>
                <span v-if="person.online" class="dm-online">在线</span>
              </span>
            </button>
          </template>
        </div>
      </div>
      <div class="dm-pane">
        <div class="dm-peer">
          <template v-if="peer">
            <strong>{{ peer.name || '某人' }}</strong>
            <span v-if="peerHandle" class="dm-handle">#{{ peerHandle }}</span>
            <span v-if="peerOnline" class="dm-online">在线</span>
          </template>
          <template v-else>选一个人说话</template>
        </div>
        <div ref="msgs" class="dm-msgs">
          <p v-if="loading" class="chat-empty">正在取聊天…</p>
          <p v-else-if="error" class="chat-empty bad">{{ error }}</p>
          <p v-else-if="!peer" class="chat-empty">选左边一个人，或者上面搜个名字。</p>
          <p v-else-if="!messages.length" class="chat-empty">还没有消息。</p>
          <article v-for="(message, index) in messages" :key="index" class="dm-msg" :class="{ 'is-me': message.fromMe }">
            <p class="dm-text">{{ readable(message.text) }}</p>
            <time class="dm-time">{{ clockText(message.ts) }}</time>
          </article>
        </div>
        <form class="dm-send" @submit.prevent="submit">
          <textarea
            v-model="draft"
            class="dm-input"
            rows="1"
            placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
            :disabled="!peer"
            @keydown="onKey"
          />
          <button class="btn primary small" type="submit" :disabled="!peer || !draft.trim()">发送</button>
        </form>
      </div>
    </div>
  </aside>
</template>
