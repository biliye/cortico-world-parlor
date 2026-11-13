<script setup lang="ts">
import { computed, ref } from 'vue';
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
const dieFaces = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

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
  last?: { text: string; die: number };
  phase?: 'await_roll' | 'await_move';
  die?: number;
});
const seats = computed(() => (table.value.seats || []) as Seat[]);
const mySeat = computed(() => seats.value.find(seat => seat.id === props.view.me.id));
const turn = computed(() => seats.value.find(seat => seat.id === table.value.turn));
const winner = computed(() => seats.value.find(seat => table.value.winners?.includes(seat.id)));
const yours = computed(() => !table.value.frozen && props.view.priv?.yourTurn === true && turn.value?.id === mySeat.value?.id);
const last = computed(() => table.value.last);
const die = computed(() => table.value.phase === 'await_roll' ? 0 : Number(table.value.die ?? last.value?.die ?? 0));
const moves = computed(() => yours.value && table.value.phase === 'await_move' ? (props.view.priv?.moves as AeroplaneMove[] ?? []) : []);
const canRoll = computed(() => yours.value && table.value.phase === 'await_roll');
const busy = ref(false);
const preview = ref<number | null>(null);

const stacks = computed(() => {
  const groups = new Map<string, { point: Point; tokens: Token[] }>();
  for (const seat of seats.value) {
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

async function submit(action: 'roll' | 'move', plane?: number): Promise<void> {
  if (busy.value || (action === 'roll' ? !canRoll.value : !moves.value.some(move => move.plane === plane))) return;
  busy.value = true;
  preview.value = null;
  try {
    await props.ctx.act({ type: 'aeroplane_action', action, ...(plane === undefined ? {} : { plane }) });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="aeroplane-layout">
    <div class="flight-frame">
      <div class="flight-board" aria-label="飞行棋棋盘">
        <div v-for="colour in colours" :key="colour.id" class="hangar" :class="colour.className" :style="grid(hangars[colour.id], 6)">
          <span>{{ colour.name }}</span>
        </div>
        <div v-for="colour in colours" :key="`parking-${colour.id}`" class="parking" :class="colour.className" :style="grid(parking[colour.id], 2)" aria-hidden="true" />
        <div v-for="cell in cells" :key="cell.point.join(',')" class="track" :class="[cell.className, { runway: cell.mark }]" :style="grid(cell.point)" aria-hidden="true">{{ cell.mark }}</div>
        <div v-for="cell in lanes" :key="cell.point.join(',')" class="lane" :class="cell.className" :style="grid(cell.point)" aria-hidden="true">{{ cell.mark }}</div>
        <div class="hub" :style="grid([7, 7])" aria-hidden="true">✦</div>
        <div v-if="target" class="flight-target" :style="grid(target)" aria-hidden="true" />
        <div v-for="[cell, stack] in stacks" :key="cell" class="plane-stack" :class="{ stacked: stack.tokens.length > 1 }" :style="grid(stack.point)">
          <template v-for="token in stack.tokens" :key="token.key">
            <button
              v-if="canFly(token)" type="button" class="plane flyable" :class="colours[token.seat.colour].className"
              :aria-label="`飞 ${token.number} 号机`" :disabled="busy" tabindex="-1"
              @click="submit('move', token.number)" @pointerenter="preview = token.number" @pointerleave="preview = null"
            >{{ token.number }}</button>
            <span v-else class="plane" :class="colours[token.seat.colour].className" :title="`${token.seat.name}的 ${token.number} 号机`">{{ token.number }}</span>
          </template>
        </div>
      </div>
    </div>

    <aside class="flight-side" aria-label="飞行棋回合信息">
      <div class="flight-control">
        <div class="flight-dice" :class="{ rolling: table.phase === 'await_move' }" aria-hidden="true">{{ dieFaces[die] || '–' }}</div>
        <div class="flight-turn" role="status">
          <strong v-if="winner">{{ winner.name }} 赢得本局</strong>
          <strong v-else-if="table.frozen">牌桌已暂停</strong>
          <strong v-else-if="yours">{{ canRoll ? '轮到你掷骰' : `掷出 ${die} 点，选择飞机` }}</strong>
          <strong v-else-if="turn">{{ table.phase === 'await_move' ? `${turn.name} 掷出 ${die} 点` : `等待 ${turn.name} 掷骰` }}</strong>
          <span v-if="winner">四架飞机全部抵达终点。</span>
          <span v-else-if="last">{{ last.text }}</span>
          <span v-else>掷出 6 点即可起飞。</span>
        </div>
        <button v-if="canRoll" type="button" class="btn primary flight-action" :disabled="busy" @click="submit('roll')">掷骰</button>
        <div v-if="moves.length" class="flight-moves">
          <button
            v-for="move in moves" :key="move.plane" type="button" class="btn flight-move" :disabled="busy"
            @click="submit('move', move.plane)" @pointerenter="preview = move.plane" @pointerleave="preview = null"
            @focus="preview = move.plane" @blur="preview = null"
          ><b>{{ move.plane }} 号机</b><span>{{ move.from === HANGAR ? '起飞' : positionText(move.to) }}{{ move.captures ? ` · 撞 ${move.captures} 架` : '' }}</span></button>
        </div>
        <button v-if="winner && mySeat" type="button" class="btn primary flight-action" @click="ctx.rematch()">再来一局</button>
      </div>
      <ul class="flight-seats">
        <li v-for="seat in seats" :key="seat.id" :class="[colours[seat.colour].className, { current: turn?.id === seat.id }]">
          <span class="flight-swatch" :title="colours[seat.colour].name" aria-hidden="true" />
          <span class="flight-seat-name">{{ seat.name }}{{ mySeat?.id === seat.id ? '（你）' : '' }}</span>
          <span class="flight-count">{{ finished(seat) }}/{{ PLANES_PER_SEAT }} 抵达</span>
        </li>
      </ul>
      <details class="flight-rules">
        <summary>飞行规则</summary>
        <ul><li v-for="rule in AEROPLANE_RULES" :key="rule">{{ rule }}</li></ul>
      </details>
    </aside>
  </section>
</template>

<style scoped>
.aeroplane-layout { display: grid; grid-template-columns: minmax(0, 550px) minmax(206px, 270px); gap: clamp(12px, 2vw, 24px); justify-content: center; align-items: start; margin-inline: auto; }
.flight-frame { min-width: 0; padding: clamp(5px, 1.5vw, 13px); border-radius: 18px; background: #e6d7b7; border: 1px solid #bd9f74; box-shadow: 0 5px 14px #2c1d182b; }
.flight-board { position: relative; isolation: isolate; display: grid; grid-template: repeat(15, minmax(0, 1fr)) / repeat(15, minmax(0, 1fr)); width: 100%; aspect-ratio: 1; border-radius: 8px; overflow: hidden; background: #f9f1de; color: #3c2c28; }
.colour-0 { --flight-ink: #a43c31; --flight-tint: #f4cac0; --flight-field: #f7ddd3; }
.colour-1 { --flight-ink: #205b8d; --flight-tint: #c0daec; --flight-field: #dce9ee; }
.colour-2 { --flight-ink: #35664b; --flight-tint: #c1dfc8; --flight-field: #dce9d8; }
.colour-3 { --flight-ink: #805108; --flight-tint: #f5dba5; --flight-field: #f5e9c7; }
.hangar { background: var(--flight-field); margin: 8%; border: 1px solid var(--flight-ink); border-radius: 16%; text-align: center; padding-block-start: 7%; color: var(--flight-ink); font-weight: 800; font-size: clamp(10px, 1.3vw, 15px); }
.parking { z-index: 1; border: 1px dashed var(--flight-ink); border-radius: 18%; background: var(--flight-tint); }
.track, .lane, .hub { display: grid; place-items: center; margin: 0.75px; border-radius: 22%; background: var(--flight-tint); color: var(--flight-ink); font-weight: 850; font-size: clamp(10px, 1.6vw, 18px); }
.track.runway, .hub { background: var(--flight-ink, #524035); color: #fff9e7; }
.lane { background: var(--flight-field); border: 1px solid var(--flight-tint); }
.plane-stack { z-index: 3; min-width: 0; min-height: 0; display: flex; justify-content: center; align-items: center; }
.plane-stack.stacked { display: grid; grid-template: repeat(2, minmax(0, 1fr)) / repeat(2, minmax(0, 1fr)); place-items: center; }
.plane { display: grid; place-items: center; width: 85%; aspect-ratio: 1; border: 1px solid #fffaf1; border-radius: 50%; background: var(--flight-ink); color: #fff; font-size: clamp(8px, 1.45vw, 14px); font-weight: 800; line-height: 1; padding: 0; box-shadow: 0 1px 3px #3a2b2770; }
.stacked .plane { width: 100%; font-size: clamp(6px, 1.1vw, 11px); }
.flyable { cursor: pointer; outline: 2px solid #fff7cc; box-shadow: 0 0 0 3px #38281c; }
.flyable:disabled { cursor: wait; opacity: .7; }
.flyable:hover, .flyable:focus-visible { filter: brightness(1.25); z-index: 1; }
.flight-target { z-index: 2; margin: 1px; border: 2px solid #513d20; outline: 1px solid #fff9e7; border-radius: 25%; pointer-events: none; }
.flight-side { display: grid; gap: 12px; min-width: 0; }
.flight-control { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 12px; padding: 13px; border: 1px solid var(--line-2); border-radius: 14px; background: var(--panel-2); }
.flight-dice { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 11px; background: #fff3d9; color: #50392a; font-size: 38px; line-height: 1; box-shadow: inset 0 0 0 1px #cdb481; }
.flight-dice.rolling { animation: flight-dice-in 190ms ease-out; }
@keyframes flight-dice-in { from { transform: rotate(-12deg) scale(.8); } to { transform: none; } }
.flight-turn { display: grid; gap: 3px; overflow-wrap: anywhere; }
.flight-turn strong { font-size: 15px; }
.flight-turn span, .flight-rules { color: var(--muted); font-size: 13px; }
.flight-action, .flight-moves { grid-column: 1 / -1; }
.flight-action, .flight-move { min-height: 44px; }
.flight-moves { display: grid; gap: 6px; }
.flight-move { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 8px; text-align: left; }
.flight-move span { font-size: 12px; }
.flight-seats { list-style: none; padding: 0; margin: 0; display: grid; gap: 3px; }
.flight-seats li { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 9px; border: 1px solid transparent; font-size: 13px; }
.flight-seats li.current { border-color: var(--accent-border); background: var(--accent-soft); }
.flight-swatch { width: 12px; height: 12px; flex: 0 0 12px; background: var(--flight-ink); border: 1px solid var(--flight-tint); border-radius: 50%; }
.flight-seat-name { overflow-wrap: anywhere; }
.flight-count { margin-inline-start: auto; white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--muted); }
.flight-rules summary { cursor: pointer; padding: 6px 3px; }
.flight-rules ul { margin-block: 4px 0; padding-inline-start: 21px; }
.flight-rules li { margin-block: 5px; }
@media (max-width: 670px) {
  .aeroplane-layout { grid-template-columns: minmax(0, 540px); }
  .flight-seats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (prefers-reduced-motion: reduce) { .flight-dice.rolling { animation: none; } }
</style>
