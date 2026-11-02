<script setup lang="ts">
/** 外观选单：深色 / 浅色「白天模式」。奶油那套在 2026-11-02 的方案里已不再保留。 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

interface ThemeApi {
  value: string;
  themes: string[];
  set(next: string): void;
}

const LABELS: Record<string, string> = { dark: '深色', light: '浅色' };
const KEEP = ['dark', 'light'];

const value = ref('dark');
const themes = ref(['dark', 'light']);

function api(): ThemeApi | undefined {
  return (window as unknown as { parlorTheme?: ThemeApi }).parlorTheme;
}

function sync(): void {
  const theme = api();
  if (!theme) return;
  // 浏览器里存着旧的 cream：折到浅色，免得选择框出现一个不存在的选项。
  if (theme.value === 'cream') theme.set('light');
  value.value = theme.value;
  themes.value = theme.themes.filter((item) => KEEP.includes(item));
}

function change(): void {
  api()?.set(value.value);
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
  <label class="theme-picker" title="外观">
    <svg class="icon" aria-hidden="true"><use href="#i-sun" /></svg>
    <select id="theme-select" v-model="value" aria-label="外观" @change="change">
      <option v-for="item in themes" :key="item" :value="item">{{ LABELS[item] || item }}</option>
    </select>
  </label>
</template>
