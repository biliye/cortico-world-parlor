<script setup lang="ts">
/** 加入页：名字 + 邀请码。统一身份在时跳去身份服务，回来再换席位。 */
import { onMounted, ref } from 'vue';
import { beginGlobalEntry, fetchHealth, joinPlayer, parentPlay as requestParentPlay } from '../api/client.ts';
import { GUEST_CLOSED_MESSAGE, guestJoinEnabled } from '../lib/join.ts';
import ThemePicker from '../components/ThemePicker.vue';
import type { Health } from '../api/types.ts';

/** `retry` 只在入场失败时出现（`initialError`），由根组件重新走一次 boot。 */
const emit = defineEmits<{ entered: []; retry: [] }>();
const props = defineProps<{ initialError?: string; canRetry?: boolean }>();

const name = ref('');
const invite = ref('');
const error = ref('');
const busy = ref(false);
const guestJoin = ref(true);
const globalIdentity = ref<Health['globalIdentity']>(null);
const parentName = ref('');
const closedMessage = ref('');

onMounted(async () => {
  const health = await fetchHealth();
  if (health) {
    guestJoin.value = guestJoinEnabled(health);
    globalIdentity.value = health.globalIdentity || null;
  }
  try {
    const response = await fetch('/v1/parent/me');
    if (response.ok) {
      const body = await response.json().catch(() => null);
      parentName.value = (body && body.account && body.account.displayName) || '家长';
    }
  } catch {
    /* 没有家长会话就当普通加入页 */
  }
});

function wantedRoom(): string {
  return new URLSearchParams(location.search).get('room') || '';
}

async function submit(): Promise<void> {
  error.value = '';
  const trimmed = name.value.trim();
  if (!trimmed) {
    error.value = '先起一个名字。';
    return;
  }
  if (!invite.value.trim()) {
    error.value = '邀请码没填。';
    return;
  }
  busy.value = true;
  try {
    if (globalIdentity.value) {
      beginGlobalEntry(globalIdentity.value.authority, { invite: invite.value.trim(), name: trimmed, room: wantedRoom() || 'hall' });
      return;
    }
    await joinPlayer(trimmed, invite.value.trim(), wantedRoom());
    emit('entered');
  } catch (joinError) {
    error.value = (joinError as Error).message || '加入失败';
  } finally {
    busy.value = false;
  }
}

async function parentPlay(): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    const body = await requestParentPlay();
    if (body.globalEntry) {
      beginGlobalEntry(body.globalEntry, { room: body.room, parent: true });
      return;
    }
    emit('entered');
  } catch (playError) {
    error.value = (playError as Error).message || '现在下不了场';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="join">
    <div class="join-scene" aria-hidden="true">
      <span class="join-lamp" />
      <div class="join-felt">
        <span class="join-felt-mark">GOOD COMPANY · GREAT HANDS</span>
      </div>
      <div class="join-cards">
        <span class="scard black">A<span>♠</span></span>
        <span class="scard red">K<span>♥</span></span>
        <span class="scard black">Q<span>♣</span></span>
      </div>
      <span class="spark spark-a">✳</span>
      <span class="spark spark-b">✳</span>
    </div>
    <ThemePicker />
    <section class="panel">
      <p class="brand">鲸语 <small>PARLOR CLUB</small></p>
      <h1>{{ guestJoin ? '客厅 · 下场玩' : '客厅 · 入口已关闭' }}</h1>
      <p v-if="!guestJoin" class="sub">
        {{ closedMessage || GUEST_CLOSED_MESSAGE }}
      </p>
      <template v-else>
        <p class="sub">用自己的席位和 Coo 同桌。你的战绩、礼物和信箱是单独的一份，不会记到她头上。</p>
        <div class="field">
          <label for="join-name">你的名字</label>
          <input id="join-name" v-model="name" maxlength="24" autocomplete="nickname" placeholder="比如：爸爸">
        </div>
        <div class="field">
          <label for="join-invite">邀请码</label>
          <input id="join-invite" v-model="invite" type="password" autocomplete="off" placeholder="部署里 PARLOR_INVITE_CODE 那一行">
        </div>
        <p class="warn error">{{ error || props.initialError }}</p>
        <button class="btn primary" type="button" :disabled="busy" @click="submit">加入客厅</button>
        <p class="note">邀请码只用来进这个房间，不会存进网址；席位令牌存在这台浏览器里。</p>
      </template>
      <!-- 入场失败（多半是钥匙没换成席位）时给一条原地重试；入口关闭时也保留，别让人只能重开链接。 -->
      <button v-if="props.canRetry" class="btn" type="button" :disabled="busy" @click="emit('retry')">再试一次</button>
      <div v-if="parentName" class="parent-play">
        <p class="sub">这台浏览器登录了「{{ parentName }}」，可以直接以这个身份下场。</p>
        <button class="btn primary" type="button" :disabled="busy" @click="parentPlay">以家长身份下场</button>
      </div>
    </section>
  </div>
</template>
