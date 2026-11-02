<script setup lang="ts">
/** 大厅：谁在、有哪些客厅、开一间。数据来自 /v1/hall 与 /v1/rooms?all=1，SSE 进出会触发刷新。 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AnnouncementBanner from '../components/AnnouncementBanner.vue';
import { api } from '../api/client.ts';
import { createRoomCarousel, type CarouselModel } from '../lib/room-carousel.ts';
import { isFavorite, toggleFavorite } from '../stores/club.ts';
import { sheetOpen } from '../stores/chat.ts';
import { hallSection } from '../stores/hall.ts';
import {
  goRoom, hallError, hallLoaded, hallSeats, loadHall, rooms, snapshot,
} from '../stores/parlor.ts';
import type { RoomCard } from '../api/types.ts';

const section = hallSection;
const filter = ref<'all' | 'ddz' | 'werewolf'>('all');
const query = ref('');
const createName = ref('');
const createVisibility = ref<'public' | 'unlisted' | 'private'>('public');
const creating = ref(false);
const notice = ref('');
const createInputEl = ref<HTMLInputElement | null>(null);

const model = ref<CarouselModel>({ rooms: [], index: 0, current: null, paused: false });
const carousel = createRoomCarousel((next) => { model.value = next; }, {
  paused: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
});
const heroHover = ref(false);
const heroFocus = ref(false);

onMounted(() => {
  void loadHall(true);
  syncActive();
  document.addEventListener('visibilitychange', syncActive);
});

onBeforeUnmount(() => {
  carousel.dispose();
  document.removeEventListener('visibilitychange', syncActive);
});

watch(rooms, (list) => { carousel.setRooms(list); }, { immediate: true });
watch([hallSection, sheetOpen], () => syncActive());
watch([heroHover, heroFocus], () => carousel.setBlocked(heroHover.value || heroFocus.value));

/** 只在大厅发现页、页面在前台、聊天抽屉没拉开时轮播。 */
function syncActive(): void {
  carousel.setActive(hallSection.value === 'all' && !document.hidden && !sheetOpen.value);
}

function heroEnter(): void {
  if (model.value.current) {
    void enter(model.value.current);
    return;
  }
  if (rooms.value.length) document.querySelector('.hall-rooms-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  else createInputEl.value?.focus();
}

/** 大厅里只显示在线的；快照还没到时不筛，免得闪一下空列表。 */
const visibleSeats = computed(() => {
  const ids = snapshot.value?.online;
  if (!Array.isArray(ids)) return hallSeats.value;
  return hallSeats.value.filter((seat) => ids.includes(seat.id));
});

const scopedRooms = computed(() => {
  if (section.value === 'mine') return rooms.value.filter((room) => room.mine);
  if (section.value === 'favorites') return rooms.value.filter((room) => isFavorite(room.id));
  return rooms.value;
});

const filteredRooms = computed(() => {
  const text = query.value.trim().toLocaleLowerCase();
  return scopedRooms.value.filter((room) => {
    if (text && !(room.name + ' ' + (room.topic || '')).toLocaleLowerCase().includes(text)) return false;
    if (filter.value !== 'all') return (room.games || []).includes(filter.value);
    return true;
  });
});

/** 首屏推荐：轮播只挑人数 > 10 的客厅（规则在旧 room-carousel.js 里，单测也在那边）。 */

function initial(name: string): string {
  return (name || '？').trim().slice(0, 1).toUpperCase();
}

function visibilityLabel(room: RoomCard): string {
  return room.visibility === 'public' ? '公开' : room.visibility === 'unlisted' ? '不公开' : '私密';
}

function emptyText(): string {
  if (query.value.trim() || filter.value !== 'all') return '没有找到符合条件的客厅，试试其他关键词或游戏。';
  if (section.value === 'mine') return '你还没有创建或加入客厅，先去发现一间喜欢的吧。';
  if (section.value === 'favorites') return '还没有收藏的客厅。在客厅卡片上点一下星标，下次就能在这里找到。';
  return '还没有客厅，开一间等朋友吧。';
}

function showDiscover(): void {
  hallSection.value = 'all';
}

async function enter(room: RoomCard): Promise<void> {  notice.value = '';
  const moved = await goRoom(room.id);
  if (!moved && hallError.value) notice.value = hallError.value;
}

async function createRoom(): Promise<void> {
  const name = createName.value.trim();
  if (name.length < 2) {
    notice.value = '客厅名字至少两个字';
    return;
  }
  creating.value = true;
  try {
    const created = await api<{ room: { id: string } }>('/v1/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, visibility: createVisibility.value, capacity: 30 }),
    });
    createName.value = '';
    await enter({ id: created.room.id } as RoomCard);
  } catch (error) {
    notice.value = (error as Error).message || '开不了这间客厅';
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="view view-hall">
    <AnnouncementBanner />
    <div class="hall-head">
      <span class="eyebrow">A LITTLE PLAY, A LITTLE COMPANY.</span>
      <h1>今晚，来一局。</h1>
      <p class="muted">找个舒服的位置，和朋友、Coo 一起把时间慢下来。</p>
    </div>

    <section
      v-if="hallSection === 'all'"
      class="club-hero"
      :class="{ 'has-carousel': model.rooms.length > 1 }"
      aria-label="热门客厅推荐"
      aria-roledescription="轮播"
      @mouseenter="heroHover = true"
      @mouseleave="heroHover = false"
      @focusin="heroFocus = true"
      @focusout="heroFocus = false"
    >
      <div class="club-hero-copy">
        <span class="eyebrow">{{ model.current ? '热闹正在发生 / PARLOR CLUB' : '留个位置，慢慢相聚 / PARLOR CLUB' }}</span>
        <h2>{{ model.current?.name || '好朋友，也可以是新朋友。' }}</h2>
        <p>{{ model.current?.topic || '先在客厅聊聊天，再选一张喜欢的桌。人和 Coo，都有自己的座位。' }}</p>
        <p v-if="model.current" class="club-hero-meta">
          {{ model.current.seats }} / {{ model.current.capacity }} 人在客厅 · {{ model.current.tableCount ?? '—' }} 张桌
        </p>
        <button class="btn primary" type="button" @click="heroEnter">
          {{ model.current ? '走进这间客厅 ↗' : rooms.length ? '逛逛客厅 ↘' : '开一间客厅' }}
        </button>
      </div>
      <div class="club-scene is-large" aria-hidden="true">
        <span class="club-orbit">✳</span>
        <div class="club-felt">
          <span v-for="value in ['A♠', 'K♥', 'Q♣']" :key="value" class="club-playing-card">{{ value }}</span>
        </div>
        <span class="club-scene-label">GOOD COMPANY. GREAT HANDS.</span>
      </div>
      <div v-if="model.rooms.length > 1" class="club-carousel-controls">
        <span class="club-carousel-status">{{ model.index + 1 }} / {{ model.rooms.length }} · 每 6 秒轮换</span>
        <button class="btn ghost small" type="button" aria-label="上一个热门客厅" @click="carousel.move(-1)">←</button>
        <div class="club-carousel-dots" aria-label="选择热门客厅">
          <button
            v-for="(room, index) in model.rooms.length <= 7 ? model.rooms : []"
            :key="room.id"
            class="club-carousel-dot"
            type="button"
            :aria-label="'推荐客厅：' + room.name"
            :aria-current="index === model.index ? 'true' : 'false'"
            @click="carousel.select(index)"
          />
        </div>
        <button class="btn ghost small" type="button" aria-label="下一个热门客厅" @click="carousel.move(1)">→</button>
        <button
          class="btn ghost small"
          type="button"
          :aria-label="model.paused ? '开始热门客厅自动轮播' : '暂停热门客厅自动轮播'"
          @click="carousel.setPaused(!model.paused)"
        >{{ model.paused ? '开始轮播' : '暂停轮播' }}</button>
      </div>
    </section>

    <section class="panel hall-rooms">
      <div class="panel-head">
        <h2>{{ section === 'all' ? '客厅' : filteredRooms.length + ' 间客厅' }}</h2>
        <button class="link" type="button" @click="loadHall(true)">刷新</button>
      </div>
      <div class="club-discovery">
        <input v-model="query" class="club-search" type="search" placeholder="搜索客厅名字、话题…" aria-label="搜索客厅">
        <div class="club-filters" aria-label="筛选客厅">
          <button
            v-for="item in [{ id: 'all', label: '全部' }, { id: 'ddz', label: '斗地主' }, { id: 'werewolf', label: '狼人杀' }] as const"
            :key="item.id"
            class="btn ghost small"
            type="button"
            :class="{ 'is-active': filter === item.id }"
            :aria-pressed="filter === item.id"
            @click="filter = item.id"
          >{{ item.label }}</button>
        </div>
      </div>
      <p v-if="notice" class="warn">{{ notice }}</p>
      <p v-if="!hallLoaded" class="muted">正在加载客厅…</p>
      <p v-else-if="hallError && !rooms.length" class="warn">取不到大厅：{{ hallError }}</p>
      <div v-else class="rooms-list hall-rooms-list">
        <div v-if="!filteredRooms.length" class="club-empty">
          <p>{{ emptyText() }}</p>
          <button v-if="section !== 'all'" class="btn ghost small" type="button" @click="showDiscover">去发现客厅 ↗</button>
        </div>
        <article v-for="room in filteredRooms" :key="room.id" class="club-room-card">
          <div class="club-scene" :class="{ 'is-night': (room.games || []).includes('werewolf') }" aria-hidden="true">
            <span class="club-orbit">✳</span>
            <div class="club-felt">
              <span v-for="value in ['A♠', 'K♥', 'Q♣']" :key="value" class="club-playing-card">{{ value }}</span>
            </div>
            <span class="club-scene-label">GOOD COMPANY. GREAT HANDS.</span>
          </div>
          <button
            class="btn ghost small club-favorite"
            type="button"
            :aria-label="(isFavorite(room.id) ? '取消收藏 ' : '收藏 ') + room.name"
            :aria-pressed="isFavorite(room.id)"
            @click="toggleFavorite(room.id)"
          >{{ isFavorite(room.id) ? '★' : '☆' }}</button>
          <div class="club-room-copy">
            <span class="eyebrow">{{ visibilityLabel(room) }}客厅</span>
            <h3>{{ room.name }}</h3>
            <p>{{ room.topic || '牌可以慢慢打，话也可以慢慢聊。' }}</p>
            <div class="club-room-foot">
              <span>{{ room.seats }} / {{ room.capacity }} 人 · {{ room.tableCount ?? '—' }} 桌</span>
              <button class="btn ghost small" type="button" @click="enter(room)">进客厅 ↗</button>
            </div>
          </div>
        </article>
      </div>
      <p class="muted hall-note">公开客厅谁都能进；不公开的要先被邀请。</p>
    </section>

    <section class="panel hall-people">
      <div class="panel-head">
        <h2>大厅里</h2>
        <span class="muted">{{ visibleSeats.length }} 人</span>
      </div>
      <div class="member-row">
        <p v-if="!visibleSeats.length" class="muted">大厅里现在没有在线的人。</p>
        <span v-for="person in visibleSeats" :key="person.id" class="member-chip">
          <span class="avatar avatar-xs">{{ initial(person.name) }}</span>
          <span>
            <strong>{{ person.name }}<template v-if="snapshot?.seat && person.id === snapshot.seat.id">（你）</template></strong>
            <small>{{ person.kind }}<template v-if="person.handle"> · #{{ person.handle }}</template></small>
          </span>
          <span v-if="person.kind === 'pet'" class="tag tag-coo">Coo</span>
        </span>
      </div>
      <p class="muted hall-note">在别的客厅里的人不在这里显示；离线的不显示。</p>
    </section>

    <section v-if="section !== 'favorites'" class="panel hall-create">
      <h2>开一间新的</h2>
      <div class="hall-create-row">
        <input ref="createInputEl" v-model="createName" type="text" maxlength="32" placeholder="客厅名字（2–32 个字）" aria-label="新客厅名字">
        <select v-model="createVisibility" aria-label="客厅可见性">
          <option value="public">公开</option>
          <option value="unlisted">不公开</option>
          <option value="private">私密</option>
        </select>
        <span class="muted">固定 30 人</span>
        <button class="btn primary small" type="button" :disabled="creating" @click="createRoom">开一间</button>
      </div>
      <p class="muted hall-note">公开的客厅会出现在别人的目录里；不公开的只有成员看得到。</p>
    </section>
  </div>
</template>
