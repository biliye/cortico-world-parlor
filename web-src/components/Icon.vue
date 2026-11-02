<script setup lang="ts">
/** play.html 里那组 <symbol>：只建引用，不内联路径。 */
defineProps<{ name: string }>();
</script>

<template>
  <svg class="icon" aria-hidden="true"><use :href="'#i-' + name" /></svg>
</template>
