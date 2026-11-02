<script setup lang="ts">
/** 成员管理：在场席位、成员、挂着邀请、邀请一个人、可见性、删除客厅。只有房主能取到数据。 */
import { ref, watch } from 'vue';
import { api } from '../api/client.ts';
import { dateTimeText } from '../lib/text.ts';
import { clearSeat, seat } from '../stores/session.ts';
import { refreshSnapshot } from '../stores/parlor.ts';
import { showToast } from '../stores/ui.ts';

interface AccessSeat { cooId: string; name?: string; kind?: string; owner?: boolean; self?: boolean }
interface AccessMember { cooId: string; name?: string; source?: string; status?: string }
interface AccessInvite { targetCooId: string; targetName?: string; expiresAt?: number }
interface AccessData {
  room?: { id: string; name?: string; visibility?: string };
  owner?: { name?: string };
  seats?: AccessSeat[];
  members?: AccessMember[];
  invitations?: AccessInvite[];
}

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ 'update:open': [boolean] }>();

const dialog = ref<HTMLDialogElement | null>(null);
const data = ref<AccessData | null>(null);
const status = ref('');
const failed = ref(false);
const busy = ref(false);
const inviteName = ref('');
const visibility = ref('public');

watch(() => props.open, async (open) => {
  if (open) {
    show();
    await load();
  } else {
    hide();
  }
}, { immediate: true });

function show(): void {
  const node = dialog.value;
  if (!node) return;
  if (typeof node.showModal === 'function') {
    if (!node.open) node.showModal();
  } else {
    node.setAttribute('open', '');
  }
}

function hide(): void {
  const node = dialog.value;
  if (node && node.open) node.close();
}

function close(): void {
  emit('update:open', false);
}

function onBackdrop(event: MouseEvent): void {
  if (event.target === dialog.value) close();
}

function roomId(): string {
  return data.value?.room?.id || seat.value?.room || '';
}

async function load(): Promise<void> {
  const id = roomId();
  status.value = '正在取成员…';
  failed.value = false;
  if (!id) {
    status.value = '还没进过客厅。';
    return;
  }
  try {
    data.value = await api<AccessData>('/v1/rooms/' + encodeURIComponent(id) + '/access');
    visibility.value = data.value.room?.visibility || 'public';
    status.value = '';
  } catch (error) {
    data.value = null;
    failed.value = true;
    status.value = (error as { status?: number }).status === 403
      ? '只有房主能管理这个客厅'
      : (error as Error).message || '取不到成员';
  }
}

function label(kind?: string): string {
  return kind === 'pet' ? 'Coo' : kind === 'observer' ? '观看' : kind === 'human' ? '人' : (kind || '');
}

async function revoke(seatLike: { cooId: string; name?: string }, verb = '移出'): Promise<void> {
  const name = seatLike.name || seatLike.cooId;
  if (!window.confirm('把「' + name + '」' + verb + '这个客厅？正在打的牌局会先托管。')) return;
  busy.value = true;
  try {
    await api('/v1/rooms/' + encodeURIComponent(roomId()) + '/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'revoke', cooId: seatLike.cooId }),
    });
    showToast('已经把「' + name + '」' + verb + '去了');
    await refreshSnapshot();
  } catch (error) {
    showToast((error as Error).message || (verb === '请出' ? '请不出去' : '移不出去'), 'bad');
  } finally {
    busy.value = false;
    await load();
  }
}

async function invite(): Promise<void> {
  const to = inviteName.value.trim();
  if (!to) {
    showToast('先填要邀请的人', 'bad');
    return;
  }
  busy.value = true;
  try {
    const result = await api<{ name?: string }>('/v1/rooms/' + encodeURIComponent(roomId()) + '/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to }),
    });
    inviteName.value = '';
    showToast('邀请已经送到「' + (result.name || to) + '」的信箱');
  } catch (error) {
    showToast((error as Error).message || '邀请发不出去', 'bad');
  } finally {
    busy.value = false;
    await load();
  }
}

async function saveVisibility(): Promise<void> {
  const before = data.value?.room?.visibility || 'public';
  const next = visibility.value;
  if (next === before) {
    showToast('可见性没变');
    return;
  }
  if (next === 'private' && before !== 'private'
    && !window.confirm('改成私密后，现在在厅里、又没有单独授权的人会被请出去（正在打的牌交给脚本托管到结算）。继续吗？')) {
    visibility.value = before;
    return;
  }
  busy.value = true;
  try {
    await api('/v1/rooms/' + encodeURIComponent(roomId()) + '/visibility', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: next }),
    });
    showToast('可见性改成「' + (next === 'public' ? '公开' : next === 'unlisted' ? '不列目录' : '私密') + '」了');
  } catch (error) {
    showToast((error as Error).message || '改不了可见性', 'bad');
  } finally {
    busy.value = false;
    await load();
  }
}

async function removeRoom(): Promise<void> {
  const room = data.value?.room;
  if (!room) return;
  if (!window.confirm('确定删除「' + (room.name || room.id) + '」？在场的所有人都会离开，未接受的邀请会失效。')) return;
  busy.value = true;
  try {
    await api('/v1/rooms/' + encodeURIComponent(room.id) + '/delete', { method: 'POST' });
    showToast('客厅已删除');
    close();
    clearSeat('这个客厅已经删除，请重新加入大厅。');
    location.assign('/play');
  } catch (error) {
    showToast((error as Error).message || '删除失败', 'bad');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <dialog ref="dialog" class="rooms-dialog" aria-label="成员管理" @click="onBackdrop" @close="close">
    <div class="rooms-box">
      <div class="rooms-head">
        <h2>成员管理</h2>
        <button class="btn ghost small" type="button" @click="close">关闭</button>
      </div>
      <p class="rooms-status muted" :class="{ bad: failed }">{{ status }}</p>

      <div v-if="data" class="access-body">
        <p class="access-owner">房主：{{ data.owner?.name || '—' }}</p>

        <section class="access-section">
          <h3>现在在厅里</h3>
          <p v-if="!data.seats?.length" class="muted">现在没有人在厅里。</p>
          <div v-for="person in data.seats || []" :key="person.cooId" class="access-row">
            <span class="access-who">
              <strong>{{ person.name || person.cooId }}</strong>
              <small class="muted">{{ label(person.kind) }}<template v-if="person.owner"> · 房主</template><template v-if="person.self"> · 你</template></small>
            </span>
            <button v-if="!person.owner && !person.self" class="btn ghost small" type="button" :disabled="busy" @click="revoke(person, '请出')">请出去</button>
          </div>
          <p class="note">公开/不列目录厅里，请出去的人还能再进来；私密厅移出就是撤销成员资格。</p>
        </section>

        <section class="access-section">
          <h3>成员</h3>
          <p v-if="!data.members?.filter((m) => m.status === 'active').length" class="muted">
            还没有单独授权的人；私密客厅只有房主和被邀请的人能进。
          </p>
          <div v-for="member in data.members?.filter((m) => m.status === 'active') || []" :key="member.cooId" class="access-row">
            <span class="access-who">
              <strong>{{ member.name || member.cooId }}</strong>
              <small class="muted">{{ member.source === 'invite' ? '接受邀请进来的' : '房主授权' }}</small>
            </span>
            <button class="btn ghost small" type="button" :disabled="busy" @click="revoke(member)">移出</button>
          </div>
        </section>

        <section class="access-section">
          <h3>等接受的邀请</h3>
          <p v-if="!data.invitations?.length" class="muted">没有挂着的邀请。</p>
          <div v-for="invitation in data.invitations || []" :key="invitation.targetCooId" class="access-row">
            <span class="access-who">
              <strong>{{ invitation.targetName || invitation.targetCooId }}</strong>
              <small class="muted">到期 {{ dateTimeText(invitation.expiresAt) }}</small>
            </span>
          </div>
        </section>

        <section class="access-section">
          <h3>邀请一个人</h3>
          <div class="access-row">
            <input v-model="inviteName" class="access-input" type="text" maxlength="40" placeholder="对方的席位名或家长名">
            <button class="btn primary small" type="button" :disabled="busy" @click="invite">邀请</button>
          </div>
          <p class="note">只能邀请私密客厅；对方在网页「信箱」里点「接受并进去」。</p>
        </section>

        <section class="access-section">
          <h3>可见性</h3>
          <div class="access-row">
            <select v-model="visibility" class="access-input">
              <option value="public">公开</option>
              <option value="unlisted">不列目录</option>
              <option value="private">私密</option>
            </select>
            <button class="btn primary small" type="button" :disabled="busy" @click="saveVisibility">保存</button>
          </div>
          <p class="note">改成私密不会自动授权现在在厅里的人，要在这里逐个授权或邀请。</p>
        </section>

        <section class="access-section">
          <h3>删除客厅</h3>
          <p class="note">删除后从目录移除，在场席位和未接受的邀请会失效。历史、身份和筹码保留；有未结束牌桌时不能删除。</p>
          <button class="btn ghost small" type="button" :disabled="busy" @click="removeRoom">删除客厅</button>
        </section>
      </div>
    </div>
  </dialog>
</template>
