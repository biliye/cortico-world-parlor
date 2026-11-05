<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { GameCtx, GameView } from '../../lib/legacy-games.ts';

type Point = { row: number; col: number };
type Level = 'win' | 'block' | 'shape';
type Hint = Point & { reason: string; level?: Level };
interface BoardView {
  board: number[];
  seats: Array<{ id: string; name: string; color: number }>;
  status: string;
  turn?: string;
  deadline?: number;
  winner?: string;
  last?: Point;
  winningLine: Point[];
  revision?: number;
}

const props = defineProps<{ view: GameView; ctx: GameCtx }>();
const table = computed(() => props.view.table as unknown as BoardView);
const mine = computed(() => props.view.priv as unknown as { canAct?: boolean; hints?: Hint[] } | null);
const hints = computed<Hint[]>(() => (mine.value?.canAct ? mine.value.hints ?? [] : []));

/** 棋盘边长跟着服务端的棋盘数组走，避免这里再写死一份 15。 */
const size = computed(() => Math.max(5, Math.round(Math.sqrt(table.value.board?.length || 225))));
const stars = computed(() => {
  const far = size.value - 4;
  const mid = (size.value - 1) / 2;
  return [[3, 3], [3, far], [mid, mid], [far, 3], [far, far]];
});
const selected = ref<Point | null>(null);
const hintIndex = ref(-1);
const submitting = ref(false);
const canPlay = computed(() => table.value.status === 'playing' && mine.value?.canAct === true);
const ended = computed(() => table.value.status === 'ended');
const mySeat = computed(() => table.value.seats?.find(seat => seat.id === props.view.me.id));
const myColor = computed(() => mySeat.value?.color || 1);
const moveCount = computed(() => table.value.board?.filter(cell => cell !== 0).length || 0);
const actor = computed(() => table.value.seats?.find(seat => seat.id === table.value.turn)?.name);
const winnerName = computed(() => table.value.seats?.find(seat => seat.id === table.value.winner)?.name);
const hint = computed(() => (hintIndex.value >= 0 ? hints.value[hintIndex.value] ?? null : null));
const ghost = computed(() => {
  const current = hint.value;
  if (!current || !canPlay.value) return null;
  return matches(selected.value, current.row, current.col) ? null : current;
});
const won = computed(() => !!table.value.winner && table.value.winner === props.view.me.id);
const tie = computed(() => ended.value && !table.value.winner);
const resultTitle = computed(() => (tie.value ? '和棋' : won.value ? '你赢了' : '你输了'));
const resultLine = computed(() => {
  if (tie.value) return `棋盘已满，共 ${moveCount.value} 手`;
  const name = winnerName.value || '对手';
  return won.value ? `连五 · 共 ${moveCount.value} 手` : `${name} 连五获胜 · 共 ${moveCount.value} 手`;
});

const position = (i: number): Point => ({ row: Math.floor(i / size.value), col: i % size.value });
const matches = (point: Point | null | undefined, row: number, col: number) => point?.row === row && point.col === col;
const isSelected = (i: number) => matches(selected.value, Math.floor(i / size.value), i % size.value);
const isLast = (i: number) => matches(table.value.last, Math.floor(i / size.value), i % size.value);
const isWinning = (i: number) => (table.value.winningLine || []).some(point => matches(point, Math.floor(i / size.value), i % size.value));
const isGhost = (i: number) => matches(ghost.value, Math.floor(i / size.value), i % size.value);
const isStar = (i: number) => {
  const row = Math.floor(i / size.value);
  const col = i % size.value;
  return stars.value.some(([r, c]) => r === row && c === col);
};
const label = (i: number) => {
  const cell = table.value.board?.[i] ?? 0;
  const point = position(i);
  return `第 ${point.row + 1} 行第 ${point.col + 1} 列` + (cell === 1 ? ' 黑棋' : cell === 2 ? ' 白棋' : ' 空位');
};

watch(() => table.value.revision, () => {
  selected.value = null;
  hintIndex.value = -1;
});

function cycleHint(): void {
  if (!hints.value.length || submitting.value) return;
  hintIndex.value = hintIndex.value >= hints.value.length - 1 ? 0 : hintIndex.value + 1;
}

async function play(): Promise<void> {
  if (!selected.value || !canPlay.value || submitting.value) return;
  submitting.value = true;
  try {
    const receipt = await props.ctx.act({ type: 'gomoku_action', ...selected.value });
    if (receipt) selected.value = null;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="gomoku">
    <div v-if="ended" class="gomoku-result" :class="tie ? 'tie' : won ? 'win' : 'lose'" role="status">
      <div class="gomoku-result-copy">
        <strong>{{ resultTitle }}</strong>
        <span>{{ resultLine }}</span>
      </div>
      <button class="btn primary" type="button" @click="ctx.showLobby()">返回客厅</button>
    </div>

    <div class="gomoku-layout">
      <div class="gomoku-frame">
        <div class="gomoku-board" :class="{ 'is-won': !!table.winningLine?.length }" :style="{ '--n': size }" role="grid" aria-label="十五乘十五五子棋盘">
          <button
            v-for="(cell, i) in table.board"
            :key="i"
            type="button"
            class="gomoku-point"
            :class="{ selected: isSelected(i), last: isLast(i), winning: isWinning(i), ghost: isGhost(i) }"
            :aria-label="label(i)"
            :aria-pressed="isSelected(i)"
            :disabled="!!cell || !canPlay || submitting"
            @click="selected = position(i)"
          >
            <span v-if="cell" class="stone" :class="cell === 1 ? 'black' : 'white'" />
            <template v-else>
              <span v-if="isGhost(i)" class="stone ghost-stone" :class="myColor === 1 ? 'black' : 'white'" />
              <span v-if="isStar(i)" class="star" aria-hidden="true" />
            </template>
          </button>
        </div>
      </div>

      <aside class="gomoku-side">
        <div class="gomoku-meta">
          <span class="gomoku-plies"><b>{{ moveCount }}</b> 手</span>
          <span>{{ myColor === 1 ? '你执黑' : '你执白' }}</span>
        </div>
        <ul class="gomoku-seats">
          <li v-for="seat in table.seats" :key="seat.id" :class="{ current: seat.id === table.turn }">
            <span class="stone" :class="seat.color === 1 ? 'black' : 'white'" />
            <span>{{ seat.name }}{{ seat.id === view.me.id ? '（你）' : '' }}</span>
          </li>
        </ul>
        <template v-if="canPlay">
          <p v-if="hint" class="gomoku-tip" :class="hint.level || 'shape'" role="status">
            建议 {{ hintIndex + 1 }}/{{ hints.length }} · {{ hint.reason }}
          </p>
          <button class="btn primary" type="button" :disabled="!selected || submitting" @click="play">
            {{ submitting ? '正在落子…' : selected ? '落子' : '先点一个空交点' }}
          </button>
          <button v-if="hints.length" class="btn ghost" type="button" :aria-expanded="hintIndex >= 0" @click="cycleHint">
            {{ hintIndex < 0 ? '下一步建议' : '看下一个建议（' + (hintIndex + 1) + '/' + hints.length + '）' }}
          </button>
        </template>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.gomoku { max-width: 960px; margin-inline: auto; color: var(--text); }
.gomoku-layout { display: grid; grid-template-columns: minmax(0, 590px) minmax(170px, 230px); justify-content: center; align-items: start; gap: 18px; }

.gomoku-frame {
  width: 100%;
  padding: 10px;
  border-radius: 16px;
  background: linear-gradient(150deg, #c08a53 0%, #a3703d 46%, #c2955d 100%);
  box-shadow: 0 20px 42px rgba(120, 80, 50, .26), inset 0 1px 0 rgba(255, 255, 255, .38), inset 0 -2px 4px rgba(90, 55, 30, .35);
}
.gomoku-board {
  position: relative;
  aspect-ratio: 1;
  width: 100%;
  padding: 8px;
  display: grid;
  grid-template: repeat(var(--n, 15), 1fr) / repeat(var(--n, 15), 1fr);
  border-radius: 8px;
  background:
    radial-gradient(120% 80% at 28% 8%, rgba(255, 255, 255, .3), transparent 62%),
    repeating-linear-gradient(94deg, rgba(150, 105, 60, .05) 0 7px, rgba(255, 244, 224, .07) 7px 14px),
    linear-gradient(158deg, #eccb96 0%, #e3b97e 58%, #d9ab6e 100%);
  box-shadow: inset 0 0 0 1px rgba(120, 80, 40, .38), inset 0 0 22px rgba(130, 85, 45, .16);
}
.gomoku-point {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  min-width: 0;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
}
.gomoku-point:disabled { cursor: default; }
.gomoku-point:not(:disabled):hover { background: rgba(255, 255, 255, .2); }
.gomoku-point:focus-visible { outline: 2px solid var(--accent-2); outline-offset: -2px; z-index: 4; }
.gomoku-point::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    linear-gradient(rgba(122, 86, 48, .78), rgba(122, 86, 48, .78)) center / 100% 1px no-repeat,
    linear-gradient(rgba(122, 86, 48, .78), rgba(122, 86, 48, .78)) center / 1px 100% no-repeat;
}
.star {
  position: absolute;
  width: 15%;
  aspect-ratio: 1;
  border-radius: 50%;
  background: rgba(92, 62, 33, .72);
}

.stone { position: relative; width: 85%; aspect-ratio: 1; border-radius: 50%; box-shadow: 0 2px 4px rgba(60, 35, 15, .38); transition: opacity .18s ease, transform .18s ease; }
.stone.black { background: radial-gradient(circle at 34% 26%, #6b6461, #211d23 60%, #0d0b10); }
.stone.white { background: radial-gradient(circle at 34% 26%, #fff, #f4ede1 58%, #dccfb8); box-shadow: 0 2px 4px rgba(90, 60, 30, .42), inset 0 0 0 1px rgba(150, 125, 95, .55); }
.stone.ghost-stone { opacity: .42; filter: saturate(.55); }

.gomoku-point.ghost::after {
  content: '';
  position: absolute;
  width: 92%;
  aspect-ratio: 1;
  border: 2px dashed rgba(24, 93, 81, .8);
  border-radius: 50%;
}
.gomoku-point.selected::after {
  content: '';
  position: absolute;
  width: 88%;
  aspect-ratio: 1;
  border: 2px dashed var(--accent-2);
  border-radius: 50%;
  background: rgba(95, 184, 160, .16);
}
.gomoku-point.last .stone { box-shadow: 0 0 0 2px #f4a35f, 0 2px 6px rgba(60, 35, 15, .42); }
/* 连五：五子加金环并微微放大，其余棋子压暗，让这一排自己浮出来（不画穿子的线）。 */
.gomoku-board.is-won .gomoku-point:not(.winning) .stone { opacity: .55; filter: saturate(.75); }
.gomoku-point.winning { z-index: 2; }
.gomoku-point.winning .stone {
  transform: scale(1.06);
  box-shadow: 0 0 0 2px #ffd88c, 0 0 18px rgba(255, 180, 80, .95), 0 2px 6px rgba(60, 35, 15, .45);
}

.gomoku-side { display: grid; gap: 10px; }
.gomoku-meta { display: flex; align-items: baseline; gap: 10px; padding: 2px 4px; color: var(--muted); font-size: 12px; }
.gomoku-meta b { color: var(--text); font-size: 20px; font-variant-numeric: tabular-nums; margin-right: 2px; }
.gomoku-seats { list-style: none; padding: 0; margin: 0; display: grid; gap: 4px; }
.gomoku-seats li { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid transparent; border-radius: 9px; font-size: 13px; }
.gomoku-seats li.current { border-color: var(--accent-border); background: var(--accent-soft); }
.gomoku-seats .stone { flex: 0 0 16px; width: 16px; box-shadow: 0 1px 2px rgba(60, 35, 15, .35); }
.gomoku-tip { margin: 0; padding-left: 9px; border-left: 2px solid var(--accent-2); color: var(--muted); font-size: 12px; line-height: 1.5; }
.gomoku-tip.win { border-color: #e08a3c; color: #b3541d; }
.gomoku-tip.block { border-color: #d9a03a; color: #9a6a1c; }

.gomoku .btn.primary:disabled {
  opacity: 1;
  background: linear-gradient(180deg, #f1e4d3, #e3d0b8);
  border-color: #d9c5a8;
  color: #9c8873;
  box-shadow: none;
}

.gomoku-result {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 16px;
  padding: 14px 18px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--panel);
}
.gomoku-result.win { border-color: rgba(95, 184, 160, .45); background: linear-gradient(135deg, rgba(95, 184, 160, .18), rgba(95, 184, 160, .04)); }
.gomoku-result.lose { border-color: rgba(217, 107, 107, .32); background: linear-gradient(135deg, rgba(217, 107, 107, .13), rgba(217, 107, 107, .03)); }
.gomoku-result.tie { border-color: var(--line-2); background: var(--panel-2); }
.gomoku-result-copy { display: grid; gap: 3px; }
.gomoku-result-copy strong { font-size: 21px; letter-spacing: .02em; }
.gomoku-result-copy span { color: var(--muted); font-size: 12.5px; }
.gomoku-result .btn { flex: 0 0 auto; }

@media (max-width: 680px) {
  .gomoku-layout { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .gomoku-frame { width: 100%; padding: 7px; border-radius: 13px; }
  .gomoku-seats { display: flex; flex-wrap: wrap; }
  .gomoku-seats li { flex: 1 1 40%; }
  .gomoku-result { padding: 12px 14px; }
  .gomoku-result-copy strong { font-size: 18px; }
}
</style>
