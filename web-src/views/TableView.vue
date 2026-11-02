<script setup lang="ts">
/** 牌桌壳：先显示桌号、座位与操作；各游戏桌面渲染器在第 3 刀后半接。 */
import { computed, ref } from 'vue';
import { STATUS_LABELS, enoughPlayers, gameLabel } from '../lib/games.ts';
import { initialOf } from '../lib/text.ts';
import { activeTable, joinRoomTable, leaveRoomTable, myTable, snapshot, startRoomTable } from '../stores/parlor.ts';
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
      <p class="muted">桌面渲染器（骰子 / 斗地主 / 狼人杀）在第 3 刀后半接；这一版先把桌号、座位与开局流程跑通。</p>
      <div class="actions">
        <button v-if="canJoin" class="btn primary" type="button" :disabled="busy"
          @click="run(() => joinRoomTable((table && (table.tableId || table.id)) || ''))">坐下</button>
        <button v-if="canStart" class="btn primary" type="button" :disabled="busy" @click="run(startRoomTable)">开始</button>
        <button v-if="seated" class="btn ghost" type="button" :disabled="busy" @click="run(leaveRoomTable)">退桌</button>
        <button class="btn ghost" type="button" @click="backToRoom">回到客厅</button>
      </div>
    </section>
  </div>
</template>
