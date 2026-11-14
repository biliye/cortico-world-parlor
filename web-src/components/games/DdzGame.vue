<script setup lang="ts">
/**
 * 斗地主桌面（Vue 版）：DOM 结构与类名沿用旧渲染器，样式仍由 play.css 提供，
 * 所以外观不另起一套；旧渲染器 src/web/games/ddz.js 已随旧页在 0.40.0 删除。
 * 规则、牌型、提示、计分全在服务器；这里只摆牌、按钮和结果。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { GameCtx, GameView } from '../../lib/legacy-games.ts';
import { cardLabel, fmtClock, sortHand } from '../../lib/cards.ts';
import { initialOf, readable } from '../../lib/text.ts';
import ClockText from './ClockText.vue';
import Icon from '../Icon.vue';
import PlayingCard from './PlayingCard.vue';

const props = defineProps<{ view: GameView; ctx: GameCtx }>();

interface DdzArt { rank?: string; suit?: string | null }
interface DdzSeat { id: string; name: string; bot?: boolean; role?: string; cardsLeft?: number }
interface DdzPlay { seat: string; cards?: string[]; playedCards?: DdzArt[]; label?: string }
interface DdzTable {
  status?: string;
  seats?: DdzSeat[];
  turn?: string;
  deadline?: number;
  multiplier?: number;
  landlord?: string;
  bottom?: string[];
  bottomCards?: DdzArt[];
  plays?: DdzPlay[];
  passed?: string[];
  lastPlay?: DdzPlay;
  result?: string;
  winners?: string[];
  revealed?: Array<{ id: string; cards?: string[]; handCards?: DdzArt[] }>;
  spring?: boolean;
  antiSpring?: boolean;
}
interface DdzPriv {
  yourTurn?: boolean;
  hand?: string[];
  handCards?: DdzArt[];
  status?: string;
  hint?: { bid?: boolean; cards?: string[]; label?: string; pass?: boolean };
  canPass?: boolean;
  deadline?: number;
  landlord?: string;
  multiplier?: number;
  revision?: number;
}

type Seat = NonNullable<DdzTable['seats']>[number];

const table = computed(() => props.view.table as unknown as DdzTable);
const priv = computed(() => props.view.priv as unknown as DdzPriv | null);
const me = computed(() => props.view.me);
const seats = computed<Seat[]>(() => table.value.seats ?? []);
const ended = computed(() => table.value.status === 'ended');
const myTurn = computed(() => !!priv.value?.yourTurn);
const seated = computed(() => seats.value.some((seat) => seat.id === me.value.id));
const anchor = computed(() => {
  const index = seats.value.findIndex((seat) => seat.id === me.value.id);
  return index >= 0 ? index : 0;
});
const mySeat = computed<Seat | null>(() => seats.value[anchor.value] ?? null);
const leftSeat = computed<Seat | null>(() => (seats.value.length
  ? seats.value[(anchor.value + 1) % seats.value.length] : null));
const rightSeat = computed<Seat | null>(() => (seats.value.length
  ? seats.value[(anchor.value + seats.value.length - 1) % seats.value.length] : null));
const spectating = computed(() => !seated.value);

function nameOf(id?: string, fallback = '？'): string {
  if (!id) return fallback;
  return props.view.names.get(id) || fallback;
}
function avatarClass(seat: Seat, size: string): string {
  const info = (props.view.seats || []).find((entry) => entry.id === seat.id);
  const isPet = info?.kind === 'pet';
  return ['avatar', size, isPet ? 'avatar-coo' : (props.view.classes.get(seat.id) || 's1')]
    .filter(Boolean).join(' ');
}
function isPet(seat: Seat): boolean {
  return (props.view.seats || []).some((entry) => entry.id === seat.id && entry.kind === 'pet');
}
function isOnline(seat: Seat): boolean {
  return props.view.online.includes(seat.id);
}
function isTurn(seat: Seat | null): boolean {
  return !!seat && seat.id === table.value.turn
    && (table.value.status === 'bidding' || table.value.status === 'playing');
}
function countOf(seat: Seat): number {
  return Math.max(0, Number(seat.cardsLeft) || 0);
}
function stackSlots(seat: Seat): number {
  return Math.max(1, Math.min(countOf(seat), 20));
}
function roleOf(role?: string): string {
  return role === 'landlord' || role === 'farmer' ? role : '';
}

/* —— 桌面数据 —— */
const myHand = computed<string[]>(() => (Array.isArray(priv.value?.hand) ? priv.value.hand : []));
const handCount = computed(() => myHand.value.length);
const orderedHand = computed(() => sortHand(myHand.value));
const handKey = computed(() => myHand.value.join(',') + '|' + (priv.value?.status ?? ''));
const selection = ref<Set<number>>(new Set());
watch(handKey, () => { selection.value = new Set(); });

function handArt(index: number): DdzArt | null {
  return priv.value?.handCards?.[index] ?? null;
}
function bottomArt(index: number): DdzArt | null {
  return table.value.bottomCards?.[index] ?? null;
}
const playsInfo = computed(() => {
  const entries = new Map<string, DdzPlay>();
  for (const entry of table.value.plays ?? []) entries.set(entry.seat, entry);
  const passed = new Set(table.value.passed ?? []);
  if (!entries.size && !passed.size && table.value.lastPlay) entries.set(table.value.lastPlay.seat, table.value.lastPlay);
  return { entries, passed };
});
const playSlots = computed(() => [
  { side: 'left', seat: leftSeat.value },
  { side: 'me', seat: mySeat.value },
  { side: 'right', seat: rightSeat.value },
]);
const sideColumns = computed(() => [
  { side: 'left', seat: leftSeat.value },
  { side: 'right', seat: rightSeat.value },
].filter((column): column is { side: string; seat: Seat } => column.seat !== null));

function playName(side: string, seat: Seat): string {
  const whose = side === 'me' && !spectating.value ? '你' : nameOf(seat.id, seat.name);
  const left = spectating.value && side === 'me' ? ' · 剩 ' + countOf(seat) + ' 张' : '';
  return whose + left;
}

/* —— 我的手牌：放不下时靠 --overlap 收紧，再不行横向滑 —— */
const handEl = ref<HTMLElement | null>(null);
function fitHand(): void {
  const hand = handEl.value;
  const count = handCount.value;
  if (!hand || count < 2) return;
  const card = hand.firstElementChild as HTMLElement | null;
  if (!card) return;
  const cardWidth = card.offsetWidth;
  const available = hand.clientWidth - 24;
  if (!cardWidth || available <= 0) return;
  const maxStep = cardWidth * 0.66;
  const fitStep = (available - cardWidth) / (count - 1);
  const readableStep = cardWidth >= 60 ? 26 : Math.max(24, cardWidth * 0.5);
  const step = Math.max(Math.min(readableStep, maxStep), Math.min(maxStep, fitStep));
  hand.style.setProperty('--overlap', (step - cardWidth).toFixed(1) + 'px');
}

onMounted(() => {
  fitHand();
  window.addEventListener('resize', fitHand);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', fitHand);
});
watch(() => orderedHand.value.length, () => { void nextTick(fitHand); });

/* —— 顶部与操作条 —— */
const pillText = computed(() => {
  if (table.value.status === 'bidding') return myTurn.value ? '轮到你叫' : '叫地主';
  return myTurn.value ? '轮到你出' : '出牌';
});
const mineText = computed(() => {
  if (spectating.value) return '旁观中';
  const hand = Array.isArray(priv.value?.hand) ? ' · 手牌 ' + priv.value.hand.length + ' 张' : '';
  return nameOf(me.value.id, me.value.name) + hand;
});
const deadline = computed(() => Number(priv.value?.deadline || table.value.deadline || 0));
const turnSeat = computed<Seat | null>(() => seats.value.find((seat) => seat.id === table.value.turn) ?? null);
const botTurn = computed(() => !!turnSeat.value?.bot && !myTurn.value);
const showClock = computed(() => !!deadline.value && !botTurn.value);
const selectedCount = computed(() => selection.value.size);

function toggleCard(index: number): void {
  if (!myTurn.value) return;
  const next = new Set(selection.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  selection.value = next;
}
function applyHint(): void {
  const hint = priv.value?.hint;
  if (!hint || !priv.value) return;
  if (hint.pass) {
    props.ctx.toast('这手没有能压过的牌，可以点「不要」。');
    return;
  }
  if (Array.isArray(hint.cards)) {
    const next = new Set<number>();
    const used = new Set<number>();
    for (const card of hint.cards) {
      const index = (priv.value.hand ?? []).findIndex((entry, i) => entry === card && !used.has(i));
      if (index >= 0) {
        next.add(index);
        used.add(index);
      }
    }
    selection.value = next;
  }
}
function sendAction(body: Record<string, unknown>): void {
  const submittedSelection = selection.value;
  void props.ctx.act(body).then((receipt) => {
    if (receipt && selection.value === submittedSelection) selection.value = new Set();
  }).catch(() => {});
}
function sendBid(call: boolean): void {
  sendAction({ type: 'ddz_action', move: 'bid', call });
}
function sendPlay(): void {
  const cards = [...selection.value].sort((left, right) => left - right)
    .map((index) => (priv.value?.hand ?? [])[index]);
  if (!cards.length) {
    props.ctx.toast('先点几张牌');
    return;
  }
  sendAction({ type: 'ddz_action', move: 'play', cards });
}
function sendPass(): void {
  sendAction({ type: 'ddz_action', move: 'pass' });
}
function clearSelection(): void {
  selection.value = new Set();
}

const statusText = computed(() => {
  if (ended.value) return '';
  const hint = priv.value?.hint;
  if (table.value.status === 'bidding') {
    if (myTurn.value && typeof hint?.bid === 'boolean') {
      return '提示：这手牌建议' + (hint.bid ? '叫地主' : '不叫') + '。';
    }
    return '';
  }
  if (myTurn.value && priv.value) {
    if (Array.isArray(hint?.cards) && hint.cards.length) {
      const labels = hint.cards.map((card) => cardLabel(card)).join(' ');
      return '提示：可以出 ' + labels + (hint.label ? '（' + hint.label + '）' : '');
    }
    return '';
  }
  if (seated.value && table.value.turn) {
    return '等 ' + nameOf(table.value.turn) + (table.value.status === 'bidding' ? ' 叫地主' : ' 出牌') + '。';
  }
  return '';
});

/* —— 结算 —— */
const end = computed(() => {
  const event = props.view.endEvent as { data?: Record<string, unknown> } | null;
  const data = { ...table.value, ...(event?.data ?? {}) } as {
    revealed?: Array<{ id: string; cards?: string[]; handCards?: DdzArt[] }>;
    winners?: string[];
    landlord?: string;
    spring?: boolean;
    antiSpring?: boolean;
    multiplier?: number;
  };
  const revealed = Array.isArray(data.revealed) ? data.revealed : [];
  const winners = Array.isArray(data.winners) ? data.winners : [];
  const landlordId = data.landlord || priv.value?.landlord
    || (table.value.seats || []).find((seat) => seat.role === 'landlord')?.id;
  const landlordWon = landlordId && winners.length ? winners.includes(landlordId) : null;
  const result = readable(table.value.result || '');
  const side = landlordWon === true ? '地主赢'
    : landlordWon === false ? '农民赢'
      : result.includes('地主赢') ? '地主赢'
        : result.includes('农民赢') ? '农民赢' : '这局结束了';
  const extra = data.spring ? ' · 春天' : data.antiSpring ? ' · 反春' : '';
  const multiplier = data.multiplier || priv.value?.multiplier || table.value.multiplier || 1;
  const winnersText = winners.map((id) => nameOf(id, id)).join('、');
  const rows = (table.value.seats || []).map((seat) => {
    const row = revealed.find((entry) => entry.id === seat.id);
    return {
      seat,
      row: row ?? null,
      isLord: seat.id === landlordId,
      won: winners.includes(seat.id),
    };
  });
  return { side, extra, multiplier, winnersText, rows, winnerSide: landlordWon === false };
});
function endCards(row: { cards?: string[]; handCards?: DdzArt[] } | null): string[] {
  return row && Array.isArray(row.cards) ? row.cards : [];
}
function endArt(row: { cards?: string[]; handCards?: DdzArt[] } | null, index: number): DdzArt | null {
  return row?.handCards?.[index] ?? null;
}
</script>

<template>
  <section class="panel game-ddz">
    <div v-if="ended" class="ddz-end">
      <div class="ddz-end-banner" :class="{ 'farmers-win': end.winnerSide }">
        <span class="ddz-end-kicker">斗地主 · 已结束</span>
        <h2>{{ end.side }}{{ end.extra }}</h2>
        <p>
          倍数 ×{{ end.multiplier }}<template v-if="end.winnersText"> · 赢家 {{ end.winnersText }}</template>
        </p>
      </div>
      <div class="ddz-end-seats">
        <div
          v-for="row in end.rows"
          :key="row.seat.id"
          class="ddz-end-seat"
          :class="{ 'is-winner': row.won, 'is-landlord': row.isLord }"
        >
          <div class="ddz-end-seat-head">
            <span :class="avatarClass(row.seat, 'avatar-sm')">{{ initialOf(row.seat.name) }}</span>
            <div class="ddz-end-copy">
              <div class="ddz-end-name">
                {{ nameOf(row.seat.id, row.seat.name) }}{{ row.seat.id === me.id ? '（你）' : '' }}{{ row.seat.bot ? '（脚本）' : '' }}
              </div>
              <span class="tag" :class="row.isLord ? 'tag-landlord' : 'tag-farmer'">
                <Icon v-if="row.isLord" name="crown" />{{ row.isLord ? '地主' : '农民' }}
              </span>
            </div>
            <span v-if="row.won" class="ddz-end-win">赢</span>
          </div>
          <div class="ddz-end-cards">
            <template v-if="endCards(row.row).length">
              <PlayingCard
                v-for="(card, index) in endCards(row.row)"
                :key="'end-' + row.seat.id + '-' + index"
                :card="card"
                :art="endArt(row.row, index)"
                :small="true"
              />
            </template>
            <span v-else-if="!row.row && (row.seat.cardsLeft ?? 0) > 0" class="ddz-end-empty">剩 {{ row.seat.cardsLeft }} 张</span>
            <span v-else class="ddz-end-empty">出完了</span>
          </div>
        </div>
      </div>
      <div class="ddz-actions">
        <button class="btn primary" type="button" @click="ctx.rematch()">再来一局</button>
        <button class="btn ghost" type="button" @click="ctx.showLobby()">返回客厅</button>
      </div>
    </div>

    <template v-else>
      <div class="ddz-board" :class="{ 'is-my-turn': myTurn }">
        <div class="ddz-topbar">
          <span class="ddz-pill" :class="{ live: myTurn }">
            <span v-if="myTurn" class="live-dot" />
            {{ pillText }}
          </span>
          <span v-if="table.multiplier" class="ddz-chip">倍数 ×{{ table.multiplier }}</span>
          <span v-if="table.status === 'playing' && table.landlord" class="ddz-chip gold">地主 {{ nameOf(table.landlord, table.landlord) }}</span>
          <span class="ddz-seat-mine">{{ mineText }}</span>
        </div>

        <div class="ddz-bottoms">
          <span class="ddz-bottom-label">底牌</span>
          <div class="ddz-bottom-cards">
            <template v-if="table.bottom && table.bottom.length">
              <PlayingCard
                v-for="(card, index) in table.bottom"
                :key="'bottom-' + index"
                :card="card"
                :art="bottomArt(index)"
                :small="true"
              />
            </template>
            <template v-else>
              <div v-for="index in 3" :key="'back-' + index" class="pcard back small-card" aria-hidden="true" />
            </template>
          </div>
        </div>

        <div class="ddz-grid">
          <div v-for="column in sideColumns" :key="'seat-' + column.side" :class="['ddz-side', 'ddz-side-' + column.side]">
            <div :class="['ddz-stack', { 'is-turn': isTurn(column.seat) }]" aria-hidden="true">
              <i v-for="index in stackSlots(column.seat)" :key="'cardback-' + index" class="ddz-back" />
            </div>
            <div :class="['ddz-side-info', { 'is-turn': isTurn(column.seat), 'is-landlord': column.seat.role === 'landlord' }]">
              <span :class="avatarClass(column.seat, 'avatar')">
                {{ initialOf(column.seat.name) }}
                <span v-if="isPet(column.seat)" class="avatar-badge"><Icon name="spark" /></span>
                <span v-if="isOnline(column.seat)" class="status-dot online" />
              </span>
              <span v-if="roleOf(column.seat.role)" class="tag" :class="column.seat.role === 'landlord' ? 'tag-landlord' : 'tag-farmer'">
                <Icon v-if="column.seat.role === 'landlord'" name="crown" />{{ column.seat.role === 'landlord' ? '地主' : '农民' }}
              </span>
              <div class="ddz-side-name">{{ nameOf(column.seat.id, column.seat.name) }}</div>
              <div class="ddz-side-meta">
                <span class="ddz-left-count">{{ countOf(column.seat) }} 张</span>
                <span v-if="isTurn(column.seat)" class="ddz-think">{{ table.status === 'bidding' ? '正在叫…' : '正在想…' }}</span>
              </div>
              <span v-if="column.seat.bot" class="ddz-bot-mark">脚本</span>
            </div>
          </div>

          <div class="ddz-center">
            <div v-if="table.status !== 'bidding'" class="ddz-plays">
              <div v-for="slot in playSlots" :key="'play-' + slot.side" :class="['ddz-play', 'ddz-play-' + slot.side]">
                <template v-if="slot.seat">
                  <span class="ddz-play-name">
                    {{ playName(slot.side, slot.seat) }}<template v-if="playsInfo.entries.get(slot.seat.id)?.label"> · {{ playsInfo.entries.get(slot.seat.id)?.label }}</template>
                  </span>
                  <div class="ddz-play-cards">
                    <template v-if="playsInfo.entries.get(slot.seat.id)?.cards?.length">
                      <PlayingCard
                        v-for="(card, index) in playsInfo.entries.get(slot.seat.id)?.cards"
                        :key="'playcard-' + slot.side + '-' + index"
                        :card="card"
                        :art="playsInfo.entries.get(slot.seat.id)?.playedCards?.[index] ?? null"
                        :small="true"
                      />
                    </template>
                    <span v-else-if="playsInfo.passed.has(slot.seat.id)" class="ddz-play-pass">不要</span>
                    <span v-else-if="table.turn === slot.seat.id && table.status !== 'ended'" class="ddz-play-quiet">
                      {{ table.status === 'bidding' ? '叫地主' : '在想' }}…
                    </span>
                    <span v-else class="ddz-play-quiet">—</span>
                  </div>
                </template>
              </div>
            </div>
            <div v-if="table.status === 'bidding'" class="ddz-center-note">叫地主 · 底牌先扣着</div>
          </div>

          <div class="ddz-handbar">
            <div class="ddz-actionbar">
              <div class="ddz-actions">
                <template v-if="table.status === 'bidding'">
                  <template v-if="myTurn">
                    <button class="btn primary" type="button" @click="sendBid(true)">叫地主</button>
                    <button class="btn" type="button" @click="sendBid(false)">不叫</button>
                  </template>
                  <span v-else-if="seated" class="ddz-wait">等 {{ nameOf(table.turn) }} 叫地主</span>
                  <span v-else class="ddz-wait">旁观中</span>
                </template>
                <template v-else-if="myTurn">
                  <button class="btn primary" type="button" :disabled="selectedCount === 0" @click="sendPlay">出牌</button>
                  <button
                    class="btn"
                    type="button"
                    :disabled="priv?.canPass !== true"
                    :title="priv?.canPass === true ? '' : '你先出，必须出牌'"
                    @click="sendPass"
                  >不要</button>
                  <button class="btn small" type="button" @click="applyHint">提示</button>
                  <button class="btn ghost small" type="button" :disabled="selectedCount === 0" @click="clearSelection">清空</button>
                  <span v-if="selectedCount" class="ddz-selected">已选 {{ selectedCount }} 张</span>
                </template>
                <template v-else-if="seated">
                  <span class="ddz-wait">等 {{ nameOf(table.turn) }} 出牌</span>
                </template>
                <span v-else class="ddz-wait">旁观中</span>
              </div>
              <span v-if="showClock" class="ddz-clock">
                本回合 {{ fmtClock(deadline) }} · <ClockText :deadline="deadline" :server-now="ctx.serverNow" />
              </span>
              <span v-else-if="botTurn" class="ddz-clock quiet">脚本在想…</span>
            </div>

            <div v-if="handCount" ref="handEl" class="ddz-hand">
              <PlayingCard
                v-for="item in orderedHand"
                :key="'hand-' + item.index"
                :card="item.card"
                :art="handArt(item.index)"
                :selected="selection.has(item.index)"
                :clickable="myTurn"
                @pick="toggleCard(item.index)"
              />
            </div>
            <div v-else class="ddz-hand-empty">你在旁观；这一局结束后可以坐下一桌。</div>
          </div>
        </div>
      </div>

      <div v-if="statusText" class="ddz-status-line"><span>{{ statusText }}</span></div>
    </template>
  </section>
</template>
