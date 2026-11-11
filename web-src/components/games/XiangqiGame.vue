<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { GameCtx, GameView } from '../../lib/legacy-games.ts';
import {
  colorName, indexOf, moveText, pieceName, XIANGQI_COLS, XIANGQI_ROWS,
  type Color, type Point, type XiangqiHint, type XiangqiMove,
} from '../../../src/room/games/xiangqi.ts';

interface BoardView {
  board: number[];
  seats: Array<{ id: string; name: string; color: Color }>;
  status: string;
  turn?: string;
  winner?: string;
  last?: XiangqiMove;
  plies: number;
  check: boolean;
  revision?: number;
  text: string;
}

const props = defineProps<{ view: GameView; ctx: GameCtx }>();
const table = computed(() => props.view.table as unknown as BoardView);
const mine = computed(() => props.view.priv as unknown as {
  canAct?: boolean; hints?: XiangqiHint[]; legalMoves?: XiangqiMove[]; warning?: string;
} | null);
const selected = ref<number | null>(null);
const destination = ref<number | null>(null);
const hintIndex = ref(-1);
const submitting = ref(false);

const canPlay = computed(() => table.value.status === 'playing' && mine.value?.canAct === true);
const ended = computed(() => table.value.status === 'ended');
const mySeat = computed(() => table.value.seats?.find(seat => seat.id === props.view.me.id));
const hints = computed(() => canPlay.value ? mine.value?.hints ?? [] : []);
const hint = computed(() => hints.value[hintIndex.value]);
const last = computed(() => table.value.last ? [indexOf(table.value.last.from), indexOf(table.value.last.to)] : []);
const movesBySource = computed(() => {
  const bySource = new Map<number, Map<number, XiangqiMove>>();
  for (const move of mine.value?.legalMoves ?? []) {
    const source = indexOf(move.from);
    if (!bySource.has(source)) bySource.set(source, new Map());
    bySource.get(source)!.set(indexOf(move.to), move);
  }
  return bySource;
});
const destinations = computed(() => selected.value === null ? undefined : movesBySource.value.get(selected.value));
const move = computed(() => destination.value === null ? undefined : destinations.value?.get(destination.value));
const position = (i: number): Point => ({ row: Math.floor(i / XIANGQI_COLS), col: i % XIANGQI_COLS });

function pointLabel(i: number, piece: number): string {
  const { row, col } = position(i);
  return `行 ${row}，列 ${col}，${piece ? colorName(piece > 0 ? 1 : -1) + pieceName(piece) : '空位'}`;
}

function choosePoint(i: number): void {
  if (!canPlay.value || submitting.value) return;
  hintIndex.value = -1;
  if (destinations.value?.has(i)) {
    destination.value = i;
    return;
  }
  if (movesBySource.value.has(i)) {
    selected.value = selected.value === i ? null : i;
    destination.value = null;
  }
}

function cycleHint(): void {
  if (!hints.value.length || submitting.value) return;
  hintIndex.value = (hintIndex.value + 1) % hints.value.length;
  if (hint.value) {
    selected.value = indexOf(hint.value.from);
    destination.value = indexOf(hint.value.to);
  }
}

function resetSelection(): void {
  selected.value = null;
  destination.value = null;
  hintIndex.value = -1;
}

watch([() => table.value.revision, canPlay], resetSelection);

async function submit(action: XiangqiMove | { resign: true }): Promise<void> {
  if (!canPlay.value || submitting.value) return;
  submitting.value = true;
  try {
    if (await props.ctx.act({ type: 'xiangqi_action', ...action })) resetSelection();
  } finally {
    submitting.value = false;
  }
}

function resign(): void {
  if (window.confirm('认输后本局判负，确定吗？')) void submit({ resign: true });
}
</script>

<template>
  <section class="xiangqi">
    <div v-if="ended" class="xiangqi-result" role="status">
      <strong>{{ table.text }}</strong>
      <button class="btn primary" type="button" @click="ctx.rematch()">再来一局</button>
      <button class="btn ghost" type="button" @click="ctx.showLobby()">返回客厅</button>
    </div>

    <div class="xiangqi-layout">
      <div class="xiangqi-frame">
        <div class="file-labels" aria-hidden="true">
          <span v-for="col in XIANGQI_COLS" :key="col">{{ col - 1 }}</span>
        </div>
        <div class="rank-labels" aria-hidden="true">
          <span v-for="row in XIANGQI_ROWS" :key="row">{{ row - 1 }}</span>
        </div>
        <div class="xiangqi-board" role="group" aria-label="中国象棋棋盘，红方在下">
          <span class="palace north" aria-hidden="true" />
          <span class="palace south" aria-hidden="true" />
          <div class="river" aria-hidden="true"><span>楚河</span><span>汉界</span></div>
          <button
            v-for="(piece, i) in table.board"
            :key="i"
            type="button"
            class="xiangqi-point"
            :class="{ selected: selected === i || destination === i, target: destinations?.has(i), last: last.includes(i) }"
            :aria-label="pointLabel(i, piece)"
            :aria-pressed="selected === i || destination === i"
            :disabled="!canPlay || submitting || (!movesBySource.has(i) && !destinations?.has(i))"
            @click="choosePoint(i)"
          >
            <span v-if="piece" class="piece" :class="{ red: piece > 0 }">{{ pieceName(piece) }}</span>
            <span v-else-if="destinations?.has(i)" class="target-dot" />
          </button>
        </div>
      </div>

      <aside class="xiangqi-side">
        <p class="muted">{{ mySeat ? '你执' + colorName(mySeat.color) : '观战' }} · {{ table.plies }} 手</p>
        <ul class="xiangqi-seats">
          <li v-for="seat in table.seats" :key="seat.id" :class="{ current: seat.id === table.turn }">
            <span class="seat-color" :class="{ red: seat.color === 1 }">{{ colorName(seat.color) }}</span>
            {{ seat.name }}{{ seat.id === view.me.id ? '（你）' : '' }}
          </li>
        </ul>
        <p v-if="table.status === 'playing' && table.check" class="xiangqi-warning" role="status">
          {{ mine?.warning || '将军' }}
        </p>
        <template v-if="canPlay">
          <button class="btn primary" type="button" :disabled="!move || submitting" @click="move && submit(move)">
            {{ submitting ? '正在提交…' : move ? '确认走棋' : selected === null ? '先选棋子' : '选择落点' }}
          </button>
          <button v-if="hints.length" class="btn ghost" type="button" :disabled="submitting" @click="cycleHint">
            {{ hint ? '下一条建议' : '下一步建议' }}
          </button>
          <p v-if="hint" class="xiangqi-hint" role="status">
            {{ hintIndex + 1 }}/{{ hints.length }} · {{ hint.reason }}<br />{{ moveText(hint) }}
          </p>
          <button class="btn ghost" type="button" :disabled="submitting" @click="resign">认输</button>
        </template>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.xiangqi { max-width: 860px; margin-inline: auto; color: var(--text); }
.xiangqi-layout { display: grid; grid-template-columns: minmax(0, clamp(330px, 90dvh - 275px, 520px)) minmax(165px, 220px); gap: 18px; align-items: start; justify-content: center; }
.xiangqi-frame {
  position: relative;
  min-width: 0;
  padding: 20px 7px 7px 20px;
  border: 1px solid #805536;
  border-radius: 14px;
  color: #50351f;
  background: linear-gradient(140deg, #e9c696, #d8a86e);
  box-shadow: 0 6px 16px #22130433, inset 0 0 0 2px #f6dcb577;
}
.file-labels, .rank-labels { position: absolute; display: grid; place-items: center; font-size: 10px; }
.file-labels { inset: 4px 7px auto 20px; grid-template-columns: repeat(9, 1fr); }
.rank-labels { inset: 20px auto 7px 4px; grid-template-rows: repeat(10, 1fr); }
.xiangqi-board {
  --ink: #745332;
  position: relative;
  display: grid;
  grid-template-columns: repeat(9, 1fr);
  grid-template-rows: repeat(10, 1fr);
  aspect-ratio: 9 / 10;
  container-type: inline-size;
}
.xiangqi-point {
  display: grid;
  place-items: center;
  position: relative;
  isolation: isolate;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
}
.xiangqi-point::before, .xiangqi-point::after { content: ''; position: absolute; z-index: -1; background: var(--ink); }
.xiangqi-point::before { inset: 50% 0 auto; height: 1px; }
.xiangqi-point::after { inset: 0 auto 0 50%; width: 1px; }
.xiangqi-point:nth-of-type(9n + 1)::before { left: 50%; }
.xiangqi-point:nth-of-type(9n)::before { right: 50%; }
.xiangqi-point:nth-of-type(-n + 9)::after { top: 50%; }
.xiangqi-point:nth-of-type(n + 82)::after { bottom: 50%; }
.xiangqi-point:nth-of-type(n + 38):nth-of-type(-n + 44)::after { bottom: 50%; }
.xiangqi-point:nth-of-type(n + 47):nth-of-type(-n + 53)::after { top: 50%; }
.palace {
  position: absolute;
  left: calc(100% * 3.5 / 9);
  width: calc(100% * 2 / 9);
  height: 20%;
  background:
    linear-gradient(45deg, transparent calc(50% - .5px), var(--ink) 50%, transparent calc(50% + .5px)),
    linear-gradient(-45deg, transparent calc(50% - .5px), var(--ink) 50%, transparent calc(50% + .5px));
}
.palace.north { top: 5%; }
.palace.south { bottom: 5%; }
.river {
  position: absolute;
  top: 45%;
  width: 100%;
  height: 10%;
  display: flex;
  align-items: center;
  justify-content: space-evenly;
  font-family: 'Songti SC', SimSun, serif;
  font-size: clamp(14px, 4cqw, 24px);
  letter-spacing: .2em;
  pointer-events: none;
}
.piece {
  display: grid;
  place-items: center;
  width: 83%;
  aspect-ratio: 1;
  box-sizing: border-box;
  border: 1px solid currentColor;
  border-radius: 50%;
  font-family: 'Songti SC', SimSun, serif;
  font-size: clamp(14px, 5.2cqw, 29px);
  font-weight: 700;
  color: #2e2722;
  background: radial-gradient(circle at 40% 30%, #fff0cc, #e6bd81);
  box-shadow: 0 2px 3px #4d2c225e, inset 0 0 0 2px #f6daaa;
}
.red { color: #9f2823; }
.xiangqi-point:disabled { cursor: default; opacity: 1; }
.xiangqi-point:focus-visible { outline: 2px solid #432719; outline-offset: -1px; z-index: 1; }
.xiangqi-point.last { background: #ffeb9a66; }
.xiangqi-point.target .piece { outline: 2px dotted #225148; }
.xiangqi-point.selected { background: #386c5555; }
.target-dot { width: 24%; aspect-ratio: 1; border-radius: 50%; background: #386c55; }
.xiangqi-side { display: grid; gap: 9px; }
.xiangqi-side p { margin: 0; }
.xiangqi-seats { list-style: none; padding: 0; margin: 0; display: grid; gap: 4px; }
.xiangqi-seats li { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border: 1px solid transparent; border-radius: 9px; overflow-wrap: anywhere; }
.xiangqi-seats .current { border-color: var(--accent-border); background: var(--accent-soft); }
.seat-color { border-radius: 50%; padding: 1px 5px; flex: none; font-weight: 700; color: #2e2722; background: #f6daaa; }
.seat-color.red { color: #9f2823; }
.xiangqi-warning, .xiangqi-hint { padding: 4px 8px; border-left: 2px solid var(--accent-2); font-size: .875rem; }
.xiangqi-warning { background: #d96b6b30; font-weight: 600; }
.xiangqi-result { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; padding: 10px 12px; border: 1px solid var(--line-2); border-radius: 12px; background: var(--panel-2); }
.xiangqi-result strong { flex: 1 1 180px; }
@media (max-width: 690px) {
  .xiangqi-layout { grid-template-columns: minmax(0, 480px); gap: 12px; }
  .xiangqi-seats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
