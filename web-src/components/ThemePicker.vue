<script setup lang="ts">
/** 外观选单：深色 / 浅色 / 奶油。theme.js 已先于样式恢复外观，这里只负责切换。 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

interface ThemeApi {
  value: string;
  themes: string[];
  set(next: string): void;
}

const LABELS: Record<string, string> = { dark: '深色', light: '浅色', cream: '奶油' };

const value = ref('dark');
const themes = ref(['dark', 'light', 'cream']);

function api(): ThemeApi | undefined {
  return (window as unknown as { parlorTheme?: ThemeApi }).parlorTheme;
}

function sync(): void {
  const theme = api();
  if (!theme) return;
  value.value = theme.value;
  themes.value = theme.themes;
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
  <label class="theme-picker">
    <svg class="icon" aria-hidden="true"><use href="#i-sun" /></svg>
    <select v-model="value" aria-label="外观" @change="change">
      <option v-for="item in themes" :key="item" :value="item">{{ LABELS[item] || item }}</option>
    </select>
  </label>
</template>
