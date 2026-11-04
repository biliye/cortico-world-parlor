<script setup lang="ts">
/** 客厅：成员、多张桌、开一桌 / 入座 / 围观。牌桌本身在 TableView。 */
import { computed, ref } from 'vue';
import AccessDialog from '../components/AccessDialog.vue';
import AnnouncementBanner from '../components/AnnouncementBanner.vue';
import { ENABLED_GAMES, STATUS_LABELS, canStartTable, gameLabel, gameOf, tableStartBlockers } from '../lib/games.ts';
import { initialOf } from '../lib/text.ts';
import {
  goRoom, joinRoomTable, leaveRoomTable, myTable, openRoomTable, snapshot, startRoomTable, tableIdOf, tableList,
} from '../stores/parlor.ts';
import { enterTable } from '../stores/view.ts';
import { seat } from '../stores/session.ts';
import { showToast } from '../stores/ui.ts';
import type { TableSummary } from '../api/types.ts';

const notice = ref('');
const busy = ref(false);
const accessOpen = ref(false);

const seats = computed(() => snapshot.value?.seats || []);
const seatedCount = computed(() => seats.value.filter((person) => person.kind !== 'observer').length);
const tables = computed(() => tableList().filter((table) => table.status !== 'abandoned'));
const mine = computed(() => myTable.value);
const meId = computed(() => snapshot.value?.seat?.id || '');
const roomName = computed(() => snapshot.value?.name || '客厅');
const onlineIds = computed(() => new Set(snapshot.value?.online || []));
const tableSeatIds = computed(() => {
  const ids = new Set<string>();
  for (const table of tableList()) {
    for (const person of activeSeats(table)) ids.add(person.id);
  }
  return ids;
});

function activeSeats(table: TableSummary) {
  // 已结束的牌桌保留参赛名单供回看。
  const { status, seats } = table;
  return status === 'open' || status === 'bidding' || status === 'playing' ? seats || [] : [];
}

function seatedAt(table: TableSummary): boolean {
  return activeSeats(table).some((person) => person.id === meId.value);
}

function capacityOf(table: TableSummary): number {
  return table.game === 'werewolf' ? 9 : table.game === 'ddz' ? 3 : 4;
}

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

function watch(table: TableSummary): void {
  enterTable(tableIdOf(table));
}

function backToMine(): void {
  if (mine.value) watch(mine.value);
}

function open(game: string): void {
  void run(() => openRoomTable(game));
}

function join(table: TableSummary): void {
  void run(() => joinRoomTable(tableIdOf(table)));
}

function start(): void {
  void run(() => startRoomTable());
}

function leave(): void {
  void run(() => leaveRoomTable());
}

function backToHall(): void {
  void run(() => goRoom('hall'));
}

/** 与旧版同一句话、同一个链接：朋友先进客厅，再选桌。 */
async function invite(): Promise<void> {
  const room = seat.value?.room || '';
  const url = location.origin + '/play' + (room ? '?room=' + encodeURIComponent(room) : '');
  try {
    await navigator.clipboard.writeText(url);
    showToast('客厅链接已复制；朋友进入后再选桌。私密厅仍需成员邀请。');
  } catch {
    window.prompt('复制客厅链接（私密厅还需要成员邀请）', url);
  }
}
</script>

<template>
  <div class="view view-lobby">
    <AnnouncementBanner />
    <div class="club-page-nav">
      <button class="btn ghost small" type="button" @click="backToHall">← 返回大厅</button>
      <button class="btn ghost small" type="button" @click="invite">邀请来客厅</button>
      <button class="btn ghost small" type="button" @click="accessOpen = true">成员管理</button>
    </div>

    <AccessDialog v-model:open="accessOpen" />

    <div class="lobby-head">
      <div>
        <span class="eyebrow">客厅 / {{ seatedCount }} / {{ snapshot?.maxSeats || 30 }} 人 · {{ tables.length }} 张桌</span>
        <h1>{{ roomName }}</h1>
        <p>{{ snapshot?.topic || '想玩就坐下来，想聊就留一会儿。' }}</p>
      </div>
    </div>

    <section class="club-welcome">
      <span class="eyebrow">MAKE YOURSELF AT HOME</span>
      <h2>先聊两句，再挑一张桌。</h2>
      <p>同一个客厅，不同的好时光。想玩就入座，想聊就坐一会儿。</p>
    </section>

    <section class="panel members">
      <div class="panel-head">
        <h2>房间里的人</h2>
        <span class="muted">{{ seats.length }} 人</span>
      </div>
      <div class="member-row">
        <span v-for="person in seats" :key="person.id" class="member-chip">
          <span class="avatar avatar-xs">{{ initialOf(person.name) }}</span>
          <span>
            <strong>{{ person.name }}<template v-if="person.id === meId">（你）</template></strong>
            <small>
              <span v-if="onlineIds.has(person.id)" class="live-dot" />
              {{ onlineIds.has(person.id) ? '在线' : '离线' }}<template v-if="tableSeatIds.has(person.id)"> · 在牌桌</template><template v-if="person.kind === 'observer'"> · 观看</template><template v-if="person.handle"> · #{{ person.handle }}</template>
            </small>
          </span>
          <span v-if="person.kind === 'pet'" class="tag tag-coo">Coo</span>
        </span>
      </div>
    </section>

    <div class="club-section-head">
      <h2>挑张桌，坐下来</h2>
      <span class="muted">斗地主 3 席 · 狼人杀 9 席</span>
    </div>

    <p v-if="notice" class="warn">{{ notice }}</p>
    <div class="club-table-grid">
      <p v-if="!tables.length" class="club-empty">桌子还空着。选个游戏，开一桌等朋友。</p>
      <article v-for="table in tables" :key="tableIdOf(table)" class="club-table-card" :class="{ 'is-night': table.game === 'werewolf' }">
        <div class="club-section-head">
          <span>{{ gameLabel(table.game) }}</span>
          <span class="muted">{{ (table.seats || []).length }} / {{ capacityOf(table) }} 席</span>
        </div>
        <div class="club-scene" :aria-hidden="true">
          <span class="club-orbit">✳</span>
          <div class="club-felt">
            <span v-for="value in ['A♠', 'K♥', 'Q♣']" :key="value" class="club-playing-card">{{ value }}</span>
          </div>
          <div class="club-table-avatars">
            <span v-for="person in (table.seats || []).slice(0, 9)" :key="person.id" class="avatar avatar-sm">{{ initialOf(person.name) }}</span>
          </div>
          <span class="club-scene-label">GOOD COMPANY. GREAT HANDS.</span>
        </div>
        <div class="club-table-copy">
          <h3>{{ table.label || gameLabel(table.game) }}</h3>
          <small class="muted">桌号 {{ tableIdOf(table) }}</small>
          <p>
            {{ STATUS_LABELS[table.status] || table.status }} ·
            {{ (table.seats || []).map((person) => person.name).join('、') || '等待朋友入座' }}
          </p>
          <p v-if="table.status === 'open' && table.game === 'werewolf'" class="muted">
            {{ tableStartBlockers(table).join('；') || '开局条件已满足，由开桌者开始。' }}
          </p>
          <div class="club-room-foot">
            <button
              v-if="table.status === 'open' && !seatedAt(table) && !mine"
              class="btn primary small"
              type="button"
              :disabled="(table.seats || []).length >= capacityOf(table) || busy"
              @click="join(table)"
            >入座一起玩 ↗</button>
            <button
              v-else-if="seatedAt(table) && table.status === 'open' && table.host === meId"
              class="btn primary small"
              type="button"
              :disabled="busy || !canStartTable(table)"
              :title="tableStartBlockers(table).join('；')"
              @click="start"
            >开始</button>
            <button v-else-if="seatedAt(table)" class="btn ghost small" type="button" :disabled="busy" @click="leave">退桌</button>
            <button class="btn ghost small" type="button" @click="watch(table)">
              {{ seatedAt(table) ? '回到我的桌 ↗' : table.status === 'ended' ? '查看结果 ↗' : '围观这桌 ↗' }}
            </button>
          </div>
        </div>
      </article>
    </div>

    <div class="game-grid">
      <article v-for="game in ENABLED_GAMES" :key="game" class="game-card game-card-live game-card-hero">
        <div class="game-card-body">
          <span class="eyebrow">{{ mine && mine.game === game ? '我的牌桌' : '开一张新桌' }}</span>
          <h2>{{ gameLabel(game) }}</h2>
          <p>{{ gameOf(game)?.blurb }}</p>
          <div class="game-card-foot">
            <span class="muted">{{ gameOf(game)?.foot }}</span>
            <button
              v-if="mine && mine.status !== 'ended' && mine.game === game"
              class="btn primary small"
              type="button"
              :disabled="busy"
              @click="backToMine"
            >回到我的桌</button>
            <button
              v-else
              class="btn primary small"
              type="button"
              :disabled="busy || !!(mine && mine.status !== 'ended')"
              :title="mine && mine.status !== 'ended' ? '先结束或离开自己的牌桌' : ''"
              @click="open(game)"
            >开一桌</button>
          </div>
        </div>
      </article>
    </div>

    <div class="club-stay">
      <strong>✳ 不玩游戏，也欢迎留下来。</strong>
      <p>打开聊天，和这个客厅里的朋友说两句。</p>
    </div>
  </div>
</template>
