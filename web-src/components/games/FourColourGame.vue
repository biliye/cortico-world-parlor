<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  COLOUR_LABELS, FOUR_COLOURS, fourColourFaceText, type FourColour,
} from '../../../src/room/games/four-colour-rules.ts';
import type { FourColourTable } from '../../../src/room/games/four-colour-table.ts';
import type { GameCtx, GameView } from '../../lib/game-types.ts';
import { initialOf } from '../../lib/text.ts';
import FourColourCard from './FourColourCard.vue';
import TableSpeech from './TableSpeech.vue';

const props = defineProps<{ view: GameView; ctx: GameCtx }>();
type PublicTable = ReturnType<FourColourTable['public']>;
type PrivateTable = NonNullable<ReturnType<FourColourTable['view']>>;

const table = computed(() => props.view.table as unknown as PublicTable);
const mine = computed(() => props.view.priv as PrivateTable | null);
const ended = computed(() => table.value.status === 'ended');
const actions = computed(() => props.view.table.frozen ? [] : mine.value?.actions ?? []);
const selected = ref<number | null>(null);
const busy = ref(false);
const selectedCard = computed(() => mine.value?.hand.find(card => card.id === selected.value));
const turnName = computed(() => table.value.seats.find(seat => seat.id === table.value.turn)?.name);
// 手牌很多时限制桌边牌堆的长度，名牌继续显示实际张数。
const MAX_VISIBLE_BACKS = 7;
const opponents = computed(() => {
  const seats = table.value.seats;
  const own = seats.findIndex(seat => seat.id === props.view.me.id);
  const otherSeats = own < 0 ? seats : [...seats.slice(own + 1), ...seats.slice(0, own)];
  const layout = { 1: ['top'], 2: ['left', 'right'], 3: ['left', 'top', 'right'], 4: ['left', 'top', 'right', 'bottom'] } as const;
  return otherSeats.map((seat, index) => ({ ...seat, spot: layout[otherSeats.length as keyof typeof layout]?.[index] }));
});

watch(() => mine.value?.playable, (playable) => {
  if (selected.value !== null && !playable?.includes(selected.value)) selected.value = null;
});

function isPlayable(card: number): boolean {
  return actions.value.includes('play') && !!mine.value?.playable.includes(card);
}

function selectCard(card: number): void {
  if (isPlayable(card)) selected.value = selected.value === card ? null : card;
}

async function submit(action: 'draw' | 'play' | 'pass', colour?: FourColour): Promise<void> {
  if (busy.value || !actions.value.includes(action)) return;
  const card = selectedCard.value;
  if (action === 'play' && (!card || !isPlayable(card.id) || (card.colour === null && !colour))) return;
  busy.value = true;
  try {
    const result = await props.ctx.act({
      type: 'four-colour_action', action,
      ...(action === 'play' && card ? { card: card.id, ...(colour ? { colour } : {}) } : {}),
    });
    if (result) selected.value = null;
  } catch { /* 状态层统一提示提交错误。 */ }
  finally { busy.value = false; }
}
</script>

<template>
  <section class="colour-table" aria-label="四彩牌桌">
    <div class="colour-felt">
      <header class="colour-status">
        <strong v-if="ended">本局结束</strong>
        <strong v-else-if="mine?.yourTurn">轮到你</strong>
        <span v-else>轮到 {{ turnName || '同桌玩家' }}</span>
        <span v-if="!ended" class="direction">{{ table.direction === 1 ? '↻ 顺时针' : '↺ 逆时针' }}</span>
      </header>

      <div v-for="opponent in opponents" :key="opponent.id" class="colour-seat"
        :class="['spot-' + opponent.spot, { 'their-turn': table.turn === opponent.id }]">
        <div v-if="opponent.count > 0" class="opponent-stack" aria-hidden="true">
          <FourColourCard v-for="index in Math.min(opponent.count, MAX_VISIBLE_BACKS)" :key="index" class="opponent-back" />
        </div>
        <div class="colour-seat-tag">
          <span class="colour-avatar" aria-hidden="true">{{ initialOf(opponent.name) }}</span>
          <span class="colour-name" :title="opponent.name">{{ opponent.name }}</span>
          <span class="colour-count" :class="{ 'last-card': opponent.count === 1 }">{{ opponent.count }} 张</span>
        </div>
        <TableSpeech v-if="mine && !ended" :table="view.table.tableId || view.table.id || ''"
          :sender="opponent.id" :align="opponent.spot === 'left' ? 'left' : opponent.spot === 'right' ? 'right' : 'center'" />
      </div>

      <div class="colour-centre">
        <strong v-if="ended" class="colour-result">
          {{ table.seats.find(seat => table.winners?.includes(seat.id))?.name }} 出完了手牌
        </strong>
        <div class="colour-piles">
          <div class="colour-pile">
            <button type="button" class="card-button" aria-label="摸牌"
              :disabled="busy || !actions.includes('draw')" @click="submit('draw')">
              <FourColourCard />
            </button>
            <span>摸牌堆 · {{ table.stockCount }}</span>
          </div>
          <div v-if="table.top" class="colour-pile">
            <div class="top-card"><FourColourCard :face="table.top" /></div>
            <span>最新弃牌</span>
          </div>
        </div>
        <div v-if="table.colour" class="current-colour">
          <i :class="'tone-' + table.colour" aria-hidden="true" />当前颜色 · {{ COLOUR_LABELS[table.colour] }}
        </div>
      </div>

      <footer class="colour-controls">
        <p class="colour-last" aria-live="polite">{{ table.last }}</p>
        <div v-if="ended" class="colour-actions">
          <button v-if="mine" class="btn" type="button" @click="ctx.rematch">再来一局</button>
          <button class="btn ghost" type="button" @click="ctx.showLobby">返回客厅</button>
        </div>
        <div v-else-if="mine && actions.length" class="colour-actions">
          <template v-if="selectedCard?.colour === null">
            <span>选择颜色</span>
            <button v-for="colour in FOUR_COLOURS" :key="colour" type="button" class="btn ghost colour-choice"
              :class="'tone-' + colour" :disabled="busy" @click="submit('play', colour)">{{ COLOUR_LABELS[colour] }}</button>
          </template>
          <template v-else>
            <button class="btn" type="button" :disabled="busy || !selectedCard" @click="submit('play')">出牌</button>
            <button v-if="actions.includes('draw')" class="btn ghost" type="button" :disabled="busy" @click="submit('draw')">摸牌</button>
            <button v-if="actions.includes('pass')" class="btn ghost" type="button" :disabled="busy" @click="submit('pass')">结束回合</button>
          </template>
        </div>
        <div v-if="mine && !ended" class="colour-hand" aria-label="你的手牌">
          <button v-for="card in mine.hand" :key="card.id" type="button" class="card-button"
            :class="{ chosen: selected === card.id, playable: isPlayable(card.id) }"
            :aria-label="fourColourFaceText(card)" :aria-pressed="selected === card.id"
            :disabled="busy || !isPlayable(card.id)" @click="selectCard(card.id)">
            <FourColourCard :face="card" />
          </button>
        </div>
        <p v-else-if="!ended" class="colour-spectating">你正在观战</p>
      </footer>
    </div>
  </section>
</template>

<style scoped>
.colour-table {
  min-width: 0;
  padding: clamp(7px, 1vw, 16px);
  border: 1px solid #634b37;
  border-radius: 22px;
  background: #2b1d16;
}
.colour-felt {
  display: grid;
  grid-template: 'status status status' auto '. top .' auto 'left centre right' minmax(165px, 1fr)
    '. bottom .' auto 'controls controls controls' auto / minmax(80px, 1fr) minmax(155px, 3fr) minmax(80px, 1fr);
  align-items: center;
  gap: 12px;
  min-height: clamp(445px, 64vh, 715px);
  padding: clamp(10px, 2vw, 24px);
  border: 3px double #74915d;
  border-radius: 15px;
  background: radial-gradient(ellipse at center, #2a5445, #193a31 68%);
  color: #f2edd6;
  text-align: center;
}
.colour-status { grid-area: status; display: flex; align-items: center; gap: 10px; min-height: 28px; font-size: 13px; }
.colour-status strong, .last-card { color: #ffdf97; }
.direction { color: #d9e4c3; }
.colour-seat {
  position: relative;
  justify-self: center;
  display: grid;
  justify-items: center;
  width: min(100%, 192px);
  min-width: 0;
  gap: 8px;
  font-size: 13px;
}
.colour-seat-tag {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 4px 6px;
  box-sizing: border-box;
  min-width: 0;
  border: 1px solid #7d956a;
  border-radius: 11px;
  background: #17372e;
}
.spot-left { grid-area: left; }
.spot-top { grid-area: top; }
.spot-right { grid-area: right; }
.spot-bottom { grid-area: bottom; }
.their-turn .colour-seat-tag { border-color: #f2ca78; box-shadow: 0 0 0 1px #f2ca78; }
.opponent-stack {
  --opponent-card-width: clamp(27px, 3vw, 48px);
  display: flex;
  justify-content: center;
  min-width: 0;
  max-width: 100%;
}
.opponent-stack > .opponent-back { width: var(--opponent-card-width); flex: 0 0 auto; }
.opponent-back + .opponent-back { margin-inline-start: calc(var(--opponent-card-width) * -.57); }
.colour-avatar {
  display: grid;
  place-items: center;
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #d4deac;
  color: #243325;
  font-weight: 700;
}
.colour-name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; }
.colour-count { font-family: var(--num); white-space: nowrap; }
.colour-centre { grid-area: centre; display: grid; justify-items: center; gap: 10px; }
.colour-piles { display: flex; justify-content: center; gap: clamp(12px, 3vw, 45px); }
.colour-pile { display: grid; justify-items: center; gap: 7px; font-size: 12px; }
.card-button, .top-card { width: clamp(49px, 7vw, 86px); font-size: clamp(23px, 4vw, 46px); }
.card-button {
  display: block;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}
.card-button:disabled { cursor: default; }
.card-button:focus-visible, .card-button.playable:hover { outline: 2px solid #f9da98; outline-offset: 2px; }
.card-button.chosen { outline: 2px solid #f9da98; outline-offset: 2px; transform: translateY(-5px); }
.current-colour { display: flex; align-items: center; gap: 6px; font-size: 13px; padding: 4px 8px; }
.current-colour i { width: 10px; height: 10px; border: 1px solid #fff7dc; border-radius: 50%; background: var(--tone); }
.tone-red { --tone: #df6760; }
.tone-yellow { --tone: #efc96c; }
.tone-green { --tone: #86bd88; }
.tone-blue { --tone: #86b8e5; }
.colour-controls { grid-area: controls; min-width: 0; }
.colour-last, .colour-spectating { margin: 0 0 7px; font-size: 13px; }
.colour-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 7px; min-height: 34px; }
.colour-actions .colour-choice { color: #211e15; background: var(--tone); }
.colour-hand {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: clamp(5px, 1vw, 10px);
  padding: 12px 3px 4px;
}
.colour-hand .card-button { width: clamp(43px, 6vw, 75px); }
.colour-hand .card-button:disabled { opacity: .84; }
.colour-result { color: #ffdf97; }
@media (min-width: 661px) {
  .spot-left, .spot-right { width: min(100%, 118px); }
  .spot-left { justify-self: start; }
  .spot-right { justify-self: end; }
  :is(.spot-left, .spot-right) .opponent-stack {
    --opponent-card-width: clamp(42px, 4.5vw, 68px);
    flex-direction: column;
  }
  :is(.spot-left, .spot-right) .opponent-back + .opponent-back {
    margin-block-start: calc(var(--opponent-card-width) * -1.24);
    margin-inline-start: 0;
  }
}
@media (max-width: 660px) {
  .colour-felt {
    grid-template-areas: 'status status status' 'left top right' 'centre centre centre' '. bottom .' 'controls controls controls';
    grid-template-columns: repeat(3, minmax(0, 1fr));
    grid-template-rows: auto auto minmax(135px, 1fr) auto auto;
    gap: 9px;
    min-height: 400px;
  }
  .colour-seat-tag {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 2px 4px;
    font-size: 12px;
  }
  .colour-count { grid-column: 1 / -1; }
  .opponent-stack { --opponent-card-width: clamp(20px, 6vw, 29px); }
  .opponent-back + .opponent-back { margin-inline-start: calc(var(--opponent-card-width) * -.72); }
  .colour-hand { max-height: 188px; overflow: auto; }
}
</style>
