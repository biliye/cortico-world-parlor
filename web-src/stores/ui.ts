/** 页面级提示条。旧版的 toast 挂在 #toast 上；Vue 这边自己渲染一条。 */
import { ref } from 'vue';

export const toastText = ref('');
export const toastKind = ref('');

let timer: number | undefined;

export function showToast(message: string, kind = ''): void {
  if (!message) return;
  toastText.value = message;
  toastKind.value = kind;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    toastText.value = '';
    toastKind.value = '';
  }, 3200);
}
