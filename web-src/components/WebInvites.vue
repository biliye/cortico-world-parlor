<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ApiError } from '../api/client.ts';
import { uncertainWebResult, webPlayerRequest } from '../api/web-player.ts';

const props = defineProps<{ seatToken?: string }>();
type Invite = { id: string; guestName: string | null; guestHandle: string | null; redeemBy: number; accessUntil: number | null; revokedAt: number | null };
const invites = ref<Invite[] | null>(null);
const issued = ref<{ id: string; link: string } | null>(null);
const linkField = ref<HTMLInputElement | null>(null);
const copyStatus = ref('');
const error = ref('');
const listError = ref('');
const loading = ref(false);
const busy = ref(false);
const format = (time: number) => new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const ended = (invite: Invite) => invite.revokedAt !== null || (invite.accessUntil ?? invite.redeemBy) <= Date.now();

async function load() {
  if (loading.value) return;
  loading.value = true;
  listError.value = '';
  try {
    const { invites: list } = await webPlayerRequest<{ invites: Invite[] }>('invites', undefined, props.seatToken);
    if (!Array.isArray(list)) throw new Error('暂时无法读取邀请列表。');
    invites.value = list;
  } catch (cause) {
    listError.value = (cause as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function change(id?: string) {
  if (busy.value || loading.value || listError.value || !invites.value) return;
  busy.value = true;
  error.value = '';
  copyStatus.value = '';
  try {
    if (id) {
      await webPlayerRequest('invites/' + id + '/revoke', {}, props.seatToken);
      if (issued.value?.id === id) issued.value = null;
    } else {
      issued.value = null;
      const result = await webPlayerRequest<{ id: string; link: string }>('invites', {}, props.seatToken);
      if (!result.id || !result.link) throw new ApiError('未收到邀请链接', 0, '');
      issued.value = result;
    }
    await load();
  } catch (cause) {
    error.value = (cause as Error).message;
    if (uncertainWebResult(cause)) {
      await load();
      if (id && invites.value.some(invite => invite.id === id && invite.revokedAt !== null)) {
        if (issued.value?.id === id) issued.value = null;
        error.value = '';
      } else {
        error.value = id
          ? '未收到撤销结果，请先查看邀请状态。'
          : '未收到发码结果。请先查看列表，如有已生成但没拿到链接的邀请，可撤销后再生成。';
      }
    }
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
  <details>
    <summary>邀请朋友试玩</summary>
    <p>链接 7 天内可用一次，朋友填写昵称后可在试玩客厅玩 24 小时。</p>
    <p v-if="loading" role="status">正在读取邀请…</p>
    <template v-if="listError">
      <p class="bad" role="alert">{{ listError }}</p>
      <button class="btn ghost small" type="button" :disabled="busy || loading" @click="load">重查邀请</button>
    </template>
    <button class="btn small" type="button" :disabled="busy || loading || !!listError || !invites" @click="change()">生成邀请链接</button>
    <div v-if="issued" class="field">
      <label>邀请链接 <input ref="linkField" :value="issued.link" readonly></label>
      <button class="btn small" type="button" @click="copyLink">复制链接</button>
    </div>
    <p v-if="copyStatus" role="status">{{ copyStatus }}</p>
    <p v-if="error" class="bad" role="alert">{{ error }}</p>
    <p v-if="invites?.length === 0 && !loading && !listError" class="muted">还没有邀请。</p>
    <section v-for="invite in invites" :key="invite.id" class="access-section">
      <p v-if="invite.revokedAt">已撤销</p>
      <p v-else-if="invite.guestHandle && invite.accessUntil">{{ invite.guestName }} #{{ invite.guestHandle }} · {{ ended(invite) ? '已到期' : '可玩至 ' + format(invite.accessUntil) }}</p>
      <p v-else>待使用 · {{ format(invite.redeemBy) }} 到期</p>
      <button v-if="!ended(invite)" class="btn ghost small" type="button" :disabled="busy || loading || !!listError" @click="change(invite.id)">撤销邀请</button>
    </section>
  </details>
</template>
