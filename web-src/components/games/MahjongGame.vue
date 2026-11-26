<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { SUITS, TILES, suitOf } from '../../../src/room/games/mahjong-rules.ts';
import type { MahjongTable } from '../../../src/room/games/mahjong-table.ts';
import type { GameCtx, GameView } from '../../lib/game-types.ts';
import { mahjongArt, preloadMahjongArt } from '../../lib/mahjong-art.ts';
import MahjongTileFace from './MahjongTileFace.vue';
import TableSpeech from './TableSpeech.vue';

preloadMahjongArt(true);

const props = defineProps<{ view: GameView; ctx: GameCtx }>();
type PublicTable = ReturnType<MahjongTable['public']>;
type PrivateTable = NonNullable<ReturnType<MahjongTable['view']>>;
type Seat = PublicTable['seats'][number];

const table = computed(() => props.view.table as unknown as PublicTable);
const mine = computed(() => props.view.priv as PrivateTable | null);
const actions = computed(() => props.view.table.frozen ? [] : mine.value?.actions ?? []);
const ended = computed(() => table.value.status === 'ended');
const score = (value: number) => value > 0 ? '+' + value : String(value);
const tileText = (tile: number | null) => tile === null ? '暗牌' : TILES[tile];
const claimLabels = { pung: '碰', kong: '杠', hu: '胡' };
const riverLabel = (entry: { tile: number; taken?: keyof typeof claimLabels; claimedBy?: string[] }) =>
  tileText(entry.tile) + (entry.taken
    ? '，被 ' + (entry.claimedBy ?? []).map(id => props.view.names.get(id)
      ?? table.value.seats.find(seat => seat.id === id)?.name ?? id).join('、') + ' ' + claimLabels[entry.taken]
    : '');

const meldSummary = (seat: Seat) => seat.melds
  .map(meld => (meld.kind === 'pung' ? '碰' : '杠') + (meld.tile === null ? '暗' : tileText(meld.tile)))
  .join(' · ');

interface Showdown { tiles: number[]; winIndex: number }
/** 结算摊牌：点炮的那张不在手里，要补在末尾；胡牌张单独标出来。 */
function showdownOf(seat: Seat): Showdown | null {
  if (!seat.revealed) return null;
  const tiles = seat.revealed.slice();
  if (seat.win && seat.win.from != null) tiles.push(seat.win.tile);
  let winIndex = -1;
  if (seat.win) {
    for (let i = tiles.length - 1; i >= 0; i--) if (tiles[i] === seat.win.tile) { winIndex = i; break; }
  }
  return { tiles, winIndex };
}

type Spot = 'up' | 'left' | 'right' | 'me';
const POSITION: Record<Spot, string> = { me: '自己', right: '下家', up: '对家', left: '上家' };
interface RingSeat { spot: Spot; label: string; vertical: boolean; seat: Seat; show: Showdown | null; isMe: boolean }

/** 四家按麻将的逆时针方位摆到环上：对家在上、上家在左、下家在右、自己在下方。 */
const ring = computed<RingSeat[]>(() => {
  const list = table.value.seats ?? [];
  if (!list.length) return [];
  const own = list.findIndex(seat => seat.id === props.view.me.id);
  const used = new Set<string>();
  const at = (offset: number): Seat | undefined => own < 0
    ? undefined
    : list[((own + offset) % list.length + list.length) % list.length];
  const take = (entry: Seat | undefined, spot: Spot, vertical: boolean): RingSeat | null => {
    if (!entry || used.has(entry.id)) return null;
    used.add(entry.id);
    // 旁观时没有「自己」，位置按座次标号
    const label = own >= 0 ? POSITION[spot] : `${list.indexOf(entry) + 1} 号位`;
    const seat = entry.id === mine.value?.seat ? { ...entry, melds: mine.value.ownMelds } : entry;
    return { spot, label, vertical, seat, show: showdownOf(seat), isMe: seat.id === props.view.me.id };
  };
  return [
    take(at(0) ?? list[0], 'me', false),
    take(at(1) ?? list[1], 'right', true),
    take(at(2) ?? list[2], 'up', false),
    take(at(3) ?? list[3], 'left', true),
  ].filter((slot): slot is RingSeat => slot !== null);
});

const turnName = computed(() => {
  const id = table.value.turn;
  return id ? props.view.names.get(id) ?? '其他玩家' : '';
});

const phaseLabel = computed(() => {
  switch (table.value.phase) {
    case 'exchange': return '换三张';
    case 'missing': return '定缺';
    case 'claim': return '弃牌响应';
    case 'result': return '本局结算';
    default: return table.value.turn === props.view.me.id
      ? '轮到你出牌'
      : turnName.value ? turnName.value + ' 出牌中' : '摸打进行中';
  }
});

const settlement = computed(() => {
  const winners = (table.value.seats ?? []).filter(seat => seat.win);
  if (!winners.length) return '流局 · 牌墙摸完';
  return winners.map(seat => seat.name + ' '
    + (seat.win!.from === null ? '自摸' : '点炮') + ' ' + tileText(seat.win!.tile)
    + ' · ' + score(seat.score) + ' 分').join('，');
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
const responses = [{ id: 'hu', label: '胡' }, { id: 'kong', label: '杠' },
  { id: 'pung', label: '碰' }, { id: 'pass', label: '跳过' }] as const;
const isDealer = (seat: Seat) => table.value.dealer === seat.id;
const mySlot = computed(() => ring.value.find(slot => slot.isMe));
const myScore = computed(() => mySlot.value?.seat.score ?? null);
// 血战续打时自己的摊牌放在手牌区，结算后才回到桌上的摊牌布局。
const myShowdown = computed(() => mine.value && !ended.value && mySlot.value?.seat.win ? mySlot.value.show : null);

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
  <section class="mahjong" :class="{ ended }" :style="{
    '--mj-board-img': mahjongArt.board || 'none',
    '--mj-faces-img': mahjongArt.faces,
    '--mj-cloth-img': mahjongArt.cloth || 'none',
  }" aria-label="麻将牌桌">
    <header class="hud">
      <div class="hud-line">
        <span class="dot" :class="{ live: !ended && table.turn === view.me.id }" aria-hidden="true"></span>
        <strong>{{ phaseLabel }}</strong>
        <span v-if="ended" class="hud-sub" role="status">{{ settlement }}</span>
        <span v-else-if="table.direction" class="hud-sub">{{ directions[table.direction] }}</span>
        <span v-else-if="mine?.missing != null" class="hud-sub">缺 {{ SUITS[mine.missing] }}</span>
      </div>
    </header>

    <div class="felt">
      <template v-for="slot in ring" :key="slot.spot">
        <section class="seat" :class="['seat-' + slot.spot, { 'is-self': slot.isMe, current: table.turn === slot.seat.id, won: !!slot.seat.win }]"
          :aria-label="slot.seat.name">
          <header class="who">
            <span class="position" :class="{ self: slot.isMe }">{{ slot.label }}</span>
            <strong class="seat-name">{{ slot.seat.name }}</strong>
            <span v-if="isDealer(slot.seat)" class="mark">庄</span>
            <span v-if="slot.seat.win" class="mark win">{{ slot.seat.win.from === null ? '自摸' : '点炮' }}</span>
            <span class="points" :class="{ plus: slot.seat.score > 0, minus: slot.seat.score < 0 }">{{ score(slot.seat.score) }}</span>
            <span v-if="slot.seat.missing != null" class="lack">缺 {{ SUITS[slot.seat.missing] }}</span>
            <span v-if="!slot.show && !slot.isMe" class="hand-count">{{ slot.seat.count }} 张</span>
            <TableSpeech v-if="mine && !ended && !slot.isMe" :table="view.table.tableId || view.table.id || ''"
              :sender="slot.seat.id" :align="slot.spot === 'up' ? 'center' : slot.spot === 'right' ? 'right' : 'left'" above />
          </header>

          <div v-if="!slot.isMe || ended || (slot.show && !myShowdown)" class="seat-rack">
            <div v-if="!slot.isMe && !slot.show && slot.seat.count" class="backs" aria-hidden="true">
              <span v-for="n in slot.seat.count" :key="n"></span>
            </div>

            <div v-if="slot.show" class="showdown" :class="{ 'is-win': !!slot.seat.win }" aria-label="摊开的手牌">
              <span class="showdown-tag">摊牌</span>
              <span v-for="(tile, index) in slot.show.tiles" :key="index" class="tile sz-show"
                :class="{ win: index === slot.show.winIndex }" :title="tileText(tile)">
                <MahjongTileFace :tile="tile" />
              </span>
            </div>

            <div v-if="slot.seat.melds.length && (!slot.isMe || ended)" class="melds"
              :aria-label="meldSummary(slot.seat)">
              <span v-for="(meld, index) in slot.seat.melds" :key="index" class="meld"
                :title="meld.tile === null ? '暗杠' : claimLabels[meld.kind] + tileText(meld.tile)">
                <span v-for="n in (meld.kind === 'pung' ? 3 : 4)" :key="n" class="tile sz-mini"
                  :class="{ back: meld.tile === null }">
                  <MahjongTileFace v-if="meld.tile !== null" :tile="meld.tile" />
                </span>
              </span>
            </div>
          </div>

          <component v-if="slot.seat.river.length" :is="ended ? 'details' : 'div'" class="river-area">
            <summary v-if="ended">牌河 · {{ slot.seat.river.length }} 张</summary>
            <ol class="river" :class="slot.vertical ? 'river-v' : 'river-h'" aria-label="按出牌顺序">
              <li v-for="entry in slot.seat.river" :key="entry.order" class="tile sz-river"
                :class="{ latest: entry.order === table.lastDiscard, taken: entry.taken }"
                :title="riverLabel(entry)" :aria-label="riverLabel(entry)">
                <MahjongTileFace :tile="entry.tile" />
                <span v-if="entry.taken" class="claim-mark" aria-hidden="true">{{ claimLabels[entry.taken] }}</span>
              </li>
            </ol>
          </component>
        </section>
      </template>

      <div v-if="!ended" class="core" aria-label="牌桌中央">
        <span class="core-cap">余牌</span>
        <b class="core-num">{{ table.wallCount }}</b>
        <span class="core-turn">{{ phaseLabel }}</span>
      </div>
    </div>

    <section v-if="mine && !ended" class="hand-panel" aria-label="你的手牌和操作">
      <div v-if="!myShowdown" class="dock" :aria-label="actions.length ? '可选动作' : undefined">
        <template v-if="actions.includes('exchange')">
          <button class="act act-primary" type="button" :disabled="busy || selected.length !== 3"
            @click="submit('exchange', { tiles: selected.map(i => hand[i].tile) })"><span>确认换牌</span></button>
        </template>
        <template v-else-if="actions.includes('missing')">
          <button v-for="(suit, index) in SUITS" :key="suit" class="act" type="button" :disabled="busy"
            @click="submit('missing', { suit: index })"><span>缺{{ suit }}</span></button>
        </template>
        <template v-else-if="actions.includes('discard')">
          <button class="act act-primary" type="button" :disabled="busy || selectedTile === undefined"
            @click="submit('discard', { tile: selectedTile })"><span>打出</span></button>
          <button v-if="actions.includes('hu')" class="act act-gold" type="button" :disabled="busy"
            @click="submit('hu')"><span>自摸</span></button>
          <button v-for="tile in mine?.kongs ?? []" :key="tile" class="act" type="button" :disabled="busy"
            @click="submit('kong', { tile })"><span>杠{{ tileText(tile) }}</span></button>
        </template>
        <template v-else-if="actions.includes('pass')">
          <button v-for="response in responses.filter(option => actions.includes(option.id))" :key="response.id"
            class="act" :class="{ 'act-gold': response.id === 'hu', 'act-quiet': response.id === 'pass' }" type="button"
            :disabled="busy" @click="submit(response.id)"><span>{{ response.label }}</span></button>
        </template>
      </div>

      <div class="hand-heading">
        <span v-if="myShowdown" class="hand-label">{{ mySlot?.seat.win?.from === null ? '自摸' : '点炮胡牌' }} · 观战中</span>
        <span v-else class="hand-label">你的手牌</span>
        <span v-if="actions.includes('exchange')">选三张同门 · <b>{{ selected.length }}/3</b></span>
        <span v-else-if="actions.includes('missing')">选一门优先打完</span>
        <span v-else-if="mine.missing != null" class="lack">缺 {{ SUITS[mine.missing] }}</span>
        <span v-if="myScore != null" class="hand-score" :class="{ plus: myScore > 0, minus: myScore < 0 }">{{ score(myScore) }} 分</span>
      </div>

      <div class="hand-rack">
        <div class="hand">
          <template v-if="myShowdown">
            <span v-for="(tile, index) in myShowdown.tiles" :key="index" class="tile sz-hand"
              :class="{ win: index === myShowdown.winIndex }" role="img"
              :aria-label="tileText(tile) + (index === myShowdown.winIndex ? '，胡牌张' : '')">
              <MahjongTileFace :tile="tile" />
            </span>
          </template>
          <template v-else>
            <button v-for="({ tile, drawn }, index) in hand" :key="index" type="button" class="tile sz-hand"
              :class="{ selected: selected.includes(index), drawn }"
              :aria-pressed="selected.includes(index)" :aria-label="tileText(tile) + (drawn ? '，刚摸到' : '')"
              :disabled="busy || !canSelect(tile)" @click="select(index)">
              <MahjongTileFace :tile="tile" />
            </button>
          </template>
        </div>

        <div v-if="mine.ownMelds.length" class="melds own-melds" aria-label="你的副露">
          <span v-for="(meld, index) in mine.ownMelds" :key="index" class="meld"
            :title="meld.tile === null ? '暗杠' : claimLabels[meld.kind] + tileText(meld.tile)">
            <span v-for="n in (meld.kind === 'pung' ? 3 : 4)" :key="n" class="tile sz-mini"
              :class="{ back: meld.tile === null }">
              <MahjongTileFace v-if="meld.tile !== null" :tile="meld.tile" />
            </span>
          </span>
        </div>
      </div>

      <div class="hand-foot">
        <button v-if="actions.includes('discard') && mine.hints.length" class="btn ghost" type="button"
          :aria-expanded="showTips" @click="showTips = !showTips">出牌提示</button>
        <span v-if="(table.phase === 'exchange' || table.phase === 'missing') && !actions.length" class="waiting">已提交，等其他玩家。</span>
      </div>

      <ul v-if="showTips && actions.includes('discard')" class="tips">
        <li v-for="hint in mine.hints" :key="hint.tile">打{{ tileText(hint.tile) }} · {{ hint.reason }}</li>
      </ul>
    </section>

    <div v-if="ended && ring.some(slot => slot.isMe)" class="actions result">
      <button class="btn primary" type="button" @click="ctx.rematch()">再来一局</button>
    </div>
  </section>
</template>

<style scoped>
.mahjong {
  --mj-cloth: #1c4034;
  --mj-cloth-lift: #25523f;
  --mj-gold: #f0b95e;
  --mj-ink: #f3f8f2;
  --mj-sub: #b7cec1;
  --mj-line: rgba(255, 255, 255, .10);
  --mj-lack-bg: rgba(255, 130, 100, .18);
  --mj-lack-ink: #ffc9b6;
  --mj-lack-panel-bg: rgba(255, 130, 100, .18);
  --mj-lack-panel-ink: #ffc9b6;
  --mj-face-hi: #fffefb;
  --mj-face: #fdf9f0;
  --mj-face-lo: #fbf6ea;
  --mj-wall-hi: #e8d9b8;
  --mj-wall-lo: #bfa87d;
  --mj-tile-edge: rgba(34, 26, 15, .52);
  --mj-tile-shadow: rgba(4, 12, 9, .58);
  --mj-tile-ink: #23332b;
  --rv-w: clamp(24px, 4.4cqw, 43px);
  width: 100%;
  max-width: 960px;
  margin-inline: auto;
  display: grid;
  gap: 8px;
  min-width: 0;
  container-type: inline-size;
}

html[data-theme="light"] .mahjong {
  --mj-cloth: #27503f;
  --mj-cloth-lift: #2f5c49;
  --mj-sub: #c6d9cb;
  --mj-lack-panel-bg: rgba(168, 52, 30, .14);
  --mj-lack-panel-ink: #8f3320;
  --mj-face-hi: #ffffff;
  --mj-face: #fefcf6;
  --mj-face-lo: #fdf9f1;
  --mj-wall-hi: #f1e5c9;
  --mj-wall-lo: #cab48b;
  --mj-tile-edge: rgba(34, 26, 15, .46);
  --mj-tile-shadow: rgba(30, 20, 8, .34);
}

/* ── 顶部状态 ── */
.hud { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding-inline: 2px; }
.hud-line { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; }
.hud-line strong { font-size: 18px; }
.hud-sub { color: var(--muted); font-size: 12.5px; }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--dim); }
.dot.live { background: var(--lime); box-shadow: 0 0 0 3px color-mix(in srgb, var(--lime) 22%, transparent); animation: mj-pulse 1.8s ease-in-out infinite; }
@keyframes mj-pulse { 50% { opacity: .45; } }

/* ── 牌桌（环形） ── */
.felt {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.48fr) minmax(0, 1fr);
  grid-template-areas:
    "left up   right"
    "left core right"
    "left dn   right";
  gap: 8px 12px;
  padding: clamp(32px, 6.5cqw, 63px) clamp(22px, 6cqw, 58px) clamp(24px, 4.5cqw, 44px);
  border-radius: 22px;
  background: var(--mj-cloth) var(--mj-board-img) center / 100% 100% no-repeat;
  box-shadow: 0 18px 38px rgba(0, 0, 0, .28);
}

.seat { position: relative; z-index: 1; min-width: 0; color: var(--mj-ink); }
.seat-up, .seat-me { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.seat-up { grid-area: up; }
.seat-me { grid-area: dn; padding-block: 2px 6px; }
.mahjong:not(.ended) .seat-me > .seat-rack { order: 1; }
.seat-left, .seat-right {
  --rv-w: clamp(23px, 3.9cqw, 38px);
  --side-tile-w: 25px;
  --side-tile-h: 18px;
  display: grid; align-items: center; gap: 6px;
}
.seat-left {
  grid-area: left;
  grid-template: 'who rack river' / auto auto minmax(0, 1fr);
}
.seat-right {
  grid-area: right;
  grid-template: 'river rack who' / minmax(0, 1fr) auto auto;
}
.who { grid-area: who; }
.seat-rack { grid-area: rack; display: flex; align-items: center; gap: 9px; min-width: 0; max-inline-size: 100%; }
/* 副露总排在座位右端。对家和右家转向桌心后，视觉顺序随之反向。 */
.seat-up > .seat-rack { flex-direction: row-reverse; align-items: flex-start; }
.seat-left > .seat-rack, .seat-right > .seat-rack { flex-direction: column; }
.seat-right > .seat-rack { flex-direction: column-reverse; }
.mahjong:not(.ended) .river-area {
  grid-area: river; min-width: 0; max-inline-size: 100%;
  overflow-x: auto; scrollbar-width: thin; padding: 2px 2px 5px; box-sizing: border-box;
}
.seat-left > .river-area { justify-self: end; }
.seat-right > .river-area { justify-self: start; }

.seat.current .seat-name { color: #ffe2ab; text-shadow: 0 0 14px rgba(240, 185, 94, .45); }
.seat.current .position { border-color: transparent; background: var(--mj-gold); color: #2b1a06; font-weight: 700; }
.seat.won .seat-name { color: #ffd894; }

/* ── 席位信息 ── */
.who {
  position: relative;
  display: flex; align-items: center; flex-wrap: wrap; gap: 3px 6px; min-width: 0;
  padding: 4px 8px; border-radius: 9px; background: rgba(8, 22, 17, .34);
  border: 1px solid rgba(255, 255, 255, .07);
}
.seat-left .who, .seat-right .who {
  flex: none; flex-direction: column; align-items: flex-end; gap: 2px; width: 70px;
  box-sizing: border-box; padding: 5px 6px; text-align: right;
}
.seat-left .who .seat-name, .seat-right .who .seat-name { font-size: 12px; line-height: 1.25; }
.position { flex: none; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--mj-line); background: rgba(0, 0, 0, .2); color: var(--mj-sub); font-size: 10px; letter-spacing: .08em; }
.position.self { border-color: transparent; background: var(--mj-gold); color: #2b1a06; font-weight: 700; }
.seat-name { font-size: 14px; font-weight: 700; overflow-wrap: anywhere; }
.mark { flex: none; padding: 0 5px; border: 1px solid rgba(247, 215, 155, .35); border-radius: 999px; color: #f7d79b; font-size: 10px; }
.mark.win { background: rgba(247, 215, 155, .18); }
.points { flex: none; color: var(--mj-sub); font-size: 12px; font-variant-numeric: tabular-nums; font-weight: 700; }
.points.plus { color: #ffd998; }
.points.minus { color: #a9c6b4; opacity: .85; }
.lack { flex: none; padding: 0 6px; border-radius: 999px; background: var(--mj-lack-bg); color: var(--mj-lack-ink); font-size: 10.5px; }

/* ── 牌面：实体瓷砖（亮顶面 + 前壁厚度 + 接触阴影，参照雀魂的实牌观感） ──
   结构：.tile 自身是整块牌（背景只在下沿 --thick 露出来 = 前壁），
   ::before 是顶面，压在前壁之上并留一道接缝，牌才像一块立着的实体。 */
.tile {
  --thick: 3px;
  display: inline-flex; flex-direction: column; align-items: center; justify-content: center;
  position: relative; flex: none; box-sizing: border-box; padding: 0;
  border: 0; border-radius: 4px;
  /* 顶面区域透明，只让下沿一条露出前壁（浅→深，模拟侧壁受光） */
  background: linear-gradient(180deg,
    rgba(0, 0, 0, 0) 0 calc(100% - var(--thick)),
    var(--mj-wall-hi) calc(100% - var(--thick)),
    var(--mj-wall-lo) 100%);
  box-shadow:
    0 0 0 1px var(--mj-tile-edge),                                   /* 整块牌的外轮廓，1px 才立得起来 */
    0 calc(var(--thick) + 0.5px) 1px -0.5px rgba(0, 0, 0, .55),     /* 底面贴着桌面的接触阴影 */
    0 calc(var(--thick) + 4px) 9px -3px var(--mj-tile-shadow);       /* 落在桌面上的投影 */
  color: var(--mj-tile-ink); font-weight: 800; line-height: 1;
  transition: transform .14s ease, box-shadow .14s ease;
}
/* 顶面：象牙白，上沿/左沿受光、右沿与下沿转暗，四周不留内凹环 */
.tile::before {
  content: ''; position: absolute; inset: 0 0 var(--thick) 0;
  border-radius: 4px 4px 1px 1px; pointer-events: none;
  background: linear-gradient(174deg,
    var(--mj-face-hi) 0%, var(--mj-face) 54%, var(--mj-face-lo) 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, .98),      /* 上沿高光 */
    inset 1.5px 0 0 rgba(255, 255, 255, .52),    /* 左沿高光 */
    inset -1.5px 0 0 rgba(118, 96, 62, .22),     /* 右沿暗部 */
    inset 0 -1px 0 rgba(108, 86, 54, .32),       /* 顶面与前壁的接缝 */
    0 1px 0 rgba(255, 255, 255, .44);            /* 前壁顶端的一线反光 */
}
.tile > * { position: relative; z-index: 1; }
/** 牌面图案：贴在顶面上，留出顶面边光与下方前壁。 */
.tile .face {
  position: absolute; left: 3px; top: 3px;
  width: calc(100% - 6px); height: calc(100% - var(--thick) - 5px);
  pointer-events: none; user-select: none;
}
.tile.back {
  background: linear-gradient(180deg,
    rgba(0, 0, 0, 0) 0 calc(100% - var(--thick)),
    #3f6b57 calc(100% - var(--thick)),
    #27473b 100%);
}
.tile.back::before {
  background:
    repeating-linear-gradient(45deg, rgba(255, 255, 255, .07) 0 3px, transparent 3px 6px),
    linear-gradient(174deg, #6b9c83, #45745e 56%, #33584a);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, .34),
    inset 1.5px 0 0 rgba(255, 255, 255, .18),
    inset -1.5px 0 0 rgba(0, 0, 0, .26),
    inset 0 -1px 0 rgba(0, 0, 0, .40),
    0 1px 0 rgba(255, 255, 255, .18);
}

/* 牌河和副露平放在桌上，沿用相同的落影。 */
:is(.river, .meld) .tile {
  box-shadow:
    0 0 0 1px var(--mj-tile-edge),
    0 calc(var(--thick) + 1px) 2px -1px rgba(0, 0, 0, .48);
}

.sz-river { width: var(--rv-w); height: var(--rv-h); font-size: calc(var(--rv-w) * .44); border-radius: 3px; --thick: 3px; }
.sz-mini { width: clamp(19px, 2.4cqw, 24px); aspect-ratio: 1 / 1.14; font-size: 11px; border-radius: 3px; --thick: 3px; }
.sz-mini .face { inset: 2px 2px calc(var(--thick) + 1px); width: auto; height: auto; }
.sz-show { width: 30px; height: 35px; font-size: 14px; border-radius: 3px; --thick: 2.5px; }
.sz-hand { width: clamp(40px, 4.4vw, 54px); aspect-ratio: 1 / 1.32; font-size: 20px; border-radius: 5px; --thick: 4px; }
button.sz-hand { cursor: pointer; }
.sz-hand::before { border-radius: 5px 5px 1px 1px; }

/* ── 副露 / 摊牌 / 牌河 ── */
.melds { display: flex; flex-wrap: wrap; gap: 7px 9px; }
.meld { display: inline-flex; flex: none; gap: 2px; }
.seat-up .melds { justify-content: flex-end; }
.mahjong:not(.ended) :is(.seat-left, .seat-right) .melds { flex-direction: column; }
.mahjong:not(.ended) :is(.seat-left, .seat-right) .meld { flex-direction: column; }
.mahjong:not(.ended) :is(.seat-left, .seat-right) .sz-mini {
  width: var(--side-tile-w); height: max(16px, var(--side-tile-h)); font-size: 9px;
}
.mahjong:not(.ended) :is(.seat-left, .seat-right) .sz-mini .face { inset-block: 1px var(--thick); }

.showdown { display: flex; flex-wrap: wrap; align-items: center; gap: 3px; padding: 4px 6px 5px; border-radius: 8px; background: rgba(255, 255, 255, .05); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .07); }
.showdown.is-win { background: rgba(255, 255, 255, .09); box-shadow: inset 0 0 0 1px rgba(240, 185, 94, .34); }
.showdown-tag { flex: none; margin-inline-end: 3px; color: #f7d79b; font-size: 10px; letter-spacing: .1em; white-space: nowrap; }
.tile.win { z-index: 1; transform: translateY(-2px); outline: 2px solid var(--mj-gold); outline-offset: 1px; }

/* 局中侧家摊牌仍留在各自桌边。 */
.mahjong:not(.ended) :is(.seat-left, .seat-right) .showdown {
  --show-tile-w: max(16px, var(--side-tile-h));
  display: grid; grid-template-columns: repeat(2, var(--show-tile-w));
  gap: 2px; padding: 4px 3px;
}
.mahjong:not(.ended) :is(.seat-left, .seat-right) .showdown-tag { grid-column: 1 / -1; margin: 0 0 1px; }
.mahjong:not(.ended) :is(.seat-left, .seat-right) .sz-show {
  width: var(--show-tile-w); height: max(21px, var(--side-tile-w)); font-size: 9px;
}
.mahjong:not(.ended) :is(.seat-left, .seat-right) .tile.win { transform: none; outline-width: 1.5px; }
.mahjong.ended .felt {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-areas: "left up" "dn right";
  gap: 10px;
}
.mahjong.ended .felt .seat {
  display: flex; flex-direction: column; align-items: stretch; justify-content: flex-start;
  gap: 6px; padding: 8px; box-sizing: border-box;
  border-radius: 8px; background: rgba(8, 22, 17, .55);
}
.mahjong.ended .felt .seat > * { align-self: stretch; }
.mahjong.ended .seat-rack { flex-direction: column; align-items: stretch; }
.mahjong.ended .melds { justify-content: flex-start; }
.mahjong.ended .river-area > summary {
  color: var(--mj-ink); font-size: 12px; cursor: pointer; padding-block: 4px;
}
.mahjong.ended .river {
  display: flex; flex-wrap: wrap; padding: 3px 2px 5px;
}
.mahjong.ended .river .sz-river { width: 25px; height: 30px; }

.hand-count { flex: none; color: var(--mj-sub); font-size: 10.5px; opacity: .8; }

/* 站着的牌露出浅色顶边，右侧面略暗，牌脚紧贴桌布。 */
.backs {
  --back-w: clamp(14px, 2cqw, 21px);
  --back-h: clamp(21px, 3.25cqw, 32px);
  --back-top: 5px;
  --back-side: 4px;
  --rack-slant: 0deg;
  display: grid; flex: none; gap: 1px; grid-auto-flow: column;
}
.seat-left .backs, .seat-right .backs {
  --back-w: var(--side-tile-w);
  --back-h: var(--side-tile-h);
  --back-top: 4px;
  grid-auto-flow: row; transform: skewX(var(--rack-slant)); margin-inline: 5px;
}
.seat-left .backs { --rack-slant: -4deg; }
.seat-right .backs { --rack-slant: 4deg; }
.backs > span {
  position: relative; width: var(--back-w); height: var(--back-h); border-radius: 3px;
  background: linear-gradient(145deg, #78b293, #4e896e 60%, #34624f);
  box-shadow: inset 1px 0 rgba(233, 251, 237, .27), 0 2px 3px rgba(3, 17, 11, .62);
}
.backs > span::before, .backs > span::after { content: ''; position: absolute; }
.backs > span::before {
  inset: 0 var(--back-side) auto 0; height: var(--back-top); border-radius: 3px 0 1px 0;
  background: linear-gradient(var(--mj-face-hi), var(--mj-wall-hi));
  box-shadow: 0 1px rgba(26, 53, 40, .58);
}
.backs > span::after {
  inset: 0 0 0 auto; width: var(--back-side); border-radius: 0 3px 3px 0;
  background: linear-gradient(#e0cdab 0 var(--back-top), #42745d var(--back-top), #234a3a);
}

.river {
  --rv-h: calc(var(--rv-w) * 1.15);
  flex: none; list-style: none; margin: 0; padding: 0; display: grid; gap: 4px;
}
.river-h { grid-template-columns: repeat(6, var(--rv-w)); }
.river-v { grid-template-rows: repeat(6, var(--rv-h)); grid-auto-flow: column; grid-auto-columns: var(--rv-w); }
.seat.won .river { opacity: .6; }
.river > .tile.latest { z-index: 2; outline: 2px solid var(--mj-gold); outline-offset: 1px; box-shadow: 0 0 12px rgba(240, 185, 94, .35); }
.river > .tile.taken::before { background: linear-gradient(180deg, #e6ddc4, #cfc3a2); outline: 1px dashed rgba(96, 72, 46, .55); outline-offset: -1px; }
.river > .tile.taken .face { opacity: .62; }
.claim-mark {
  position: absolute; z-index: 2; inset: auto 0 0 auto; padding: 1px 2px;
  border-radius: 3px; background: #1d2b26; color: #fff1d3; font-size: 10px; line-height: 1.1;
}

/* ── 中央场况 ── */
.core {
  grid-area: core; position: relative; z-index: 1;
  justify-self: center; align-self: center;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
  width: clamp(108px, 13.2cqw, 126px); aspect-ratio: 1;
  padding: 10px; box-sizing: border-box; border-radius: 18px;
  background: radial-gradient(120% 110% at 50% -8%, #3d5249, #1d2b26 76%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, .14),
    inset 0 -3px 0 rgba(0, 0, 0, .55),
    inset 0 0 0 1px rgba(240, 185, 94, .34),
    inset 0 0 0 8px rgba(4, 14, 11, .34),
    0 6px 0 -1px rgba(0, 0, 0, .42),
    0 14px 26px rgba(0, 0, 0, .42);
  color: var(--mj-sub); text-align: center;
}
.core-cap { font-size: 10px; letter-spacing: .18em; opacity: .78; }
.core-num { font-family: var(--num); font-size: clamp(28px, 3.8vw, 36px); line-height: 1.05; color: #ffe6b0; font-variant-numeric: tabular-nums; }
.core-turn { margin-top: 3px; max-width: 100%; font-size: 10.5px; line-height: 1.25; color: var(--mj-sub); opacity: .9; }

/* ── 牌桌和手牌之间预留动作区 ── */
.dock {
  display: flex; align-items: center; justify-content: safe center; gap: 8px;
  block-size: 46px; min-width: 0; padding-inline: 8px;
  overflow-x: auto; scrollbar-width: thin;
}
.dock .act {
  flex: none;
  appearance: none; cursor: pointer; font-family: inherit;
  min-width: 72px; padding: 12px 18px; border-radius: 3px;
  border: 1px solid rgba(255, 245, 220, .5); border-bottom: 3px solid rgba(0, 0, 0, .6);
  background: linear-gradient(180deg, #5a4632, #241a12 58%, #120d09);
  color: #fdf7e8; font-size: 16px; font-weight: 800; letter-spacing: .16em;
  line-height: 1; transform: skewX(-13deg);
  box-shadow: 0 10px 24px rgba(0, 0, 0, .5), inset 0 1px 0 rgba(255, 255, 255, .3);
  transition: transform .12s ease, box-shadow .12s ease, filter .12s ease;
}
.dock .act > span { display: inline-block; transform: skewX(13deg); }
.dock .act:hover:not(:disabled) { filter: brightness(1.18); box-shadow: 0 11px 24px rgba(0, 0, 0, .52), inset 0 1px 0 rgba(255, 255, 255, .26); }
.dock .act:active:not(:disabled) { transform: skewX(-13deg) translateY(1px); }
.dock .act:disabled { opacity: .58; }
.dock .act-quiet { border-color: rgba(255, 255, 255, .26); color: #ddd5c6; }
.dock .act-primary {
  border-color: rgba(255, 216, 150, .74);
  background: linear-gradient(180deg, #bd4a32, #7d1d11);
  box-shadow: 0 9px 22px rgba(150, 40, 20, .5), inset 0 1px 0 rgba(255, 232, 196, .32);
}
.dock .act-gold {
  border-color: rgba(255, 228, 162, .88);
  background: linear-gradient(180deg, #e0ac48, #a06a14);
  color: #2a1704;
  box-shadow: 0 9px 24px rgba(190, 140, 30, .5), inset 0 1px 0 rgba(255, 248, 218, .6);
}
.dock .act:focus-visible { outline: 2px solid var(--mj-gold); outline-offset: 3px; }

/* ── 手牌区 ── */
.hand-panel {
  min-width: 0;
  display: grid; gap: 5px; padding: 6px 15px 12px; border-radius: 12px 12px 16px 16px;
  background-image:
    radial-gradient(130% 96% at 50% -18%, rgba(255, 255, 255, .08), transparent 62%),
    var(--mj-cloth-img, none);
  background-size: auto, cover;
  background-position: center, center 30%;
  background-repeat: no-repeat;
  background-color: var(--mj-cloth);
  box-shadow:
    inset 0 0 0 1px rgba(255, 246, 220, .10),
    inset 0 1px 0 rgba(255, 255, 255, .08),
    inset 0 12px 30px rgba(0, 0, 0, .30),
    0 14px 30px rgba(0, 0, 0, .22);
}
.hand-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; color: var(--mj-sub); font-size: 12.5px; }
.hand-label { color: var(--mj-ink); font-size: 13.5px; font-weight: 700; letter-spacing: .02em; }
.hand-heading b { color: var(--mj-gold); font-variant-numeric: tabular-nums; }
/* 手牌台在深浅两套主题下都是深绿桌面，徽标固定用亮色，否则浅色主题下看不见 */
.hand-heading .lack { background: rgba(255, 130, 100, .2); color: #ffc9b6; font-size: 11px; }
.hand-score { color: var(--mj-sub); font-size: 12px; font-variant-numeric: tabular-nums; font-weight: 700; }
.hand-score.plus { color: #ffd998; }
.hand-score.minus { color: #a9c6b4; }
.hand-rack { display: flex; align-items: flex-end; gap: 14px; min-width: 0; }
.own-melds { flex: none; justify-content: flex-end; max-inline-size: 64%; padding: 0 2px 7px; }
.own-melds .sz-mini { width: clamp(19px, 3.15cqw, 30px); }
.hand {
  display: flex; flex: 1 1 auto; align-items: flex-end; gap: 3px;
  min-width: 0; padding: 12px 3px 7px; overflow-x: auto; scrollbar-width: thin;
}
.hand:only-child { justify-content: safe center; }
.hand .tile.drawn { margin-inline-start: 14px; }
.hand .tile.drawn::after { content: ''; position: absolute; top: 2px; bottom: 2px; left: -8px; width: 1px; background: rgba(255, 255, 255, .22); }
/* 选中的牌被拿起来：影子散开、轮廓点亮 */
.hand .tile.selected {
  transform: translateY(-9px);
  outline: 2px solid var(--mj-gold); outline-offset: 1px;
  box-shadow:
    0 0 0 1px var(--mj-tile-edge),
    0 calc(var(--thick) + 7px) 3px -2px rgba(0, 0, 0, .34),
    0 calc(var(--thick) + 13px) 15px -5px var(--mj-tile-shadow);
}
.hand .tile:disabled { opacity: .6; cursor: default; }
.hand .tile:focus-visible { outline: 2px solid var(--lime); outline-offset: 2px; }
.hand-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.hand-foot:empty { display: none; }
/* 手牌台在两套主题下都是深绿桌布，全局 .btn 的浅色覆盖在这里读不清，单独给一套亮色 */
.hand-panel .btn.ghost {
  border-color: rgba(255, 255, 255, .26); background: rgba(255, 255, 255, .07); color: #eef6ef;
}
.hand-panel .btn.ghost:hover { background: rgba(255, 255, 255, .14); }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
.result { justify-content: center; }
.waiting { color: var(--mj-sub); font-size: 13px; }
.tips { margin: 8px 0 0; padding: 8px 10px 8px 26px; border-radius: 9px; background: rgba(0, 0, 0, .3); color: var(--mj-sub); font-size: 12.5px; }

/* 窄桌让对家和自己横跨桌面，为两侧手牌留出各自的桌边。 */
@container (max-width: 760px) {
  .felt {
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    grid-template-areas: "up up up" "left core right" "dn dn dn";
    gap: 8px 6px;
  }
  .seat-left, .seat-right { --side-tile-w: 20px; --side-tile-h: 15px; }
  .seat-left .backs, .seat-right .backs { margin-inline: 3px; }
  .seat-left .backs { --rack-slant: -2deg; }
  .seat-right .backs { --rack-slant: 2deg; }
  .hand-rack { display: grid; gap: 2px; }
  .own-melds { grid-row: 1; justify-self: end; max-inline-size: 100%; padding-block: 3px 0; }
  .hand:only-child { justify-content: start; }
}

@container (max-width: 560px) {
  .felt { padding: 29px 15px 24px; border-radius: 14px; gap: 6px 4px; }
  .seat-left, .seat-right {
    --side-tile-w: 20px; --side-tile-h: 13px;
    gap: 5px 3px;
  }
  .seat-left { grid-template: 'who who' auto 'rack river' 1fr / auto minmax(0, 1fr); }
  .seat-right { grid-template: 'who who' auto 'river rack' 1fr / minmax(0, 1fr) auto; }
  .seat-left .who, .seat-right .who {
    width: auto; flex-direction: row; justify-content: flex-start; align-items: center;
    gap: 2px 4px; padding: 3px 4px; text-align: start;
  }
  .seat-right .who { justify-content: flex-end; }
  .seat-left .who .seat-name, .seat-right .who .seat-name { font-size: 11px; }
  .seat-left .who :is(.points, .lack, .hand-count), .seat-right .who :is(.points, .lack, .hand-count) { font-size: 9px; }
  .mahjong:not(.ended) :is(.seat-left, .seat-right) .position,
  .mahjong:not(.ended) .seat-me.is-self .who { display: none; }
  .core { width: 70px; border-radius: 12px; padding: 6px; }
  .core-cap { font-size: 9px; letter-spacing: .12em; }
  .core-num { font-size: 24px; }
  .core-turn { font-size: 9px; }
  .hand-panel { padding-inline: 9px; }
  .dock { block-size: 40px; }
  .sz-show { width: 22px; height: 26px; font-size: 11.5px; }
  .sz-hand { width: 40px; font-size: 17px; }
}

@media (max-width: 720px) {
  .dock { gap: 6px; }
  .dock .act { min-width: 56px; padding: 9px 12px; font-size: 13.5px; }
}

@media (max-width: 560px) {
  .hud-line strong { font-size: 16px; }
  .dock .act { min-width: 50px; padding: 8px 11px; font-size: 13px; }
}
@media (prefers-reduced-motion: reduce) {
  .tile { transition: none; }
  .dot.live { animation: none; }
}
</style>
