<script setup lang="ts">
/** 大厅：发现是「舞台 + 海报墙」；我的客厅是个人席位墙；收藏是书签清单。数据仍来自 /v1/hall 与 /v1/rooms。 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AnnouncementBanner from '../components/AnnouncementBanner.vue';
import HallPaper from '../components/HallPaper.vue';
import LobbyMatching from '../components/LobbyMatching.vue';
import LobbyScene from '../components/LobbyScene.vue';
import { api } from '../api/client.ts';
import { createRoomCarousel, type CarouselModel } from '../lib/room-carousel.ts';
import { gameLabel } from '../lib/games.ts';
import { ROOM_CAPACITY, createRoomBody } from '../lib/rooms.ts';
import { isFavorite, toggleFavorite } from '../stores/club.ts';
import { sheetOpen } from '../stores/chat.ts';
import { hallSection } from '../stores/hall.ts';
import {
  goRoom, hallError, hallLoaded, hallSeats, loadHall, refreshSnapshot, rooms, snapshot,
} from '../stores/parlor.ts';
import type { RoomCard } from '../api/types.ts';

const section = hallSection;
const filter = ref('all');
const gameFilters = [
  { id: 'all', label: '全部' },
  ...['ddz', 'werewolf', 'gomoku', 'xiangqi', 'monopoly2d'].map(id => ({ id, label: gameLabel(id) })),
];
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
/* 背景是固定定位的，滚到目录它还在视口里；这里按首屏滚过去没有，决定要不要继续画。 */
const pastHero = ref(false);
let stageEl: HTMLElement | null = null;
let pulse: number | undefined;

/** 首屏滚过去（约一屏高）就停下那间茶馆，省电；滚回来接着跑。 */
function onScroll(): void {
  if (!stageEl) return;
  pastHero.value = stageEl.scrollTop > window.innerHeight * 0.92;
}

onMounted(() => {
  void loadHall(true);
  syncActive();
  stageEl = document.querySelector('.stage-body');
  stageEl?.addEventListener('scroll', onScroll, { passive: true });
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
  stageEl?.removeEventListener('scroll', onScroll);
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

function visibilityLabel(room: RoomCard): string {
  return room.visibility === 'public' ? '公开' : room.visibility === 'unlisted' ? '不公开' : '私密';
}

function scrollToRooms(): void {
  if (section.value !== 'all') {
    hallSection.value = 'all';
    return;
  }
  directoryEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 首屏那条「今日新闻与公告」：小报没渲染（两边都空）就直接去看客厅。 */
function scrollToNews(): void {
  const band = document.getElementById('hall-news');
  if (band) band.scrollIntoView({ behavior: 'smooth', block: 'start' });
  else scrollToRooms();
}

/** 「开一间」的空位：滚到表单并聚焦。 */
function focusCreate(): void {
  createInputEl.value?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  createInputEl.value?.focus();
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
  <div class="view view-hall" :class="'section-' + section">
    <!-- 大厅的底：一间真的在动的茶馆，铺满整个界面当背景。
         固定定位 + cover，跟着滚动不动，所以往下翻目录时它一直在；
         文案和告示牌浮在上面（见 night.css 的 .hall-bg / .hero）。
         画法在 lobby/scene.js，组件是 components/LobbyScene.vue。 -->
    <div v-if="section === 'all'" class="hall-bg" aria-hidden="true">
      <LobbyScene fill :paused="pastHero" />
      <span class="hall-bg-mark">鲸语茶室 · 今夜营业</span>
    </div>

    <AnnouncementBanner />

    <!-- ═════════ 发现：舞台 ═════════ -->
    <template v-if="section === 'all'">
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
          <h1>今晚，<br>来一局。<span class="spark">✳</span></h1>
          <p class="hero-sub"><span>会馆里灯亮着，牌已经洗好。</span><span>找个位置坐下，和朋友、Coo 一起把时间慢下来。</span></p>

          <div v-if="!model.current" class="hero-actions">
            <button class="cta" type="button" @click="heroEnter">
              {{ rooms.length ? '逛逛客厅' : '开一间客厅' }}<span class="cta-arrow">↗</span>
            </button>
            <button v-if="rooms.length" class="ghost-link" type="button" @click="scrollToRooms">看看有哪些客厅 ↓</button>
            <button class="ghost-link" type="button" @click="scrollToNews">今日新闻与公告 ↓</button>
          </div>
        </div>

        <!-- 底角那一排：左「推荐客厅」、右「找一桌」。
             两块牌子各坐一个角，中间那片屋子完整露出来 ——
             原先「找一桌」挂在右栏正中，正好压住茶柜。 -->
        <div class="hero-dock">
          <div v-if="model.current" class="hero-now">
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
            <div class="hero-actions hero-actions-inline">
              <button class="cta" type="button" @click="enter(model.current)">
                走进「{{ model.current.name }}」<span class="cta-arrow">↗</span>
              </button>
              <button class="ghost-link" type="button" @click="scrollToRooms">逛逛其他客厅 ↓</button>
              <button class="ghost-link" type="button" @click="scrollToNews">今日新闻与公告 ↓</button>
            </div>
          </div>

          <div class="hero-side">
            <LobbyMatching />
          </div>
        </div>
      </section>

      <!-- 画面到此为止：下面这些纸面内容用实底接住，滚动时不会跟背景打架。 -->
      <div class="hall-floor">
        <!-- 首屏与目录之间：每日新闻 + 公告栏，往下滚一屏就到。 -->
        <HallPaper />

        <section id="hall-rooms" ref="directoryEl" class="directory hall-rooms" aria-label="全部客厅">
          <header class="directory-head">
            <h2>全部客厅</h2>
            <span class="directory-count">{{ filteredRooms.length }} 间</span>
            <div class="directory-tools">
              <input v-model="query" class="search" type="search" placeholder="搜客厅名字、话题…" aria-label="搜索客厅">
              <div class="filters" aria-label="筛选客厅">
                <button
                  v-for="item in gameFilters"
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
              <button class="btn ghost small" type="button" @click="showDiscover">去发现客厅 ↗</button>
            </div>
            <article v-for="room in filteredRooms" :key="room.id" class="poster club-room-card" @click="enter(room)">
              <div class="poster-art" :class="artFor(room)">
                <span class="poster-chip" :class="{ live: isLive(room) }">
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
                  <button class="poster-go" type="button" :aria-label="'进入客厅 ' + room.name" @click.stop="enter(room)">{{ visibilityLabel(room) }} · 进客厅 ↗</button>
                </div>
              </div>
            </article>
          </div>
          <p class="muted hall-note">公开客厅谁都能进；不公开的要先被邀请。</p>
        </section>

        <section class="people">
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

        <section class="create hall-create">
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

    <!-- ═════════ 我的客厅：个人席位墙 ═════════ -->
    <template v-else-if="section === 'mine'">
      <header class="section-head">
        <p class="eyebrow">MY PARLOR · 我的客厅</p>
        <h1>你的位子，一直留着。</h1>
        <p class="section-sub">你创建或加入的客厅都在这里。坐下就好，位置一直给你保留着。</p>
        <div class="section-tools">
          <input v-model="query" class="search" type="search" placeholder="在我的客厅里找…" aria-label="搜索我的客厅">
          <button class="refresh" type="button" @click="loadHall(true)">刷新</button>
        </div>
      </header>

      <p v-if="notice" class="warn">{{ notice }}</p>

      <div v-if="filteredRooms.length" class="mine-grid">
        <article v-for="room in filteredRooms" :key="room.id" class="mine-card">
          <div class="poster-art" :class="artFor(room)">
            <span class="poster-chip" :class="{ live: isLive(room) }">
              <i class="dot" :class="{ live: isLive(room) }" />{{ isLive(room) ? '正在对局' : '等你入座' }}
            </span>
            <span class="poster-motif">
              <template v-if="artFor(room) === 'art-cards'"><i>A♠</i><i>K♥</i><i>Q♣</i></template>
              <template v-else-if="artFor(room) === 'art-moon'"><i class="moon-disc" /></template>
              <template v-else><i class="die one" /><i class="die two" /></template>
            </span>
          </div>
          <div class="mine-copy">
            <div class="mine-title">
              <h3>{{ room.name }}</h3>
              <span class="mine-tag">{{ visibilityLabel(room) }}</span>
            </div>
            <p>{{ room.topic || '牌可以慢慢打，话也可以慢慢聊。' }}</p>
            <div class="mine-meta">
              <span><b>{{ room.seats }}</b> / {{ room.capacity }} 人</span>
              <span>·</span>
              <span><b>{{ room.tableCount ?? '—' }}</b> 张桌</span>
            </div>
            <div class="mine-actions">
              <button class="btn primary small" type="button" @click="enter(room)">进客厅 ↗</button>
              <button class="ghost-link" type="button" @click="toggleFavorite(room.id)">
                {{ isFavorite(room.id) ? '★ 已收藏' : '☆ 收藏' }}
              </button>
            </div>
          </div>
        </article>

        <button class="mine-card add" type="button" @click="focusCreate">
          <span class="add-plus">＋</span>
          <span class="add-title">开一间新的客厅</span>
          <span class="add-sub">起个名字，等朋友来坐</span>
        </button>
      </div>

      <div v-else class="empty-stage">
        <div class="empty-art mine-art" aria-hidden="true">
          <span class="empty-orbit">✳</span>
          <span class="empty-chair" />
          <span class="empty-dash" />
        </div>
        <h2>还没有属于你的客厅</h2>
        <p>去发现一间喜欢的，或者自己开一间——名字、话题和第一张桌子都由你定。</p>
        <div class="empty-actions">
          <button class="btn primary" type="button" @click="showDiscover">去发现一间</button>
          <button class="btn ghost" type="button" @click="focusCreate">开一间</button>
        </div>
      </div>

      <section class="create hall-create">
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
      </section>
    </template>

    <!-- ═════════ 收藏：书签清单 ═════════ -->
    <template v-else>
      <header class="section-head">
        <p class="eyebrow">SAVED PLACES · 收藏的地方</p>
        <h1>收着的几间客厅。</h1>
        <p class="section-sub">点过星标的客厅都在这里，想回去的时候不用再翻目录。</p>
        <div class="section-tools">
          <input v-model="query" class="search" type="search" placeholder="在收藏里找…" aria-label="搜索收藏的客厅">
          <button class="refresh" type="button" @click="loadHall(true)">刷新</button>
        </div>
      </header>

      <div v-if="filteredRooms.length" class="fav-list">
        <article v-for="room in filteredRooms" :key="room.id" class="fav-row">
          <div class="fav-thumb" :class="artFor(room)" aria-hidden="true">
            <span class="poster-motif">
              <template v-if="artFor(room) === 'art-cards'"><i>A♠</i><i>K♥</i><i>Q♣</i></template>
              <template v-else-if="artFor(room) === 'art-moon'"><i class="moon-disc" /></template>
              <template v-else><i class="die one" /><i class="die two" /></template>
            </span>
          </div>
          <div class="fav-copy">
            <h3>{{ room.name }}</h3>
            <p>{{ room.topic || '牌可以慢慢打，话也可以慢慢聊。' }}</p>
            <div class="fav-meta">
              <span>{{ visibilityLabel(room) }}客厅</span>
              <span>·</span>
              <span><b>{{ room.seats }}</b> / {{ room.capacity }} 人</span>
              <span>·</span>
              <span><b>{{ room.tableCount ?? '—' }}</b> 张桌</span>
            </div>
          </div>
          <button class="fav-star" type="button" title="取消收藏" @click="toggleFavorite(room.id)">★</button>
          <button class="btn primary small" type="button" @click="enter(room)">进去 ↗</button>
        </article>
      </div>

      <div v-else class="empty-stage">
        <div class="empty-art fav-art" aria-hidden="true">
          <span class="empty-frame">☆</span>
          <span class="empty-orbit fav">✳</span>
        </div>
        <h2>{{ query.trim() ? '收藏里没有这间' : '还没有收藏的地方' }}</h2>
        <p>{{ query.trim() ? '换个名字试试，或者回发现页重新逛逛。' : '在客厅卡片右上角点一下星标，下次想回来的时候就能在这里找到。' }}</p>
        <div class="empty-actions">
          <button class="btn primary" type="button" @click="showDiscover">去发现客厅</button>
        </div>
      </div>
    </template>
  </div>
</template>
