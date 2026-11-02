<script setup lang="ts">
/**
 * 外观按钮：点一下就切，不再展开下拉选单。
 *
 * 整颗按钮（太阳/月亮图标、文字、留白）都可点；顶条和加入页共用，
 * 手机窄屏只留图标时同样能点。换色本身仍由 theme.js 的 window.parlorTheme 做，
 * 这里只挑下一套并跟随它广播的状态。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import { otherTheme, themeHint, themeIcon, themeLabel } from '../lib/theme-toggle.ts';

interface ThemeApi {
  value: string;
  set(next: string): void;
}

const value = ref('dark');

function api(): ThemeApi | undefined {
  return (window as unknown as { parlorTheme?: ThemeApi }).parlorTheme;
}

function sync(): void {
  const theme = api();
  if (!theme) return;
  // 浏览器里存着旧的 cream：折到浅色，免得按钮写着已下线的外观。
  if (theme.value === 'cream') theme.set('light');
  value.value = theme.value;
}

const label = computed(() => themeLabel(value.value));
const icon = computed(() => themeIcon(value.value));
const hint = computed(() => themeHint(value.value));

function toggle(): void {
  const theme = api();
  if (!theme) return;
  theme.set(otherTheme(theme.value));
  // 正常会收到 themechange 并再走一次 sync；事件万一没回来，按钮也立刻变，不让人以为没点上。
  value.value = theme.value;
}

onMounted(() => {
  sync();
  document.addEventListener('parlor:themechange', sync);
});

onBeforeUnmount(() => {
  document.removeEventListener('parlor:themechange', sync);
});
</script>

<template>
  <button class="theme-picker" type="button" :title="hint" :aria-label="hint" @click="toggle">
    <Icon :name="icon" />
    <span class="theme-picker-label">{{ label }}</span>
  </button>
</template>
