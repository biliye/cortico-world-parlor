<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { webPlayerRequest } from '../api/web-player.ts';

const props = defineProps<{ seatToken?: string }>();
type Invite = { id: string; guestName: string | null; guestHandle: string | null; redeemBy: number; accessUntil: number | null; revokedAt: number | null };
const invites = ref<Invite[] | null>(null);
const code = ref('');
const error = ref('');
const busy = ref(false);
const format = (time: number) => new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const ended = (invite: Invite) => invite.revokedAt !== null || (invite.accessUntil ?? invite.redeemBy) <= Date.now();

async function load() {
  invites.value = (await webPlayerRequest<{ invites: Invite[] }>('invites', undefined, props.seatToken)).invites;
}
onMounted(() => { void load().catch(() => {}); });

async function change(id?: string) {
  busy.value = true;
  error.value = '';
  try {
    if (id) await webPlayerRequest('invites/' + id + '/revoke', {}, props.seatToken);
    else code.value = (await webPlayerRequest<{ code: string }>('invites', {}, props.seatToken)).code;
    await load();
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <details v-if="invites">
    <summary>邀请朋友试玩</summary>
    <p>邀请码 7 天内可用一次，兑换后可在试玩客厅玩 24 小时。</p>
    <button class="btn small" type="button" :disabled="busy" @click="change()">生成邀请码</button>
    <div v-if="code" class="field">
      <label>一次性邀请码 <input :value="code" readonly @focus="($event.target as HTMLInputElement).select()"></label>
      <p>复制给朋友，让对方在 <a href="/play?entry=guest">邀请码试玩</a> 填写。</p>
    </div>
    <p v-if="error" class="bad" role="alert">{{ error }}</p>
    <section v-for="invite in invites" :key="invite.id" class="access-section">
      <p v-if="invite.revokedAt">已撤销</p>
      <p v-else-if="invite.guestHandle && invite.accessUntil">{{ invite.guestName }} #{{ invite.guestHandle }} · {{ ended(invite) ? '已到期' : '可玩至 ' + format(invite.accessUntil) }}</p>
      <p v-else>待使用 · {{ format(invite.redeemBy) }} 到期</p>
      <button v-if="!ended(invite)" class="btn ghost small" type="button" :disabled="busy" @click="change(invite.id)">撤销邀请</button>
    </section>
  </details>
</template>
