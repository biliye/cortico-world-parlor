<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DivinationDraw, DivinationView } from '../../src/room/divination-protocol.ts';
import { api } from '../api/client.ts';
import Icon from '../components/Icon.vue';
import { newRequestId } from '../stores/parlor.ts';
import { lotTone } from '../lib/divination.ts';

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
const poem = computed(() => (draw.value?.lot.poem ?? '').split('\n').map(line => line.trim()).filter(Boolean));
const dayLabel = computed(() => new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' }).format(new Date()));
const todayKey = computed(() => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' }).format(new Date()));
const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' });
let requestId = '';
let generation = 0;
let timer = 0;
let reading = false;

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
    /* 刚抽完签的那一秒，轮询可能先于落库读回空状态；同一天的手上这张签不能被它盖掉。 */
    const keep = result.draw ?? (draw.value?.day === todayKey.value ? draw.value : null);
    state.value = { ...result, draw: keep };
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
  const started = performance.now();
  try {
    const result = await post<{ draw: DivinationDraw; day: string }>('draw', { requestId });
    requestId = '';
    // 签筒至少要摇完一遍才把签递出来，别让网络快慢决定仪式长短。
    const rest = 640 - (performance.now() - started);
    if (rest > 0) await wait(rest);
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
  <section class="divination-page" :class="{ standalone }" aria-labelledby="divination-heading">
    <a v-if="standalone" class="dv-back" href="/play"><Icon name="arrow" />返回茶馆</a>

    <header class="div-head">
      <div>
        <p class="dv-eyebrow"><i aria-hidden="true" />{{ dayLabel }} · 每日一签</p>
        <h1 id="divination-heading">问卦阁</h1>
        <p class="lede">家长抽签，自家 Coo 解签。茶余一乐，别当真。</p>
      </div>
    </header>

    <p v-if="error" class="note-line" role="status">
      {{ error }}
      <button type="button" @click="refresh">重试</button>
    </p>
    <p v-else-if="!state" class="note-line loading" role="status">正在推开阁门…</p>

    <div v-if="state" class="divination-layout">
      <section class="draw" aria-labelledby="draw-heading">
        <h2 id="draw-heading" class="section-label">我的今日签</h2>

        <div v-if="draw" class="lot-wrap" aria-live="polite">
          <div class="lot-column">
            <span v-if="draw.head" class="head-tag">今日头签</span>
            <article :key="draw.id" class="dv-lot" :class="[{ reveal }, draw.head ? 'is-head' : '']">
              <header class="lot-head">
                <span class="lot-no">第 {{ draw.lot.number }} 签</span>
                <span class="dv-seal" :class="'tone-' + lotTone(draw.lot.grade)" aria-label="签等：{{ draw.lot.grade }}">{{ draw.lot.grade }}</span>
              </header>
              <div class="dv-poem" :aria-label="poem.join('，')">
                <span v-for="(line, index) in poem" :key="index" class="poem-line" :style="{ '--i': index }">{{ line }}</span>
              </div>
              <footer class="lot-foot">
                <span class="dv-advice">宜 · {{ draw.lot.advice }}</span>
                <span class="lot-note">{{ draw.lot.note }}</span>
              </footer>
            </article>
          </div>

          <div class="interpret" :class="{ 'dv-waiting': !draw.interpretation }">
            <p class="interpret-label">
              <i aria-hidden="true" />
              {{ draw.interpretation ? '自家 Coo 的解' : '已寄给自家 Coo' }}
            </p>
            <template v-if="draw.interpretation">
              <p class="interpret-text">{{ draw.interpretation }}</p>
            </template>
            <template v-else>
              <p class="interpret-text waiting-text">签已收好，等孩子解这一签。</p>
              <p class="interpret-hint">解完会在这里出现，也会弹一次提醒。今天没解，签也不会丢。</p>
              <span class="breath" aria-hidden="true" />
            </template>
          </div>
        </div>

        <div v-else class="draw-prompt">
          <div class="tube" :class="{ shaking: busy, dim: !state.canDraw }" aria-hidden="true">
            <span v-for="n in 7" :key="n" class="stick" :style="{ '--i': n }" />
            <span class="tube-mouth" />
            <span class="tube-hole" />
            <span class="tube-body" />
            <span class="tube-band" />
            <span class="tube-label" aria-hidden="true">问卦</span>
          </div>
          <button v-if="state.canDraw" class="shake-btn" :disabled="busy" type="button" @click="shake">
            {{ busy ? '正在摇签…' : '摇一签' }}
          </button>
          <p v-if="state.canDraw" class="hint">一天一签，明日再来。</p>
          <p v-else class="hint">求签是家长的事。你先坐，榜和闲话都开着。</p>
          <p v-if="drawError" class="dv-alert" role="alert">{{ drawError }}</p>
        </div>
      </section>

      <aside class="dv-side">
        <section class="dv-board" aria-labelledby="board-heading">
          <header>
            <h2 id="board-heading">今日红榜</h2>
            <span>只记上上与上吉</span>
          </header>
          <p v-if="!state.board.length" class="empty">今日红榜还空着，等你来开张。</p>
          <ol v-else>
            <li v-for="entry in state.board" :key="entry.number + entry.time + entry.name" :class="{ 'is-head': entry.head }">
              <span class="board-name">{{ entry.name }}</span>
              <span class="board-grade" :class="'tone-' + lotTone(entry.grade)">{{ entry.head ? '头签' : entry.grade }}</span>
              <span class="board-num">第 {{ entry.number }} 签</span>
              <time>{{ clock.format(entry.time) }}</time>
            </li>
          </ol>
        </section>

        <section class="dv-talk" aria-labelledby="talk-heading">
          <header>
            <h2 id="talk-heading">阁中闲话</h2>
            <span>{{ state.chat.length ? '大家在这儿说话' : '安静' }}</span>
          </header>
          <p v-if="!state.chat.length" class="empty">还没人开口，你可以先问一句。</p>
          <ul v-else ref="chatLog" aria-label="最近发言">
            <li v-for="line in state.chat" :key="line.seq">
              <p class="dv-who"><strong>{{ line.name }}</strong><time>{{ clock.format(line.time) }}</time></p>
              <p class="said">{{ line.text }}</p>
            </li>
          </ul>
          <form v-if="state.canChat" @submit.prevent="say">
            <input v-model="message" :disabled="sending" aria-label="阁中发言" maxlength="200" placeholder="和阁里的茶客聊两句">
            <button type="submit" :disabled="sending || !message.trim()">发送</button>
          </form>
          <p v-else class="empty">入座之后就能在这里说话。</p>
          <p v-if="chatError" class="dv-alert" role="alert">{{ chatError }}</p>
        </section>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.divination-page {
  width: min(100%, 68rem);
  margin-inline: auto;
  padding: clamp(1.1rem, 3.4vw, 2.4rem) clamp(1rem, 3.4vw, 2.4rem) clamp(3rem, 8vw, 5rem);
  color: var(--text);
}
.divination-page.standalone { height: 100vh; overflow-y: auto; padding-top: clamp(2.5rem, 7vw, 4.5rem); }

/* —— 页头 —— */
.dv-back { display: inline-flex; align-items: center; gap: .35rem; margin-bottom: 1.4rem; color: var(--muted); font-size: .86rem; }
.dv-back :deep(.icon) { width: 14px; height: 14px; transform: rotate(180deg); }
.div-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 1.4rem; margin-bottom: clamp(1.6rem, 4vw, 2.4rem); }
.dv-eyebrow { display: flex; align-items: center; gap: .5rem; margin: 0 0 .55rem; color: var(--muted); font-size: .8rem; letter-spacing: .12em; }
.dv-eyebrow i { width: 6px; height: 6px; border-radius: 50%; background: var(--red); box-shadow: 0 0 10px color-mix(in oklab, var(--red) 70%, transparent); }
.div-head h1 { margin: 0; font-size: clamp(1.9rem, 3.6vw, 2.6rem); font-weight: 700; letter-spacing: .14em; }
.lede { margin: .55rem 0 0; color: var(--muted); font-size: .9rem; }

.note-line { display: flex; align-items: center; gap: .7rem; color: var(--muted); }
.note-line button { padding: .2rem .6rem; border: 1px solid var(--line-2); border-radius: 999px; font-size: .82rem; }
.note-line.loading::before { content: ''; width: .5rem; height: .5rem; border-radius: 50%; background: var(--red); animation: dv-pulse 1.4s ease-in-out infinite; }

/* —— 主区 —— */
.divination-layout { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(18rem, 1fr); gap: clamp(1rem, 2.6vw, 1.8rem); align-items: start; }
.draw { position: relative; min-height: 30rem; padding: clamp(1.1rem, 2.6vw, 1.7rem) clamp(1.1rem, 2.6vw, 1.9rem) clamp(1.4rem, 3vw, 2rem); border-radius: 1.2rem; background: color-mix(in oklab, var(--panel) 70%, transparent); }
.draw::before { content: ''; position: absolute; inset: 4% 18% auto; height: 58%; border-radius: 50%; background: radial-gradient(circle at 50% 38%, color-mix(in oklab, var(--lime) 9%, transparent), transparent 78%); pointer-events: none; }
.section-label { position: relative; margin: 0 0 1.1rem; color: var(--muted); font-size: .78rem; font-weight: 500; letter-spacing: .18em; }

/* —— 签筒 —— */
.draw-prompt { position: relative; display: grid; justify-items: center; align-content: center; gap: .8rem; min-height: 24rem; text-align: center; }
.tube { position: relative; width: 8.6rem; height: 14.6rem; filter: drop-shadow(0 24px 28px rgba(0, 0, 0, .55)); }
.tube::before { content: ''; position: absolute; left: 2%; right: 2%; bottom: -.9rem; height: 1.3rem; border-radius: 50%; background: radial-gradient(ellipse at 50% 50%, rgba(0, 0, 0, .5), transparent 72%); }
.tube.dim { opacity: .42; filter: grayscale(.5) drop-shadow(0 18px 22px rgba(0, 0, 0, .4)); }
.stick {
  position: absolute; bottom: 9.95rem; left: calc(50% + (var(--i) - 4) * .44rem);
  width: .56rem; height: 4.2rem;
  border-radius: .24rem .24rem 0 0;
  background: linear-gradient(90deg, #8a653c, #edd0a4 32%, #c69c6a 66%, #7c5a34);
  transform: rotate(calc((var(--i) - 4) * 1.3deg));
  transform-origin: 50% 100%;
}
.stick:nth-child(2n) { height: 4.7rem; }
.stick:nth-child(3n) { height: 5.1rem; }
.stick::after { content: ''; position: absolute; inset: 0 0 auto; height: .26rem; border-radius: .24rem .24rem 0 0; background: #b6432e; }
.tube-body {
  position: absolute; left: .55rem; right: .55rem; bottom: 0; height: 10rem; border-radius: .4rem .4rem .9rem .9rem;
  background: linear-gradient(90deg, #4a301e, #8d6440 22%, #7b5432 55%, #5a3a24 82%, #402818);
  box-shadow: inset .12rem 0 0 rgba(255, 255, 255, .12), inset -.18rem 0 0 rgba(0, 0, 0, .28);
}
.tube-band { position: absolute; left: .72rem; right: .72rem; bottom: 2.1rem; height: .42rem; border-radius: .2rem; background: linear-gradient(180deg, #b98f5d, #6b4a2e); opacity: .8; }
.tube-mouth {
  position: absolute; left: .28rem; right: .28rem; bottom: 9.5rem; height: 1.15rem; border-radius: 50%;
  background: linear-gradient(180deg, #c99c68, #8b6039);
  box-shadow: 0 .1rem .25rem rgba(0, 0, 0, .45);
}
.tube-hole {
  position: absolute; left: .5rem; right: .5rem; bottom: 9.72rem; height: .78rem; border-radius: 50%;
  background: radial-gradient(ellipse at 50% 35%, #1d1007, #0d0703 70%);
  box-shadow: inset 0 .12rem .2rem rgba(0, 0, 0, .9);
}
.tube-label {
  position: absolute; left: 50%; bottom: 3.4rem; transform: translateX(-50%);
  padding: .55rem .32rem; writing-mode: vertical-rl; letter-spacing: .16em;
  color: #6b2f22; background: linear-gradient(180deg, #f7e9cb, #e6cfa4);
  border: 1px solid rgba(110, 56, 28, .35); border-radius: .1rem;
  font-size: .72rem; line-height: 1.2;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .35);
}
.tube.shaking { animation: dv-tube-shake .64s ease-in-out; }
.tube.shaking .stick { animation: dv-stick-jump .64s ease-in-out; animation-delay: calc(var(--i) * 14ms); }
.shake-btn {
  min-width: 9.5rem; padding: .62rem 1.5rem; border-radius: 999px;
  color: var(--panel); background: var(--text); font-size: 1rem; font-weight: 650; letter-spacing: .12em;
  box-shadow: 0 .6rem 1.6rem color-mix(in oklab, var(--lime) 16%, transparent);
  transition: transform .16s ease, box-shadow .16s ease;
}
.shake-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 .8rem 2rem color-mix(in oklab, var(--lime) 26%, transparent); }
.shake-btn:disabled { cursor: default; opacity: .6; }
.hint { margin: 0; color: var(--muted); font-size: .82rem; }

/* —— 签纸 —— */
.lot-wrap { position: relative; display: flex; flex-wrap: wrap; gap: clamp(1.2rem, 3vw, 2.2rem); align-items: flex-start; justify-content: center; }
.lot-column { position: relative; }
.head-tag {
  position: absolute; top: -.75rem; left: -1.1rem; z-index: 2; padding: .16rem .6rem;
  color: #3a2408; background: linear-gradient(180deg, #f2d08a, #d9ab55); font-size: .72rem; font-weight: 700;
  letter-spacing: .1em; border-radius: .2rem; transform: rotate(-4deg); box-shadow: 0 .3rem .8rem rgba(0, 0, 0, .35);
}
.dv-lot {
  position: relative; display: flex; flex-direction: column; width: 16.5rem; min-height: 24rem;
  padding: 1.5rem 1.35rem 1.35rem; border-radius: .28rem;
  color: var(--paper-ink);
  background:
    repeating-linear-gradient(90deg, rgba(120, 84, 48, .035) 0 1px, transparent 1px 6px),
    radial-gradient(120% 90% at 50% 0%, #fffaf0, var(--paper) 62%, #efe4cd);
  box-shadow: 0 1.6rem 3rem rgba(0, 0, 0, .45), inset 0 0 0 1px rgba(120, 84, 48, .34);
  transform: rotate(-.6deg);
  transition: transform .3s ease;
}
.dv-lot.is-head { box-shadow: 0 1.6rem 3rem rgba(0, 0, 0, .45), inset 0 0 0 1px rgba(120, 84, 48, .28), inset 0 .2rem 0 #d9ab55; }
.dv-lot:hover { transform: rotate(0); }
.dv-lot.reveal { animation: dv-lot-in .46s cubic-bezier(.2, .9, .2, 1); }
.lot-head { display: flex; align-items: flex-start; justify-content: space-between; gap: .6rem; }
.lot-no { color: #7a6247; font-size: .8rem; letter-spacing: .16em; }
.dv-seal {
  display: grid; place-items: center; width: 2.6rem; height: 2.6rem; margin: -.3rem -.25rem 0 0;
  color: #fff3e2; background: #9c2f22; font-size: .84rem; font-weight: 700; line-height: 1;
  writing-mode: vertical-rl; letter-spacing: .1em; border-radius: .18rem;
  box-shadow: inset 0 0 0 2px rgba(255, 240, 220, .32), 0 .2rem .5rem rgba(90, 20, 12, .35);
  transform: rotate(-3deg);
}
.dv-seal.tone-low { background: #3f6b56; }
.dv-seal.tone-mid { background: #4a3524; }

.dv-poem {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  margin: 1rem 0 1.2rem; padding-block: .4rem;
  font-family: "Noto Serif SC", "Songti SC", SimSun, "Source Han Serif SC", serif;
  font-size: 1.32rem; writing-mode: vertical-rl; line-height: 1.62; letter-spacing: .16em;
  align-self: center;
}
.poem-line { display: block; opacity: 0; animation: dv-line-in .5s ease-out forwards; animation-delay: calc(.14s + var(--i) * .09s); }
.lot-foot { display: grid; gap: .3rem; padding-top: .8rem; border-top: 1px solid rgba(120, 84, 48, .22); }
.dv-advice { color: #9c2f22; font-size: .92rem; font-weight: 700; letter-spacing: .1em; }
.lot-note { color: #6b543a; font-size: .82rem; line-height: 1.6; }

/* —— 解签条 —— */
.interpret { flex: 1; min-width: 14rem; max-width: 24rem; padding-top: .4rem; }
.interpret-label { display: flex; align-items: center; gap: .45rem; margin: 0 0 .7rem; color: var(--muted); font-size: .78rem; letter-spacing: .14em; }
.interpret-label i { width: .32rem; height: .32rem; border-radius: 50%; background: var(--red); }
.interpret-text { margin: 0; font-size: .98rem; line-height: 1.95; overflow-wrap: anywhere; white-space: pre-line; }
.interpret:not(.dv-waiting) .interpret-text { padding-left: .9rem; border-left: 2px solid color-mix(in oklab, var(--red) 62%, transparent); }
.waiting-text { color: var(--muted); }
.interpret-hint { margin: .5rem 0 0; color: var(--dim); font-size: .8rem; line-height: 1.7; }
.breath { display: block; width: 4.5rem; height: 1px; margin-top: 1.1rem; background: color-mix(in oklab, var(--lime) 70%, transparent); animation: dv-breath-line 2.6s ease-in-out infinite; }

/* —— 右栏 —— */
.dv-side { display: grid; gap: clamp(.9rem, 2vw, 1.3rem); }
.dv-board, .dv-talk { padding: 1.1rem 1.15rem 1.2rem; border: 1px solid var(--line-2); border-radius: 1rem; background: color-mix(in oklab, var(--panel-2) 78%, transparent); }
.dv-board { border-top: 2px solid color-mix(in oklab, var(--red) 55%, transparent); }
.dv-board header, .dv-talk header { display: flex; align-items: baseline; justify-content: space-between; gap: .6rem; margin-bottom: .7rem; }
.dv-board h2, .dv-talk h2 { margin: 0; font-size: .98rem; letter-spacing: .1em; }
.dv-board header span, .dv-talk header span { color: var(--dim); font-size: .74rem; }
.empty { margin: .2rem 0; color: var(--dim); font-size: .84rem; }
.dv-board ol { display: grid; gap: .1rem; max-height: 20rem; margin: 0; padding: 0; overflow-y: auto; list-style: none; scrollbar-width: thin; scrollbar-color: var(--line-2) transparent; }
.dv-board li {
  display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; gap: .5rem; align-items: center;
  padding: .5rem .1rem; border-bottom: 1px dashed var(--line); font-size: .86rem;
}
.dv-board li:last-child { border-bottom: 0; }
.dv-board li.is-head { background: linear-gradient(90deg, color-mix(in oklab, var(--lime) 10%, transparent), transparent 70%); }
.board-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.board-grade { padding: .05rem .4rem; border: 1px solid currentColor; border-radius: .18rem; font-size: .72rem; letter-spacing: .08em; }
.board-grade.tone-high { color: var(--red); }
.board-grade.tone-mid { color: var(--muted); }
.board-grade.tone-low { color: #6f9c84; }
.dv-board li.is-head .board-grade { color: var(--lime); }
.board-num { color: var(--muted); font-size: .76rem; }
.dv-board time, .dv-talk time { color: var(--dim); font-size: .72rem; font-variant-numeric: tabular-nums; }

.dv-talk ul { display: grid; gap: .1rem; max-height: 18rem; margin: 0; padding: 0 .1rem 0 0; overflow-y: auto; list-style: none; scrollbar-width: thin; scrollbar-color: var(--line-2) transparent; }
.dv-talk li { padding: .55rem .1rem; border-bottom: 1px dashed var(--line); }
.dv-talk li:last-child { border-bottom: 0; }
.dv-who { display: flex; align-items: baseline; justify-content: space-between; gap: .6rem; margin: 0 0 .18rem; }
.dv-who strong { font-size: .78rem; font-weight: 600; color: var(--muted); }
.said { margin: 0; font-size: .9rem; line-height: 1.7; overflow-wrap: anywhere; white-space: pre-wrap; }
.dv-talk form { display: flex; gap: .45rem; margin-top: .8rem; }
.dv-talk input {
  flex: 1; width: 0; padding: .5rem .8rem; border: 1px solid var(--line-2); border-radius: 999px;
  color: var(--text); background: color-mix(in oklab, var(--panel) 70%, transparent); font: inherit; font-size: .88rem;
}
.dv-talk input::placeholder { color: var(--dim); }
.dv-talk input:focus-visible { outline: 2px solid color-mix(in oklab, var(--lime) 60%, transparent); outline-offset: 1px; }
.dv-talk form button { padding: .5rem 1rem; border-radius: 999px; color: var(--panel); background: var(--text); font-size: .86rem; font-weight: 600; }
.dv-talk form button:disabled { opacity: .45; cursor: default; }

.dv-alert { margin: .6rem 0 0; color: var(--red); font-size: .84rem; }

@keyframes dv-tube-shake {
  0%, 100% { transform: rotate(0); }
  14% { transform: rotate(-3.2deg); }
  30% { transform: rotate(3.2deg); }
  46% { transform: rotate(-2.4deg); }
  62% { transform: rotate(2.4deg); }
  80% { transform: rotate(-1deg); }
}
@keyframes dv-stick-jump {
  0%, 100% { translate: 0 0; }
  22% { translate: 0 -.45rem; }
  44% { translate: 0 .1rem; }
  66% { translate: 0 -.25rem; }
}
@keyframes dv-lot-in { from { opacity: 0; transform: rotate(-.6deg) translateY(1.2rem) scale(.94); } to { opacity: 1; transform: rotate(-.6deg) translateY(0) scale(1); } }
@keyframes dv-line-in { from { opacity: 0; translate: 0 -.35rem; } to { opacity: 1; translate: 0 0; } }
@keyframes dv-pulse { 0%, 100% { opacity: .3; } 50% { opacity: 1; } }
@keyframes dv-breath-line { 0%, 100% { opacity: .18; } 50% { opacity: .8; } }

@media (max-width: 900px) {
  .divination-layout { grid-template-columns: minmax(0, 1fr); }
  .draw { min-height: 0; }
  .dv-side { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 560px) {
  .div-head { align-items: flex-start; }
    .dv-lot { width: min(100%, 16.5rem); }
  .lot-wrap { gap: 1.4rem; }
  .interpret { max-width: none; }
  .dv-poem { font-size: 1.2rem; height: 10rem; }
}
@media (prefers-reduced-motion: reduce) {
  .tube.shaking, .tube.shaking .stick, .dv-lot.reveal { animation: none; }
  .poem-line { opacity: 1; animation: none; }
  .breath { animation: none; opacity: .6; }
}
</style>
