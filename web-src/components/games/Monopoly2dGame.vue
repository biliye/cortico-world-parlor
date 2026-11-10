<script setup lang="ts">
/**
 * 快局大富翁桌面。
 *
 * 摆放全部按服务端给的 `cells`（含编号、名称、类别、售价、租金）来，客户端不存地图副本，
 * 所以地图升版后旧局也能照原样画出来。动作只发 `move` 与桌面上的 `turnNo`，
 * 规则、租金额、事件结果都在服务器算。
 */
import { computed, ref } from 'vue';
import type { GameCtx, GameView } from '../../lib/legacy-games.ts';
import { initialOf } from '../../lib/text.ts';
import ClockText from './ClockText.vue';
import Icon from '../Icon.vue';

const props = defineProps<{ view: GameView; ctx: GameCtx }>();

interface M2dCell {
  index: number;
  name: string;
  kind: 'start' | 'property' | 'event' | 'rest';
  price?: number;
  rent?: number;
}
interface M2dSeat {
  id: string;
  name: string;
  cash: number;
  pos: number;
  properties?: number[];
  estate?: number;
}
interface M2dRank {
  seat: string;
  cash: number;
  estate: number;
  total: number;
  rank: number;
  properties?: number[];
}
interface M2dLast {
  seat?: string;
  die?: number;
  to?: number;
  rent?: number;
  rentTo?: string;
  card?: { label: string; amount: number };
  bought?: number;
  pending?: number;
  auto?: boolean;
}
interface M2dTable {
  status?: string;
  phase?: 'await_roll' | 'await_buy' | null;
  turn?: string;
  deadline?: number;
  turnNo?: number;
  round?: number;
  totalRounds?: number;
  cells?: M2dCell[];
  seats?: M2dSeat[];
  owners?: Array<{ cell: number; seat: string }>;
  pending?: number;
  last?: M2dLast;
  ranking?: M2dRank[];
  winners?: string[];
  tie?: boolean;
}
interface M2dPriv {
  seat?: string;
  phase?: 'await_roll' | 'await_buy' | null;
  turnNo?: number;
  canAct?: boolean;
  moves?: string[];
  cash?: number;
  pos?: number;
  properties?: number[];
  estate?: number;
  pending?: { index: number; name: string; price: number; rent: number; affordable: boolean; cashAfter: number } | null;
  ranking?: M2dRank[];
}

const table = computed<M2dTable>(() => (props.view.table as unknown as M2dTable) ?? {});
const priv = computed<M2dPriv | null>(() => (props.view.priv as unknown as M2dPriv | null) ?? null);
const me = computed(() => props.view.me);

const cells = computed<M2dCell[]>(() => [...(table.value.cells ?? [])].sort((left, right) => left.index - right.index));
// 方形环每条边有相同的格数，起点在左上角，沿顺时针排一圈。
const edgeLength = computed(() => cells.value.length / 4 || 4);
const seats = computed<M2dSeat[]>(() => table.value.seats ?? []);
const playing = computed(() => table.value.status === 'playing');
const ended = computed(() => table.value.status === 'ended');
const seated = computed(() => seats.value.some((seat) => seat.id === me.value.id));
const yourTurn = computed(() => !!playing.value && !!priv.value?.canAct);
const phase = computed(() => (playing.value ? (table.value.phase ?? 'await_roll') : null));
const turnNo = computed(() => Number(table.value.turnNo) || 0);
const round = computed(() => Number(table.value.round) || 0);
const totalRounds = computed(() => Number(table.value.totalRounds) || 6);
const currentSeat = computed<M2dSeat | null>(() => seats.value.find((seat) => seat.id === table.value.turn) ?? null);
const pendingCell = computed<M2dCell | null>(() => {
  const index = table.value.pending;
  return index === undefined ? null : cells.value.find((cell) => cell.index === index) ?? null;
});

const submitting = ref(false);

function nameOf(seatId?: string, fallback = '？'): string {
  if (!seatId) return fallback;
  return seats.value.find((seat) => seat.id === seatId)?.name || props.view.names.get(seatId) || fallback;
}
function initial(name: string): string {
  return initialOf(name || '？');
}
function seatIndex(seatId?: string): number {
  const index = seats.value.findIndex((seat) => seat.id === seatId);
  return index < 0 ? 0 : index;
}
function seatClass(seatId?: string): string {
  return 'm2d-p' + (seatIndex(seatId) % 4);
}
function cellGridArea(index: number): string {
  const edge = edgeLength.value;
  const last = edge + 1;
  const offset = index % edge;
  if (index < edge) return `1 / ${1 + offset}`;
  if (index < 2 * edge) return `${1 + offset} / ${last}`;
  if (index < 3 * edge) return `${last} / ${last - offset}`;
  return `${last - offset} / 1`;
}
function cellClass(cell: M2dCell): string[] {
  const classes = ['is-' + cell.kind];
  if (cell.price) classes.push('band-' + Math.min(3, Math.floor((cell.price - 100) / 60)));
  if (cell.index % edgeLength.value === 0) classes.push('is-corner');
  if (me.value && seats.value.some((seat) => seat.id === me.value.id && seat.pos === cell.index)) classes.push('is-here');
  if (playing.value && currentSeat.value?.pos === cell.index) classes.push('is-current');
  if (table.value.pending === cell.index) classes.push('is-pending');
  return classes;
}
function ownerOf(cellIndex: number): string | undefined {
  return (table.value.owners ?? []).find((entry) => entry.cell === cellIndex)?.seat;
}
function tokensAt(cellIndex: number): M2dSeat[] {
  return seats.value.filter((seat) => seat.pos === cellIndex);
}

/* —— 当前状态的一句话 —— */
const phaseText = computed(() => {
  if (ended.value) return '已结束';
  if (!playing.value) return '等人';
  return phase.value === 'await_buy' ? '买地' : '掷骰';
});
const centerHint = computed(() => {
  if (ended.value) return '结算完成';
  if (!playing.value) return '坐满四席后由开桌的人开始';
  if (phase.value === 'await_buy') return `${nameOf(table.value.turn)} 正在决定买不买`;
  return `等 ${nameOf(table.value.turn)} 掷骰`;
});

const lastText = computed(() => {
  const last = table.value.last;
  if (!last) return '';
  const who = nameOf(last.seat);
  const parts: string[] = [];
  if (typeof last.die === 'number') parts.push(`${who} 掷出 ${last.die}`);
  if (typeof last.to === 'number') {
    const cell = cells.value.find((entry) => entry.index === last.to);
    if (cell) parts.push(`走到「${cell.name}」`);
  }
  if (last.bought !== undefined) {
    const cell = cells.value.find((entry) => entry.index === last.bought);
    parts.push(`买下${cell ? `「${cell.name}」` : '地产'}`);
  }
  if (typeof last.rent === 'number' && last.rent > 0) parts.push(`付租 ${last.rent} 给 ${nameOf(last.rentTo)}`);
  if (last.card) parts.push(`${last.card.label} ${last.card.amount >= 0 ? '+' : ''}${last.card.amount}`);
  if (last.auto) parts.push('（托管/超时代掷）');
  return parts.join(' · ');
});

/* —— 结算 —— */
const rankRows = computed(() => {
  const rows = ended.value ? (table.value.ranking ?? priv.value?.ranking ?? []) : [];
  return rows.map((row) => ({
    ...row,
    name: nameOf(row.seat),
    mine: row.seat === me.value.id,
    won: row.rank === 1,
  }));
});

/* —— 动作 —— */
const moves = computed(() => (yourTurn.value ? (priv.value?.moves ?? []) : []));
const canRoll = computed(() => moves.value.includes('roll'));
const canBuy = computed(() => moves.value.includes('buy') && !!priv.value?.pending?.affordable);
const canPass = computed(() => moves.value.includes('pass'));
const buyPending = computed(() => priv.value?.pending ?? null);

function send(move: 'roll' | 'buy' | 'pass'): void {
  if (submitting.value) return;
  const current = priv.value;
  if (!current || !yourTurn.value) return;
  submitting.value = true;
  void props.ctx.act({ type: 'monopoly2d_action', move, turnNo: current.turnNo ?? turnNo.value })
    .catch(() => { /* 失败提示由发送层给，按钮随后恢复 */ })
    .finally(() => { submitting.value = false; });
}
</script>

<template>
  <section class="panel game-m2d">
    <header class="m2d-head">
      <div class="m2d-title">
        <h2>快局大富翁</h2>
        <p class="m2d-sub">
          <template v-if="playing || ended">
            第 {{ round }}/{{ totalRounds }} 轮 · 第 {{ turnNo }}/{{ totalRounds * 4 }} 手 · {{ phaseText }}
          </template>
          <template v-else>四人坐满开局，只用局内金币</template>
        </p>
      </div>
      <div v-if="playing && table.deadline" class="m2d-clock">
        <span class="m2d-clock-label">{{ nameOf(table.turn) }} 的{{ phase === 'await_buy' ? '购买' : '掷骰' }}时间</span>
        <ClockText :deadline="table.deadline" :server-now="ctx.serverNow" />
      </div>
    </header>

    <div v-if="ended" class="m2d-result" aria-live="polite">
      <div class="m2d-result-head">
        <Icon name="trophy" />
        <strong>{{ table.tie ? '并列第一' : '本局结果' }}</strong>
      </div>
      <ol class="m2d-result-list">
        <li v-for="row in rankRows" :key="row.seat" class="m2d-result-row" :class="{ 'is-me': row.mine, 'is-won': row.won }">
          <span class="m2d-rank">{{ row.rank }}</span>
          <span class="m2d-result-dot" :class="seatClass(row.seat)">{{ initial(row.name) }}</span>
          <span class="m2d-result-name">{{ row.name }}<em v-if="row.mine">（你）</em></span>
          <span class="m2d-result-num">{{ row.total }}</span>
          <span class="m2d-result-break">金币 {{ row.cash }} + 地产 {{ row.estate }}</span>
        </li>
      </ol>
      <button class="btn ghost" type="button" @click="ctx.showLobby()">返回客厅</button>
    </div>

    <div class="m2d-layout">
      <div
        class="m2d-board"
        :class="{ 'm2d-board-expanded': edgeLength > 4 }"
        :style="{ '--m2d-grid-size': edgeLength + 1 }"
        role="grid"
        aria-label="大富翁棋盘"
      >
        <div
          v-for="cell in cells"
          :key="cell.index"
          class="m2d-cell"
          :class="cellClass(cell)"
          :style="{ gridArea: cellGridArea(cell.index) }"
          role="gridcell"
        >
          <span class="m2d-cell-name">{{ cell.name }}</span>
          <div class="m2d-cell-foot">
            <span v-if="cell.price" class="m2d-cell-price">{{ cell.price }}</span>
            <span v-else-if="cell.kind === 'event'" class="m2d-cell-tag">消息</span>
            <span v-else-if="cell.kind === 'start'" class="m2d-cell-tag">起点</span>
            <span class="m2d-tokens">
              <span
                v-for="seat in tokensAt(cell.index)"
                :key="seat.id"
                class="m2d-token"
                :class="[seatClass(seat.id), { 'is-turn': seat.id === table.turn }]"
                :title="seat.name"
              >{{ initial(seat.name) }}</span>
            </span>
          </div>
          <span v-if="ownerOf(cell.index)" class="m2d-owner" :class="seatClass(ownerOf(cell.index))" :title="'归 ' + nameOf(ownerOf(cell.index))">
            {{ initial(nameOf(ownerOf(cell.index))) }}
          </span>
        </div>

        <div class="m2d-center" aria-hidden="true">
          <svg class="m2d-center-art" viewBox="0 0 120 120" focusable="false">
            <circle cx="60" cy="60" r="46" fill="none" stroke="currentColor" stroke-opacity="0.16" stroke-dasharray="3 7" />
            <path d="M34 72h52l-5-18H39z" fill="none" stroke="currentColor" stroke-opacity="0.45" stroke-width="2" stroke-linejoin="round" />
            <path d="M60 54c0-7 9-7 9-14" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="2" stroke-linecap="round" />
            <path d="M50 54c0-5 7-6 7-11" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="2" stroke-linecap="round" />
            <circle cx="60" cy="78" r="2.4" fill="currentColor" fill-opacity="0.5" />
          </svg>
          <div class="m2d-center-copy">
            <strong>{{ playing || ended ? '第 ' + round + ' 轮' : '快局' }}</strong>
            <span>{{ centerHint }}</span>
          </div>
        </div>
      </div>

      <aside class="m2d-side">
        <div class="m2d-actions">
          <template v-if="ended">
            <p class="m2d-hint">这一局结束了。再看一局请回客厅开新桌。</p>
          </template>
          <template v-else-if="!seated">
            <p class="m2d-hint">你在观战：能看到所有人的金币和地块，不能操作。</p>
          </template>
          <template v-else-if="canRoll">
            <button class="btn primary" type="button" :disabled="submitting" @click="send('roll')">
              {{ submitting ? '提交中…' : '掷骰' }}
            </button>
            <p class="m2d-hint">掷骰 60 秒；落在无主且买得起的地产，会再给 20 秒决定。</p>
          </template>
          <template v-else-if="buyPending">
            <div class="m2d-buy">
              <div class="m2d-buy-head">
                <strong>{{ buyPending.name }}</strong>
                <span>售价 {{ buyPending.price }} · 每次租金 {{ buyPending.rent }}</span>
              </div>
              <p class="m2d-buy-note">
                买下后剩 {{ buyPending.cashAfter }} 金币<template v-if="!buyPending.affordable">（金币不够，只能放弃）</template>。
              </p>
              <div class="m2d-buy-buttons">
                <button class="btn primary" type="button" :disabled="submitting || !canBuy" @click="send('buy')">
                  {{ submitting ? '提交中…' : '买下 ' + buyPending.price }}
                </button>
                <button class="btn ghost" type="button" :disabled="submitting || !canPass" @click="send('pass')">放弃</button>
              </div>
              <p class="m2d-hint">购买窗 20 秒；到点自动放弃。</p>
            </div>
          </template>
          <template v-else>
            <p class="m2d-hint">
              等 {{ nameOf(table.turn) }}{{ phase === 'await_buy' ? ' 决定买地' : ' 掷骰' }}。
            </p>
          </template>
        </div>

        <div class="m2d-players">
          <div
            v-for="seat in seats"
            :key="seat.id"
            class="m2d-player"
            :class="{ 'is-turn': seat.id === table.turn, 'is-me': seat.id === me.id }"
          >
            <span class="m2d-player-dot" :class="seatClass(seat.id)">{{ initial(seat.name) }}</span>
            <div class="m2d-player-copy">
              <div class="m2d-player-name">
                {{ seat.name }}<em v-if="seat.id === me.id">（你）</em>
              </div>
              <div class="m2d-player-meta">
                {{ seat.cash }} 金币 · {{ (seat.properties || []).length }} 块地<template v-if="seat.estate"> · 估值 {{ seat.estate }}</template>
              </div>
            </div>
            <span v-if="seat.id === table.turn && playing" class="m2d-badge">行动中</span>
          </div>
          <p v-if="!seats.length" class="m2d-empty">等人入座。</p>
        </div>

        <p v-if="lastText" class="m2d-last" aria-live="polite">{{ lastText }}</p>

        <div v-if="me.id && seated" class="m2d-mine">
          <span>你：{{ priv?.cash ?? 0 }} 金币 · {{ (priv?.properties || []).length }} 块地</span>
          <span v-if="priv?.estate">估值 {{ priv.estate }}</span>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.game-m2d {
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* 让下面的 @container 按面板自身宽度判断，而不是视口宽度。 */
  container-type: inline-size;
}

.m2d-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.m2d-title h2 {
  margin: 0;
  font-size: 18px;
  letter-spacing: 0.02em;
}
.m2d-sub {
  margin: 2px 0 0;
  color: var(--muted);
  font-size: 12px;
}
.m2d-clock {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  font-size: 11px;
  color: var(--muted);
}
.m2d-clock .clock {
  color: var(--lime);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.m2d-layout {
  display: grid;
  /* 侧栏跟着可用宽度收放：右侧聊天抽屉打开时，视口仍是 1280，但这一栏只剩 600 多，
     写死 264px 会把玩家列表和掷骰按钮挤出可视区。 */
  grid-template-columns: minmax(0, 1fr) clamp(196px, 28%, 264px);
  gap: 14px;
  align-items: start;
  /* 超宽屏（比如 2548）上棋盘受高度限制不再变宽，不封顶就会在棋盘和侧栏之间留一大片空。 */
  max-width: 1180px;
  margin-inline: auto;
}

/* 面板自己太窄时改成上下堆叠，不看视口宽度。 */
@container (max-width: 560px) {
  .m2d-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}

.m2d-board {
  position: relative;
  display: grid;
  grid-template-columns: repeat(var(--m2d-grid-size), minmax(0, 1fr));
  grid-template-rows: repeat(var(--m2d-grid-size), minmax(0, 1fr));
  gap: 4px;
  aspect-ratio: 1 / 1;
  /* 方形棋盘要么占满这一栏，要么让位给顶栏与面板留白：
     518px 的方块在 775px 高的窗口里会顶出可视区，逼得用户滚动才能看到底边。 */
  width: min(100%, calc(100dvh - 360px));
  margin-inline: auto;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel-2);
}

.m2d-board-expanded {
  width: min(100%, max(320px, calc(100dvh - 360px)));
}
.m2d-board-expanded .m2d-cell-tag:has(+ .m2d-tokens .m2d-token) {
  display: none;
}

.m2d-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 2px;
  min-width: 0;
  min-height: 0;
  padding: 4px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
}
.m2d-cell.is-corner {
  background: color-mix(in srgb, var(--panel) 82%, var(--lime) 18%);
}
.m2d-cell.is-event {
  border-style: dashed;
}
.m2d-cell.band-0 { border-left: 3px solid #7dd3fc; }
.m2d-cell.band-1 { border-left: 3px solid #fca5a5; }
.m2d-cell.band-2 { border-left: 3px solid #c4b5fd; }
.m2d-cell.band-3 { border-left: 3px solid #fcd34d; }
.m2d-cell.is-here {
  border-color: var(--lime);
  box-shadow: inset 0 0 0 1px var(--lime);
}
.m2d-cell.is-pending {
  border-color: var(--lime);
  background: color-mix(in srgb, var(--panel) 70%, var(--lime) 30%);
}

.m2d-cell-name {
  font-size: 10px;
  line-height: 1.2;
  color: var(--text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}
.m2d-cell-foot {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 2px;
  min-height: 14px;
}
.m2d-cell-price {
  font-size: 9px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.m2d-cell-tag {
  font-size: 9px;
  color: var(--muted);
}
.m2d-tokens {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  justify-content: flex-end;
}
.m2d-token {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 8px;
  font-weight: 700;
  color: #14180f;
  border: 1px solid rgba(0, 0, 0, 0.28);
}
.m2d-token.is-turn {
  box-shadow: 0 0 0 2px var(--lime);
}
.m2d-owner {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 12px;
  height: 12px;
  border-radius: 3px;
  display: grid;
  place-items: center;
  font-size: 8px;
  font-weight: 700;
  color: #14180f;
  opacity: 0.9;
}

.m2d-center {
  grid-area: 2 / 2 / var(--m2d-grid-size) / var(--m2d-grid-size);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 8px;
  border-radius: 10px;
  background: radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--panel-2) 60%, var(--lime) 12%), var(--panel-2));
  color: var(--text);
  text-align: center;
}
.m2d-center-art {
  width: min(46%, 150px);
  height: auto;
  color: var(--lime);
}
.m2d-center-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.m2d-center-copy strong {
  font-size: 13px;
  letter-spacing: 0.04em;
}
.m2d-center-copy span {
  font-size: 11px;
  color: var(--muted);
}

.m2d-side {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.m2d-players {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.m2d-player {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
}
.m2d-player.is-turn {
  border-color: var(--lime);
}
.m2d-player.is-me {
  background: color-mix(in srgb, var(--panel) 88%, var(--lime) 12%);
}
.m2d-player-dot {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 700;
  color: #14180f;
}
.m2d-player-copy {
  min-width: 0;
  flex: 1;
}
.m2d-player-name {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.m2d-player-name em {
  font-style: normal;
  color: var(--muted);
}
.m2d-player-meta {
  font-size: 10px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.m2d-badge {
  flex: 0 0 auto;
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--lime);
  color: var(--lime-ink);
}
.m2d-empty {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}

.m2d-last {
  margin: 0;
  padding: 7px 8px;
  border-radius: 8px;
  border: 1px dashed var(--line);
  font-size: 11px;
  color: var(--muted);
  line-height: 1.4;
}

.m2d-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.m2d-hint {
  margin: 0;
  font-size: 11px;
  color: var(--muted);
  line-height: 1.4;
}
.m2d-buy {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel);
}
.m2d-buy-head {
  flex-wrap: wrap;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}
.m2d-buy-head span {
  font-size: 10px;
  color: var(--muted);
}
.m2d-buy-note {
  margin: 0;
  font-size: 11px;
  color: var(--muted);
}
.m2d-buy-buttons {
  display: flex;
  gap: 6px;
}
.m2d-buy-buttons .btn {
  flex: 1;
}

.m2d-mine {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px dashed var(--line);
  font-size: 11px;
  color: var(--muted);
}

.m2d-result {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--lime);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--panel) 90%, var(--lime) 10%);
}
.m2d-result-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.m2d-result-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.m2d-result-row {
  display: grid;
  grid-template-columns: 22px 24px minmax(0, 1fr) auto;
  grid-template-areas:
    'rank dot name total'
    'rank dot break break';
  column-gap: 8px;
  align-items: center;
  padding: 5px 6px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--panel) 94%, transparent);
}
.m2d-result-row.is-won {
  border: 1px solid var(--lime);
}
.m2d-result-row.is-me {
  background: color-mix(in srgb, var(--panel) 84%, var(--lime) 16%);
}
.m2d-rank {
  grid-area: rank;
  font-size: 12px;
  color: var(--muted);
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.m2d-result-dot {
  grid-area: dot;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 700;
  color: #14180f;
}
.m2d-result-name {
  grid-area: name;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.m2d-result-name em {
  font-style: normal;
  color: var(--muted);
}
.m2d-result-num {
  grid-area: total;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.m2d-result-break {
  grid-area: break;
  font-size: 10px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

/* 四个席位的固定配色：深浅主题下都能看清，棋子与归属用同一套。 */
.m2d-p0 { background: #d9f87d; }
.m2d-p1 { background: #7dd3fc; }
.m2d-p2 { background: #fca5a5; }
.m2d-p3 { background: #c4b5fd; }

@media (max-width: 720px) {
  .m2d-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .m2d-side {
    order: 2;
  }
  .m2d-board {
    gap: 2px;
    padding: 4px;
  }
  .m2d-cell {
    padding: 3px;
    border-radius: 4px;
  }
  .m2d-cell-name {
    font-size: 9px;
    -webkit-line-clamp: 2;
  }
  .m2d-cell-price,
  .m2d-cell-tag {
    font-size: 8px;
  }
  .m2d-token {
    width: 11px;
    height: 11px;
    font-size: 7px;
  }
  .m2d-owner {
    width: 10px;
    height: 10px;
    font-size: 7px;
  }
  .m2d-center-art {
    width: 54%;
  }
  .m2d-center-copy strong {
    font-size: 11px;
  }
  .m2d-center-copy span {
    font-size: 9px;
  }
}

.m2d-cell.is-current { box-shadow: inset 0 0 0 2px var(--accent, #a96938); }

@media (prefers-reduced-motion: no-preference) {
  .m2d-cell.is-here,
  .m2d-player.is-turn {
    transition: border-color 160ms ease, box-shadow 160ms ease;
  }
}
</style>
