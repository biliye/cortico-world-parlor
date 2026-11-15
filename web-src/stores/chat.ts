/**
 * 聊天栏的界面状态：开合、当前频道、未读与草稿。
 * 只放浏览器侧状态；消息本身在 parlor 的 log 里，发送走 /v1/action。
 */
import { reactive, ref } from 'vue';
import { club, saveDraft, draft as readDraft, persistClub } from './club.ts';
import { seat } from './session.ts';

export type ChatTab = 'room' | 'table' | 'mail';

export const tab = ref<ChatTab>('room');
export const unread = reactive({ room: 0, table: 0 });
export const sheetOpen = ref(false);
const floatingChatTable = ref('');
const floatingChatOpen = ref(false);

/** 牌桌聊天默认收起，开合不会写回客厅的聊天偏好。 */
export function setFloatingChatTable(tableKey: string): void {
  if (tableKey === floatingChatTable.value) return;
  if (sheetOpen.value) closeSheet();
  floatingChatTable.value = tableKey;
  floatingChatOpen.value = false;
}

function desktop(): boolean {
  return window.matchMedia('(min-width: 1101px)').matches;
}

/** 桌面看侧栏有没有展开；手机看抽屉有没有拉开。 */
export function chatExpanded(): boolean {
  if (!desktop()) return sheetOpen.value;
  return floatingChatTable.value ? floatingChatOpen.value : club.chatOpen;
}

export function toggleChat(force?: boolean): void {
  const next = force ?? !chatExpanded();
  if (desktop()) {
    if (floatingChatTable.value) floatingChatOpen.value = next;
    else club.chatOpen = next;
  } else {
    if (!floatingChatTable.value) club.mobileChatOpen = next;
    sheetOpen.value = next;
  }
  if (!floatingChatTable.value) persistClub();
  if (next && tab.value !== 'mail') unread[tab.value] = 0;
}

export function chooseTab(next: ChatTab): void {
  tab.value = next;
  if (next !== 'mail') unread[next] = 0;
  if (!desktop()) toggleChat(true);
}

export function closeSheet(): void {
  sheetOpen.value = false;
  if (floatingChatTable.value) return;
  club.mobileChatOpen = false;
  persistClub();
}

/** 与旧版同一个草稿键：身份 + 客厅 + 频道 + 桌号。 */
export function draftKey(channel: ChatTab, tableId = ''): string {
  return JSON.stringify([
    seat.value?.cooId || seat.value?.seatId || '',
    seat.value?.room || '',
    channel,
    channel === 'table' ? tableId : '',
  ]);
}

export function draftFor(key: string): string {
  return readDraft(key);
}

export function saveDraftFor(key: string, text: string): void {
  saveDraft(key, text);
}

/** 收到一条聊天/进出事件：没看着这一栏就记未读。 */
export function noteChatEvent(event: { type?: string }): void {
  const type = event.type || '';
  const channel: 'room' | 'table' | null = type === 'parlor.say' ? 'room'
    : type === 'parlor.table.say' ? 'table'
      : (type === 'parlor.joined' || type === 'parlor.left') ? 'room'
        : null;
  if (!channel) return;
  if (tab.value === channel && chatExpanded()) return;
  unread[channel] += 1;
}

/** 换席位后清掉旧厅的未读角标；消息本身在 parlor 的 log 里，那边一起清。 */
export function resetChatState(): void {
  unread.room = 0;
  unread.table = 0;
}
