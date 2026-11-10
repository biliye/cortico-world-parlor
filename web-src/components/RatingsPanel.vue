<script setup lang="ts">
import { ref, watch } from 'vue';
import type { RatingBoard } from '../../src/room/ratings/types.ts';
import { api } from '../api/client.ts';
import { GAMES } from '../lib/games.ts';
import { seat } from '../stores/session.ts';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ 'update:open': [boolean] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const game = ref('gomoku');
const games = ['gomoku', 'ddz', 'werewolf', 'monopoly2d', 'dice'];
const board = ref<RatingBoard | null>(null);
const busy = ref(false);
const error = ref('');
const reload = ref(0);
const date = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium' });
const score = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1, signDisplay: 'exceptZero' });

function close(): void {
  emit('update:open', false);
}

watch([() => props.open, game, () => seat.value?.token, reload], async ([open], _, onCleanup) => {
  if (!open) {
    if (dialog.value?.open) dialog.value.close();
    return;
  }
  if (dialog.value && !dialog.value.open) dialog.value.showModal();
  const request = new AbortController();
  onCleanup(() => request.abort());
  board.value = null;
  error.value = '';
  busy.value = true;
  try {
    const query = new URLSearchParams({ game: game.value });
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(25_000)]);
    const data = await api<RatingBoard>('/v1/hall/ratings?' + query, { signal });
    if (!request.signal.aborted) board.value = data;
  } catch (cause) {
    if (!request.signal.aborted) error.value = (cause as Error).message;
  } finally {
    if (!request.signal.aborted) busy.value = false;
  }
}, { flush: 'post' });
</script>

<template>
  <dialog ref="dialog" class="rooms-dialog" aria-label="会馆等级分榜" @close="close" @cancel="close">
    <div class="rooms-box">
      <div class="rooms-head">
        <h2>会馆等级分榜</h2>
        <button class="btn ghost small" type="button" @click="close">关闭</button>
      </div>
      <div class="access-body">
        <label class="game-filter">
          玩法
          <select v-model="game">
            <option v-for="id in games" :key="id" :value="id">{{ GAMES[id]?.label }}</option>
          </select>
        </label>
        <p v-if="busy" class="muted" role="status">正在读取榜单…</p>
        <div v-else-if="error">
          <p class="warn" role="alert">{{ error }}</p>
          <button class="btn ghost small" type="button" @click="reload++">重试</button>
        </div>
        <template v-else-if="board">
          <p class="muted">
            <template v-if="board.since !== null">记录始于 {{ date.format(board.since) }}。</template>
            累计 {{ board.minGames }} 局有效对战后上榜。同队与脚本陪练不参与比较。
          </p>
          <p>
            我的有效对局 <strong>{{ board.mine.games }}</strong> 局
            <template v-if="board.mine.rating !== null"> · 等级分 <strong>{{ score.format(board.mine.rating) }}</strong></template>
          </p>
          <p v-if="!board.groups.length" class="muted">暂时还没有达到上榜局数的玩家。</p>
          <p v-if="board.groups.length > 1" class="muted">各组玩家之间没有交手路径，组间分数独立。</p>
          <section v-for="(group, groupIndex) in board.groups" :key="groupIndex" class="access-section">
            <h3 v-if="board.groups.length > 1">对战组 {{ groupIndex + 1 }}</h3>
            <table class="rating-table">
              <thead><tr><th scope="col">名次</th><th scope="col">玩家</th><th scope="col">等级分</th><th scope="col">有效局</th></tr></thead>
              <tbody>
                <tr v-for="(row, rowIndex) in group.rows" :key="rowIndex">
                  <td>{{ row.position }}</td>
                  <th scope="row">{{ row.name }}<template v-if="row.mine">（你）</template></th>
                  <td>{{ score.format(row.rating) }}</td>
                  <td>{{ row.games }}</td>
                </tr>
              </tbody>
            </table>
          </section>
        </template>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.game-filter { display: flex; align-items: center; gap: 0.6rem; }
.rating-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.rating-table th, .rating-table td { padding: 0.45rem; text-align: left; border-bottom: 1px solid var(--line-2); }
.rating-table :is(th, td):nth-child(2) { overflow-wrap: anywhere; }
.rating-table :is(th, td):not(:nth-child(2)) { white-space: nowrap; }
</style>
