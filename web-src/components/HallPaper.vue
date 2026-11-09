<script setup lang="ts">
/**
 * 会馆小报：首屏茶馆与客厅目录之间的一屏，左边每日新闻、右边公告栏。
 * 新闻一天一版，正文点开才取；公告只摆最近 6 条，更早的去 /support 看。
 * 两边都没内容时整段不渲染，别留一屏空白。
 */
import { computed, onMounted, ref } from 'vue';
import { dateTimeText } from '../lib/text.ts';
import { items as notices } from '../stores/announcements.ts';
import { items as news, loaded as newsLoaded, loadBody, loadNews } from '../stores/news.ts';
import type { NewsItem, NewsSummary } from '../stores/news.ts';

const expanded = ref('');
const body = ref<NewsItem | null>(null);
const bodyError = ref('');
const bodyLoading = ref(false);

/* 公告接口最多给 50 条，小报只摆最近 6 条；剩下的留在 /support 的公告区。 */
const latestNotices = computed(() => notices.value.slice(0, 6));
/* 等第一次列表请求落地再判断，免得「先空一屏、数据到了突然长出来」。 */
const show = computed(() => newsLoaded.value && (news.value.length > 0 || notices.value.length > 0));

onMounted(() => { void loadNews(); });

/** 「今天 / 昨天」按北京时间比字符串，不把 issueDate 丢给 Date 解析，免得差一天。 */
function issueLabel(date: string): string {
  const now = Date.now() + 8 * 3_600_000;
  const today = new Date(now).toISOString().slice(0, 10);
  const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
  if (date === today) return '今天';
  if (date === yesterday) return '昨天';
  const [, month, day] = date.split('-');
  return Number(month) + ' 月 ' + Number(day) + ' 日';
}

function paragraphs(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function toggle(item: NewsSummary): Promise<void> {
  if (expanded.value === item.id) { expanded.value = ''; return; }
  expanded.value = item.id;
  body.value = null;
  bodyError.value = '';
  bodyLoading.value = true;
  try {
    const full = await loadBody(item.id);
    // 等全文的时候可能又点开了别的一期，晚到的结果不该盖上去。
    if (expanded.value !== item.id) return;
    if (full) body.value = full;
    else bodyError.value = '这一期还没发出来，过会儿再看。';
  } catch (error) {
    if (expanded.value === item.id) bodyError.value = (error as Error).message || '取不到全文';
  } finally {
    if (expanded.value === item.id) bodyLoading.value = false;
  }
}

/** 失败后重来：先收掉再走一次 toggle，复用同一段加载逻辑。 */
function retry(item: NewsSummary): void {
  expanded.value = '';
  void toggle(item);
}
</script>

<template>
  <section v-if="show" id="hall-news" class="hall-paper" aria-label="每日新闻与公告">
    <header class="paper-head">
      <p class="eyebrow">THE PARLOR TIMES · 会馆小报</p>
      <h2>今天的一页，贴在门口。</h2>
      <p class="paper-sub">新闻一天一版，公告是运营随手贴的条子。都不打扰你——想看的时候往下滚一屏。</p>
    </header>

    <div class="paper-grid">
      <section class="paper-col news-col" aria-label="每日新闻">
        <div class="paper-col-head">
          <h3>每日新闻</h3>
          <span class="directory-count">{{ news.length }} 期</span>
        </div>
        <p v-if="!news.length" class="muted paper-empty">还没有发过新闻。</p>
        <ol v-else class="news-list">
          <li
            v-for="item in news"
            :key="item.id"
            class="news-item"
            :class="{ 'is-open': expanded === item.id }"
          >
            <button
              class="news-head"
              type="button"
              :aria-expanded="expanded === item.id"
              @click="toggle(item)"
            >
              <span class="news-date">{{ issueLabel(item.issueDate) }}</span>
              <span class="news-title">{{ item.title }}</span>
              <span class="news-caret">{{ expanded === item.id ? '收起' : '读全文' }}</span>
            </button>
            <p class="news-summary">{{ item.summary }}</p>

            <div v-if="expanded === item.id" class="news-body">
              <p v-if="bodyLoading" class="muted">正在取全文…</p>
              <template v-else-if="body">
                <p v-for="(line, index) in paragraphs(body.body)" :key="index">{{ line }}</p>
              </template>
              <p v-else class="news-body-error">
                {{ bodyError }}
                <button class="news-retry" type="button" @click="retry(item)">再试一次</button>
              </p>
            </div>
          </li>
        </ol>
      </section>

      <aside class="paper-col notice-col" aria-label="公告栏">
        <div class="paper-col-head">
          <h3>公告栏</h3>
          <span class="directory-count">{{ latestNotices.length }} 条</span>
        </div>
        <p v-if="!latestNotices.length" class="muted paper-empty">门口暂时没贴新条子。</p>
        <ol v-else class="notice-list">
          <li v-for="item in latestNotices" :key="item.id" class="notice-item">
            <span class="notice-time">{{ dateTimeText(Number(item.created_at)) }}</span>
            <p class="notice-text">{{ item.text }}</p>
          </li>
        </ol>
        <a class="paper-more" href="/support" target="_blank" rel="noopener">
          更早的公告与反馈 <span aria-hidden="true">↗</span>
        </a>
      </aside>
    </div>
  </section>
</template>
