<script setup lang="ts">
/** 大厅：会馆首屏（B 版：一整间房间）+ 客厅目录海报墙（A 版）。数据仍来自 /v1/hall 与 /v1/rooms。 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AnnouncementBanner from '../components/AnnouncementBanner.vue';
import { api } from '../api/client.ts';
import { createRoomCarousel, type CarouselModel } from '../lib/room-carousel.ts';
import { ROOM_CAPACITY, createRoomBody } from '../lib/rooms.ts';
import { isFavorite, toggleFavorite } from '../stores/club.ts';
import { sheetOpen } from '../stores/chat.ts';
import { hallSection } from '../stores/hall.ts';
import {
  goRoom, hallError, hallLoaded, hallSeats, loadHall, refreshSnapshot, rooms, snapshot,
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
const directoryEl = ref<HTMLElement | null>(null);

const model = ref<CarouselModel>({ rooms: [], index: 0, current: null, paused: false });
const carousel = createRoomCarousel((next) => { model.value = next; }, {
  paused: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
});
const heroHover = ref(false);
const heroFocus = ref(false);
let pulse: number | undefined;

onMounted(() => {
  void loadHall(true);
  syncActive();
  document.addEventListener('visibilitychange', syncActive);
  // 掉线不发事件：停在大厅时每 20 秒连快照一起刷，在线名单才不会停在旧值。
  pulse = window.setInterval(() => {
    if (document.hidden) return;
    void loadHall(true);
    void refreshSnapshot().catch(() => {});
  }, 20_000);
});

onBeforeUnmount(() => {
  carousel.dispose();
  window.clearInterval(pulse);
  document.removeEventListener('visibilitychange', syncActive);
});

watch(rooms, (list) => { carousel.setRooms(list); }, { immediate: true });
watch([hallSection, sheetOpen], () => syncActive());
watch([heroHover, heroFocus], () => carousel.setBlocked(heroHover.value || heroFocus.value));
// 换了范围就把搜索和游戏筛选清掉，和旧版一样从整份目录重新看。
watch(hallSection, () => { query.value = ''; filter.value = 'all'; });

/** 只在大厅发现页、页面在前台、聊天抽屉没拉开时轮播。 */
function syncActive(): void {
  carousel.setActive(hallSection.value === 'all' && !document.hidden && !sheetOpen.value);
}

/** 首屏底部那排：热门客厅优先（人数 > 10 的轮播池），没有热门就取目录前几间。 */
const topRooms = computed(() => (model.value.rooms.length ? model.value.rooms : rooms.value).slice(0, 3));

/** 海报画：狼人杀月色、斗地主牌扇、其余骰子。 */
function artFor(room: RoomCard): string {
  const games = room.games || [];
  if (games.includes('werewolf')) return 'art-moon';
  if (games.includes('ddz')) return 'art-cards';
  return 'art-dice';
}

function isLive(room: RoomCard): boolean {
  return (room.tableCount || 0) > 0;
}

function scrollToRooms(): void {
  directoryEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function heroEnter(): void {
  if (model.value.current) {
    void enter(model.value.current);
    return;
  }
  if (rooms.value.length) scrollToRooms();
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

function initial(name: string): string {
  return (name || '？').trim().slice(0, 1).toUpperCase();
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

async function enter(room: RoomCard): Promise<void> {
  notice.value = '';
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
      body: JSON.stringify(createRoomBody(name, createVisibility.value)),
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

    <section
      class="hero"
      aria-label="会馆首屏"
      @mouseenter="heroHover = true"
      @mouseleave="heroHover = false"
      @focusin="heroFocus = true"
      @focusout="heroFocus = false"
    >
      <div class="hero-copy">
        <p class="eyebrow">A LITTLE PLAY, A LITTLE COMPANY.</p>
        <h1>
          <template v-if="section === 'all'">今晚，<br>来一局。<span class="spark">✳</span></template>
          <template v-else-if="section === 'mine'">我的客厅。</template>
          <template v-else>收藏的地方。</template>
        </h1>
        <p class="hero-sub">
          <template v-if="section === 'all'">会馆里灯亮着，牌已经洗好。找个位置坐下，和朋友、Coo 一起把时间慢下来。</template>
          <template v-else-if="section === 'mine'">你创建或加入的客厅都在这里。坐下就好，位置一直给你留着。</template>
          <template v-else>点过星标的客厅都在这里。想去哪儿，先来这儿看看。</template>
        </p>
        <div class="hero-actions">
          <button class="cta" type="button" @click="heroEnter">
            {{ model.current && section === 'all' ? '走进这间客厅' : rooms.length ? '逛逛客厅' : '开一间客厅' }}
            <span class="cta-arrow">↗</span>
          </button>
          <button class="ghost-link" type="button" @click="scrollToRooms">逛逛其他客厅 ↓</button>
        </div>

        <div v-if="model.current && section === 'all'" class="hero-now">
          <span class="hero-now-kicker"><i class="dot" />热闹正在发生 / PARLOR CLUB</span>
          <div class="hero-now-row">
            <div class="hero-now-main">
              <h2>{{ model.current.name }}</h2>
              <p>{{ model.current.topic || '先在客厅聊聊天，再选一张喜欢的桌。' }}</p>
              <p class="hero-now-meta">
                <b>{{ model.current.seats }}</b> / {{ model.current.capacity }} 人在客厅
                <span>·</span>
                <b>{{ model.current.tableCount ?? '—' }}</b> 张桌
              </p>
            </div>
            <div v-if="model.rooms.length > 1" class="hero-carousel">
              <button class="car-btn" type="button" aria-label="上一个热门客厅" @click="carousel.move(-1)">←</button>
              <span class="car-count">{{ model.index + 1 }} / {{ model.rooms.length }}</span>
              <span class="car-dots">
                <button
                  v-for="(room, index) in model.rooms.length <= 7 ? model.rooms : []"
                  :key="room.id"
                  class="car-dot"
                  type="button"
                  :class="{ 'is-on': index === model.index }"
                  :aria-label="'推荐客厅：' + room.name"
                  :aria-current="index === model.index ? 'true' : 'false'"
                  @click="carousel.select(index)"
                />
              </span>
              <button class="car-btn" type="button" aria-label="下一个热门客厅" @click="carousel.move(1)">→</button>
              <button
                class="car-pause"
                type="button"
                :aria-label="model.paused ? '开始轮播' : '暂停轮播'"
                @click="carousel.setPaused(!model.paused)"
              >{{ model.paused ? '▶' : 'Ⅱ' }}</button>
            </div>
          </div>
        </div>
      </div>

      <div class="scene" aria-hidden="true">
        <span class="scene-lamp" />
        <span class="spark spark-a">✳</span>
        <span class="spark spark-b">✳</span>
        <span class="spark spark-c">✳</span>
        <div class="scene-table">
          <div class="scene-felt"><span class="scene-felt-mark">GOOD COMPANY · GREAT HANDS</span></div>
          <div class="scene-seat seat-a" />
          <div class="scene-seat seat-b" />
          <div class="scene-cards">
            <span class="scard black">A<span>♠</span></span>
            <span class="scard red">K<span>♥</span></span>
            <span class="scard black">Q<span>♣</span></span>
          </div>
        </div>
        <span class="scene-caption">THE PARLOR SESSIONS · VOL. 03</span>
      </div>

      <div v-if="section === 'all'" class="hero-chips">
        <p class="hero-chips-label">今晚有人的客厅 <b>{{ topRooms.length }}</b> 间</p>
        <button v-for="room in topRooms" :key="room.id" class="rchip" type="button" @click="enter(room)">
          <span class="rchip-top">
            <i class="dot" :class="{ live: isLive(room) }" />{{ isLive(room) ? '正在对局' : '等你入座' }}
          </span>
          <span class="rchip-name">{{ room.name }}</span>
          <span class="rchip-meta">
            <b>{{ room.seats }}</b> / {{ room.capacity }} 人
            <span>·</span>
            <b>{{ room.tableCount ?? '—' }}</b> 张桌
          </span>
        </button>
        <button class="rchip all" type="button" @click="scrollToRooms">全部客厅 ↓</button>
      </div>
    </section>

    <section ref="directoryEl" class="directory hall-rooms" :aria-label="section === 'all' ? '全部客厅' : '我的客厅'">
      <header class="directory-head">
        <h2>{{ section === 'all' ? '全部客厅' : section === 'mine' ? '我的客厅' : '收藏的地方' }}</h2>
        <span class="directory-count">{{ filteredRooms.length }} 间</span>
        <div class="directory-tools">
          <input v-model="query" class="search" type="search" placeholder="搜客厅名字、话题…" aria-label="搜索客厅">
          <div class="filters" aria-label="筛选客厅">
            <button
              v-for="item in [{ id: 'all', label: '全部' }, { id: 'ddz', label: '斗地主' }, { id: 'werewolf', label: '狼人杀' }] as const"
              :key="item.id"
              class="filter"
              type="button"
              :class="{ 'is-on': filter === item.id }"
              :aria-pressed="filter === item.id"
              @click="filter = item.id"
            >{{ item.label }}</button>
          </div>
          <button class="refresh" type="button" @click="loadHall(true)">刷新</button>
        </div>
      </header>

      <p v-if="notice" class="warn">{{ notice }}</p>
      <p v-if="!hallLoaded" class="muted hall-note">正在加载客厅…</p>
      <p v-else-if="hallError && !rooms.length" class="warn hall-note">取不到大厅：{{ hallError }}</p>
      <div v-else class="posters hall-rooms-list">
        <div v-if="!filteredRooms.length" class="club-empty">
          <p>{{ emptyText() }}</p>
          <button v-if="section !== 'all'" class="btn ghost small" type="button" @click="showDiscover">去发现客厅 ↗</button>
        </div>
        <article v-for="room in filteredRooms" :key="room.id" class="poster club-room-card">
          <div class="poster-art" :class="artFor(room)">
            <span class="chip" :class="{ live: isLive(room) }">
              <i class="dot" :class="{ live: isLive(room) }" />{{ isLive(room) ? '正在对局' : '等你入座' }}
            </span>
            <button
              class="poster-fav club-favorite"
              type="button"
              :aria-label="(isFavorite(room.id) ? '取消收藏 ' : '收藏 ') + room.name"
              :aria-pressed="isFavorite(room.id)"
              @click.stop="toggleFavorite(room.id)"
            >{{ isFavorite(room.id) ? '★' : '☆' }}</button>
            <span class="poster-motif">
              <template v-if="artFor(room) === 'art-cards'"><i>A♠</i><i>K♥</i><i>Q♣</i></template>
              <template v-else-if="artFor(room) === 'art-moon'"><i class="moon-disc" /></template>
              <template v-else><i class="die one" /><i class="die two" /></template>
            </span>
          </div>
          <div class="poster-body">
            <h3>{{ room.name }}</h3>
            <p>{{ room.topic || '牌可以慢慢打，话也可以慢慢聊。' }}</p>
            <div class="poster-foot">
              <span><b>{{ room.seats }}</b> / {{ room.capacity }} 人</span>
              <span>·</span>
              <span><b>{{ room.tableCount ?? '—' }}</b> 张桌</span>
              <span class="poster-go">{{ room.visibility === 'public' ? '进客厅' : '成员可见' }} ↗</span>
            </div>
          </div>
        </article>
      </div>
      <p class="muted hall-note">公开客厅谁都能进；不公开的要先被邀请。</p>
    </section>

    <section v-if="section === 'all'" class="people">
      <div class="people-head">
        <h2>大厅里</h2>
        <span class="directory-count">{{ visibleSeats.length }} 人</span>
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
    </section>

    <section v-if="section !== 'favorites'" class="create hall-create">
      <h2>开一间新的</h2>
      <div class="hall-create-row">
        <input ref="createInputEl" v-model="createName" type="text" maxlength="32" placeholder="客厅名字（2–32 个字）" aria-label="新客厅名字">
        <select v-model="createVisibility" aria-label="客厅可见性">
          <option value="public">公开</option>
          <option value="unlisted">不公开</option>
          <option value="private">私密</option>
        </select>
        <span class="muted">固定 {{ ROOM_CAPACITY }} 人</span>
        <button class="btn primary small" type="button" :disabled="creating" @click="createRoom">开一间</button>
      </div>
      <p class="muted hall-note">公开的客厅会出现在别人的目录里；不公开的只有成员看得到。</p>
    </section>
  </div>
</template>
