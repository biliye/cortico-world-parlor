<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { GIFTS } from '../../src/room/gifts/catalog.ts';
import {
  STORY_CHAT_LIMIT, STORY_NOTE_LIMIT, STORY_PART_LIMIT, STORY_TITLE_LIMIT, STORY_VISITOR_ID, type StoryArchive, type StoryCursor,
  type StoryPage, type StoryState, type StorySummary,
} from '../../src/room/story-protocol.ts';
import { api } from '../api/client.ts';
import StoryChat from '../components/StoryChat.vue';
import { newRequestId } from '../stores/parlor.ts';
import { seat } from '../stores/session.ts';

const state = ref<StoryState>();
const round = computed(() => state.value?.round);
const mode = ref<'live' | 'archive'>('live');
const countdown = ref(0);
const following = ref(true);
const unreadParts = ref(0);
const reader = ref<HTMLElement>();
const compose = ref<'note' | 'snack' | 'start' | 'finish'>();
const draft = ref('');
const note = ref('');
const preview = ref<StoryState['preview']>();
const chatDraft = ref('');
const title = ref('');
const selectedSnack = ref('');
const busy = ref(false);
const problem = ref('');
const archive = ref<StoryArchive>();
const rounds = ref<StorySummary[]>([]);
const before = ref<StoryCursor | null>(null);
const archiveBusy = ref(false);
const lastRound = ref('');
const snacks = GIFTS.filter(item => item.kind === 'snack');
const formatTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' });
let alive = true;
let polling = false;
let revision = 0;
let offset = 0;
let speechRequest = '';
let speechText = '';
let chatRequest = '';
let chatText = '';
let pollTimer: ReturnType<typeof setTimeout>;
let clockTimer: ReturnType<typeof setInterval>;
const serverNow = computed(() => countdown.value + offset);
const secondsLeft = computed(() => Math.max(0, Math.ceil(((round.value?.endsAt ?? 0) - serverNow.value) / 1000)));
const closing = computed(() => !!round.value && serverNow.value >= round.value.notesAt);
const visibleNotes = computed(() => round.value?.batch ?? preview.value?.notes);
const chat = computed(() => state.value?.chat);
const chatStatus = computed(() => {
  if (!state.value) return '';
  if (round.value) return '台上正在说书，散场后开放聊天。';
  if (!seat.value) return '入座后可在网页查看聊天并发言。';
  if (!chat.value) return '当前茶馆未开放说书厅聊天。';
  return '';
});
const canStart = computed(() => !!seat.value && !round.value && !!state.value
  && (state.value.queue.open || (state.value.queue.readyUntil ?? 0) > serverNow.value));
const timer = computed(() => `${Math.floor(secondsLeft.value / 60)}:${String(secondsLeft.value % 60).padStart(2, '0')}`);
let guestId: string | undefined;

function storyGuestId(): string {
  if (guestId) return guestId;
  guestId = newRequestId();
  // 同一浏览器打开多个访客标签页时只计一次。
  try {
    const key = 'parlor-story-guest';
    const stored = localStorage.getItem(key);
    if (stored && STORY_VISITOR_ID.test(stored)) guestId = stored;
    else localStorage.setItem(key, guestId);
  } catch { /* 存储不可用时，以当前页面为访客。 */ }
  return guestId;
}

function jump(toEnd: boolean): void {
  following.value = toEnd;
  if (toEnd) unreadParts.value = 0;
  if (reader.value) reader.value.scrollTop = toEnd ? reader.value.scrollHeight : 0;
}

function trackScroll(): void {
  const node = reader.value;
  if (node && node.scrollHeight - node.clientHeight - node.scrollTop > 32) following.value = false;
}

function apply(data: StoryState, delta = false): void {
  offset = data.now - Date.now();
  countdown.value = Date.now();
  const old = round.value;
  const next = data.round;
  if (old?.id !== next?.id) {
    if (old) lastRound.value = old.id;
    draft.value = '';
    note.value = '';
    preview.value = undefined;
    speechRequest = '';
    compose.value = undefined;
    following.value = true;
    unreadParts.value = 0;
  } else if (next && old) {
    const latest = old.parts.at(-1)?.seq ?? 0;
    const additions = next.parts.filter(part => part.seq > latest);
    if (!following.value) unreadParts.value += additions.length;
    if (delta) next.parts = [...old.parts, ...additions];
  }
  if (data.preview) preview.value = data.preview;
  if (old?.id !== next?.id || chat.value?.round?.id !== data.chat?.round?.id) {
    chatDraft.value = '';
    chatRequest = '';
  }
  state.value = data;
  if (following.value) void nextTick(() => jump(true));
}

async function poll(): Promise<void> {
  if (polling || busy.value || document.hidden || mode.value !== 'live') return;
  polling = true;
  const request = revision;
  try {
    const current = round.value;
    const params = new URLSearchParams({ visitor: storyGuestId() });
    if (current) {
      params.set('round', current.id);
      params.set('after', String(current.parts.at(-1)?.seq ?? 0));
    }
    const data = await api<StoryState>('/v1/story/live?' + params);
    if (!alive || request !== revision) return;
    apply(data, true);
    problem.value = '';
    if (seat.value && data.round && !data.round.listening && mode.value === 'live') {
      await act('listen', { round: data.round.id }, false);
    }
  } catch (error) {
    if (alive && request === revision) problem.value = (error as Error).message;
  } finally {
    polling = false;
  }
}

async function loop(): Promise<void> {
  await poll();
  if (alive) pollTimer = setTimeout(loop, round.value ? 2_500 : 5_000);
}

async function act(action: string, fields: Record<string, string> = {}, showError = true): Promise<boolean> {
  if (busy.value) return false;
  const request = ++revision;
  busy.value = true;
  try {
    const result = await api<StoryState>('/v1/story/action', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...fields }),
    });
    if (!alive || request !== revision) return false;
    apply(result);
    problem.value = '';
    return true;
  } catch (error) {
    if (alive && request === revision && showError) problem.value = (error as Error).message;
    return false;
  } finally {
    busy.value = false;
  }
}

async function speak(): Promise<void> {
  const id = round.value?.id;
  const text = draft.value.trim();
  if (!id || !text) return;
  if (!speechRequest || speechText !== text) speechRequest = newRequestId();
  speechText = text;
  if (await act('speak', { round: id, text, requestId: speechRequest })) {
    draft.value = '';
    speechRequest = '';
  }
}

async function sendChat(): Promise<void> {
  const text = chatDraft.value.trim();
  if (!seat.value || round.value || !chat.value || !text) return;
  if (!chatRequest || chatText !== text) chatRequest = newRequestId();
  chatText = text;
  const id = chat.value.round?.id;
  if (await act('chat', { ...(id ? { round: id } : {}), text, requestId: chatRequest })) {
    chatDraft.value = '';
    chatRequest = '';
  }
}

function openNote(): void {
  note.value = round.value?.note?.text ?? note.value;
  compose.value = 'note';
}

async function submitInteraction(action: 'note' | 'snack'): Promise<void> {
  const id = round.value?.id;
  if (!id) return;
  const values = action === 'note' ? { text: note.value.trim() } : { item: selectedSnack.value };
  if (await act(action, { round: id, ...values } as Record<string, string>)) {
    compose.value = undefined;
  }
}

async function showArchive(more = false): Promise<void> {
  if (archiveBusy.value) return;
  mode.value = 'archive';
  archive.value = undefined;
  archiveBusy.value = true;
  problem.value = '';
  try {
    const params = new URLSearchParams();
    if (more && before.value) {
      params.set('cursorAt', String(before.value.endedAt));
      params.set('cursorId', before.value.id);
    }
    const data = await api<StoryPage>('/v1/story/archive?' + params);
    rounds.value = more ? [...rounds.value, ...data.rounds] : data.rounds;
    before.value = data.next;
  } catch (error) {
    problem.value = (error as Error).message;
  } finally {
    archiveBusy.value = false;
  }
}

async function openArchive(id: string): Promise<void> {
  mode.value = 'archive';
  archiveBusy.value = true;
  problem.value = '';
  try {
    archive.value = await api<StoryArchive>('/v1/story/archive?id=' + encodeURIComponent(id));
  } catch (error) {
    problem.value = (error as Error).message;
  } finally {
    archiveBusy.value = false;
  }
}

function showLive(): void {
  mode.value = 'live';
  problem.value = '';
  void poll();
}

watch(() => seat.value?.cooId, () => {
  ++revision;
  state.value = undefined;
  compose.value = undefined;
  draft.value = '';
  note.value = '';
  preview.value = undefined;
  chatDraft.value = '';
  chatRequest = '';
  speechRequest = '';
  void poll();
}, { flush: 'sync' });

onMounted(() => {
  countdown.value = Date.now();
  clockTimer = setInterval(() => { countdown.value = Date.now(); }, 250);
  document.addEventListener('visibilitychange', poll);
  void loop();
});
onUnmounted(() => {
  alive = false;
  clearInterval(clockTimer);
  clearTimeout(pollTimer);
  document.removeEventListener('visibilitychange', poll);
});
</script>

<template>
  <section class="story-page" :class="{ 'story-guest': !seat }" aria-label="说书厅">
    <header class="story-nav">
      <div class="story-title">
        <h1>说书人</h1>
        <span v-if="mode === 'live' && state?.present != null" class="story-muted">{{ state.present }} 位在场</span>
      </div>
      <nav aria-label="说书厅导航">
        <button type="button" :aria-pressed="mode === 'live'" @click="showLive">现场</button>
        <button type="button" :aria-pressed="mode === 'archive'" @click="showArchive()">往期</button>
        <a v-if="!seat" href="/play?view=story&amp;join=1">入座</a>
      </nav>
    </header>
    <p v-if="problem" class="story-error" role="alert">{{ problem }}</p>
    <template v-if="mode === 'live'">
      <article v-if="round" class="story-live">
        <header class="story-heading">
          <div>
            <span class="story-phase" :class="{ closing }">{{ closing ? '收尾' : '讲述中' }}</span>
            <h2>{{ round.title }}</h2>
            <p>{{ round.speaker }} · 收到 {{ round.snacks }} 份零食</p>
          </div>
          <time class="story-countdown" aria-label="本场剩余时间">{{ timer }}</time>
        </header>
        <div class="story-reading">
          <button type="button" @click="jump(false)">从头读</button>
          <button type="button" :aria-pressed="following" @click="jump(true)">
            {{ unreadParts ? '回到最新 · ' + unreadParts + ' 段新正文' : '跟到最新' }}
          </button>
        </div>
        <div ref="reader" class="story-transcript" tabindex="0" aria-label="本场正文" @scroll.passive="trackScroll">
          <p v-for="part in round.parts" :key="part.seq">{{ part.text }}</p>
          <p v-if="!round.parts.length" class="story-muted">说书人正在准备开讲。</p>
        </div>
        <section v-if="round.speaking && visibleNotes" class="story-notes" aria-label="收到的纸条">
          <h3>{{ round.batch ? '听众纸条' : '当前收到的纸条' }}</h3>
          <p v-if="!visibleNotes.length">这场还没有纸条。</p>
          <blockquote v-for="(item, index) in visibleNotes" :key="index">
            <p>{{ item.text }}</p><cite>{{ item.name }}</cite>
          </blockquote>
        </section>
        <form v-if="round.speaking" class="story-form" @submit.prevent="speak">
          <label for="story-speech">台上发言</label>
          <textarea id="story-speech" v-model="draft" :maxlength="STORY_PART_LIMIT" rows="3" />
          <div class="story-actions">
            <button class="story-primary" :disabled="busy || !draft.trim() || !secondsLeft" type="submit">发到台上</button>
            <button v-if="!closing" type="button" :disabled="busy || !secondsLeft" @click="act('peek_notes', { round: round.id })">
              {{ preview ? '刷新纸条' : '看看纸条' }}
            </button>
            <button type="button" @click="compose = compose === 'finish' ? undefined : 'finish'">提前下台</button>
          </div>
        </form>
        <div v-else-if="seat" class="story-actions">
          <button type="button" :disabled="closing || busy" @click="openNote">{{ round.note && !closing ? '修改纸条' : '递纸条' }}</button>
          <button type="button" :disabled="round.sentSnack || busy || !secondsLeft" @click="compose = 'snack'">{{ round.sentSnack ? '已送零食' : '送零食' }}</button>
          <button v-if="!state?.queue.position" type="button" :disabled="busy" @click="act('queue')">排队上台</button>
        </div>
        <p v-else class="story-muted">入座后可以递纸条、送零食或上台。</p>
        <p v-if="round.note" class="story-muted" role="status">
          {{ round.note.status === 'waiting' ? '纸条待投递' : round.note.status === 'delivered' ? '纸条已送达' : '纸条未抽中' }}
        </p>
        <form v-if="compose === 'note' && !closing" class="story-form" @submit.prevent="submitInteraction('note')">
          <label for="story-note">给说书人一句话</label>
          <textarea id="story-note" v-model="note" :maxlength="STORY_NOTE_LIMIT" rows="2" />
          <div class="story-actions">
            <button class="story-primary" type="submit" :disabled="busy || !note.trim()">递出纸条</button>
            <button type="button" @click="compose = undefined">取消</button>
          </div>
        </form>
        <form v-if="compose === 'snack'" class="story-form" @submit.prevent="submitInteraction('snack')">
          <label for="story-snack">挑一份零食</label>
          <select id="story-snack" v-model="selectedSnack">
            <option value="" disabled>选择零食</option>
            <option v-for="item in snacks" :key="item.id" :value="item.id">{{ item.icon }} {{ item.name }}</option>
          </select>
          <div class="story-actions">
            <button class="story-primary" type="submit" :disabled="busy || !selectedSnack">送给说书人</button>
            <button type="button" @click="compose = undefined">取消</button>
          </div>
        </form>
        <div v-if="compose === 'finish' && round.speaking" class="story-form">
          <p>现在结束这场说书？已公开的正文会进入往期。</p>
          <div class="story-actions">
            <button type="button" :disabled="busy" @click="act('finish', { round: round.id })">确认下台</button>
            <button type="button" @click="compose = undefined">继续讲</button>
          </div>
        </div>
      </article>
      <section v-else-if="state" class="story-empty">
        <h2>{{ canStart && state.queue.position ? '轮到你了' : '台上还空着' }}</h2>
        <p>可以讲一件你和家长一起经历、愿意和大家分享的小事。</p>
        <div class="story-actions">
          <button v-if="canStart" class="story-primary" type="button" @click="compose = 'start'">上台说书</button>
          <button v-else-if="seat && !state.queue.position" type="button" :disabled="busy" @click="act('queue')">排队上台</button>
          <button v-if="lastRound" type="button" @click="openArchive(lastRound)">回看刚才这场</button>
          <button v-else type="button" @click="showArchive()">看往期</button>
        </div>
        <form v-if="canStart && compose === 'start'" class="story-form" @submit.prevent="act('start', { title: title.trim() })">
          <label for="story-title">题目（可选）</label>
          <input id="story-title" v-model="title" :maxlength="STORY_TITLE_LIMIT">
          <p>每场 10 分钟。台上文字对现场公开，云端可回看 7 天，已同步到本机的副本会继续保留。</p>
          <div class="story-actions">
            <button class="story-primary" type="submit" :disabled="busy">确认开讲</button>
            <button type="button" @click="compose = undefined">取消</button>
          </div>
        </form>
      </section>
      <p v-else-if="!problem" role="status">正在打开说书厅…</p>
      <StoryChat :key="chat?.round?.id ?? 'idle'" :live="chat" :status="chatStatus">
        <form v-if="seat && chat && !round" class="story-form story-chat-form" @submit.prevent="sendChat">
          <label for="story-chat-text">发一条聊天消息</label>
          <textarea id="story-chat-text" v-model="chatDraft" :maxlength="STORY_CHAT_LIMIT" :disabled="busy" rows="2" />
          <div class="story-actions">
            <button class="story-primary" type="submit" :disabled="busy || !chatDraft.trim()">发送</button>
          </div>
        </form>
      </StoryChat>
      <div v-if="state?.queue.position" class="story-actions story-queue">
        <span>{{ canStart ? '请在确认窗口内上台' : '排队中 · 第 ' + state.queue.position + ' 位' }}</span>
        <button type="button" :disabled="busy" @click="act('cancel')">退出排队</button>
      </div>
    </template>
    <template v-else>
      <article v-if="archive" class="story-archive">
        <button type="button" @click="showArchive()">返回往期</button>
        <h2>{{ archive.title }}</h2>
        <p class="story-muted">{{ archive.speaker }} · {{ formatTime.format(archive.startedAt) }} · {{ archive.snacks }} 份零食</p>
        <div class="story-archived-text"><p v-for="part in archive.parts" :key="part.seq">{{ part.text }}</p></div>
        <StoryChat v-if="seat" :key="`${seat.cooId}:${archive.id}`" :archive-id="archive.id" />
      </article>
      <section v-else>
        <h2>最近 7 天</h2>
        <p v-if="archiveBusy" role="status">正在读取往期…</p>
        <p v-else-if="!rounds.length && !problem" class="story-muted">还没有可以回看的说书记录。</p>
        <ul class="story-archive-list">
          <li v-for="item in rounds" :key="item.id">
            <button type="button" :disabled="archiveBusy" @click="openArchive(item.id)">
              <strong>{{ item.title }}</strong>
              <span>{{ item.speaker }} · {{ formatTime.format(item.startedAt) }}</span>
            </button>
          </li>
        </ul>
        <button v-if="before" type="button" :disabled="archiveBusy" @click="showArchive(true)">更早的场次</button>
      </section>
    </template>
  </section>
</template>

<style scoped>
.story-page { width: min(100%, 49rem); margin-inline: auto; padding: clamp(1rem, 4vw, 2.75rem); color: var(--text); }
.story-guest { min-height: 100vh; }
.story-nav, .story-title, .story-heading, .story-actions, .story-reading { display: flex; align-items: center; gap: .65rem; flex-wrap: wrap; }
.story-nav, .story-heading { justify-content: space-between; }
.story-nav { border-bottom: 1px solid var(--line-2); padding-bottom: .9rem; margin-bottom: 1.4rem; }
.story-nav nav { display: flex; align-items: center; gap: .4rem; }
.story-nav h1, .story-heading h2, .story-empty h2, .story-archive h2 { margin: 0; }
.story-nav h1 { font-size: 1.15rem; }
.story-heading h2, .story-empty h2, .story-archive h2 { font-size: clamp(1.6rem, 5vw, 2.35rem); overflow-wrap: anywhere; }
.story-heading p, .story-muted { color: var(--muted, var(--text)); font-size: .9rem; }
.story-phase { display: inline-block; margin-bottom: .5rem; color: var(--muted, var(--text)); }
.story-phase.closing { font-weight: 700; color: var(--accent, var(--text)); }
.story-countdown { font-size: clamp(1.45rem, 4vw, 2rem); font-variant-numeric: tabular-nums; }
.story-reading { justify-content: flex-end; margin-bottom: .45rem; }
.story-reading button { font-size: .85rem; }
.story-transcript, .story-archived-text { line-height: 1.85; font-size: 1.08rem; }
.story-transcript { min-height: 13rem; max-height: 42vh; overflow-y: auto; overscroll-behavior: contain; padding: .4rem .9rem; border-block: 1px solid var(--line-2); margin-bottom: 1rem; }
.story-transcript p, .story-archived-text p, .story-notes p { white-space: pre-wrap; overflow-wrap: anywhere; }
.story-form, .story-notes, .story-queue { margin-block: 1rem; padding: .85rem; border: 1px solid var(--line-2); border-radius: .65rem; background: var(--panel-2); }
.story-form { display: grid; gap: .55rem; }
.story-chat-form { border: 0; margin-bottom: 0; padding: 0; }
.story-form p, .story-notes h3 { margin: 0; }
.story-notes blockquote { margin: .65rem 0 0; padding-left: .8rem; border-left: 2px solid var(--line-2); }
.story-notes blockquote p { margin: 0; }
.story-page button, .story-form :is(textarea, input, select) { font: inherit; color: inherit; padding: .48rem .7rem; border: 1px solid var(--line-2); border-radius: .5rem; background: var(--panel-2); }
.story-page button { cursor: pointer; }
.story-page button:disabled { cursor: default; opacity: .55; }
.story-page button.story-primary, .story-nav button[aria-pressed=true] { background: var(--text); color: var(--panel-2); }
.story-error { padding: .6rem 0; font-weight: 650; }
.story-archive-list { padding: 0; list-style: none; }
.story-archive-list button { width: 100%; text-align: left; display: grid; gap: .35rem; margin-bottom: .45rem; overflow-wrap: anywhere; }
.story-archive-list span { font-size: .88rem; }
.story-archive > button { margin-bottom: .8rem; }
@media (max-width: 520px) { .story-transcript { max-height: 38vh; padding-inline: .25rem; } }
</style>
