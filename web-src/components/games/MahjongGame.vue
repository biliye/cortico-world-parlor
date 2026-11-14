<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RED, SUITS, TILES, suitOf } from '../../../src/room/games/mahjong-rules.ts';
import type { MahjongTable } from '../../../src/room/games/mahjong-table.ts';
import type { GameCtx, GameView } from '../../lib/legacy-games.ts';

const props = defineProps<{ view: GameView; ctx: GameCtx }>();
type PublicTable = ReturnType<MahjongTable['public']>;
type PrivateTable = NonNullable<ReturnType<MahjongTable['view']>>;
type Seat = PublicTable['seats'][number];

const table = computed(() => props.view.table as unknown as PublicTable);
const mine = computed(() => props.view.priv as PrivateTable | null);
const actions = computed(() => props.view.table.frozen ? [] : mine.value?.actions ?? []);
const ended = computed(() => table.value.status === 'ended');
const positionNames = ['自己', '下家', '对家', '上家'];
const seats = computed(() => {
  const entries = table.value.seats ?? [];
  const own = entries.findIndex(seat => seat.id === props.view.me.id);
  return entries.map((_, i) => {
    const entry = entries[(i + Math.max(0, own)) % entries.length];
    const seat = entry.id === mine.value?.seat ? { ...entry, melds: mine.value.ownMelds } : entry;
    return { seat, position: own >= 0 ? positionNames[i] : (i + 1) + ' 号位' };
  });
});
const phaseLabel = computed(() => {
  switch (table.value.phase) {
    case 'exchange': return '换三张';
    case 'missing': return '定缺';
    case 'claim': return '弃牌响应';
    case 'result': return '本局结算';
    default: return table.value.turn === props.view.me.id ? '轮到你出牌' : '摸打进行中';
  }
});
const settlement = computed(() => {
  const all = table.value.seats ?? [];
  const winners = all.filter(seat => seat.win).map(seat => seat.name);
  return winners.length ? winners.join('、') + ' 胡牌' : '流局';
});
const selected = ref<number[]>([]);
const busy = ref(false);
const showTips = ref(false);
const hand = computed(() => {
  if (ended.value) return [];
  const entries = mine.value?.hand.slice() ?? [];
  const drawn = mine.value?.drawn;
  if (drawn == null) return entries.map(tile => ({ tile, drawn: false }));
  entries.splice(entries.lastIndexOf(drawn), 1);
  return [...entries.map(tile => ({ tile, drawn: false })), { tile: drawn, drawn: true }];
});
const selectedTile = computed(() => selected.value.length ? hand.value[selected.value[0]]?.tile : undefined);
const directions = ['', '顺换', '对换', '逆换'];
const score = (value: number) => value > 0 ? '+' + value : String(value);
const tileText = (tile: number | null) => tile === null ? '暗牌' : TILES[tile];
const claimLabels = { pung: '碰', kong: '杠', hu: '胡' };
const responses = [{ id: 'hu', label: '胡' }, { id: 'kong', label: '杠' },
  { id: 'pung', label: '碰' }, { id: 'pass', label: '过' }] as const;
const isDealer = (seat: Seat) => table.value.dealer === seat.id;

watch(() => mine.value?.windowId, () => { selected.value = []; showTips.value = false; });

function canSelect(tile: number): boolean {
  return actions.value.includes('exchange') || actions.value.includes('discard') && !!mine.value?.discardable.includes(tile);
}

function select(index: number): void {
  if (!actions.value.includes('exchange')) {
    selected.value = selected.value.includes(index) ? [] : [index];
    return;
  }
  if (selected.value.includes(index)) {
    selected.value = selected.value.filter(i => i !== index);
  } else if (selected.value.length && suitOf(hand.value[selected.value[0]].tile) !== suitOf(hand.value[index].tile)) {
    selected.value = [index];
  } else if (selected.value.length < 3) {
    selected.value = [...selected.value, index];
  }
}

async function submit(action: string, fields: Record<string, unknown> = {}) {
  if (busy.value || !mine.value || !actions.value.includes(action as PrivateTable['actions'][number])) return;
  busy.value = true;
  try {
    const reply = await props.ctx.act({
      type: table.value.game + '_action', action, windowId: mine.value.windowId, ...fields,
    });
    if (reply) selected.value = [];
  } catch {
    // 牌桌宿主显示服务端返回的动作错误。
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="mahjong" aria-label="麻将牌桌">
    <header class="status">
      <div>
        <strong>{{ phaseLabel }}</strong>
        <span v-if="ended" class="phase-detail" role="status">{{ settlement }}</span>
        <span v-else-if="table.direction" class="phase-detail">{{ directions[table.direction] }}</span>
      </div>
      <span class="wall">牌墙 <b>{{ table.wallCount }}</b> 张</span>
    </header>

    <div class="felt">
      <section v-for="{ seat, position } in seats" :key="seat.id" class="seat"
        :class="{ current: table.turn === seat.id, won: seat.win }" :aria-label="seat.name + ' 的牌河'">
        <header class="seat-heading">
          <div class="seat-name">
            <span class="position">{{ position }}</span>
            <strong>{{ seat.name }}</strong>
            <span v-if="isDealer(seat)" class="mark">庄</span>
            <span v-if="seat.win" class="mark win">{{ seat.win.from === null ? '自摸' : '已胡' }}</span>
          </div>
          <span class="seat-meta">
            <span v-if="seat.missing != null">缺{{ SUITS[seat.missing] }} · </span>{{ score(seat.score) }} 分
          </span>
        </header>
        <div v-if="seat.melds.length" class="melds" aria-label="副露">
          <span v-for="(meld, index) in seat.melds" :key="index" class="meld" :title="meld.tile === null ? '暗杠' : claimLabels[meld.kind]">
            <span v-for="n in meld.kind === 'pung' ? 3 : 4" :key="n" class="tile mini"
              :class="{ back: meld.tile === null, red: meld.tile === RED }">{{ meld.tile === null ? '' : tileText(meld.tile) }}</span>
          </span>
        </div>
        <div v-if="seat.revealed" class="revealed" aria-label="亮出的手牌">
          <span v-for="(tile, index) in seat.revealed" :key="index" class="tile mini" :class="{ red: tile === RED }">{{ tileText(tile) }}</span>
          <span v-if="seat.win?.from != null" class="tile mini win-tile" aria-label="点胡的牌">{{ tileText(seat.win.tile) }}</span>
        </div>
        <div v-else class="count">手牌 {{ seat.count }} 张</div>
        <ol class="river" aria-label="按出牌顺序">
          <li v-for="entry in seat.river" :key="entry.order" class="tile river-tile"
            :class="{ latest: entry.order === table.lastDiscard, taken: entry.taken, red: entry.tile === RED }"
            :title="tileText(entry.tile) + (entry.taken ? ' · ' + entry.claimedBy?.map(id => view.names.get(id) ?? id).join('、')
              + ' ' + claimLabels[entry.taken] : '')">
            {{ tileText(entry.tile) }}<span v-if="entry.taken" class="claim-mark">{{ claimLabels[entry.taken] }}</span>
          </li>
        </ol>
        <p v-if="!seat.river.length" class="empty">还没有出牌</p>
      </section>
    </div>

    <section v-if="mine && !ended" class="hand-panel" aria-label="你的手牌和操作">
      <div class="hand-heading">
        <strong>你的手牌</strong>
        <span v-if="actions.includes('exchange')">选三张同门牌 · {{ selected.length }}/3</span>
        <span v-else-if="actions.includes('missing')">选一门优先打完</span>
        <span v-else-if="mine.missing != null">缺{{ SUITS[mine.missing] }}</span>
      </div>
      <div class="hand">
        <button v-for="({ tile, drawn }, index) in hand" :key="index" type="button" class="tile hand-tile"
          :class="{ selected: selected.includes(index), drawn, red: tile === RED }"
          :aria-pressed="selected.includes(index)" :aria-label="tileText(tile) + (drawn ? '，刚摸到' : '')"
          :disabled="busy || !canSelect(tile)" @click="select(index)">{{ tileText(tile) }}</button>
      </div>
      <div class="actions">
        <template v-if="actions.includes('exchange')">
          <button class="btn primary" type="button" :disabled="busy || selected.length !== 3"
            @click="submit('exchange', { tiles: selected.map(i => hand[i].tile) })">确认换牌</button>
        </template>
        <template v-else-if="actions.includes('missing')">
          <button v-for="(suit, index) in SUITS" :key="suit" class="btn" type="button" :disabled="busy"
            @click="submit('missing', { suit: index })">缺{{ suit }}</button>
        </template>
        <template v-else-if="actions.includes('discard')">
          <button class="btn primary" type="button" :disabled="busy || selectedTile === undefined"
            @click="submit('discard', { tile: selectedTile })">打出</button>
          <button v-if="actions.includes('hu')" class="btn" type="button" :disabled="busy" @click="submit('hu')">自摸</button>
          <button v-for="tile in mine.kongs" :key="tile" class="btn" type="button" :disabled="busy"
            @click="submit('kong', { tile })">杠{{ tileText(tile) }}</button>
          <button v-if="mine.hints.length" class="btn ghost" type="button" :aria-expanded="showTips"
            @click="showTips = !showTips">出牌提示</button>
        </template>
        <template v-else-if="actions.includes('pass')">
          <button v-for="response in responses.filter(option => actions.includes(option.id))" :key="response.id"
            class="btn" :class="{ primary: response.id === 'hu' }" type="button" :disabled="busy"
            @click="submit(response.id)">{{ response.label }}</button>
        </template>
        <span v-else-if="table.phase === 'exchange' || table.phase === 'missing'" class="waiting">已提交，等其他玩家。</span>
      </div>
      <ul v-if="showTips && actions.includes('discard')" class="tips">
        <li v-for="hint in mine.hints" :key="hint.tile">打{{ tileText(hint.tile) }} · {{ hint.reason }}</li>
      </ul>
    </section>
    <div v-if="ended && seats.some(({ seat }) => seat.id === view.me.id)" class="actions result">
      <button class="btn primary" type="button" @click="ctx.rematch()">再来一局</button>
    </div>
  </section>
</template>

<style scoped>
.mahjong { max-width: 860px; margin-inline: auto; display: grid; gap: 12px; }
.status, .seat-heading, .hand-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.status { padding-inline: 4px; }
.status strong { font-size: 19px; }
.phase-detail, .wall, .hand-heading span, .waiting, .tips { color: var(--muted); font-size: 13px; }
.phase-detail { margin-inline-start: 10px; }
.wall { white-space: nowrap; }
.wall b { color: var(--text); font-size: 18px; font-variant-numeric: tabular-nums; }
.felt { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; padding: 1px; color: #f6f2dc; background: #5a7760; border: 5px solid #a88358; border-radius: 18px; overflow: hidden; }
.seat { min-width: 0; padding: clamp(8px, 2vw, 16px); background: #264c40; min-height: 96px; }
.seat.current { background: #2f6150; box-shadow: inset 0 0 0 1px #a2bd8e; }
.seat.won { background: #3b5142; }
.seat-name { display: flex; flex-wrap: wrap; align-items: baseline; min-width: 0; gap: 4px 7px; }
.seat-name strong { overflow-wrap: anywhere; }
.position, .count, .seat-meta, .empty { color: #d2dfcc; font-size: 12px; }
.seat-meta { flex: none; }
.mark { color: #f9d595; font-size: 11px; }
.mark.win { color: #ffe6a2; }
.count, .empty { margin-block: 4px; }
.river, .melds, .revealed, .hand { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.river { padding: 0; margin: 7px 0 0; list-style: none; }
.melds, .revealed { margin-block: 5px; }
.meld { display: inline-flex; gap: 1px; margin-inline-end: 5px; }
.tile { display: inline-grid; place-items: center; position: relative; flex: none; box-sizing: border-box; border: 1px solid #decdaa; border-bottom: 3px solid #b99e6c; border-radius: 5px; background: #fffae9; color: #17372d; font-weight: 700; line-height: 1; white-space: nowrap; }
.tile.red { color: #a62630; }
.tile.back { background: #436956; border-color: #7b9f81; }
.river-tile { width: 29px; height: 34px; font-size: 12px; }
.tile.mini { width: 23px; height: 26px; font-size: 10px; }
.latest, .win-tile { outline: 2px solid #ffc978; outline-offset: 0; }
.taken { background: #d5d5b5; padding-bottom: 6px; }
.claim-mark { position: absolute; right: 1px; bottom: 0; color: #663c23; font-size: 9px; }
.hand-panel { border: 1px solid var(--line); background: var(--panel); border-radius: 13px; padding: 10px 12px; }
.hand { margin: 8px 0; }
.hand-tile { width: clamp(36px, 6vw, 46px); min-height: 46px; cursor: pointer; font-size: 15px; transition: transform 140ms ease, background-color 140ms ease; }
.hand-tile:disabled { opacity: .7; cursor: default; }
.hand-tile.drawn { margin-inline-start: 6px; }
.hand-tile.selected { transform: translateY(-3px); background: #ffe2a5; border-color: #a96a2b; }
.hand-tile:focus-visible { outline: 2px solid #a96a2b; outline-offset: 2px; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.result { justify-content: center; }
.tips { margin-block: 8px 0; padding-inline-start: 20px; }
@media (max-width: 520px) {
  .felt { border-width: 3px; }
  .seat-heading { flex-direction: column; gap: 2px; }
  .river { gap: 3px; }
}
@media (prefers-reduced-motion: reduce) { .hand-tile { transition: none; } }
</style>
