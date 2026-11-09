<script setup lang="ts">
/** 狼人杀身份牌面：图片缺了退回文字身份，不无限加载。 */
import { computed, ref, watch } from 'vue';

const ROLE_NAMES: Record<string, string> = {
  wolf: '狼人', villager: '平民', seer: '预言家', witch: '女巫', hunter: '猎人', guard: '守卫',
};
const ROLE_FACTIONS: Record<string, string> = {
  wolf: '狼人阵营', villager: '好人阵营', seer: '好人阵营', witch: '好人阵营', hunter: '好人阵营', guard: '好人阵营',
};
const ROLE_SKILLS: Record<string, string> = {
  wolf: '每晚可发两条狼队私聊，交一张刀票。可刀任意存活玩家，包括自己和队友。唯一最高票成为刀口，平票或没有有效票则空刀。',
  villager: '没有夜间技能，靠白天发言与投票找出狼人。',
  seer: '每晚最多查验一名其他存活玩家，只得到「狼人 / 好人」。',
  witch: '各一瓶解药与毒药，每夜最多用一瓶；解药尚在才得知刀口；首夜可自救，不能自毒。',
  guard: '每晚可守一名存活玩家，可自守或空守。不能连守同一人；守护挡狼刀，不挡毒药，同守同救仍出局。',
  hunter: '被狼刀或白天投票出局可开枪带走一名其他存活玩家；中毒不能开枪。',
};

const props = defineProps<{
  role: string;
  mates?: Array<{ seatNo: number; name: string }>;
  withClose?: boolean;
}>();
defineEmits<{ close: [] }>();

const missing = ref(false);
watch(() => props.role, () => { missing.value = false; });

const matesText = computed(() => (props.mates ?? []).map((mate) => `${mate.seatNo}号 ${mate.name}`).join('、'));
const artUrl = computed(() => `/play/assets/assets/werewolf/roles/${props.role}.jpg`);
</script>

<template>
  <div class="wf-card-face">
    <div class="wf-roleart" :class="{ 'is-missing': missing }">
      <img
        v-if="!missing"
        class="wf-roleimg"
        :src="artUrl"
        :alt="`${ROLE_NAMES[role]}身份牌`"
        loading="eager"
        decoding="async"
        @error="missing = true"
      >
    </div>
    <div class="wf-role-name">{{ ROLE_NAMES[role] }} · {{ ROLE_FACTIONS[role] }}</div>
    <p class="wf-role-skill">{{ ROLE_SKILLS[role] }}</p>
    <p v-if="role === 'wolf' && matesText" class="wf-role-mates">同伴：{{ matesText }}</p>
    <button v-if="withClose" class="btn small" type="button" @click="$emit('close')">收好身份</button>
  </div>
</template>
