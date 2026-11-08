<script setup lang="ts">
/** 牌桌壳：等人时是座位与开局操作；开局后把桌面交给 GameHost（旧渲染器原样挂载）。 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import GameHost from '../components/GameHost.vue';
import TableDiscovery from '../components/TableDiscovery.vue';
import Icon from '../components/Icon.vue';
import { STATUS_LABELS, canStartTable, gameLabel, gameOf, tableSeatLabel, tableStartBlockers } from '../lib/games.ts';
import { initialOf } from '../lib/text.ts';
import {
  activePrivate, activeTable, joinRoomTable, leaveRoomTable, myTable, serverNow, snapshot,
  startRoomTable, tableIdOf,
} from '../stores/parlor.ts';
import { backToRoom } from '../stores/view.ts';

const table = activeTable;
const notice = ref('');
const busy = ref(false);
const now = ref(serverNow());
let pulse: number | undefined;

const meId = computed(() => snapshot.value?.seat?.id || '');
const meName = computed(() => snapshot.value?.seat?.name || '你');
const seats = computed(() => table.value?.seats || []);
const seated = computed(() => seats.value.some((person) => person.id === meId.value));
const host = computed(() => table.value?.host === meId.value);
const canJoin = computed(() => table.value?.status === 'open' && !seated.value && !myTable.value
  && seats.value.length < (table.value.capacity || Infinity));
const startReady = computed(() => !!table.value && canStartTable(table.value));
const canStart = computed(() => table.value?.status === 'open' && seated.value && host.value && startReady.value);
const startBlockers = computed(() => table.value ? tableStartBlockers(table.value) : []);
const activeStage = computed(() => table.value?.status === 'bidding' || table.value?.status === 'playing');

const names = computed(() => {
  const map = new Map<string, string>();
  for (const person of snapshot.value?.seats || []) map.set(person.id, person.name);
  for (const person of table.value?.seats || []) if (!map.has(person.id)) map.set(person.id, person.name);
  return map;
});
const myTurn = computed(() => activePrivate()?.yourTurn === true);
const turnSeat = computed(() => seats.value.find((person) => person.id === table.value?.turn));
const turnName = computed(() => {
  const id = table.value?.turn;
  if (!id) return '—';
  return names.value.get(id) || '？';
});
const botTurn = computed(() => !!turnSeat.value?.bot && !myTurn.value);
const deadline = computed(() => Number(table.value?.deadline || (activePrivate()?.deadline as number) || 0));
const timerTotal = ref(0);
let timerKey = '';

watch(deadline, (next) => {
  if (!next) {
    timerTotal.value = 0;
    timerKey = '';
    return;
  }
  const key = tableIdOf(table.value) + ':' + (table.value?.game || '') + ':' + next;
  if (key !== timerKey) {
    timerKey = key;
    timerTotal.value = Math.max(10, Math.ceil((next - serverNow()) / 1000));
  }
}, { immediate: true });

const left = computed(() => (deadline.value ? Math.max(0, Math.ceil((deadline.value - now.value) / 1000)) : 0));
const timerText = computed(() => {
  const value = left.value;
  return String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
});
const timerProgress = computed(() => (timerTotal.value
  ? Math.max(0, Math.min(100, (left.value / timerTotal.value) * 100))
  : 0));

const metaParts = computed(() => {
  const current = table.value;
  if (!current) return [];
  const parts: string[] = [STATUS_LABELS[current.status] || current.status];
  if (seats.value.length) parts.push(seats.value.length + ' 人');
  if (current.game === 'ddz' && current.multiplier) parts.push('倍数 ×' + current.multiplier);
  if (current.game === 'monopoly' && current.round) parts.push('第 ' + current.round + '/' + (current.rounds || 12) + ' 轮');
  return parts;
});

onMounted(() => {
  pulse = window.setInterval(() => { now.value = serverNow(); }, 1000);
});

onBeforeUnmount(() => {
  window.clearInterval(pulse);
});

async function run(task: () => Promise<unknown>): Promise<void> {
  if (busy.value) return;
  notice.value = '';
  busy.value = true;
  try {
    await task();
  } catch (error) {
    notice.value = (error as Error).message || '这个动作没成功';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="view view-table" :class="{ 'view-werewolf': table?.game === 'werewolf' && activeStage }">
    <div class="club-page-nav">
      <button class="btn ghost small" type="button" @click="backToRoom">← 返回客厅</button>
    </div>

    <div v-if="table && activeStage" class="table-head">
      <div class="game-id">
        <span class="game-icon"><Icon :name="gameOf(table.game)?.icon || 'cards'" /></span>
        <div>
          <h1>{{ table.label || gameLabel(table.game) }}</h1>
          <p>{{ metaParts.join(' · ') }}</p>
        </div>
      </div>
      <div class="turn-box">
        <div v-if="table.game !== 'werewolf' || table.turn" class="turn-copy">
          <span class="turn-kicker">{{ myTurn ? '轮到你' : '轮到' }}</span>
          <span class="turn-name">{{ myTurn ? meName : (botTurn ? turnName + ' · 脚本' : turnName) }}</span>
        </div>
        <div
          class="turn-timer"
          :class="{ 'is-off': !deadline || left <= 0 || botTurn }"
          :style="{ '--p': String(botTurn ? 100 : timerProgress) }"
        >
          <span>{{ botTurn ? '脚本' : (deadline ? timerText : '—') }}</span>
        </div>
      </div>
    </div>
    <div v-else class="table-head-host">
      <div class="lobby-head">
        <div>
          <span class="eyebrow">{{ gameLabel(table?.game || '') }} · {{ STATUS_LABELS[table?.status || ''] || table?.status }}</span>
          <h1>{{ table?.label || gameLabel(table?.game || '') }}</h1>
          <p>桌号 {{ (table && (table.tableId || table.id)) || '—' }}</p>
        </div>
      </div>
    </div>

    <p v-if="notice" class="warn">{{ notice }}</p>

    <section v-if="!table" class="panel">
      <h2>这张桌已经收起</h2>
      <p class="muted">回客厅看看别的桌吧。</p>
      <button class="btn primary" type="button" @click="backToRoom">回到客厅</button>
    </section>

    <template v-else-if="table.status === 'open'">
      <section class="panel">
        <div class="panel-head">
          <h2>桌上的人</h2>
          <span class="muted">{{ seats.length }} 位</span>
        </div>
        <div class="member-row">
          <p v-if="!seats.length" class="muted">还没有人入座。</p>
          <span v-for="person in seats" :key="person.id" class="member-chip">
            <span class="avatar avatar-xs">{{ initialOf(person.name) }}</span>
            <span>
              <strong>{{ person.name }}<template v-if="person.id === meId">（你）</template></strong>
              <small>{{ tableSeatLabel(person) }}</small>
            </span>
          </span>
        </div>
      </section>
      <section class="panel">
        <div class="actions">
          <button v-if="canJoin" class="btn primary" type="button" :disabled="busy"
            @click="run(() => joinRoomTable(tableIdOf(table)))">坐下</button>
          <button v-if="canStart" class="btn primary" type="button" :disabled="busy" @click="run(startRoomTable)">开始</button>
          <button v-if="seated" class="btn ghost" type="button" :disabled="busy" @click="run(leaveRoomTable)">退桌</button>
          <button class="btn ghost" type="button" @click="backToRoom">回到客厅</button>
        </div>
        <p v-if="table.game === 'werewolf'" class="muted">
          等待入座 {{ seats.length }}/{{ table.capacity ?? 9 }}，尚未分配角色。坐满且至少有一只 Coo 后，由开桌者开始。
          {{ table.requireHuman === false ? '本桌允许全 Coo 局。' : '本桌要求至少一名真人入座。' }}
        </p>
        <template v-if="seated || table.game === 'werewolf'">
          <p v-if="seated && startReady && !host" class="muted" role="status">开局条件已满足，等待开桌者开始。</p>
          <template v-else-if="startBlockers.length">
            <p v-for="issue in startBlockers" :key="issue" class="muted">{{ issue }}</p>
          </template>
          <p v-else-if="seated && !startReady" class="muted">人数不够，还不能开局。</p>
        </template>
        <p v-if="!seated && table.capacity && seats.length >= table.capacity" class="muted">这张桌已满，可以等待空位或去看看别的桌。</p>
      </section>
      <TableDiscovery v-if="seated" :table="table" />
    </template>

    <template v-else>
      <GameHost />
    </template>
  </div>
</template>

<style scoped>
.view-werewolf .table-head {
  margin-top: 4px;
  padding-block: 8px;
}

@media (max-width: 550px) {
  .view-werewolf .table-head h1 { font-size: 22px; }
}
</style>
