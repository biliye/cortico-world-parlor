<script setup lang="ts">
/**
 * 聊天侧栏：客厅/牌桌/信箱三个频道。
 * 过滤与边界文案在 lib/chat-lines.ts、lib/chat-copy.ts，便于单测。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { clockText, initialOf, readable } from '../lib/text.ts';
import { chatChannelAccepts, chatLineMatchesTable, chatLineVisible } from '../lib/chat-lines.ts';
import {
  TABLE_ROOM_HINT, TABLE_TALK_PREFIX,
  roomPlaceholder, roomScopeText, tableEmptyText, tablePlaceholder, tableScopeText,
} from '../lib/chat-copy.ts';
import {
  chooseTab, closeSheet, draftFor, draftKey, saveDraftFor, sheetOpen, tab, toggleChat, unread,
} from '../stores/chat.ts';
import { openThread as openDmThread, openWindow as openDmWindow } from '../stores/dm.ts';
import {
  acceptInvite, declineInvite, error as mailError, inviteErrorText, items as mailItems,
  loadMail, loading as mailLoading, markAllRead, unread as mailUnread,
} from '../stores/mail.ts';
import { act, activeTable, goRoom, log, myTable, snapshot, tableIdOf } from '../stores/parlor.ts';
import { seat } from '../stores/session.ts';
import { showToast } from '../stores/ui.ts';

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
    if (!chatLineVisible(type)) continue;
    if (!chatChannelAccepts(channel, type)) continue;
    if (channel === 'table' && !chatLineMatchesTable((event.data as Record<string, unknown> | undefined)?.tableId, myTableId.value)) continue;
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
      text: (tableTalk ? TABLE_TALK_PREFIX : '') + readable(event.text || ''),
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

// 进页面时先把已有回放落到底部（首次挂载时 log 已经补完，watcher 不会再触发）。
onMounted(() => { void nextTick(toBottom); });

watch(tab, (next) => {
  void nextTick(toBottom);
  if (next === 'mail') void loadMail(true);
}, { immediate: true });

const readingAll = ref(false);
const hiddenUnread = computed(() => Math.max(0, mailUnread.value - mailItems.value.filter(item => item.read === false).length));

// 快照里的未读变了（新私聊/新邀请）：正看着信箱就顺手刷新列表。
watch(mailUnread, (next, prev) => {
  if (tab.value === 'mail' && next !== prev && !readingAll.value) void loadMail(true);
});

async function readAll(): Promise<void> {
  if (readingAll.value) return;
  readingAll.value = true;
  try {
    const result = await markAllRead();
    if (result) showToast(`已标记 ${result.changed} 封，剩余 ${result.remaining} 封未读。`);
  } catch (caught) {
    showToast((caught as Error).message || '标不上已读', 'bad');
  } finally {
    readingAll.value = false;
  }
}

function onMail(item: { kind?: string; fromCooId?: string; fromName?: string; fromHandle?: string }): void {
  if (item.kind !== 'whisper' || !item.fromCooId) return;
  openDmWindow();
  void openDmThread(item.fromCooId, item.fromName, item.fromHandle);
}

async function accept(item: Parameters<typeof acceptInvite>[0]): Promise<void> {
  try {
    const room = await acceptInvite(item);
    if (!room) {
      showToast('这封邀请没有目的地', 'bad');
      return;
    }
    if (room === seat.value?.room) {
      showToast('你现在就在这个客厅里。');
      return;
    }
    showToast('接受了，正在进这个客厅…');
    await goRoom(room);
  } catch (caught) {
    showToast(inviteErrorText(caught), 'bad');
    await loadMail(true);
  }
}

async function decline(item: Parameters<typeof declineInvite>[0]): Promise<void> {
  try {
    await declineInvite(item);
    showToast('已经拒绝这个邀请');
  } catch (caught) {
    showToast(inviteErrorText(caught), 'bad');
  }
}

function enterRoom(room?: string): void {
  if (room) void goRoom(room);
}

const input = ref('');
const notice = ref('');
const scopeKey = computed(() => draftKey(tab.value === 'table' ? 'table' : 'room', tab.value === 'table' ? myTableId.value : ''));

watch(scopeKey, (next) => { input.value = draftFor(next); }, { immediate: true });

const scopeText = computed(() => {
  if (tab.value === 'mail') return '';
  if (tab.value === 'table') {
    const watching = activeTable.value;
    const mine = myTable.value;
    return tableScopeText({
      tableOpen: tableOpen.value,
      elsewhere: !!watching && !!mine && tableIdOf(watching) !== tableIdOf(mine),
      werewolfActive: watching?.game === 'werewolf' && watching?.status !== 'open',
    });
  }
  return roomScopeText(inHall.value);
});

const placeholder = computed(() => {
  if (tab.value === 'table') return tablePlaceholder(tableOpen.value);
  return roomPlaceholder(inHall.value);
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
    const receipt = await act(tab.value === 'table' ? { type: 'table_say', text } : { type: 'say', text });
    if (!receipt) throw new Error('上一个动作还没回话，稍等一下再发');
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
          <button v-if="tab === 'mail' && mailUnread" class="btn ghost small" type="button" :disabled="readingAll" @click="readAll">都看过了</button>
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
          :aria-selected="tab === 'mail'" @click="chooseTab('mail')">
          信箱
          <span v-if="mailUnread" class="tab-count">{{ mailUnread }}</span>
        </button>
      </div>

      <div class="chat-body">
        <div v-if="tab !== 'mail'" ref="logBox" class="chat-log">
          <p v-if="!lines.length" class="chat-empty">
            <template v-if="tab === 'table'">
              {{ tableEmptyText(tableOpen) }}
              <span v-if="tableOpen" class="muted"><br>{{ TABLE_ROOM_HINT }}</span>
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
          <p v-if="mailLoading && !mailItems.length" class="chat-empty">正在取信箱…</p>
          <p v-else-if="mailError" class="chat-empty bad">{{ mailError }}</p>
          <p v-else-if="!mailItems.length" class="chat-empty">信箱是空的。</p>
          <article
            v-for="item in mailItems"
            :key="item.id"
            class="mail-item"
            :class="{
              'is-unread': item.read === false,
              'is-invite': item.kind === 'invite',
              'is-dm': item.kind === 'whisper',
            }"
            @click="onMail(item)"
          >
            <span class="mail-seal" :class="{ 'is-system': item.fromName === '系统' }" />
            <div class="mail-copy">
              <div class="mail-meta">
                <strong>{{ item.fromName || '系统' }}</strong>
                <span v-if="item.fromHandle" class="mail-handle">#{{ item.fromHandle }}</span>
                <time>{{ clockText(item.ts) }}</time>
              </div>
              <p>{{ readable(item.text) }}</p>
              <span class="mail-sub">只有你能看</span>
              <div v-if="item.kind === 'invite' && item.action === 'room_invite' && item.invitationId" class="mail-actions">
                <button class="btn primary small" type="button" @click.stop="accept(item)">接受并进去</button>
                <button class="btn ghost small" type="button" @click.stop="decline(item)">拒绝</button>
              </div>
              <template v-else-if="item.kind === 'invite' && item.room">
                <span v-if="item.room === seat?.room" class="mail-sub">你现在就在这儿</span>
                <button v-else class="ghost-btn mail-go" type="button" @click.stop="enterRoom(item.room)">进去</button>
              </template>
            </div>
            <span v-if="item.read === false" class="unread-dot" />
          </article>
          <p v-if="hiddenUnread" class="chat-empty">
            列表外还有 {{ hiddenUnread }} 封未读。
          </p>
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
