<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { webPlayerRequest } from '../api/web-player.ts';

const props = defineProps<{ seatToken?: string }>();
type Invite = { id: string; guestName: string | null; guestHandle: string | null; redeemBy: number; accessUntil: number | null; revokedAt: number | null };
const invites = ref<Invite[] | null>(null);
const issued = ref<{ id: string; link: string } | null>(null);
const linkField = ref<HTMLInputElement | null>(null);
const copyStatus = ref('');
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
  copyStatus.value = '';
  try {
    if (id) {
      await webPlayerRequest('invites/' + id + '/revoke', {}, props.seatToken);
      if (issued.value?.id === id) issued.value = null;
    } else {
      issued.value = await webPlayerRequest('invites', {}, props.seatToken);
    }
    await load();
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}

async function copyLink() {
  if (!issued.value) return;
  try {
    await navigator.clipboard.writeText(issued.value.link);
    copyStatus.value = '已复制邀请链接。';
  } catch {
    linkField.value?.focus();
    linkField.value?.select();
    copyStatus.value = '已选中邀请链接，请手动复制。';
  }
}
</script>

<template>
  <details v-if="invites">
    <summary>邀请朋友试玩</summary>
    <p>链接 7 天内可用一次，朋友填写昵称后可在试玩客厅玩 24 小时。</p>
    <button class="btn small" type="button" :disabled="busy" @click="change()">生成邀请链接</button>
    <div v-if="issued" class="field">
      <label>邀请链接 <input ref="linkField" :value="issued.link" readonly></label>
      <button class="btn small" type="button" @click="copyLink">复制链接</button>
    </div>
    <p v-if="copyStatus" role="status">{{ copyStatus }}</p>
    <p v-if="error" class="bad" role="alert">{{ error }}</p>
    <section v-for="invite in invites" :key="invite.id" class="access-section">
      <p v-if="invite.revokedAt">已撤销</p>
      <p v-else-if="invite.guestHandle && invite.accessUntil">{{ invite.guestName }} #{{ invite.guestHandle }} · {{ ended(invite) ? '已到期' : '可玩至 ' + format(invite.accessUntil) }}</p>
      <p v-else>待使用 · {{ format(invite.redeemBy) }} 到期</p>
      <button v-if="!ended(invite)" class="btn ghost small" type="button" :disabled="busy" @click="change(invite.id)">撤销邀请</button>
    </section>
  </details>
</template>
