<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DivinationDraw } from '../../src/room/divination-protocol.ts';
import { timeoutSignal } from '../api/client.ts';

const dialog = ref<HTMLDialogElement | null>(null);
const draw = ref<DivinationDraw | null>(null);
const saving = ref(false);
const error = ref('');
let active = true;
let reading = false;
let timer = 0;

async function refresh(): Promise<void> {
  if (document.hidden || reading || saving.value) return;
  reading = true;
  try {
    const response = await fetch('/v1/divination/unread', { signal: timeoutSignal() });
    if (!response.ok) return;
    const { draw: next } = await response.json() as { draw: DivinationDraw | null };
    if (active && !saving.value && (!draw.value || !next)) draw.value = next;
  } catch {
    // Recheck on the next poll or when the tab becomes visible again.
  } finally {
    reading = false;
  }
}

watch(draw, current => {
  if (current && !dialog.value?.open) dialog.value?.showModal();
  if (!current) dialog.value?.close();
}, { flush: 'post' });

async function acknowledge(): Promise<void> {
  const id = draw.value?.id;
  if (!id || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    const response = await fetch('/v1/divination/seen', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }), signal: timeoutSignal(),
    });
    if (!response.ok && response.status !== 401) throw new Error('暂时没能标记已读，请重试。');
    draw.value = null;
  } catch {
    error.value = '暂时没能标记已读，请重试。';
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void refresh();
  timer = window.setInterval(() => { void refresh(); }, 8_000);
  document.addEventListener('visibilitychange', refresh);
});
onBeforeUnmount(() => {
  active = false;
  window.clearInterval(timer);
  document.removeEventListener('visibilitychange', refresh);
});
</script>

<template>
  <dialog ref="dialog" class="divination-notice" aria-labelledby="divination-notice-title" @cancel.prevent="acknowledge">
    <template v-if="draw">
      <h2 id="divination-notice-title">你家 Coo 解了这一签</h2>
      <p class="lot-ref">{{ draw.day }} · 第 {{ draw.lot.number }} 签 · {{ draw.head ? '头签' : draw.lot.grade }}</p>
      <blockquote>{{ draw.lot.poem }}</blockquote>
      <p class="interpretation">{{ draw.interpretation }}</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <button type="button" autofocus :disabled="saving" @click="acknowledge">{{ saving ? '正在收下…' : '收下' }}</button>
    </template>
  </dialog>
</template>

<style scoped>
.divination-notice { width: min(31rem, calc(100% - 2rem)); max-height: 85vh; overflow-y: auto; padding: clamp(1rem, 5vw, 1.75rem); color: var(--text); background: var(--panel-2); border: 1px solid var(--line-2); border-radius: .8rem; }
.divination-notice[open] { animation: appear .24s ease-out; }
.divination-notice::backdrop { background: rgb(0 0 0 / 52%); }
.divination-notice h2 { margin: 0 0 .45rem; font-size: 1.25rem; }
.lot-ref { color: var(--muted, var(--text)); margin: 0; }
.divination-notice blockquote { margin: .9rem 0; padding-inline-start: .75rem; border-inline-start: 2px solid var(--line-2); white-space: pre-line; line-height: 1.55; }
.interpretation { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
.divination-notice button { font: inherit; padding: .45rem .85rem; color: var(--panel-2); background: var(--text); border: 1px solid var(--line-2); border-radius: .45rem; }
@keyframes appear { from { opacity: 0; transform: translateY(.35rem); } to { opacity: 1; transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) { .divination-notice[open] { animation: none; } }
</style>
