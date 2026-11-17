<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { beginGlobalEntry, fetchHealth, joinPlayer, parentPlay as requestParentPlay } from '../api/client.ts';
import { guestJoinEnabled } from '../lib/join.ts';
import ThemePicker from '../components/ThemePicker.vue';
import WebInvites from '../components/WebInvites.vue';
import type { Health } from '../api/types.ts';
import { logoutWebPlayer, takeWebSeat, webPlayerRequest, type WebPlayer } from '../api/web-player.ts';
import { seat } from '../stores/session.ts';
import { detectGateway, gateway } from '../stores/server.ts';

/** `retry` 只在入场失败时出现（`initialError`），由根组件重新走一次 boot。 */
const emit = defineEmits<{ entered: []; retry: []; redeemed: [] }>();
const props = defineProps<{ initialError?: string; canRetry?: boolean; inviteCode?: string }>();

const name = ref('');
const invite = ref('');
const error = ref('');
const busy = ref(false);
const guestJoin = ref(false);
const globalIdentity = ref<Health['globalIdentity']>(null);
const parentName = ref('');
const entry = ref(new URLSearchParams(location.search).get('entry') === 'guest' ? 'guest' : 'login');
const loginName = ref('');
const password = ref('');
const code = ref('');
const guestName = ref('');
const player = ref<WebPlayer | null>(null);

watch(() => props.inviteCode, inviteCode => {
  if (!inviteCode) return;
  entry.value = 'guest';
  code.value = inviteCode;
  error.value = '';
}, { immediate: true });

async function loadWebPlayer(): Promise<void> {
  player.value = await webPlayerRequest<WebPlayer>('me').catch(() => null);
  if (player.value?.guest && !guestName.value) guestName.value = player.value.name;
}

onMounted(async () => {
  void loadWebPlayer();
  // 与 fetchHealth 同一拍发起，共用同一个 /healthz；单厅据此不显示回首页的入口。
  void detectGateway();
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

async function webAction(action: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await action();
  } catch (cause) {
    error.value = (cause as Error).message;
    await loadWebPlayer();
  } finally {
    busy.value = false;
  }
}

async function signIn() {
  await webAction(async () => {
    await webPlayerRequest('login', { loginName: loginName.value, password: password.value });
    password.value = '';
    await loadWebPlayer();
  });
}

async function redeem() {
  await webAction(async () => {
    await webPlayerRequest('redeem', { code: code.value, name: guestName.value });
    code.value = '';
    emit('redeemed');
    await loadWebPlayer();
    await takeWebSeat(false);
    emit('entered');
  });
}

async function play() {
  await webAction(async () => {
    await takeWebSeat(player.value?.seated === true, player.value?.guest ? guestName.value : undefined);
    emit('entered');
  });
}

async function logout() {
  await webAction(async () => {
    await logoutWebPlayer();
    player.value = null;
  });
}

function removeEntryMode(): void {
  const url = new URL(location.href);
  url.searchParams.delete('entry');
  history.replaceState(history.state, '', url);
}

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
      removeEntryMode();
      beginGlobalEntry(globalIdentity.value.authority, { invite: invite.value.trim(), name: trimmed, room: wantedRoom() || 'hall' });
      return;
    }
    await joinPlayer(trimmed, invite.value.trim(), wantedRoom());
    removeEntryMode();
    emit('entered');
  } catch (joinError) {
    error.value = (joinError as Error).message || '加入失败';
  } finally {
    busy.value = false;
  }
}

/** 入场失败后重试：顺带重探服务器形态，healthz 恢复后回首页的入口要自己回来。 */
function retryEntry(): void {
  void detectGateway();
  emit('retry');
}

async function parentPlay(): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    const body = await requestParentPlay();
    removeEntryMode();
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
      <!-- 单厅（serve.ts）没有对外首页，那边只留品牌文字，不给一条 404 的链接。 -->
      <a v-if="gateway" class="brand" href="/" title="回鲸语会馆首页" aria-label="鲸语会馆 · 回首页">鲸语 <small>PARLOR CLUB</small></a>
      <p v-else class="brand">鲸语 <small>PARLOR CLUB</small></p>
      <h1>进入会馆</h1>
      <p v-if="error || props.initialError" class="warn error" role="alert">{{ error || props.initialError }}</p>
      <template v-if="player">
        <p class="sub">{{ player.name }}<template v-if="player.guest"> · 游客资格至 {{ new Date(player.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }}</template></p>
        <p v-if="props.inviteCode" class="note">要使用这张新邀请，请先退出当前会馆登录。</p>
        <div v-if="player.guest && !player.seated" class="field"><label for="resume-guest-name">游客昵称</label><input id="resume-guest-name" v-model="guestName" maxlength="24" autocomplete="nickname"></div>
        <button class="btn primary" type="button" :disabled="busy" @click="play">{{ player.seated ? (player.guest ? '继续试玩' : '接管席位') : (player.guest ? '进入试玩客厅' : '进入大厅') }}</button>
        <button class="btn ghost" type="button" :disabled="busy" @click="logout">{{ player.guest ? '结束试玩' : '退出登录' }}</button>
        <WebInvites v-if="!player.guest" />
      </template>
      <template v-else>
        <div class="entry-options">
          <button class="btn" type="button" :aria-pressed="entry === 'login'" @click="entry = 'login'; error = ''">账号登录</button>
          <button class="btn" type="button" :aria-pressed="entry === 'guest'" @click="entry = 'guest'; error = ''">邀请码试玩</button>
        </div>
        <form v-if="entry === 'login'" @submit.prevent="signIn">
          <div class="field"><label for="login-name">登录名</label><input id="login-name" v-model="loginName" maxlength="48" autocomplete="username" required></div>
          <div class="field"><label for="login-password">密码</label><input id="login-password" v-model="password" type="password" autocomplete="current-password" required></div>
          <button class="btn primary" type="submit" :disabled="busy">登录</button>
          <p class="note">可从 Coo 的家长页设置登录名和密码。</p>
        </form>
        <form v-else @submit.prevent="redeem">
          <div class="field"><label for="guest-name">游客昵称</label><input id="guest-name" v-model="guestName" maxlength="24" autocomplete="nickname" required></div>
          <div class="field"><label for="guest-code">一次性邀请码</label><input id="guest-code" v-model="code" maxlength="22" type="password" autocomplete="off" required></div>
          <button class="btn primary" type="submit" :disabled="busy">开始试玩</button>
        </form>
      </template>
      <p v-if="seat" class="note"><a href="/play">返回当前席位</a></p>
      <details v-if="guestJoin">
        <summary>使用会馆共享码</summary>
        <p class="sub">用自己的席位和 Coo 同桌。你的战绩、礼物和信箱是单独的一份，不会记到她头上。</p>
        <div class="field">
          <label for="join-name">你的名字</label>
          <input id="join-name" v-model="name" maxlength="24" autocomplete="nickname" placeholder="比如：爸爸">
        </div>
        <div class="field">
          <label for="join-invite">邀请码</label>
          <input id="join-invite" v-model="invite" type="password" autocomplete="off">
        </div>
        <button class="btn primary" type="button" :disabled="busy" @click="submit">加入客厅</button>
      </details>
      <!-- 入场失败（多半是钥匙没换成席位）时给一条原地重试；入口关闭时也保留，别让人只能重开链接。 -->
      <button v-if="props.canRetry" class="btn" type="button" :disabled="busy" @click="retryEntry">再试一次</button>
      <div v-if="parentName" class="parent-play">
        <p class="sub">这台浏览器登录了「{{ parentName }}」，可以直接以这个身份下场。</p>
        <button class="btn primary" type="button" :disabled="busy" @click="parentPlay">以家长身份下场</button>
      </div>
      <!-- 从聊天软件点错的链接多半落在这一页；给一条明确的退路，不指望人记得域名。 -->
      <p v-if="gateway" class="note home-note"><a href="/">← 回会馆首页</a></p>
    </section>
  </div>
</template>

<style scoped>
.entry-options { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.entry-options [aria-pressed="true"] { border-color: currentColor; font-weight: 700; }
details { margin-block: 12px; }
/* 品牌行现在是回首页的链接；触屏没有 hover，所以底部另留一条带下划线的文字链接。 */
.brand:hover, .brand:focus-visible { text-decoration: underline; text-underline-offset: 4px; }
.join .home-note { margin-top: 20px; }
/* 字号写在 a 上：父级 .note 的 11px 来自 night.css，改 p 会被它按优先级压回去。 */
.join .home-note a {
  display: inline-block;
  padding: 6px 0;
  font-size: 12px;
  color: var(--muted);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.join .home-note a:hover, .join .home-note a:focus-visible { color: var(--text); }
</style>
