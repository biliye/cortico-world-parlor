<script setup lang="ts">
/** 一条发言卡：白天/历史共用。 */
const SPEECH_KIND: Record<string, string> = { day: '发言', pk: 'PK 发言', lastwords: '遗言' };

defineProps<{
  entry: { day?: number; kind?: string; seatNo?: number; seatName?: string; text?: string; passed?: boolean };
  live?: boolean;
  whoKind?: string;
}>();
</script>

<template>
  <article class="wf-speech" :class="{ 'is-live': live, 'is-pass': entry.passed }">
    <header class="wf-speech-head">
      <span class="wf-speech-day">第{{ entry.day }}天·{{ SPEECH_KIND[entry.kind || ''] || '发言' }}</span>
      <span class="wf-speech-who">
        {{ entry.seatNo }}号 {{ entry.seatName || '' }}
        <span v-if="whoKind" class="wf-kind">{{ whoKind }}</span>
      </span>
    </header>
    <p class="wf-speech-text">{{ entry.passed ? '（过麦，没有发言）' : entry.text }}</p>
  </article>
</template>
