<script setup lang="ts">
/** 首屏公告横幅：有新公告才出现，一句话 + 查看详情 + 知道了。 */
import { computed, nextTick } from 'vue';
import Icon from './Icon.vue';
import { excerptOf } from '../lib/announcement-rules.ts';
import { current, dismissAll } from '../stores/announcements.ts';
import { hallSection } from '../stores/hall.ts';

const text = computed(() => {
  const item = current.value;
  if (!item) return '';
  const body = excerptOf(item.text);
  return body ? '运营公告：' + body : '运营发了一条新公告。';
});

/**
 * 「查看详情」先滚到大厅里那条小报（首屏与目录之间）。
 * 小报在别的分栏、或两边都没内容时没渲染，就把这次点击交回给链接，照旧去 /support。
 */
function onDetail(event: MouseEvent): void {
  // 中键与修饰键是「开新标签/新窗口」的意思，不拦。
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const here = document.getElementById('hall-news');
  if (here) {
    event.preventDefault();
    here.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (hallSection.value !== 'all') {
    // 默认行为必须在这里同步拦下：等 nextTick 再 preventDefault 就晚了。
    event.preventDefault();
    hallSection.value = 'all';
    void nextTick().then(() => {
      document.getElementById('hall-news')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}
</script>

<template>
  <aside v-if="current" class="announce-banner" aria-live="polite" :title="current.text">
    <span class="announce-mark"><Icon name="mail" /></span>
    <p class="announce-text">{{ text }}</p>
    <a class="announce-link" href="/support" target="_blank" rel="noopener" @click="onDetail">查看详情</a>
    <button class="btn ghost small announce-dismiss" type="button" @click="dismissAll">知道了</button>
  </aside>
</template>
