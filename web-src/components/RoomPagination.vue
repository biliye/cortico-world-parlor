<script setup lang="ts">
const props = defineProps<{ page: number; pageCount: number; position: '列表上方' | '列表下方' }>();
const emit = defineEmits<{ change: [page: number] }>();

function selectPage(event: Event): void {
  const select = event.target as HTMLSelectElement;
  const selected = Number(select.value);
  if (!Number.isInteger(selected) || selected < 1 || selected > props.pageCount) {
    select.value = String(props.page);
    return;
  }
  emit('change', selected);
}
</script>

<template>
  <nav class="directory-pagination" :aria-label="`客厅分页（${position}）`">
    <button class="btn ghost small" type="button" :disabled="page === 1" @click="emit('change', page - 1)">上一页</button>
    <select
      class="directory-page-select"
      :aria-label="`跳到客厅页码（${position}）`"
      :value="page"
      @change="selectPage"
    >
      <option v-for="number in pageCount" :key="number" :value="number">第 {{ number }} / {{ pageCount }} 页</option>
    </select>
    <button class="btn ghost small" type="button" :disabled="page === pageCount" @click="emit('change', page + 1)">下一页</button>
  </nav>
</template>
