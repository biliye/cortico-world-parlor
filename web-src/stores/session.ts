/** 这台浏览器记着的席位。键名与旧版 play.js 完全一致，切过去时不用重新加入。 */
import { ref } from 'vue';
import type { SeatConfig } from '../api/types.ts';

export const STORE_KEY = 'parlor-play-v1';

function read(): SeatConfig | null {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!raw || !raw.token || !raw.seatId || !raw.cooId || !raw.cooSecret) return null;
    return raw as SeatConfig;
  } catch {
    return null;
  }
}

/** 只读存储里的席位，不动内存里的那一份；迟到 401 要用它判断「是不是别的标签页已经换了席位」。 */
export function readStoredSeat(): SeatConfig | null {
  return read();
}

export const seat = ref<SeatConfig | null>(read());

/** 席位被清掉时给加入页看的原因（例如令牌失效、被另一台设备顶掉）。 */
export const entryNotice = ref('');

/** 采用其他窗口已写入的席位，只改本页内存，避免相互回写触发通知。 */
export function adoptSeat(next: SeatConfig | null, notice = ''): void {
  seat.value = next;
  entryNotice.value = notice;
}

export function saveSeat(next: SeatConfig): void {
  adoptSeat(next);
  localStorage.setItem(STORE_KEY, JSON.stringify(next));
}

export function clearSeat(notice = ''): void {
  seat.value = null;
  entryNotice.value = notice;
  localStorage.removeItem(STORE_KEY);
}

/** 当前客厅；没有席位时为空串，接口就走默认客厅的 /v1/... 别名。 */
export function currentRoom(): string {
  return seat.value?.room || '';
}
