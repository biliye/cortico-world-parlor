/** 大厅的三个范围：发现 / 我的客厅 / 收藏。左栏导航与大厅列表共用这一份。 */
import { ref } from 'vue';

export type HallSection = 'all' | 'mine' | 'favorites';

export const hallSection = ref<HallSection>('all');

export function selectHallSection(next: HallSection): void {
  hallSection.value = next;
}
