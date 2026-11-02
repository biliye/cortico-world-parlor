/** 大厅 / 客厅 / 牌桌三层：当前在哪一层、看的是哪张桌。URL 与它保持同步。 */
import { ref } from 'vue';
import { seat } from './session.ts';

export type ViewName = 'hall' | 'lobby' | 'table';

export const view = ref<ViewName>('hall');
export const watchTableId = ref('');

export function readView(): void {
  const params = new URLSearchParams(location.search);
  watchTableId.value = params.get('table') || '';
  view.value = params.get('view') === 'table'
    ? 'table'
    : (seat.value?.room === 'hall' ? 'hall' : 'lobby');
}

export function writeView(replace = false): void {
  const params = new URLSearchParams(location.search);
  if (view.value === 'table') {
    params.set('view', 'table');
    if (watchTableId.value) params.set('table', watchTableId.value);
    else params.delete('table');
  } else {
    params.delete('view');
    params.delete('table');
  }
  const url = '/play' + (params.toString() ? '?' + params : '');
  history[replace ? 'replaceState' : 'pushState']({ parlor: true }, '', url);
}

export function enterTable(id = ''): void {
  watchTableId.value = id;
  view.value = 'table';
  writeView();
}

export function backToRoom(): void {
  view.value = 'lobby';
  watchTableId.value = '';
  writeView();
}
