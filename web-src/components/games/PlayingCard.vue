<script setup lang="ts">
/** 一张牌：牌面来自雪碧图，图没到先显示点数；类名与旧渲染器卡牌按钮一致。 */
import { computed, onMounted, watch } from 'vue';
import { cardArtStyle, cardClass, cardLabel, probeCardArt, type CardArt } from '../../lib/cards.ts';

const props = defineProps<{
  card: string;
  art?: CardArt;
  selected?: boolean;
  small?: boolean;
  clickable?: boolean;
}>();
defineEmits<{ pick: [] }>();

const style = computed(() => (props.art ? cardArtStyle(props.art.rank ?? props.card, props.art.suit ?? null) : {}));
const hasArt = computed(() => Object.keys(style.value).length > 0);
const classes = computed(() => [
  'pcard',
  cardClass(props.card),
  hasArt.value ? 'has-art' : '',
  props.selected ? 'sel' : '',
  props.small ? 'small-card' : '',
].filter(Boolean).join(' '));

function warmArt(): void {
  if (props.art || hasArt.value) probeCardArt();
}

onMounted(warmArt);
watch(() => props.art, warmArt);
</script>

<template>
  <button
    type="button"
    :class="classes"
    :style="style"
    :disabled="!clickable"
    :aria-pressed="clickable ? !!selected : undefined"
    :aria-label="clickable ? cardLabel(card) : undefined"
    @click="clickable && $emit('pick')"
  >{{ cardLabel(card) }}</button>
</template>
