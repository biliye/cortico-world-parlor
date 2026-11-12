<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import { api } from '../api/client.ts';
import { seat } from '../stores/session.ts';

const props = defineProps<{ open:boolean }>();
const emit = defineEmits<{ 'update:open':[boolean] }>();
const dialog = ref<HTMLDialogElement|null>(null);
const kind = ref<'games'|'gifts'>('games');
const game = ref('');
const from = ref('');
const until = ref('');
const room = ref('');
const busy = ref(false);
const error = ref('');
const summary = ref<{ games:number;wins:number;losses:number;draws:number }|null>(null);
type Item = { id:string;ts:number;roomName:string;game?:string;result?:string;itemId?:string;itemName?:string;direction?:'in'|'out'|'used';text:string };
const items = ref<Item[]>([]);
const next = ref<number|null>(null);
let epoch = 0;
const when = (ts:number) => new Date(ts).toLocaleString('zh-CN', { timeZone:'Asia/Shanghai', hour12:false });
const resultLabel = (value?:string) => ({ win:'胜', loss:'负', draw:'平' }[value || ''] || '');
const giftLabel = (value?:string) => ({ in:'收到', out:'送出', used:'喝掉/吃掉' }[value || ''] || '礼物');
function close():void { emit('update:open', false); }
async function load(more = false):Promise<void> {
  if (more && busy.value) return;
  const current = ++epoch;
  const token = seat.value?.token;
  busy.value = true; error.value = '';
  if (!more) { items.value = []; next.value = null; }
  try {
    const q = new URLSearchParams({ kind:kind.value, limit:'20' });
    if (game.value) q.set('game', game.value);
    if (room.value.trim()) q.set('room', room.value.trim());
    if (from.value) q.set('from', String(new Date(from.value + 'T00:00:00+08:00').getTime()));
    if (until.value) q.set('until', String(new Date(until.value + 'T00:00:00+08:00').getTime() + 86400000));
    if (more && next.value) q.set('before', String(next.value));
    const [account, page] = await Promise.all([
      api<{ledger:NonNullable<typeof summary.value>}>('/v1/me/ledger'),
      api<{items:Item[];next:number|null}>('/v1/me/history?' + q),
    ]);
    if (current !== epoch || token !== seat.value?.token) return;
    summary.value = account.ledger;
    items.value = more ? [...items.value, ...page.items] : page.items;
    next.value = page.next;
  } catch (cause) { if (current === epoch) error.value = (cause as Error).message; }
  finally { if (current === epoch) busy.value = false; }
}
watch(() => props.open, async open => {
  ++epoch;
  await nextTick();
  if (open) { dialog.value?.showModal(); void load(); }
  else if (dialog.value?.open) dialog.value.close();
});
watch(() => seat.value?.cooId, () => { ++epoch; items.value = []; summary.value = null; if (props.open) void load(); });
</script>

<template>
  <dialog ref="dialog" class="rooms-dialog" aria-label="我的账户与记录" @close="close" @cancel="close">
    <div class="rooms-box">
      <div class="rooms-head"><h2>我的账户</h2><button class="btn ghost small" type="button" @click="close">关闭</button></div>
      <div class="access-body">
        <p v-if="summary">{{ summary.games }} 局 · {{ summary.wins }} 胜 {{ summary.losses }} 负 {{ summary.draws }} 平</p>
        <p class="muted">包含你在所有客厅的记录；已归档客厅的对局仍可查看。时间按北京时间显示。</p>
        <form class="account-filters" @submit.prevent="load()">
          <label>记录 <select v-model="kind"><option value="games">历史对局</option><option value="gifts">礼物流水</option></select></label>
          <label v-if="kind === 'games'">游戏 <select v-model="game"><option value="">全部</option><option value="ddz">斗地主</option><option value="werewolf">狼人杀</option><option value="dice">骰子</option><option value="gomoku">五子棋</option><option value="xiangqi">中国象棋</option><option value="monopoly2d">快局大富翁</option><option value="aeroplane">飞行棋</option></select></label>
          <label>开始日期 <input v-model="from" type="date" /></label>
          <label>结束日期 <input v-model="until" type="date" /></label>
          <label>原客厅号 <input v-model="room" placeholder="全部客厅" /></label>
          <button class="btn primary small" type="submit" :disabled="busy">查询</button>
        </form>
        <p v-if="error" class="bad" role="alert">{{ error }}</p>
        <p v-if="busy" class="muted" role="status">正在读取…</p>
        <p v-else-if="!items.length && !error" class="muted">暂无记录。</p>
        <section v-for="item in items" :key="item.id" class="access-section">
          <strong>{{ kind === 'games' ? resultLabel(item.result) : giftLabel(item.direction) + ' · ' + (item.itemName || '礼物') }}</strong>
          <p>{{ item.text }}</p>
          <small class="muted">{{ when(item.ts) }} · {{ item.roomName }}{{ kind === 'games' ? ' · ' + (item.game || '其他') : '' }}</small>
        </section>
        <button v-if="next" class="btn ghost" type="button" :disabled="busy" @click="load(true)">更早的记录</button>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.account-filters { display:flex;flex-wrap:wrap;gap:12px;align-items:end;margin:16px 0; }
.account-filters label { display:grid;gap:4px;min-width:120px;flex:1; }
.account-filters input,.account-filters select { box-sizing:border-box;width:100%;min-width:0; }
.access-section p { overflow-wrap:anywhere; }
</style>
