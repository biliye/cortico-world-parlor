<script setup lang="ts">
import { ref } from 'vue';

/** 第 1 刀的探针：只证明运行时、模板编译、事件、动态样式在页面 CSP 下都能跑。 */
const checks = [
  'Vue 运行时已挂载',
  '模板在构建期编译（无 eval）',
  '事件与响应式可用',
  '动态样式未被 CSP 拦',
];
const hits = ref(0);
</script>

<template>
  <div
    class="vue-probe"
    role="status"
    :style="{
      position: 'fixed', left: '12px', bottom: '12px', zIndex: '2147483000',
      padding: '10px 14px', borderRadius: '10px', fontSize: '13px', lineHeight: '1.7',
      background: '#10191b', color: '#e7f0e9', border: '1px solid #3d5a4a',
    }"
  >
    <strong>Vue 构建链自检</strong>
    <ul :style="{ margin: '4px 0 6px', paddingLeft: '18px' }">
      <li v-for="check in checks" :key="check">{{ check }}</li>
    </ul>
    <button type="button" @click="hits++">点了 {{ hits }} 次</button>
  </div>
</template>
