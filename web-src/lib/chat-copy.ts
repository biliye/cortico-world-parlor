/** 聊天栏里给玩家看的边界说明。与旧 play.js 的 renderChat 一致，抽出来便于单测与 Vue 共用。 */

export const TABLE_TALK_SCOPE = '只发到这一桌 · 客厅和不在桌上的人看不见';
export const TABLE_TALK_ELSEWHERE = '只发到我的桌 · 你现在看的是另一桌';
export const TABLE_READONLY_SCOPE = '围观只读 · 聊天请切到「客厅」';
export const WEREWOLF_TALK_SCOPE = '狼人杀进行中 · 发言和狼聊请使用游戏内面板';
export const TABLE_TALK_PREFIX = '（只有同桌看得见）';
export const TABLE_EMPTY = '同桌的话，留在这一桌。';
export const TABLE_EMPTY_OBSERVER = '围观不开放同桌聊天。';
export const TABLE_ROOM_HINT = '牌桌上还没人说话。客厅的聊天在「客厅」那一栏。';

export function roomScopeText(inHall: boolean): string {
  return inHall ? '发到大厅 · 大厅里的人都看得见' : '发到客厅 · 房间里的人都看得见';
}

export function roomPlaceholder(inHall: boolean): string {
  return inHall ? '在大厅说点什么…' : '在客厅说点什么…';
}

export interface TableScopeInput {
  tableOpen: boolean;
  elsewhere?: boolean;
  werewolfActive?: boolean;
}

export function tableScopeText(input: TableScopeInput): string {
  if (!input.tableOpen) {
    return input.werewolfActive ? WEREWOLF_TALK_SCOPE : TABLE_READONLY_SCOPE;
  }
  return input.elsewhere ? TABLE_TALK_ELSEWHERE : TABLE_TALK_SCOPE;
}

export function tablePlaceholder(tableOpen: boolean): string {
  return tableOpen ? '对同桌说点什么…' : '当前桌聊不可用';
}

export function tableEmptyText(tableOpen: boolean): string {
  return tableOpen ? TABLE_EMPTY : TABLE_EMPTY_OBSERVER;
}
