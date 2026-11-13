<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { StoryChatPage } from '../../src/room/story-protocol.ts';
import { api, ApiError } from '../api/client.ts';

const props = defineProps<{ live?: StoryChatPage; archiveId?: string; status?: string }>();
const archive = ref<StoryChatPage>();
const earlier = ref<StoryChatPage>();
const loading = ref(false);
const error = ref('');
const log = ref<HTMLOListElement>();
const page = computed(() => props.live ?? archive.value);
const before = computed(() => earlier.value ? earlier.value.before : page.value?.before);
const messages = computed(() => {
  const latest = page.value?.messages ?? [];
  const first = latest[0]?.seq ?? Infinity;
  return [...(earlier.value?.messages.filter(message => message.seq < first) ?? []), ...latest];
});
let alive = true;

async function load(older = false): Promise<void> {
  if (loading.value) return;
  const cursor = before.value;
  if (older && cursor == null) return;
  const expectedRound = props.archiveId ?? page.value?.round?.id;
  const params = new URLSearchParams();
  if (expectedRound) params.set('round', expectedRound);
  if (older && cursor != null) params.set('before', String(cursor));
  loading.value = true;
  error.value = '';
  try {
    const result = await api<StoryChatPage>('/v1/story/chat?' + params);
    if (!alive || result.round?.id !== expectedRound) return;
    if (older) earlier.value = { ...result, messages: [...result.messages, ...(earlier.value?.messages ?? [])] };
    else archive.value = result;
  } catch (caught) {
    if (alive && (older || !(caught instanceof ApiError && caught.status === 404))) error.value = (caught as Error).message;
  } finally {
    loading.value = false;
  }
}

// 有人继续发言时保留已读到的上下文，只有最新页发生断档才重置回服务器页。
watch(page, (next, previous) => {
  const previousTail = previous?.messages.at(-1)?.seq;
  if (previousTail != null && (next?.messages[0]?.seq ?? 0) > previousTail) earlier.value = undefined;
  else if (earlier.value && previous && next) {
    const first = next.messages[0]?.seq ?? Infinity;
    const added = previous.messages.filter(message => message.seq < first);
    if (added.length) earlier.value = { ...earlier.value, messages: [...earlier.value.messages, ...added] };
  }
});
function scrollToLatest(): void {
  const node = log.value;
  if (node) node.scrollTop = node.scrollHeight;
}
watch(() => page.value?.messages.at(-1)?.seq, scrollToLatest, { flush: 'post' });

onMounted(() => {
  if (props.archiveId) void load();
  else scrollToLatest();
});
onUnmounted(() => { alive = false; });
</script>

<template>
  <section v-if="page || error || status" class="story-chat" aria-label="说书厅聊天">
    <h3>{{ page?.round ? `《${page.round.title}》散场讨论` : '说书厅聊天' }}</h3>
    <button v-if="before" type="button" :disabled="loading" @click="load(true)">更早的消息</button>
    <button v-if="error && !page" type="button" :disabled="loading" @click="load()">重试</button>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="status">{{ status }}</p>
    <ol v-else-if="messages.length" ref="log" class="story-chat-log" tabindex="0">
      <li v-for="message in messages" :key="message.seq">
        <strong>{{ message.name }}</strong>
        <p>{{ message.text }}</p>
      </li>
    </ol>
    <p v-else-if="page">还没有聊天消息。</p>
    <slot />
  </section>
</template>

<style scoped>
.story-chat { margin-block: 1rem; padding: .85rem; border: 1px solid var(--line-2); border-radius: .65rem; background: var(--panel-2); }
.story-chat h3 { margin: 0 0 .65rem; overflow-wrap: anywhere; }
.story-chat-log { list-style: none; padding: 0; max-height: 34vh; overflow-y: auto; overscroll-behavior: contain; }
.story-chat-log li { padding: .45rem 0; border-bottom: 1px solid var(--line-2); overflow-wrap: anywhere; }
.story-chat-log p { margin: .15rem 0 0; white-space: pre-wrap; }
.story-chat button { font: inherit; color: inherit; padding: .45rem .7rem; border: 1px solid var(--line-2); border-radius: .5rem; background: var(--panel-2); cursor: pointer; }
</style>
