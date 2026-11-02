<script setup lang="ts">
/** 换客厅：列出目录里的客厅，点一间就换过去（旧版顶栏房卡的同一条路）。 */
import { computed, ref, watch } from 'vue';
import type { RoomCard } from '../api/types.ts';
import { goRoom, hallError, loadHall, rooms, snapshot } from '../stores/parlor.ts';
import { seat } from '../stores/session.ts';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ 'update:open': [boolean] }>();

const dialog = ref<HTMLDialogElement | null>(null);
const loading = ref(false);
const failed = ref('');
const busyId = ref('');

const current = computed(() => seat.value?.room || '');
const currentName = computed(() => (current.value === 'hall' ? '大厅' : snapshot.value?.name || '客厅'));
const list = computed(() => rooms.value.filter((room) => room.id !== current.value));

watch(() => props.open, (open) => {
  if (open) {
    show();
    void refresh();
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

async function refresh(): Promise<void> {
  loading.value = true;
  failed.value = '';
  try {
    await loadHall(true);
    if (hallError.value) failed.value = hallError.value;
  } finally {
    loading.value = false;
  }
}

async function enter(room: RoomCard): Promise<void> {
  if (busyId.value) return;
  busyId.value = room.id;
  failed.value = '';
  try {
    const moved = await goRoom(room.id);
    if (moved) close();
    else failed.value = hallError.value || '换不了这间客厅';
  } finally {
    busyId.value = '';
  }
}
</script>

<template>
  <dialog ref="dialog" class="rooms-dialog" aria-label="换客厅" @click="onBackdrop" @close="close">
    <div class="rooms-box">
      <div class="rooms-head">
        <h2>换客厅</h2>
        <button class="btn ghost small" type="button" @click="close">关闭</button>
      </div>
      <p v-if="loading" class="rooms-status muted">正在取大厅目录…</p>
      <p v-else-if="failed" class="rooms-status bad">{{ failed }}</p>
      <div v-else class="access-body">
        <p class="access-owner">你现在在：{{ currentName }}</p>
        <p v-if="!list.length" class="muted">目录里还没有别的客厅。先回大厅开一间。</p>
        <section v-else class="access-section">
          <h3>可去的客厅</h3>
          <div v-for="room in list" :key="room.id" class="access-row">
            <span class="access-who">
              <strong>{{ room.name }}</strong>
              <small>{{ room.seats }} / {{ room.capacity }} 人 · {{ room.topic || '想玩就坐下来' }}</small>
            </span>
            <button class="btn ghost small" type="button" :disabled="!!busyId" @click="enter(room)">
              {{ busyId === room.id ? '正在换…' : '进去' }}
            </button>
          </div>
        </section>
      </div>
    </div>
  </dialog>
</template>
