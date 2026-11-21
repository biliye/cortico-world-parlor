<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DivinationDraw } from '../../src/room/divination-protocol.ts';
import { timeoutSignal } from '../api/client.ts';
import { lotTone } from '../lib/divination.ts';

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
      <p class="dv-eyebrow"><i aria-hidden="true" />你家 Coo 解了这一签</p>
      <header class="notice-head">
        <h2 id="divination-notice-title">第 {{ draw.lot.number }} 签</h2>
        <span class="dv-seal" :class="'tone-' + lotTone(draw.lot.grade)">{{ draw.lot.grade }}</span>
      </header>
      <p class="lot-ref">{{ draw.day }}<template v-if="draw.head"> · 今日头签</template></p>
      <p class="dv-poem">{{ draw.lot.poem }}</p>
      <p class="dv-advice">宜 · {{ draw.lot.advice }}<span>{{ draw.lot.note }}</span></p>
      <section class="say">
        <p class="say-label">自家 Coo 的解</p>
        <p class="say-text">{{ draw.interpretation }}</p>
      </section>
      <p v-if="error" class="dv-alert" role="alert">{{ error }}</p>
      <footer>
        <span>茶余一乐，别当真</span>
        <!-- 只有一个「收下」是刻意的：家长与自家 Coo 的对话留在他们自己的私信里，茶馆不设回复框。
             2026-11-21 拍板（见 openM 提案第十一节「留白」），不要再加「回一句」输入框。 -->
        <button type="button" autofocus :disabled="saving" @click="acknowledge">{{ saving ? '正在收下…' : '收下' }}</button>
      </footer>
    </template>
  </dialog>
</template>

<style scoped>
.divination-notice {
  width: min(30rem, calc(100% - 2rem));
  max-height: 86vh;
  margin: auto;
  overflow-y: auto;
  padding: 1.6rem 1.5rem 1.25rem;
  color: var(--paper-ink);
  border: 0;
  border-radius: .3rem;
  background:
    repeating-linear-gradient(90deg, rgba(120, 84, 48, .035) 0 1px, transparent 1px 6px),
    radial-gradient(120% 90% at 50% 0%, #fffaf0, var(--paper) 62%, #efe4cd);
  box-shadow: 0 2.2rem 5rem rgba(0, 0, 0, .55), inset 0 .22rem 0 #9c2f22;
}
.divination-notice[open] { animation: dv-appear .3s cubic-bezier(.2, .9, .2, 1); }
.divination-notice::backdrop { background: color-mix(in oklab, #140c07 58%, transparent); backdrop-filter: blur(4px); }
.dv-eyebrow { display: flex; align-items: center; gap: .45rem; margin: 0 0 .5rem; color: #8a6b46; font-size: .76rem; letter-spacing: .16em; }
.dv-eyebrow i { width: .34rem; height: .34rem; border-radius: 50%; background: #9c2f22; }
.notice-head { display: flex; align-items: flex-start; justify-content: space-between; gap: .8rem; }
.notice-head h2 { margin: 0; font-size: 1.5rem; letter-spacing: .08em; color: #2a1a10; }
.dv-seal {
  display: grid; place-items: center; width: 2.5rem; height: 2.5rem;
  color: #fff3e2; background: #9c2f22; font-size: .8rem; font-weight: 700; line-height: 1;
  writing-mode: vertical-rl; letter-spacing: .1em; border-radius: .18rem;
  box-shadow: inset 0 0 0 2px rgba(255, 240, 220, .32);
  transform: rotate(-3deg);
}
.dv-seal.tone-low { background: #3f6b56; }
.dv-seal.tone-mid { background: #4a3524; }
.lot-ref { margin: .2rem 0 0; color: #8a6b46; font-size: .78rem; letter-spacing: .08em; }
.dv-poem {
  margin: 1rem 0 .4rem; padding-block: .9rem; border-block: 1px solid rgba(120, 84, 48, .2);
  font-family: "Noto Serif SC", "Songti SC", SimSun, "Source Han Serif SC", serif;
  font-size: 1rem; line-height: 1.9; letter-spacing: .12em; white-space: pre-line; text-align: center; color: #4a3520;
}
.dv-advice { margin: 0; color: #9c2f22; font-size: .88rem; font-weight: 700; letter-spacing: .08em; }
.dv-advice span { margin-left: .6rem; color: #6b543a; font-weight: 400; letter-spacing: 0; }
.say { margin-top: 1.1rem; padding-left: .9rem; border-left: 2px solid rgba(156, 47, 34, .5); }
.say-label { margin: 0 0 .3rem; color: #8a6b46; font-size: .74rem; letter-spacing: .14em; }
.say-text { margin: 0; font-size: .98rem; line-height: 1.95; overflow-wrap: anywhere; white-space: pre-wrap; color: #2a1a10; }
.dv-alert { color: #9c2f22; font-size: .84rem; }
footer { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-top: 1.35rem; }
footer span { color: #8a6b46; font-size: .74rem; }
footer button {
  padding: .52rem 1.5rem; border-radius: 999px; color: #fff3e2; background: #2a1a10;
  font: inherit; font-size: .9rem; font-weight: 600; letter-spacing: .1em;
}
footer button:disabled { opacity: .6; }
@keyframes dv-appear { from { opacity: 0; transform: translateY(.6rem) scale(.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
@media (max-width: 480px) { .divination-notice { padding: 1.4rem 1.15rem 1.1rem; } .dv-poem { font-size: .95rem; } }
@media (prefers-reduced-motion: reduce) { .divination-notice[open] { animation: none; } }
</style>
