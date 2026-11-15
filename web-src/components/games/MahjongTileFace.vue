<script setup lang="ts">
import { RED, TILES } from '../../../src/room/games/mahjong-rules.ts';
import { mahjongArt } from '../../lib/mahjong-art.ts';

defineProps<{ tile: number }>();
</script>

<template>
  <span class="face" aria-hidden="true">
    <span v-if="mahjongArt.faces" class="face-art"
      :style="{ '--col': tile % 9, '--row': Math.floor(tile / 9) }"></span>
    <span v-else class="face-label" :class="{ red: tile < 9 || tile === RED }">{{ TILES[tile] }}</span>
  </span>
</template>

<style scoped>
.face { display: grid; place-items: center; }
.face-art {
  height: 100%;
  max-width: 100%;
  aspect-ratio: 3 / 4;
  background-image: var(--mj-faces-img);
  background-size: 900% 400%;
  background-position: calc(var(--col) * 100% / 8) calc(var(--row) * 100% / 3);
  background-repeat: no-repeat;
}
.face-label { font-size: .85em; line-height: 1; white-space: nowrap; }
.face-label.red { color: #a52c25; }
</style>
