<script setup lang="ts">
/** 跟随秒针的倒计时：旧页由 play.js 的统一 ticker 更新，Vue 页里由这个小组件自己走。 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { fmtLeft } from '../../lib/cards.ts';

const props = defineProps<{ deadline: number; serverNow: () => number }>();

const now = ref(props.serverNow());
let timer: number | undefined;

onMounted(() => {
  timer = window.setInterval(() => { now.value = props.serverNow(); }, 500);
});

onBeforeUnmount(() => {
  if (timer !== undefined) window.clearInterval(timer);
});

const text = computed(() => {
  const left = fmtLeft(props.deadline, now.value);
  return left === '已截止' ? '已截止（服务器托管中）' : '还剩 ' + left;
});
</script>

<template><span class="clock">{{ text }}</span></template>
