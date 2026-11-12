<script setup lang="ts">
/**
 * 找一桌：快速匹配 + 大厅牌桌招募。
 *
 * 首页里它挂在灯下空桌的下面，是同一张桌子的「告示牌」，不是又一张客厅卡：
 * 材质比客厅卡更深一档、上缘贴住桌沿；招募条默认只露一条，更多的在面板内滚动，
 * 不撑开首屏、也不会因为展开按钮把下面的客厅条推下去。
 */
import { computed, ref } from 'vue';
import { enterDiscoveredTable, loadHall, myTable, recruitments } from '../stores/parlor.ts';
import type { TableRecruitment } from '../../src/room/table-discovery-db.ts';

const game = ref('ddz');
const busy = ref(false);
const notice = ref('');
/* 首屏这块牌子只是「顺手坐一桌」的入口，默认露一条就够；其余的在牌子内滚。 */
const VISIBLE_ROWS = 1;
const hasMore = computed(() => recruitments.value.length > VISIBLE_ROWS);

async function join(target: { game: string } | { room: string; table: string }): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  notice.value = '';
  try { await enterDiscoveredTable(target); }
  catch (error) { notice.value = (error as Error).message || '加入失败，请重试'; }
  finally { busy.value = false; }
}
function joinRecruit(item: TableRecruitment): void {
  void join({ room: item.room, table: item.tableId });
}
function tableNote(): string {
  return '不押东西，坐下就能打';
}
</script>

<template>
  <section class="recruit-board" aria-label="快速匹配与牌桌招募">
    <header class="board-head">
      <div class="board-intro">
        <p class="board-kicker">FIND A TABLE</p>
        <h2>找一桌</h2>
      </div>
      <div class="board-quick">
        <label class="board-select">想玩
          <select v-model="game" aria-label="快速匹配游戏" :disabled="busy">
            <option value="ddz">斗地主</option><option value="werewolf">狼人杀</option><option value="dice">骰子</option>
            <option value="gomoku">五子棋</option><option value="xiangqi">中国象棋</option><option value="monopoly2d">快局大富翁</option>
            <option value="aeroplane">飞行棋</option>
          </select>
        </label>
        <button class="btn primary board-match" type="button" :disabled="busy || !!myTable" @click="join({ game })">{{ busy ? '正在加入…' : '快速匹配' }}</button>
      </div>
    </header>
    <p class="board-hint">匹配公开客厅里等人的空桌。</p>

    <p v-if="myTable" class="board-note muted">你已经在牌桌上，可以从「牌桌」回去继续。</p>
    <p v-if="notice" class="board-note warn" role="status">{{ notice }}</p>

    <div class="board-recruits">
      <div class="board-subhead">
        <h3>大厅牌桌招募 <small>{{ recruitments.length }}</small></h3>
        <button class="board-refresh" type="button" @click="loadHall(true)">刷新招募</button>
      </div>
      <template v-if="recruitments.length">
        <ul class="board-rows" :class="{ 'is-scroll': hasMore }">
          <li v-for="item in recruitments" :key="item.tableId" class="board-row">
            <div class="row-copy">
              <p class="row-title">
                <strong>{{ item.label }} · {{ item.seats }}/{{ item.capacity }}</strong>
                <span class="row-state">{{ item.full ? '已满员' : '等人中' }}</span>
              </p>
              <p class="row-text">{{ item.text }}</p>
              <p class="row-meta">{{ item.author }} · {{ item.roomName }} · {{ tableNote() }}</p>
            </div>
            <div class="row-actions">
              <a class="row-link" :href="item.link">看看牌桌 ↗</a>
              <button class="btn ghost small row-join" type="button" :disabled="busy || item.full || !!myTable" @click="joinRecruit(item)">加入这桌</button>
            </div>
          </li>
        </ul>
        <p v-if="hasMore" class="board-scroll-hint">还有 {{ recruitments.length - VISIBLE_ROWS }} 张桌，滚动看全部</p>
      </template>
      <p v-else class="board-empty muted">暂时没有招募。<a class="board-link" href="#hall-rooms">去客厅开一桌 ↓</a></p>
    </div>
  </section>
</template>

<style scoped>
/* 告示牌：比客厅卡暗一档的面，配一道上缘高光和偏右的投影，贴在桌沿下。 */
.recruit-board {
  position: relative;
  z-index: 2;
  width: 100%;
  max-width: 520px;
  margin-inline: auto;
  box-sizing: border-box;
  padding: 16px 20px 14px;
  border: 1px solid var(--line-2);
  border-radius: 18px;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--text) 4%, transparent), transparent 42%),
    var(--panel-2);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--text) 10%, transparent),
    var(--shadow-md);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}

.board-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
}
.board-intro { min-width: 0; }
.board-kicker {
  margin: 0;
  font-family: var(--num);
  font-size: 9.5px;
  letter-spacing: .22em;
  color: var(--dim);
}
.board-intro h2 { margin: 4px 0 0; font-size: 22px; font-weight: 700; letter-spacing: -.015em; }
.board-hint { margin: 5px 0 0; font-size: 12px; line-height: 1.55; color: var(--muted); }
.board-quick { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex: none; }
.board-select { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--muted); white-space: nowrap; }
.board-select select {
  font: inherit;
  font-size: 12.5px;
  color: var(--text);
  background: color-mix(in srgb, var(--text) 6%, transparent);
  border: 1px solid var(--line-2);
  border-radius: 999px;
  padding: 7px 11px;
}
.board-select select:focus-visible { outline: 2px solid var(--lime); outline-offset: 2px; }
/* 原生下拉弹层的底色由系统 color-scheme 决定，深色外观下会变成「浅字压白底」。
   给 option 一组不透明的作者色，三套外观都跟着当前 token 走。 */
.board-select select option { background: var(--panel-solid); color: var(--text); }
.board-match { height: 36px; padding: 0 15px; }

.board-note { margin: 9px 0 0; font-size: 12px; }

.board-recruits { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 9px; }
.board-subhead { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.board-subhead h3 { margin: 0; font-size: 12.5px; font-weight: 600; letter-spacing: .02em; }
.board-subhead h3 small { margin-left: 4px; font-family: var(--num); font-size: 11px; color: var(--dim); }
.board-refresh { flex: none; font-size: 11.5px; color: var(--dim); padding: 2px 0; }
.board-refresh:hover { color: var(--lime); }

.board-rows { list-style: none; margin: 0; padding: 0; }
.board-rows.is-scroll {
  max-height: 96px;
  overflow-y: auto;
  padding-right: 4px;
  scrollbar-width: thin;
  scrollbar-color: var(--line-2) transparent;
}
.board-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 9px 0;
  border-bottom: 1px solid var(--line);
}
.board-row:first-child { padding-top: 6px; }
.board-row:last-child { border-bottom: 0; }
.row-copy { min-width: 0; flex: 1; }
.row-title { display: flex; align-items: baseline; gap: 8px; margin: 0; font-size: 12.5px; color: var(--muted); }
.row-title strong { font-size: 13px; font-weight: 700; color: var(--text); }
.row-state { flex: none; font-size: 11px; color: var(--dim); }
.row-text {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.row-meta { margin: 3px 0 0; font-size: 11px; color: var(--dim); }
.row-actions { display: flex; flex: none; align-items: center; gap: 10px; }
.row-link { font-size: 11.5px; color: var(--dim); white-space: nowrap; }
.row-link:hover { color: var(--lime); }
.row-join {
  height: 30px;
  color: var(--lime);
  border-color: color-mix(in srgb, var(--lime) 38%, transparent);
}
.row-join:hover:not(:disabled) { background: color-mix(in srgb, var(--lime) 12%, transparent); border-color: var(--lime); }

.board-scroll-hint { margin: 6px 0 0; font-size: 11px; color: var(--dim); }
.board-empty { margin: 8px 0 2px; font-size: 12.5px; }
.board-link { color: var(--lime); margin-left: 4px; white-space: nowrap; }
.board-link:hover { text-decoration: underline; }

@media (max-width: 640px) {
  .recruit-board { padding: 14px 15px 12px; border-radius: 16px; }
  .board-head { align-items: flex-start; }
  .board-intro h2 { font-size: 20px; }
  .board-quick { width: 100%; }
  .board-select { flex: 1; }
  .board-select select { flex: 1; }
  .board-row { flex-wrap: wrap; gap: 7px; }
  .row-actions { width: 100%; justify-content: space-between; }
  .row-join { margin-left: auto; }
}
</style>
