<script setup lang="ts">
/**
 * 旧大富翁长局（Vue 版）：7×7 外圈棋盘、地产、道具、托管。
 * 规则与金额全在服务器，DOM 类名沿用 play.css。
 */
import { computed, ref, watch } from 'vue';
import ClockText from './ClockText.vue';
import { fmtClock } from '../../lib/cards.ts';
import type { GameCtx, GameView } from '../../lib/game-types.ts';

const props = defineProps<{ view: GameView; ctx: GameCtx }>();

interface MonoCell {
  index: number;
  kind: string;
  name: string;
  group?: string;
  price?: number;
  upgrade?: number;
  amount?: number;
  perUpgrade?: number;
}

interface MonoPlayer {
  id: string;
  name: string;
  pos: number;
  cash: number;
  auto?: boolean;
  bankrupt?: boolean;
  properties?: number;
}

interface MonoProperty {
  index: number;
  owner?: string;
  level: number;
}

interface MonoLegal {
  phase: string;
  items?: string[];
  repairTargets?: Array<{ index: number; cost: number }>;
  pending?: number;
  canBuy?: boolean;
  canUpgrade?: boolean;
  workshop?: string[];
}

interface MonoPriv {
  cash?: number;
  pos?: number;
  position?: string;
  items?: Record<string, number>;
  properties?: Array<{ name: string; level?: number }>;
  yourTurn?: boolean;
  legal?: MonoLegal | null;
  turnSeq?: number;
}

interface MonoTableExtra {
  round?: number;
  rounds?: number;
  turn?: string;
  phase?: string;
  deadline?: number;
  players?: MonoPlayer[];
  board?: MonoCell[];
  rules?: { itemLabels?: Record<string, string> };
  properties?: MonoProperty[];
  last?: string[];
  seats?: Array<{ id: string; auto?: boolean }>;
  ended?: {
    ranking?: Array<{ seatId: string; cash: number; propertyValue: number; assets: number }>;
  };
}

const steps = ref(3);
const repairTarget = ref<number | null>(null);

const table = computed(() => props.view.table as GameView['table'] & MonoTableExtra);
const priv = computed(() => props.view.priv as MonoPriv | null);
const me = computed(() => props.view.me);
const players = computed(() => (Array.isArray(table.value.players) ? table.value.players : []));
const board = computed(() => (Array.isArray(table.value.board) ? table.value.board : []));
const rules = computed(() => table.value.rules || {});
const ownedProps = computed(() => (Array.isArray(table.value.properties) ? table.value.properties : []));
const seated = computed(() => players.value.some((player) => player.id === me.value.id));
const turnPlayer = computed(() => players.value.find((player) => player.id === table.value.turn));
const mePlayer = computed(() => players.value.find((player) => player.id === me.value.id));
const legal = computed(() => priv.value?.legal ?? null);
const myAuto = computed(() => (
  ((table.value.seats || []) as Array<{ id: string; auto?: boolean }>)
    .some((seat) => seat.id === me.value.id && seat.auto === true)
));

const repairTargets = computed(() => (Array.isArray(legal.value?.repairTargets) ? legal.value!.repairTargets! : []));
watch(repairTargets, (targets) => {
  if (targets.length && !targets.some((target) => target.index === repairTarget.value)) {
    repairTarget.value = targets[0].index;
  }
}, { immediate: true });

function seatIndex(id: string): number {
  return players.value.findIndex((player) => player.id === id);
}

function playerClass(index: number): string {
  return 's' + (index % 6);
}

function cellNote(cell: MonoCell): string {
  if (cell.kind === 'property') return '¥' + cell.price;
  if (cell.kind === 'subsidy') return '+' + cell.amount;
  if (cell.kind === 'fee') return '-' + cell.amount;
  if (cell.kind === 'maintenance') return '每升 -' + cell.perUpgrade;
  if (cell.kind === 'workshop') return '补卡';
  if (cell.kind === 'park') return '公园';
  if (cell.kind === 'start') return '起点';
  return '';
}

function itemLabel(item: string): string {
  return (rules.value.itemLabels && rules.value.itemLabels[item]) || item;
}

function ownerOf(cellIndex: number): { ownerClass: string; level: number } | null {
  const owned = ownedProps.value.find((property) => property.index === cellIndex);
  if (!owned || !owned.owner) return null;
  const owner = players.value.find((player) => player.id === owned.owner);
  return {
    ownerClass: owner ? playerClass(seatIndex(owner.id)) : '',
    level: owned.level || 0,
  };
}

function playersAt(cellIndex: number): MonoPlayer[] {
  return players.value.filter((player) => player.pos === cellIndex);
}

function playerTags(player: MonoPlayer): string {
  const tags: string[] = [];
  if (player.auto) tags.push('托管');
  if (player.bankrupt) tags.push('破产');
  if (player.properties) tags.push(player.properties + ' 块地');
  return tags.join(' · ');
}

const phaseLabel = computed(() => (
  table.value.phase === 'prepare' ? '准备'
    : table.value.phase === 'buy' ? '买地'
      : table.value.phase === 'upgrade' ? '升级' : '工坊'
));

const heldItemsText = computed(() => {
  const items = priv.value?.items || {};
  return Object.entries(items)
    .filter(([, count]) => count > 0)
    .map(([item, count]) => `${itemLabel(item)}×${count}`)
    .join('、') || '没有';
});

const myPropsText = computed(() => (
  (priv.value?.properties || [])
    .map((property) => property.name + (property.level ? ' L' + property.level : ''))
    .join('、') || '还没有'
));

const pendingCell = computed(() => (
  legal.value?.pending !== undefined ? board.value[legal.value.pending] : undefined
));

function randomId(): string {
  return globalThis.crypto && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

function actMono(action: string, extra: Record<string, unknown> = {}): void {
  const body: Record<string, unknown> = { type: 'monopoly', action, requestId: randomId(), ...extra };
  if (priv.value && typeof priv.value.turnSeq === 'number') body.turnId = priv.value.turnSeq;
  void props.ctx.act(body).catch(() => {});
}
</script>

<template>
  <section class="panel game-mono">
    <div class="game-head">
      <h2>大富翁</h2>
      <span class="meta">第 {{ table.round || 0 }}/{{ table.rounds || 12 }} 轮</span>
      <span class="meta">轮到 {{ view.names.get(table.turn || '') || '？' }}</span>
      <span class="meta">{{ phaseLabel }}</span>
    </div>

    <p v-if="!board.length" class="warn">服务器没有给棋盘（版本可能旧了）。</p>

    <div v-else class="board">
      <div
        v-for="cell in board"
        :key="cell.index"
        :class="[
          'cell',
          'pos-' + cell.index,
          'kind-' + cell.kind,
          cell.group ? 'g-' + cell.group : '',
          { turn: turnPlayer && turnPlayer.pos === cell.index, mine: mePlayer && mePlayer.pos === cell.index },
        ]"
      >
        <div class="cname">{{ cell.name }}</div>
        <div class="cprice">{{ cellNote(cell) }}</div>
        <template v-if="ownerOf(cell.index)">
          <div :class="['ownerbar', ownerOf(cell.index)!.ownerClass]" />
          <span v-if="ownerOf(cell.index)!.level > 0" class="level">L{{ ownerOf(cell.index)!.level }}</span>
        </template>
        <div v-if="playersAt(cell.index).length" class="tokens">
          <span
            v-for="player in playersAt(cell.index)"
            :key="player.id"
            :class="['token', playerClass(seatIndex(player.id)), { me: player.id === me.id }]"
            :title="player.name + (player.id === me.id ? '（你）' : '')"
          >
            {{ (player.name || '?').slice(0, 1) }}
          </span>
        </div>
      </div>

      <div class="board-center">
        <div class="h">
          <strong>第 {{ table.round || 0 }}/{{ table.rounds || 12 }} 轮</strong>
          <span class="muted">轮到 {{ view.names.get(table.turn || '') || '？' }}</span>
          <template v-if="table.deadline">
            <span class="clock">截止 {{ fmtClock(table.deadline) }}</span>
            <ClockText :deadline="table.deadline" :server-now="ctx.serverNow" />
          </template>
        </div>

        <div class="mono-players">
          <div v-for="player in players" :key="player.id" :class="['mono-player', { turn: player.id === table.turn }]">
            <span :class="['token', playerClass(seatIndex(player.id))]">{{ (player.name || '?').slice(0, 1) }}</span>
            <span class="nm">{{ player.name + (player.id === me.id ? '（你）' : '') }}</span>
            <span v-if="playerTags(player)" class="meta">{{ playerTags(player) }}</span>
            <span class="cash">¥{{ player.cash }}</span>
          </div>
        </div>

        <div v-if="priv" class="mono-my">
          <span>现金 </span><b>¥{{ priv.cash }}</b>
          <span>位置 </span><b>{{ priv.position || ('#' + priv.pos) }}</b>
          <span>道具 </span><b>{{ heldItemsText }}</b>
          <span>我的地 </span><b>{{ myPropsText }}</b>
        </div>

        <div v-if="Array.isArray(table.last) && table.last.length" class="mono-facts">
          <div v-for="(fact, idx) in table.last.slice(-3)" :key="idx">· {{ fact }}</div>
        </div>

        <template v-if="table.status === 'ended'">
          <div v-if="table.ended && Array.isArray(table.ended.ranking)" class="ranking">
            <div v-for="(row, index) in table.ended.ranking" :key="row.seatId" class="rank">
              <span class="place">#{{ index + 1 }}</span>
              <span class="who">{{ view.names.get(row.seatId) || row.seatId }}</span>
              <span class="detail">现金 {{ row.cash }} + 地产 {{ row.propertyValue }} = {{ row.assets }}</span>
            </div>
          </div>
          <div class="mono-actions">
            <button class="btn small" type="button" @click="ctx.showLobby()">回大厅</button>
          </div>
        </template>

        <div v-else class="mono-actions">
          <button
            v-if="seated"
            class="btn small ghost"
            type="button"
            @click="actMono('set_auto', { on: !myAuto })"
          >
            {{ myAuto ? '取消托管' : '托管这一局' }}
          </button>

          <span v-if="!seated" class="muted">你在旁观；这一局结束后可以坐下一桌。</span>
          <span v-else-if="!priv || !priv.yourTurn || !legal" class="muted">
            等 {{ view.names.get(table.turn || '') || '？' }} 行动。
          </span>
          <template v-else-if="legal.phase === 'prepare'">
            <button class="btn primary" type="button" @click="actMono('roll')">掷骰</button>
            <template v-if="(legal.items || []).includes('signpost')">
              <select v-model.number="steps" aria-label="路标卡走几格">
                <option v-for="value in 6" :key="value" :value="value">{{ value }} 格</option>
              </select>
              <button class="btn small" type="button" @click="actMono('use_item', { item: 'signpost', steps })">
                用路标卡
              </button>
            </template>
            <button
              v-if="(legal.items || []).includes('pass')"
              class="btn small"
              type="button"
              @click="actMono('use_item', { item: 'pass' })"
            >
              用通行卡
            </button>
            <template v-if="(legal.items || []).includes('repair') && repairTargets.length">
              <select v-model.number="repairTarget" aria-label="修缮卡修哪块地">
                <option v-for="entry in repairTargets" :key="entry.index" :value="entry.index">
                  {{ entry.index }} {{ board[entry.index] ? board[entry.index].name : '' }}（¥{{ entry.cost }}）
                </option>
              </select>
              <button
                class="btn small"
                type="button"
                @click="actMono('use_item', { item: 'repair', target: repairTarget })"
              >
                用修缮卡
              </button>
            </template>
            <span v-if="(priv.items?.repair || 0) > 0 && !(legal.items || []).includes('repair')" class="dim">
              修缮卡：现在没有可半价升级的地。
            </span>
          </template>
          <template v-else-if="legal.phase === 'buy'">
            <span class="muted">{{ pendingCell ? `${pendingCell.name}：¥${pendingCell.price || 0}` : '这块地' }}</span>
            <button class="btn primary" type="button" :disabled="!legal.canBuy" @click="actMono('buy')">
              {{ legal.canBuy ? `买下（¥${pendingCell?.price || 0}）` : '买不起' }}
            </button>
            <button class="btn" type="button" @click="actMono('pass')">放弃</button>
          </template>
          <template v-else-if="legal.phase === 'upgrade'">
            <span class="muted">{{ (pendingCell ? pendingCell.name : '这块地') + `：升级 ¥${pendingCell?.upgrade || 0}` }}</span>
            <button class="btn primary" type="button" :disabled="!legal.canUpgrade" @click="actMono('upgrade')">
              {{ legal.canUpgrade ? `升级（¥${pendingCell?.upgrade || 0}）` : '升级不起' }}
            </button>
            <button class="btn" type="button" @click="actMono('pass')">放弃</button>
          </template>
          <template v-else-if="legal.phase === 'workshop'">
            <span class="muted">工坊：补一张道具</span>
            <button
              v-for="item in (legal.workshop || [])"
              :key="item"
              class="btn small"
              type="button"
              @click="actMono('take_item', { item })"
            >
              补{{ itemLabel(item) }}
            </button>
            <button class="btn" type="button" @click="actMono('pass')">放弃</button>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>
