<script setup lang="ts">
import { computed } from 'vue';
import { tableSpeech } from '../../stores/chat.ts';

const props = defineProps<{
  table: string;
  sender?: string;
  align?: 'left' | 'right' | 'center';
  above?: boolean;
  names?: Map<string, string>;
}>();
const speech = computed(() => tableSpeech(props.table, props.sender));
</script>

<template>
  <div v-if="sender" class="speech-anchor" :class="[`align-${align || 'center'}`, { above }]" role="status">
    <Transition name="speech" mode="out-in">
      <div v-if="speech" :key="speech.seq" class="speech-bubble">
        <span>{{ speech.text }}</span>
      </div>
    </Transition>
  </div>
  <div v-else class="speech-strip" role="status">
    <span v-if="speech">{{ names?.get(speech.sender) || '同桌玩家' }} · {{ speech.text }}</span>
  </div>
</template>

<style scoped>
.speech-anchor { position: absolute; top: calc(100% + 6px); pointer-events: none; z-index: 3; }
.speech-anchor.above { top: auto; bottom: calc(100% + 6px); }
.align-left { left: 0; }
.align-right { right: 0; }
.align-center { left: 50%; transform: translateX(-50%); }
.speech-bubble {
  width: max-content;
  max-width: min(170px, 22vw);
  padding: 6px 10px;
  border: 1px solid #786048;
  border-radius: 10px;
  background: #33251d;
  color: #fff1db;
  box-shadow: 0 3px 10px #0005;
  font-size: 12px;
  line-height: 1.4;
  text-align: start;
}
.speech-bubble::before {
  content: '';
  position: absolute;
  inset: -4px auto auto 10px;
  width: 6px;
  height: 6px;
  border-block-start: 1px solid #786048;
  border-inline-start: 1px solid #786048;
  background: #33251d;
  transform: rotate(45deg);
}
.align-right .speech-bubble::before { inset-inline: auto 10px; }
.align-center .speech-bubble::before { inset-inline-start: calc(50% - 3px); }
.above .speech-bubble::before { inset-block: auto -4px; transform: rotate(225deg); }
.speech-bubble span {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.speech-enter-active, .speech-leave-active { transition: opacity .15s ease; }
.speech-enter-from, .speech-leave-to { opacity: 0; }
.speech-strip { display: none; }
@media (max-width: 660px) {
  .speech-anchor { display: none; }
  .speech-strip { display: block; min-height: 25px; color: var(--text); font-size: 12px; }
  .speech-strip span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}
@media (prefers-reduced-motion: reduce) {
  .speech-enter-active, .speech-leave-active { transition: none; }
}
</style>
