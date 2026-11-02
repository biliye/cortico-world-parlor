<script setup lang="ts">
/** 首屏公告横幅：有新公告才出现，一句话 + 查看详情 + 知道了。 */
import { computed } from 'vue';
import Icon from './Icon.vue';
import { excerptOf } from '../lib/announcement-rules.ts';
import { current, dismissAll } from '../stores/announcements.ts';

const text = computed(() => {
  const item = current.value;
  if (!item) return '';
  const body = excerptOf(item.text);
  return body ? '运营公告：' + body : '运营发了一条新公告。';
});
</script>

<template>
  <aside v-if="current" class="announce-banner" aria-live="polite" :title="current.text">
    <span class="announce-mark"><Icon name="mail" /></span>
    <p class="announce-text">{{ text }}</p>
    <a class="announce-link" href="/support" target="_blank" rel="noopener">查看详情</a>
    <button class="btn ghost small announce-dismiss" type="button" @click="dismissAll">知道了</button>
  </aside>
</template>
