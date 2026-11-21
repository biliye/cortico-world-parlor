<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DivinationDraw, DivinationView } from '../../src/room/divination-protocol.ts';
import { api } from '../api/client.ts';
import Icon from '../components/Icon.vue';
import { newRequestId } from '../stores/parlor.ts';

defineProps<{ standalone?: boolean }>();

const state = ref<DivinationView | null>(null);
const busy = ref(false);
const sending = ref(false);
const error = ref('');
const drawError = ref('');
const chatError = ref('');
const message = ref('');
const chatLog = ref<HTMLElement | null>(null);
const reveal = ref(false);
const draw = computed(() => state.value?.draw);
const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' });
let requestId = '';
let generation = 0;
let timer = 0;
let reading = false;

watch(() => state.value?.chat.at(-1)?.seq, () => {
  const list = chatLog.value;
  if (list && list.scrollHeight - list.scrollTop - list.clientHeight > 64) return;
  void nextTick(() => { if (chatLog.value) chatLog.value.scrollTop = chatLog.value.scrollHeight; });
});

function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  return api<T>(`/v1/divination/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function refresh(): Promise<void> {
  if (document.hidden || reading) return;
  reading = true;
  const run = ++generation;
  try {
    const result = await api<DivinationView>('/v1/divination/room');
    if (run !== generation) return;
    state.value = result;
    error.value = '';
  } catch (cause) {
    if (run === generation) error.value = (cause as Error).message || '暂时读不到问卦阁';
  } finally {
    reading = false;
  }
}

async function shake(): Promise<void> {
  if (busy.value || !state.value?.canDraw || draw.value) return;
  requestId ||= newRequestId();
  busy.value = true;
  drawError.value = '';
  try {
    const result = await post<{ draw: DivinationDraw; day: string }>('draw', { requestId });
    requestId = '';
    generation++;
    if (state.value && result.draw.day === result.day) {
      state.value = { ...state.value, draw: result.draw };
      reveal.value = true;
    }
    void refresh();
  } catch (cause) {
    drawError.value = (cause as Error).message || '暂时没能取到签，请重试';
  } finally {
    busy.value = false;
  }
}

async function say(): Promise<void> {
  const text = message.value.trim();
  if (sending.value || !text || !state.value?.canChat) return;
  sending.value = true;
  chatError.value = '';
  try {
    await post('chat', { text });
    if (message.value.trim() === text) message.value = '';
    void refresh();
  } catch (cause) {
    chatError.value = (cause as Error).message || '暂时发不出去，请重试';
  } finally {
    sending.value = false;
  }
}

onMounted(() => {
  void refresh();
  timer = window.setInterval(() => { void refresh(); }, 5_000);
  document.addEventListener('visibilitychange', refresh);
});
onBeforeUnmount(() => {
  generation++;
  window.clearInterval(timer);
  document.removeEventListener('visibilitychange', refresh);
});
</script>

<template>
  <section class="divination-page" aria-labelledby="divination-heading">
    <a v-if="standalone" class="back" href="/play">返回茶馆</a>
    <header>
      <h1 id="divination-heading">问卦阁</h1>
      <p>家长抽签，自家 Coo 解签。每日一签，茶余一乐。</p>
    </header>
    <p v-if="error" class="page-error" role="status">{{ error }} <button type="button" @click="refresh">重试</button></p>
    <p v-else-if="!state" role="status">正在打开问卦阁…</p>
    <div v-if="state" class="divination-layout">
      <section class="draw" aria-labelledby="draw-heading">
        <h2 id="draw-heading">我的今日签</h2>
        <article v-if="draw" :key="draw.id" class="lot" :class="{ reveal }">
          <header>
            <span>第 {{ draw.lot.number }} 签</span>
            <strong>{{ draw.head ? '头签' : draw.lot.grade }}</strong>
          </header>
          <p class="poem">{{ draw.lot.poem }}</p>
          <p><strong>宜 · {{ draw.lot.advice }}</strong> {{ draw.lot.note }}</p>
          <div class="interpretation" aria-live="polite">
            <template v-if="draw.interpretation">
              <h3>自家 Coo 的解读</h3>
              <p>{{ draw.interpretation }}</p>
            </template>
            <p v-else>已把签寄给自家 Coo，解完会提醒你。</p>
          </div>
        </article>
        <div v-else class="draw-prompt">
          <div class="lot-mark" :class="{ shaking: busy }" aria-hidden="true"><Icon name="spark" /></div>
          <button v-if="state.canDraw" class="primary" :disabled="busy" type="button" @click="shake">{{ busy ? '正在抽签…' : '抽一支签' }}</button>
          <p v-else>用绑定了 Coo 的家长身份进入茶馆，就能抽签。</p>
          <p v-if="drawError" role="alert">{{ drawError }}</p>
        </div>
      </section>

      <section class="lot-board" aria-labelledby="board-heading">
        <h2 id="board-heading">今日红榜</h2>
        <p v-if="!state.board.length">今天还没人抽到上上或上吉。</p>
        <ol v-else>
          <li v-for="(entry, index) in state.board" :key="index">
            <span class="board-name">{{ entry.name }}</span>
            <strong :class="{ head: entry.head }">{{ entry.head ? '头签' : entry.grade }} · 第 {{ entry.number }} 签</strong>
            <time>{{ clock.format(entry.time) }}</time>
          </li>
        </ol>
      </section>

      <section class="conversation" aria-labelledby="conversation-heading">
        <h2 id="conversation-heading">阁中闲话</h2>
        <p v-if="!state.chat.length">还没人开口。</p>
        <ul v-else ref="chatLog" aria-label="最近发言">
          <li v-for="line in state.chat" :key="line.seq">
            <div><strong>{{ line.name }}</strong><time>{{ clock.format(line.time) }}</time></div>
            <p>{{ line.text }}</p>
          </li>
        </ul>
        <form v-if="state.canChat" @submit.prevent="say">
          <input v-model="message" :disabled="sending" aria-label="阁中发言" maxlength="200" placeholder="和阁里的茶客聊两句">
          <button type="submit" :disabled="sending || !message.trim()">发送</button>
        </form>
        <p v-if="chatError" role="alert">{{ chatError }}</p>
      </section>
    </div>
  </section>
</template>

<style scoped>
.divination-page { width: min(100%, 59rem); margin-inline: auto; padding: clamp(1rem, 4vw, 2.75rem); color: var(--text); }
.divination-page > header { margin-bottom: 1.25rem; }
.divination-page h1 { margin: 0 0 .3rem; font-size: clamp(1.8rem, 4vw, 2.4rem); }
.divination-page h2 { font-size: 1.1rem; margin: 0 0 .8rem; }
.divination-page h3 { font-size: .95rem; margin: 0; }
.divination-page p { margin: .35rem 0; line-height: 1.6; }
.divination-page > header p, .divination-page time { color: var(--muted, var(--text)); }
.back { display: inline-block; margin-bottom: 1rem; }
.divination-layout { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); grid-template-rows: max-content auto; gap: 1rem; align-items: start; }
.divination-layout > section { padding: clamp(.9rem, 2.5vw, 1.35rem); border: 1px solid var(--line-2); border-radius: .8rem; background: var(--panel-2); }
.draw { grid-row: span 2; min-height: 19rem; }
.draw-prompt { min-height: 14rem; display: grid; justify-items: center; align-content: center; gap: .8rem; text-align: center; }
.lot-mark { display: grid; place-items: center; width: 3.4rem; height: 5rem; border-radius: .35rem; border: 1px solid var(--line-2); color: var(--accent, var(--text)); background: var(--panel); }
.lot-mark :deep(.icon) { width: 1.4rem; height: 1.4rem; }
.lot-mark.shaking { animation: shake .32s ease-in-out 3; }
.lot { padding: 1rem; border: 1px solid var(--line-2); border-radius: .5rem; background: var(--panel); }
.lot.reveal { animation: reveal .35s ease-out; }
.lot header { display: flex; justify-content: space-between; align-items: center; gap: .5rem; }
.lot header strong { padding: .2rem .5rem; border: 1px solid currentColor; border-radius: .25rem; color: var(--accent, var(--text)); }
.lot .poem { white-space: pre-line; padding-block: .85rem; font-family: 'Noto Serif SC', 'Songti SC', SimSun, serif; font-size: clamp(1.1rem, 3vw, 1.45rem); line-height: 1.9; }
.interpretation { margin-top: 1rem; padding-top: .65rem; border-top: 1px solid var(--line-2); overflow-wrap: anywhere; white-space: pre-line; }
.lot-board ol, .conversation ul { margin: 0; padding: 0; list-style: none; overflow: auto; }
.lot-board ol { max-height: 13rem; }
.lot-board li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: .5rem; align-items: baseline; padding-block: .35rem; border-bottom: 1px solid var(--line-2); }
.board-name { overflow-wrap: anywhere; }
.lot-board strong, .divination-page time { font-size: .8rem; }
.lot-board .head { color: var(--accent, var(--text)); }
.conversation ul { max-height: 16rem; padding-right: .45rem; }
.conversation li { padding-block: .45rem; border-bottom: 1px solid var(--line-2); overflow-wrap: anywhere; }
.conversation li div { display: flex; align-items: baseline; gap: .5rem; }
.conversation li p { white-space: pre-wrap; }
.conversation form { display: flex; gap: .45rem; margin-top: .7rem; }
.divination-page :is(button, input) { font: inherit; color: inherit; background: var(--panel-2); padding: .5rem .75rem; border: 1px solid var(--line-2); border-radius: .5rem; }
.divination-page button.primary { color: var(--panel-2); background: var(--text); }
.divination-page button:disabled { opacity: .6; }
.conversation input { flex: 1; width: 0; }
.page-error { margin-bottom: .75rem; }
@keyframes shake { 0%, 100% { transform: rotate(0); } 30% { transform: rotate(-7deg); } 70% { transform: rotate(7deg); } }
@keyframes reveal { from { opacity: 0; transform: translateY(.4rem); } to { opacity: 1; transform: translateY(0); } }
@media (max-width: 820px) { .divination-layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: none; } .draw { grid-row: auto; } }
@media (prefers-reduced-motion: reduce) { .lot-mark.shaking, .lot.reveal { animation: none; } }
</style>
