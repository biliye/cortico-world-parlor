<script setup lang="ts">
/** 一条发言卡：白天/历史共用。 */
import { initialOf } from '../../lib/text.ts';

const SPEECH_KIND: Record<string, string> = { day: '发言', pk: 'PK 发言', lastwords: '遗言' };

defineProps<{
  entry: { day?: number; kind?: string; seatNo?: number; seatName?: string; text?: string; passed?: boolean };
  live?: boolean;
  whoKind?: string;
}>();
</script>

<template>
  <article class="wf-speech" :class="{ 'is-live': live, 'is-pass': entry.passed }">
    <span class="wf-speech-avatar" :class="{ 'is-coo': whoKind === 'Coo' }" aria-hidden="true">{{ initialOf(entry.seatName) }}</span>
    <div class="wf-speech-body">
      <header class="wf-speech-head">
        <span class="wf-speech-who">
          {{ entry.seatNo }}号 {{ entry.seatName || '' }}
          <span v-if="whoKind" class="wf-kind">{{ whoKind }}</span>
        </span>
        <span class="wf-speech-day">第{{ entry.day }}天 · {{ SPEECH_KIND[entry.kind || ''] || '发言' }}</span>
      </header>
      <p class="wf-speech-text">{{ entry.passed ? '（过麦，没有发言）' : entry.text }}</p>
    </div>
  </article>
</template>

<style scoped>
.wf-speech.wf-speech {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}

.wf-speech-avatar {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--line-2);
  border-radius: 50%;
  background: var(--panel-2);
  color: var(--text);
  font-size: 12px;
  font-weight: 700;
}
.wf-speech-avatar.is-coo { background: color-mix(in srgb, var(--panel-2) 84%, #d6ab64); }
.wf-speech-head { flex-wrap: wrap; gap: 2px 7px; color: var(--muted); }
.wf-speech-who { color: var(--text); overflow-wrap: anywhere; }
.wf-speech-day { font-weight: 450; }
.wf-speech-body .wf-kind { color: var(--muted); background: var(--panel); }
.wf-speech-text {
  margin-top: 4px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 4px 11px 11px;
  background: var(--panel-2);
  color: var(--text);
  font-size: 13px;
  line-height: 1.6;
}
.is-live .wf-speech-text { border-color: var(--line-2); background: var(--panel); }
.wf-speech.is-pass { opacity: 1; }
.is-pass .wf-speech-text { color: var(--muted); }
</style>
