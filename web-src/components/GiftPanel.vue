<script setup lang="ts">
/**
 * 茶点：赠礼只能从茶单里挑一件（茶或小零食），也可以把收到的喝掉/吃掉。
 * 运气那行只是气氛——服务器算，前端照原样显示，不参与任何结算。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { api } from '../api/client.ts';
import { act, snapshot } from '../stores/parlor.ts';
import { seat } from '../stores/session.ts';

interface GiftItem { id:string; kind:'tea'|'snack'; name:string; desc:string; icon:string; count:number }

const props = defineProps<{ open:boolean }>();
const emit = defineEmits<{ 'update:open':[boolean] }>();
const dialog = ref<HTMLDialogElement|null>(null);
const items = ref<GiftItem[]>([]);
const busy = ref(false);
const loading = ref(false);
const error = ref('');
const note = ref('');
const picked = ref('');
const target = ref('');
const line = ref('');

const others = computed(() => (snapshot.value?.seats || []).filter((person) => person.id !== seat.value?.seatId));
const pickedItem = computed(() => items.value.find((item) => item.id === picked.value) || null);
const held = computed(() => items.value.filter((item) => item.count > 0));
const tea = computed(() => items.value.filter((item) => item.kind === 'tea'));
const snack = computed(() => items.value.filter((item) => item.kind === 'snack'));
const verb = (item: GiftItem) => (item.kind === 'tea' ? '喝掉' : '吃掉');

function close(): void { emit('update:open', false); }

async function load(): Promise<void> {
  const token = seat.value?.token;
  loading.value = true; error.value = '';
  try {
    const room = snapshot.value?.id;
    const data = await api<{ items:GiftItem[] }>(room ? `/v1/rooms/${encodeURIComponent(room)}/gifts` : '/v1/rooms/lobby/gifts');
    if (token !== seat.value?.token) return;
    items.value = data.items;
    if (!picked.value && items.value.length) picked.value = items.value[0].id;
  } catch (cause) { error.value = (cause as Error).message; }
  finally { loading.value = false; }
}

async function send(): Promise<void> {
  const item = pickedItem.value;
  if (!item) { error.value = '先选一件茶点'; return; }
  busy.value = true; error.value = ''; line.value = '';
  try {
    const receipt = await act({ type: 'gift', to: target.value, item: item.id, text: note.value.trim() });
    if (receipt) {
      line.value = typeof receipt.notice === 'string' ? receipt.notice : `送出 ${item.name}。`;
      note.value = '';
      await load();
    }
  } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}

async function consume(item: GiftItem): Promise<void> {
  busy.value = true; error.value = ''; line.value = '';
  try {
    const receipt = await act({ type: 'gift_eat', item: item.id });
    if (receipt) {
      line.value = typeof receipt.notice === 'string' ? receipt.notice : `吃掉了 ${item.name}。`;
      await load();
    }
  } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}

watch(() => props.open, async (open) => {
  await nextTick();
  if (open) {
    dialog.value?.showModal();
    if (!target.value) target.value = others.value[0]?.name || '';
    void load();
  } else if (dialog.value?.open) dialog.value.close();
});
watch(() => snapshot.value?.id, () => { if (props.open) void load(); });
</script>

<template>
  <dialog ref="dialog" class="rooms-dialog" aria-label="茶点" @close="close" @cancel="close">
    <div class="rooms-box">
      <div class="rooms-head">
        <h2>茶点</h2>
        <button class="btn ghost small" type="button" @click="close">关闭</button>
      </div>
      <div class="access-body">
        <p class="muted">礼物就是茶或者一份小零食，没有价签，也不押任何东西。送出去就收不回来；收到的东西可以自己喝掉或吃掉。</p>
        <p v-if="error" class="bad" role="alert">{{ error }}</p>
        <p v-if="line" class="gift-line" role="status">{{ line }}</p>

        <form v-if="others.length" class="gift-send" @submit.prevent="send()">
          <label>送给
            <select v-model="target">
              <option v-for="person in others" :key="person.id" :value="person.name">{{ person.name }}</option>
            </select>
          </label>
          <label>一句话<input v-model="note" maxlength="120" placeholder="不写也行" /></label>
          <label>选了 <strong>{{ pickedItem ? pickedItem.icon + pickedItem.name : '—' }}</strong></label>
          <button class="btn primary small" type="submit" :disabled="busy || !picked">送出</button>
        </form>
        <p v-else class="muted">这一间还没有别人，先把茶点留着。</p>

        <section v-for="group in [{ label:'茶', list:tea }, { label:'小零食', list:snack }]" :key="group.label" class="access-section">
          <strong>{{ group.label }}</strong>
          <div class="gift-grid">
            <button
              v-for="item in group.list"
              :key="item.id"
              class="gift-card"
              type="button"
              :class="{ 'is-on': picked === item.id }"
              :title="item.desc"
              @click="picked = item.id"
            >
              <span class="gift-icon">{{ item.icon }}</span>
              <span class="gift-name">{{ item.name }}</span>
              <small class="muted">{{ item.count ? '手上 ' + item.count : item.desc }}</small>
            </button>
          </div>
        </section>

        <section v-if="held.length" class="access-section">
          <strong>我手上的</strong>
          <p v-for="item in held" :key="item.id" class="gift-held">
            <span>{{ item.icon }} {{ item.name }} × {{ item.count }}</span>
            <button class="btn ghost small" type="button" :disabled="busy" @click="consume(item)">{{ verb(item) }}</button>
          </p>
          <p class="muted">连着喝/吃太多，运气那行会变——只是说说，不影响任何结果。</p>
        </section>
        <p v-else-if="!loading" class="muted">手上还没有茶点。</p>
        <p v-if="loading" class="muted" role="status">正在读茶单…</p>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.gift-send { display:flex;flex-wrap:wrap;gap:12px;align-items:end;margin:16px 0; }
.gift-send label { display:grid;gap:4px;min-width:120px;flex:1; }
.gift-send input,.gift-send select { box-sizing:border-box;width:100%;min-width:0; }
.gift-grid { display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:8px;margin-top:8px; }
.gift-card {
  display:grid;gap:2px;justify-items:start;text-align:left;padding:10px;cursor:pointer;
  border:1px solid var(--line-2);border-radius:10px;background:var(--panel-2);color:var(--text);
}
.gift-card.is-on { border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset; }
.gift-icon { font-size:20px;line-height:1; }
.gift-name { font-weight:600; }
.gift-card small { font-size:11px;line-height:1.35; }
.gift-held { display:flex;justify-content:space-between;align-items:center;gap:12px;margin:6px 0; }
.gift-line { margin:8px 0;padding:8px 10px;border-radius:8px;background:var(--panel-2);border:1px solid var(--line-2); }
</style>
