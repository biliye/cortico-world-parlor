/** 大厅 / 客厅 / 牌桌三层：当前在哪一层、看的是哪张桌。URL 与它保持同步。 */
import { ref } from 'vue';
import { seat } from './session.ts';

export type ViewName = 'hall' | 'lobby' | 'table' | 'story';

export const view = ref<ViewName>('hall');
export const watchTableId = ref('');

/**
 * `?viewhall=1`：本地单厅服务没有 /switch 接口，进不了大厅，
 * 但大厅那半屏（茶馆 canvas）最需要单独核对，所以留一个只读的开关。
 * 它只决定「渲染哪个视图」，不改席位、不写回 URL。
 *
 * 写成函数而不是顶层常量：这个文件会被单测 import，那时没有 location。
 */
export function wantHall(): boolean {
  return new URLSearchParams(location.search).get('viewhall') === '1';
}

export function readView(): void {
  const params = new URLSearchParams(location.search);
  watchTableId.value = params.get('table') || '';
  /* `?viewhall=1` 强行看大厅：单厅本地服务没有 /switch 接口，进不去大厅，
     而大厅那半屏（茶馆 canvas）又最需要单独截图核对。只影响这一屏，不写回 URL。 */
  view.value = params.get('view') === 'story' ? 'story' : params.get('viewhall') === '1'
    ? 'hall'
    : params.get('view') === 'table'
      ? 'table'
      : (seat.value?.room === 'hall' ? 'hall' : 'lobby');
}

export function writeView(replace = false): void {
  const params = new URLSearchParams(location.search);
  if (view.value === 'table') {
    params.set('view', 'table');
    if (watchTableId.value) params.set('table', watchTableId.value);
    else params.delete('table');
  } else if (view.value === 'story') {
    params.set('view', 'story');
    params.delete('table');
    params.delete('viewhall');
  } else {
    params.delete('view');
    params.delete('table');
  }
  const url = '/play' + (params.toString() ? '?' + params : '');
  history[replace ? 'replaceState' : 'pushState']({ parlor: true }, '', url);
}

export function enterStory(): void {
  view.value = 'story';
  writeView();
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
