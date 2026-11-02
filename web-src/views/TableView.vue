<script setup lang="ts">
/** 牌桌壳：等人时是座位与开局操作；开局后把桌面交给 GameHost（旧渲染器原样挂载）。 */
import { computed, ref } from 'vue';
import GameHost from '../components/GameHost.vue';
import { STATUS_LABELS, enoughPlayers, gameLabel } from '../lib/games.ts';
import { clockText, initialOf, readable } from '../lib/text.ts';
import {
  activeTable, joinRoomTable, leaveRoomTable, log, myTable, snapshot, startRoomTable, tableIdOf,
} from '../stores/parlor.ts';
import { backToRoom } from '../stores/view.ts';

const table = activeTable;
const notice = ref('');
const busy = ref(false);

const meId = computed(() => snapshot.value?.seat?.id || '');
const seats = computed(() => table.value?.seats || []);
const seated = computed(() => seats.value.some((person) => person.id === meId.value));
const host = computed(() => table.value?.host === meId.value);
const canJoin = computed(() => table.value?.status === 'open' && !seated.value && !myTable.value);
const canStart = computed(() => table.value?.status === 'open' && seated.value && host.value
  && !!table.value && enoughPlayers(table.value));

const ticker = computed(() => {
  const id = table.value ? tableIdOf(table.value) : '';
  return log.value
    .filter((event) => {
      const type = event.type || '';
      if (!type.startsWith('parlor.table.') && !type.startsWith('parlor.monopoly.')) return false;
      const eventId = (event.data as Record<string, unknown> | undefined)?.tableId;
      return !id || typeof eventId !== 'string' || !eventId || eventId === id;
    })
    .slice(-4)
    .map((event) => ({ key: event.seq ?? Math.random(), time: clockText(event.ts), text: readable(event.text) }));
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
  <div class="view view-table">
    <div class="club-page-nav">
      <button class="btn ghost small" type="button" @click="backToRoom">← 返回客厅</button>
    </div>

    <div class="table-head-host">
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
              <small>{{ person.bot ? '脚本' : '人' }}</small>
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
        <p v-if="seated && !canStart && host" class="muted">人数不够，还不能开局。</p>
      </section>
    </template>

    <template v-else>
      <GameHost />
      <div v-if="ticker.length" class="ticker">
        <p v-for="line in ticker" :key="line.key"><time>{{ line.time }}</time> {{ line.text }}</p>
      </div>
    </template>
  </div>
</template>
