<script setup lang="ts">
import { ref } from 'vue';
import { enterDiscoveredTable, loadHall, myTable, recruitments } from '../stores/parlor.ts';
import type { TableRecruitment } from '../../src/room/table-discovery-db.ts';

const game = ref('ddz');
const busy = ref(false);
const notice = ref('');
const expanded = ref(false);
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
</script>

<template>
  <section class="panel recruit-area" aria-label="快速匹配与牌桌招募">
    <div class="recruit-heading">
      <div><h2>找一桌，坐下来</h2><p class="muted">匹配公开客厅里开放的无押注等人桌，坐下后由桌主开局。</p></div>
      <div class="actions">
        <label class="recruit-select">想玩
          <select v-model="game" aria-label="快速匹配游戏" :disabled="busy">
            <option value="ddz">斗地主</option><option value="werewolf">狼人杀</option><option value="dice">骰子</option>
          </select>
        </label>
        <button class="btn primary" type="button" :disabled="busy || !!myTable" @click="join({ game })">{{ busy ? '正在加入…' : '快速匹配' }}</button>
      </div>
    </div>
    <p v-if="myTable" class="muted">你已经在牌桌上，可以从「牌桌」回去继续。</p>
    <p v-if="notice" class="warn" role="status">{{ notice }}</p>
    <div class="recruit-heading"><h3>大厅牌桌招募 <small>· {{ recruitments.length }}</small></h3><button class="btn ghost small" type="button" @click="loadHall(true)">刷新招募</button></div>
    <p v-if="!recruitments.length" class="muted">暂时没有招募。开一张桌，写句话叫大家来玩吧。</p>
    <div v-else class="recruit-grid">
      <article v-for="item in expanded ? recruitments : recruitments.slice(0, 6)" :key="item.tableId" class="recruit-card">
        <div class="recruit-heading"><strong>{{ item.label }} · {{ item.seats }}/{{ item.capacity }}</strong><span class="muted">{{ item.full ? '已满员' : '等人中' }}</span></div>
        <p class="recruit-copy">{{ item.text }}</p>
        <p class="muted">{{ item.author }} · {{ item.roomName }} · {{ item.stake ? '每人押 ' + item.stake + ' 枚筹码' : '无押注' }}</p>
        <div class="actions"><a class="btn ghost small" :href="item.link">看看牌桌 ↗</a><button class="btn primary small" type="button" :disabled="busy || item.full || !!myTable" @click="joinRecruit(item)">加入这桌</button></div>
      </article>
    </div>
    <button v-if="recruitments.length > 6" class="btn ghost small" type="button" @click="expanded = !expanded">{{ expanded ? '收起' : '查看全部招募' }}</button>
  </section>
</template>

<style scoped>
.recruit-area { margin-block: 20px; }
.recruit-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.recruit-heading h2, .recruit-heading h3 { margin-block: 8px; }
.recruit-select { display: flex; align-items: center; gap: 8px; }
.recruit-select select { font: inherit; color: inherit; background: var(--surface, transparent); border: 1px solid currentColor; border-radius: 8px; padding: 9px; }
.recruit-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 14px; margin-block: 12px; }
.recruit-card { border: 1px solid var(--line, #7776); border-radius: 12px; padding: 16px; min-width: 0; }
.recruit-copy { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
@media (max-width: 600px) { .recruit-heading > .actions { width: 100%; } .recruit-select { flex: 1; } }
</style>
