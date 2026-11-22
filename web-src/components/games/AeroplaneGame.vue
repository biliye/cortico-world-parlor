<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  AEROPLANE_RULES, COLOURS, FINISH, HANGAR, HOME_START, PLANES_PER_SEAT, positionText, trackIndex,
  type AeroplaneMove, type AeroplaneSeat,
} from '../../../src/room/games/aeroplane-rules.ts';
import type { GameCtx, GameView } from '../../lib/legacy-games.ts';

const props = defineProps<{ view: GameView; ctx: GameCtx }>();

type Point = [number, number];
type Seat = AeroplaneSeat & { colour: number };
type Token = { key: string; seat: Seat; number: number };
const colours = COLOURS.map((name, id) => ({ name, id, className: `colour-${id}` }));
const headings = ['→', '↓', '←', '↑'];
const quarter: Point[] = [[1, 6], [2, 6], [3, 6], [4, 6], [5, 6], [6, 5], [6, 4], [6, 3], [6, 2], [6, 1], [6, 0], [7, 0], [8, 0]];
const hangars: Point[] = [[0, 0], [9, 0], [9, 9], [0, 9]];
const parking: Point[] = hangars.map(([x, y]) => [x + 2, y + 2]);
const diePips = [[], [5], [1, 9], [1, 5, 9], [1, 3, 7, 9], [1, 3, 5, 7, 9], [1, 3, 4, 6, 7, 9]];

function rotate([x, y]: Point, colour: number): Point {
  for (let turn = 0; turn < colour; turn += 1) [x, y] = [14 - y, x];
  return [x, y];
}

const circuit = colours.flatMap(colour => quarter.map(point => rotate(point, colour.id)));
const cells = circuit.map((point, index) => ({
  point, className: colours[index % colours.length].className,
  mark: index % quarter.length === 0 ? headings[index / quarter.length] : '',
}));
const lanes = colours.flatMap(colour => Array.from({ length: FINISH - HOME_START + 1 }, (_, index) => ({
  point: rotate([index + 1, 7], colour.id), className: colour.className,
  mark: index === FINISH - HOME_START ? '✦' : '',
})));

function grid([x, y]: Point, span = 1) {
  return { gridColumn: `${x + 1} / span ${span}`, gridRow: `${y + 1} / span ${span}` };
}

function pointFor(colour: number, progress: number, plane: number): Point {
  if (progress === HANGAR) return rotate([2 + plane % 2, 2 + Math.floor(plane / 2)], colour);
  if (progress >= HOME_START) return rotate([progress - HOME_START + 1, 7], colour);
  return circuit[trackIndex(colour, progress)];
}

const table = computed(() => props.view.table as GameView['table'] & {
  winners?: string[];
  endReason?: 'resign';
  last?: { text: string; die: number } | null;
  phase?: 'await_roll' | 'await_move';
  die?: number;
});
const seats = computed(() => (table.value.seats || []) as Seat[]);
const mySeat = computed(() => seats.value.find(seat => seat.id === props.view.me.id));
const flyingSeats = computed(() => seats.value.filter(seat => !seat.resigned));
const turn = computed(() => seats.value.find(seat => seat.id === table.value.turn));
const winner = computed(() => seats.value.find(seat => table.value.winners?.includes(seat.id)));
const yours = computed(() => table.value.status === 'playing' && !table.value.frozen
  && !!mySeat.value && props.view.priv?.yourTurn === true && turn.value?.id === mySeat.value.id);
const last = computed(() => table.value.last);
const previousRoll = computed(() => table.value.phase === 'await_roll' && last.value);
const die = computed(() => Number(table.value.die ?? last.value?.die ?? 0));
const pips = computed(() => diePips[die.value] ?? []);
const colourClass = computed(() => {
  const seat = winner.value ?? turn.value;
  return seat ? colours[seat.colour].className : '';
});
const moves = computed(() => yours.value && table.value.phase === 'await_move' ? (props.view.priv?.moves as AeroplaneMove[] ?? []) : []);
const canRoll = computed(() => yours.value && table.value.phase === 'await_roll');
const busy = ref(false);
const preview = ref<number | null>(null);
watch(moves, () => { preview.value = null; });

const heading = computed(() => {
  if (winner.value) return winner.value.id === mySeat.value?.id ? '你赢得本局' : `${winner.value.name} 赢得本局`;
  if (table.value.frozen) return '牌桌已暂停';
  if (yours.value) return canRoll.value ? '轮到你掷骰' : `掷出 ${die.value} 点，选择飞机`;
  if (turn.value) return table.value.phase === 'await_move' ? `${turn.value.name} 掷出 ${die.value} 点，正在选飞机` : `等待 ${turn.value.name} 掷骰`;
  return '飞行棋';
});

const turnDetail = computed(() => {
  if (winner.value) return table.value.endReason === 'resign' ? '其余玩家已认输。' : '四架飞机全部抵达终点。';
  if (mySeat.value?.resigned) return '你已认输，可以继续观战。';
  if (table.value.frozen || table.value.phase !== 'await_move') return last.value?.text ?? '掷出 6 点即可起飞。';
  return '';
});

const stacks = computed(() => {
  const groups = new Map<string, { point: Point; tokens: Token[] }>();
  for (const seat of flyingSeats.value) {
    seat.planes.forEach((progress, index) => {
      const point = pointFor(seat.colour, progress, index);
      const cell = point.join(',');
      const group = groups.get(cell) ?? { point, tokens: [] };
      group.tokens.push({ key: `${seat.id}-${index}`, seat, number: index + 1 });
      groups.set(cell, group);
    });
  }
  return groups;
});

const target = computed(() => {
  const move = moves.value.find(entry => entry.plane === preview.value);
  return move && mySeat.value ? pointFor(mySeat.value.colour, move.to, move.plane - 1) : null;
});

function canFly(token: Token): boolean {
  return token.seat.id === mySeat.value?.id && moves.value.some(move => move.plane === token.number);
}

function finished(seat: Seat): number { return seat.planes.filter(progress => progress === FINISH).length; }

async function submit(action: 'roll' | 'move' | 'resign', plane?: number): Promise<void> {
  if (busy.value || !yours.value) return;
  if (action === 'roll' && !canRoll.value) return;
  if (action === 'move' && !moves.value.some(move => move.plane === plane)) return;
  busy.value = true;
  preview.value = null;
  try {
    await props.ctx.act({ type: 'aeroplane_action', action, ...(plane === undefined ? {} : { plane }) });
  } finally {
    busy.value = false;
  }
}

function resign(): void {
  if (!yours.value || busy.value) return;
  const message = flyingSeats.value.length === 2
    ? '认输后对手赢得本局。确定认输吗？'
    : '认输后你的飞机会退出本局，其余玩家继续。确定认输吗？';
  if (window.confirm(message)) void submit('resign');
}
</script>

<template>
  <section class="aeroplane-layout">
    <section class="flight-control" :class="[colourClass, { 'your-turn': yours }]" aria-label="飞行棋回合">
      <div v-if="!winner" class="flight-roll">
        <div class="flight-dice" :class="{ 'fresh-roll': table.phase === 'await_move' }"
          :key="table.phase === 'await_move' ? table.revision : 'idle'"
          role="img" :aria-label="pips.length ? `${previousRoll ? '上一掷 ' : '掷出 '}${die} 点` : '尚未掷骰'">
          <i v-for="pip in pips" :key="pip" :style="{ gridArea: `pip-${pip}` }" aria-hidden="true" />
          <span v-if="!pips.length" aria-hidden="true">–</span>
        </div>
        <small v-if="previousRoll" aria-hidden="true">上一掷</small>
      </div>
      <div v-else class="flight-result" aria-hidden="true">✦</div>
      <div class="flight-turn" role="status">
        <strong>{{ heading }}</strong>
        <span v-if="turnDetail">{{ turnDetail }}</span>
      </div>
      <button v-if="canRoll" type="button" class="flight-action" :disabled="busy" @click="submit('roll')">掷骰</button>
      <div v-if="moves.length" class="flight-moves">
        <button v-for="move in moves" :key="move.plane" type="button" class="flight-move" :disabled="busy"
          @click="submit('move', move.plane)" @pointerenter="preview = move.plane" @pointerleave="preview = null"
          @focus="preview = move.plane" @blur="preview = null">
          <b>{{ move.plane }} 号机</b>
          <span>{{ move.from === HANGAR ? '起飞' : positionText(move.to) }}{{ move.captures ? ` · 撞 ${move.captures} 架` : '' }}</span>
        </button>
      </div>
      <button v-if="yours" type="button" class="flight-resign" :disabled="busy" @click="resign">认输</button>
      <button v-if="winner && mySeat" type="button" class="flight-action" @click="ctx.rematch()">再来一局</button>
    </section>

    <div class="flight-frame">
      <div class="flight-board" role="group" aria-label="飞行棋棋盘">
        <div v-for="colour in colours" :key="colour.id" class="hangar" :class="colour.className"
          :style="grid(hangars[colour.id], 6)" aria-hidden="true">
          <span>{{ colour.name }}</span>
        </div>
        <div v-for="colour in colours" :key="`parking-${colour.id}`" class="parking" :class="colour.className"
          :style="grid(parking[colour.id], 2)" aria-hidden="true" />
        <div v-for="cell in cells" :key="cell.point.join(',')" class="track" :class="[cell.className, { runway: cell.mark }]"
          :style="grid(cell.point)" aria-hidden="true">{{ cell.mark }}</div>
        <div v-for="cell in lanes" :key="cell.point.join(',')" class="lane" :class="[cell.className, { arrival: cell.mark }]"
          :style="grid(cell.point)" aria-hidden="true">{{ cell.mark }}</div>
        <div class="hub" :style="grid([7, 7])" aria-hidden="true">✦</div>
        <div v-if="target" class="flight-target" :style="grid(target)" aria-hidden="true" />
        <div v-for="[cell, stack] in stacks" :key="cell" class="plane-stack"
          :class="{ stacked: stack.tokens.length > 1 }" :style="grid(stack.point)">
          <template v-for="token in stack.tokens" :key="token.key">
            <button v-if="canFly(token)" type="button" class="plane flyable" :class="colours[token.seat.colour].className"
              :aria-label="`飞 ${token.number} 号机`" :disabled="busy" tabindex="-1"
              @click="submit('move', token.number)" @pointerenter="preview = token.number" @pointerleave="preview = null">
              {{ token.number }}
            </button>
            <span v-else class="plane" :class="colours[token.seat.colour].className"
              :title="`${token.seat.name}的 ${token.number} 号机`">{{ token.number }}</span>
          </template>
        </div>
      </div>
    </div>

    <section class="flight-roster" aria-label="玩家与抵达进度">
      <ul class="flight-seats">
        <li v-for="seat in seats" :key="seat.id" :class="[colours[seat.colour].className, {
          current: turn?.id === seat.id && !table.frozen, resigned: seat.resigned,
        }]">
          <span class="seat-emblem" :title="colours[seat.colour].name" aria-hidden="true"><i /></span>
          <div class="seat-entry">
            <strong>{{ seat.name }}<small v-if="mySeat?.id === seat.id">你</small></strong>
            <span v-if="seat.resigned" class="seat-count">已认输</span>
            <div v-else class="seat-progress">
              <span class="seat-segments" aria-hidden="true">
                <i v-for="slot in PLANES_PER_SEAT" :key="slot" :class="{ landed: slot <= finished(seat) }" />
              </span>
              <span class="seat-count">{{ finished(seat) }}/{{ PLANES_PER_SEAT }} 抵达</span>
            </div>
          </div>
        </li>
      </ul>
      <details class="flight-rules">
        <summary>飞行规则</summary>
        <ul><li v-for="rule in AEROPLANE_RULES" :key="rule">{{ rule }}</li></ul>
      </details>
    </section>
  </section>
</template>

<style scoped>
.aeroplane-layout {
  --flight-ink: #243c53;
  --flight-tint: #d9e4ee;
  --flight-pale: #f0f5f9;
  display: grid;
  grid-template-columns: minmax(0, 570px) minmax(226px, 292px);
  grid-template-areas: "board control" "board roster" "board .";
  grid-template-rows: auto auto 1fr;
  align-items: start;
  justify-content: center;
  gap: 12px clamp(12px, 2vw, 22px);
  width: 100%;
  margin-inline: auto;
}

.colour-0 { --flight-ink: #983b3b; --flight-token: #b94444; --flight-tint: #f3c3bb; --flight-pale: #fbe6e1; }
.colour-1 { --flight-ink: #215d8e; --flight-token: #236a9e; --flight-tint: #beddf1; --flight-pale: #e2f0fa; }
.colour-2 { --flight-ink: #21634f; --flight-token: #24765d; --flight-tint: #b8ddcc; --flight-pale: #e0f1e8; }
.colour-3 { --flight-ink: #78500b; --flight-token: #8c5b0b; --flight-tint: #f2d697; --flight-pale: #fbefd0; }

.flight-frame {
  grid-area: board;
  min-width: 0;
  padding: clamp(6px, 1.25vw, 12px);
  border: 1px solid #324d61;
  border-radius: 19px;
  background: linear-gradient(145deg, #2b485b, #182e3e);
  box-shadow: 0 4px 0 #142737, 0 11px 24px #14273735;
}

.flight-board {
  position: relative;
  isolation: isolate;
  display: grid;
  grid-template: repeat(15, minmax(0, 1fr)) / repeat(15, minmax(0, 1fr));
  width: 100%;
  aspect-ratio: 1;
  container-type: inline-size;
  border-radius: 11px;
  overflow: hidden;
  background-color: #f1f6fa;
  background-image: linear-gradient(#52738a12 1px, transparent 1px), linear-gradient(90deg, #52738a12 1px, transparent 1px);
  background-size: calc(100% / 15) calc(100% / 15);
}

.hangar {
  position: relative;
  display: grid;
  justify-items: center;
  align-content: start;
  margin: 5%;
  padding-block-start: 8%;
  overflow: hidden;
  border-radius: 14%;
  border: 1px solid color-mix(in srgb, var(--flight-ink) 40%, var(--flight-tint));
  background: radial-gradient(ellipse at 50% 85%, var(--flight-tint), transparent 72%), var(--flight-pale);
  color: var(--flight-ink);
  font-size: clamp(10px, 2.55cqi, 15px);
  font-weight: 800;
  letter-spacing: .12em;
}

.hangar::before {
  content: '';
  position: absolute;
  inset: 24% 12% 12%;
  background: repeating-radial-gradient(ellipse at 50% 52%, transparent 0 22%, color-mix(in srgb, var(--flight-ink) 18%, transparent) 23% 24%);
  mask-image: radial-gradient(ellipse at center, #000 45%, transparent 73%);
}

.parking {
  margin: 2%;
  border-radius: 14%;
  border: 1px dashed var(--flight-ink);
  background: var(--flight-pale);
}

.track, .lane, .hub {
  display: grid;
  place-items: center;
  margin: 1px;
  border-radius: 23%;
  color: var(--flight-ink);
  font-size: clamp(10px, 4cqi, 22px);
  font-weight: 800;
  line-height: 1;
}

.track { background: var(--flight-tint); }
.track.runway, .lane.arrival, .hub { background: var(--flight-ink); color: #fff; }
.track.runway { box-shadow: inset 0 0 0 1px #ffffff55; }
.lane { background: var(--flight-pale); border: 1px solid var(--flight-tint); }
.hub { background: #263f52; box-shadow: inset 0 0 0 1px #ffffff55; }

.plane-stack {
  z-index: 3;
  display: grid;
  place-items: center;
  min-width: 0;
  min-height: 0;
  pointer-events: none;
}

.plane-stack.stacked { grid-template: repeat(2, minmax(0, 1fr)) / repeat(2, minmax(0, 1fr)); }

.plane {
  display: grid;
  place-items: center;
  width: 88%;
  aspect-ratio: 1;
  padding: 0;
  border: 1px solid #fff;
  border-radius: 50%;
  background: var(--flight-token);
  color: #fff;
  box-shadow: 0 2px 3px #172b4350, inset 0 0 0 1px #0002;
  font: inherit;
  font-size: clamp(9px, 2.7cqi, 15px);
  font-weight: 800;
  line-height: 1;
}

.stacked .plane { width: 100%; font-size: clamp(7px, 2cqi, 11px); }

.flyable {
  pointer-events: auto;
  cursor: pointer;
  outline: 1px solid #193345;
  box-shadow: 0 0 0 2px #fff, 0 0 0 3px #193345;
}

.flyable:disabled { cursor: wait; opacity: .7; }
.flyable:hover, .flyable:focus-visible { z-index: 1; filter: brightness(1.16); }

.flight-target {
  z-index: 2;
  margin: 1px;
  border: 2px solid #263f52;
  border-radius: 25%;
  background: #ffffff40;
  box-shadow: 0 0 0 2px #fff;
  pointer-events: none;
}

.flight-control, .flight-roster { min-width: 0; color: #24394a; }
.flight-control {
  grid-area: control;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 10px 13px;
  padding: 15px;
  border: 1px solid #d5dfe6;
  border-top: 3px solid var(--flight-ink);
  border-radius: 15px;
  background: #fcfdff;
  box-shadow: 0 3px 12px #233b5012;
}

.flight-control.your-turn { background: linear-gradient(145deg, var(--flight-pale), #fcfdff 72%); }
.flight-roll { display: grid; justify-items: center; gap: 3px; }
.flight-roll small { color: #536675; font-size: 10px; }

.flight-dice, .flight-result {
  width: 46px;
  aspect-ratio: 1;
  box-sizing: border-box;
  border: 1px solid #d5dfe6;
  border-radius: 11px;
}

.flight-dice {
  display: grid;
  grid-template-areas: "pip-1 pip-2 pip-3" "pip-4 pip-5 pip-6" "pip-7 pip-8 pip-9";
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(3, 1fr);
  place-items: center;
  padding: 8px;
  background: #fff;
  color: var(--flight-ink);
  box-shadow: 0 2px 0 #bdccd7;
}

.flight-dice i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.flight-dice span { grid-area: pip-5; font-weight: 800; line-height: 1; }
.flight-dice.fresh-roll { animation: flight-dice-in 230ms ease-out; }
@keyframes flight-dice-in { from { transform: rotate(-12deg) scale(.82); } to { transform: none; } }

.flight-result {
  display: grid;
  place-items: center;
  border-color: var(--flight-tint);
  background: var(--flight-pale);
  color: var(--flight-ink);
  font-size: 23px;
}

.flight-turn { display: grid; gap: 3px; overflow-wrap: anywhere; }
.flight-turn strong { font-size: clamp(15px, 1.4vw, 19px); line-height: 1.3; }
.flight-turn span { color: #536675; font-size: 12px; line-height: 1.5; }

.flight-action, .flight-moves, .flight-resign { grid-column: 1 / -1; }
.flight-action, .flight-move, .flight-resign {
  min-height: 44px;
  border: 1px solid transparent;
  border-radius: 9px;
  font: inherit;
  cursor: pointer;
}

.flight-action {
  background: var(--flight-ink);
  color: #fff;
  font-weight: 800;
  box-shadow: 0 2px 0 color-mix(in srgb, var(--flight-ink), #000 30%);
}

.flight-moves { display: grid; gap: 6px; min-width: 0; }

.flight-move {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 2px 8px;
  padding: 6px 10px;
  border-color: var(--flight-tint);
  background: #fff;
  color: var(--flight-ink);
  text-align: left;
  overflow-wrap: anywhere;
}

.flight-move span { font-size: 12px; }

.flight-resign {
  justify-self: end;
  min-height: 36px;
  padding: 0 12px;
  border-color: #ead7d4;
  background: #fff;
  color: #873c37;
  font-size: 12px;
}

.flight-action:hover:not(:disabled) { filter: brightness(1.15); }
.flight-move:hover:not(:disabled), .flight-move:focus-visible { background: var(--flight-pale); }
.flight-resign:hover:not(:disabled) { background: #fbebe8; }
.flight-control button:focus-visible { outline: 2px solid #234968; outline-offset: 2px; }
.flight-control button:disabled { opacity: .65; cursor: wait; }

.flight-roster {
  grid-area: roster;
  overflow: hidden;
  border: 1px solid #d5dfe6;
  border-radius: 15px;
  background: #fcfdff;
}

.flight-seats {
  display: grid;
  gap: 5px;
  margin: 0;
  padding: 8px;
  list-style: none;
}

.flight-seats li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 6px;
  border: 1px solid transparent;
  border-radius: 9px;
}

.flight-seats li.current { border-color: var(--flight-tint); background: var(--flight-pale); }
.flight-seats li.resigned { --flight-pale: #edf1f4; --flight-ink: #536675; }

.seat-emblem {
  display: grid;
  place-items: center;
  width: 28px;
  aspect-ratio: 1;
  border-radius: 7px;
  background: var(--flight-pale);
  color: var(--flight-ink);
}

.seat-emblem i {
  width: 16px;
  height: 16px;
  background: currentColor;
  clip-path: polygon(50% 0, 60% 14%, 60% 36%, 100% 65%, 100% 73%, 60% 61%, 60% 81%, 75% 95%, 75% 100%, 50% 92%, 25% 100%, 25% 95%, 40% 81%, 40% 61%, 0 73%, 0 65%, 40% 36%, 40% 14%);
}

.seat-entry { min-width: 0; display: grid; gap: 4px; }
.seat-entry strong { font-size: 13px; line-height: 1.2; overflow-wrap: anywhere; }
.seat-entry small {
  margin-inline-start: 5px;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--flight-pale);
  color: var(--flight-ink);
  font-size: 10px;
}

.seat-progress { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; }
.seat-segments { display: flex; gap: 3px; }
.seat-segments i { width: 9px; height: 5px; border-radius: 2px; background: #dde6ec; }
.seat-segments .landed { background: var(--flight-ink); }
.seat-count { color: #536675; font-size: 11px; line-height: 1; white-space: nowrap; }

.flight-rules { border-top: 1px solid #e0e8ee; color: #536675; font-size: 12px; }
.flight-rules summary { padding: 10px 13px; cursor: pointer; }
.flight-rules ul { margin-block: 0 12px; padding-inline: 28px 12px; }
.flight-rules li { margin-block: 5px; }

@media (max-width: 760px) {
  .aeroplane-layout {
    grid-template-columns: minmax(0, 570px);
    grid-template-areas: "control" "board" "roster";
    grid-template-rows: auto;
    gap: 12px;
  }
  .flight-control { grid-template-columns: auto minmax(0, 1fr) auto; padding: 10px; }
  .flight-control:has(.flight-resign) .flight-action { grid-column: 3; grid-row: 1; padding-inline: 14px; }
  .flight-moves, .flight-seats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .flight-resign { min-height: 36px; }
  .flight-control:has(.flight-moves) .flight-resign { grid-column: 3; grid-row: 1; }
  .seat-segments i { width: 7px; }
}

@media (prefers-reduced-motion: reduce) {
  .flight-dice.fresh-roll { animation: none; }
}
</style>
