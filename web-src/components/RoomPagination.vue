<script setup lang="ts">
defineProps<{ page: number; pageCount: number; label: string }>();
const emit = defineEmits<{ change: [page: number] }>();
</script>

<template>
  <nav class="directory-pagination" :aria-label="label">
    <button class="btn ghost small" type="button" :disabled="page === 1" @click="emit('change', page - 1)">上一页</button>
    <select
      class="directory-page-select"
      aria-label="跳到客厅页码"
      :value="page"
      @change="emit('change', Number(($event.target as HTMLSelectElement).value))"
    >
      <option v-for="number in pageCount" :key="number" :value="number">第 {{ number }} / {{ pageCount }} 页</option>
    </select>
    <button class="btn ghost small" type="button" :disabled="page === pageCount" @click="emit('change', page + 1)">下一页</button>
  </nav>
</template>
