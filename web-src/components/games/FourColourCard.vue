<script setup lang="ts">
import { fourColourFaceText, type FourColourFace } from '../../../src/room/games/four-colour-rules.ts';

defineProps<{ face?: FourColourFace }>();
</script>

<template>
  <span class="colour-card" :class="['row-' + (face?.colour ?? 'special'), 'rank-' + (face?.rank ?? 'back')]"
    role="img" :aria-label="face ? fourColourFaceText(face) : '牌背'" />
</template>

<style scoped>
/* 13 列 5 行，前四行各是一色，最后一行是牌背和两张变色牌。 */
.colour-card {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 25;
  border-radius: 7%;
  background-image: url('../../assets/table/four-colour-cards.webp');
  background-repeat: no-repeat;
  background-size: 1300% 500%;
  background-position: var(--column) var(--row);
  box-shadow: 0 2px 4px #0005;
}
.row-red { --row: 0%; }
.row-yellow { --row: 25%; }
.row-green { --row: 50%; }
.row-blue { --row: 75%; }
.row-special { --row: 100%; }
.rank-0, .rank-back { --column: 0%; }
.rank-1, .rank-wild { --column: calc(100% / 12); }
.rank-2, .rank-draw4 { --column: calc(200% / 12); }
.rank-3 { --column: 25%; }
.rank-4 { --column: calc(400% / 12); }
.rank-5 { --column: calc(500% / 12); }
.rank-6 { --column: 50%; }
.rank-7 { --column: calc(700% / 12); }
.rank-8 { --column: calc(800% / 12); }
.rank-9 { --column: 75%; }
.rank-skip { --column: calc(1000% / 12); }
.rank-reverse { --column: calc(1100% / 12); }
.rank-draw2 { --column: 100%; }
</style>
