<script setup lang="ts">
/**
 * 骰子桌（Vue 版）：每人两颗暗骰，轮到你可以重掷一颗或停牌。
 * 规则与数值全在服务器，DOM 类名沿用 play.css。
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import Icon from '../Icon.vue';
import ClockText from './ClockText.vue';
import type { GameCtx, GameView } from '../../lib/game-types.ts';
import { initialOf } from '../../lib/text.ts';

const props = defineProps<{ view: GameView; ctx: GameCtx }>();

interface DiceSeat {
  id: string;
  name: string;
  stood?: boolean;
}

interface DiceRevealed {
  id: string;
  name: string;
  dice: number[];
  total: number;
}

interface DicePriv {
  yourTurn?: boolean;
  rerollsLeft?: number;
  dice?: number[];
  deadline?: number;
}

const SLOTS_BY_COUNT: Record<number, number[]> = {
  1: [0],
  2: [0, 2],
  3: [0, 1, 3],
  4: [0, 1, 2, 3],
};

const PIPS: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

const rolling = ref(false);
let rollTimer: number | undefined;

onBeforeUnmount(() => {
  if (rollTimer !== undefined) window.clearTimeout(rollTimer);
});

const table = computed(() => props.view.table as GameView['table'] & {
  seats?: DiceSeat[];
  revealed?: DiceRevealed[];
  winners?: string[];
  turn?: string;
  deadline?: number;
});

const priv = computed(() => props.view.priv as DicePriv | null);
const me = computed(() => props.view.me);
const seats = computed(() => table.value.seats || []);
const seated = computed(() => seats.value.some((seat) => seat.id === me.value.id));

const seatLayout = computed(() => {
  const list = seats.value;
  const slots = SLOTS_BY_COUNT[Math.min(list.length, 4)] || SLOTS_BY_COUNT[4];
  const ordered = [...list];
  const index = ordered.findIndex((seat) => seat.id === me.value.id);
  if (index > 0) ordered.unshift(...ordered.splice(index, 1));
  return ordered.slice(0, 4).map((seat, slotIndex) => ({
    seat,
    slot: slots[slotIndex] ?? slotIndex % 4,
  }));
});

const emptySlots = computed(() => {
  const used = new Set(seatLayout.value.map((entry) => entry.slot));
  return [0, 1, 2, 3].filter((slot) => !used.has(slot));
});

function seatMeta(seat: DiceSeat) {
  const mine = seat.id === me.value.id;
  const info = (props.view.seats || []).find((entry) => entry.id === seat.id);
  const isPet = !!(info && info.kind === 'pet');
  const revealed = (table.value.revealed || []).find((entry) => entry.id === seat.id);
  const own = mine && priv.value && Array.isArray(priv.value.dice) && priv.value.dice.length ? priv.value.dice : null;
  const values = own || (revealed ? revealed.dice : null);
  const total = values ? values.reduce((sum, value) => sum + value, 0) : null;
  let stateText = '暗骰';
  if (seat.stood) stateText = total !== null ? `已停牌 · ${total} 点` : '已停牌';
  else if (seat.id === table.value.turn && table.value.status === 'playing') {
    stateText = total !== null ? `轮到这一位 · ${total} 点` : '轮到这一位';
  } else if (total !== null) {
    stateText = `合计 ${total} 点`;
  }
  return {
    mine,
    isPet,
    online: props.view.online.includes(seat.id),
    avatarClass: isPet ? 'avatar-coo' : (props.view.classes.get(seat.id) || 's0'),
    isTurn: seat.id === table.value.turn && table.value.status === 'playing',
    stateText,
  };
}

const tray = computed(() => {
  let values: number[] | null = null;
  let caption = '暗骰 · 停牌或重掷后亮出';
  if (seated.value && priv.value && Array.isArray(priv.value.dice) && priv.value.dice.length) {
    values = priv.value.dice;
    caption = `你的骰子 · 合计 ${values.reduce((sum, value) => sum + value, 0)} 点`;
  } else if (table.value.status === 'ended' && (table.value.revealed || []).length) {
    const best = [...(table.value.revealed || [])].sort((a, b) => b.total - a.total)[0];
    if (best) {
      values = best.dice;
      caption = `${best.name} · ${best.total} 点`;
    }
  }
  return { values, caption };
});

const winnerLine = computed(() => {
  const winnerIds = table.value.winners || [];
  const winners = (table.value.revealed || []).filter((entry) => winnerIds.includes(entry.id));
  const title = winnerIds.length > 1 ? '平局：' : '赢家：';
  const namesText = winners.map((entry) => `${entry.name}（${entry.total} 点）`).join('、');
  return title + (namesText || '—');
});

const myTotal = computed(() => (priv.value?.dice || []).reduce((sum, value) => sum + value, 0));
const rerollsLeft = computed(() => priv.value?.rerollsLeft || 0);

function pipOn(value: number, index: number): boolean {
  return (PIPS[value] || []).includes(index);
}

function reroll(die: number): void {
  if (rolling.value) return;
  rolling.value = true;
  if (rollTimer !== undefined) window.clearTimeout(rollTimer);
  rollTimer = window.setTimeout(() => { rolling.value = false; }, 650);
  void props.ctx.act({ type: 'table_action', action: 'roll', die }).catch(() => {});
}

function stand(): void {
  void props.ctx.act({ type: 'table_action', action: 'stand' }).catch(() => {});
}
</script>

<template>
  <section class="game-dice">
    <div class="table-stage">
      <div class="pendant" aria-hidden="true">
        <span class="pendant-cord" />
        <span class="pendant-shade" />
        <span class="pendant-bulb" />
        <span class="pendant-glow" />
      </div>
      <div class="table">
        <div class="table-felt">
          <div class="felt-noise" />
          <div class="table-mark">聚</div>
          <div class="table-ring table-ring-1" />
          <div class="table-ring table-ring-2" />

          <div
            v-for="{ seat, slot } in seatLayout"
            :key="seat.id"
            :class="[
              'tseat',
              'tseat-pos-' + slot,
              { 'is-you': seatMeta(seat).mine, 'is-turn': seatMeta(seat).isTurn },
            ]"
          >
            <span :class="['avatar', seatMeta(seat).avatarClass]">
              {{ initialOf(seat.name) }}
              <span v-if="seatMeta(seat).online" class="status-dot online" />
              <span v-if="seatMeta(seat).isPet" class="avatar-badge"><Icon name="spark" /></span>
            </span>
            <div class="tseat-meta">
              <span class="tseat-name">
                {{ seat.name + (seatMeta(seat).mine ? '（你）' : '') }}
                <span v-if="seatMeta(seat).isPet" class="tag tag-coo">Coo</span>
              </span>
              <span class="tseat-state">{{ seatMeta(seat).stateText }}</span>
            </div>
          </div>

          <div v-for="slot in emptySlots" :key="'empty-' + slot" :class="['tseat-empty', 'tseat-pos-' + slot]">
            空位
          </div>

          <div class="dice-cup" aria-hidden="true">
            <span class="cup-body" />
            <span class="cup-mouth" />
            <span class="cup-band" />
          </div>

          <div :class="['dice-tray', { 'is-rolling': rolling }]">
            <template v-if="tray.values">
              <div v-for="(val, idx) in tray.values" :key="idx" class="die" :aria-label="val + ' 点'">
                <span v-for="pip in 9" :key="pip" :class="['pip', { on: pipOn(val, pip - 1) }]" />
              </div>
            </template>
            <div v-else class="die-placeholder">还没有亮出的骰子</div>
          </div>
          <div class="dice-caption">{{ tray.caption }}</div>
        </div>
      </div>
    </div>

    <div class="action-bar">
      <div class="action-main">
        <template v-if="table.status === 'ended'">
          <div class="action-main"><span class="good">{{ winnerLine }}</span></div>
          <button class="btn small" type="button" @click="ctx.showLobby()">回大厅</button>
        </template>
        <template v-else-if="priv && priv.yourTurn">
          <button class="btn" type="button" :disabled="rerollsLeft <= 0" @click="reroll(0)">重掷第 1 颗</button>
          <button class="btn" type="button" :disabled="rerollsLeft <= 0" @click="reroll(1)">重掷第 2 颗</button>
          <button class="btn primary" type="button" @click="stand">停牌</button>
        </template>
      </div>
      <p class="action-note">
        <template v-if="table.status === 'ended'" />
        <template v-else-if="priv && priv.yourTurn">
          你的合计 {{ myTotal }} 点 · 还能重掷 {{ rerollsLeft }} 次<template v-if="priv.deadline"> · <ClockText :deadline="priv.deadline" :server-now="ctx.serverNow" /></template>
        </template>
        <template v-else-if="seated">
          等 {{ view.names.get(table.turn || '') || '？' }} 行动<template v-if="table.deadline"> · <ClockText :deadline="table.deadline" :server-now="ctx.serverNow" /></template>
        </template>
        <template v-else>
          你在旁观；桌上至少两个人，发起人才能开局。
        </template>
      </p>
    </div>
  </section>
</template>
