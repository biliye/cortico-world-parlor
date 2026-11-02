/** 聊天栏显示哪条事件、进哪一栏：与旧 play.js 的 renderChat 过滤规则一致，抽成纯函数便于单测。 */

export type ChatChannel = 'room' | 'table' | 'mail';

/**
 * 聊天栏不显示的事件：
 * - 私聊走浮窗；
 * - 牌桌动作、大富翁过程只留在牌桌，不混进聊天；
 * - 摘要不进聊天（由唤醒层处理）。
 */
export function chatLineVisible(type: string): boolean {
  if (type === 'parlor.whisper' || type === 'parlor.table.turn' || type === 'parlor.digest') return false;
  if (type.startsWith('parlor.table.') && type !== 'parlor.table.say') return false;
  if (type.startsWith('parlor.monopoly.')) return false;
  return true;
}

/**
 * 哪一栏收这条：
 * - 客厅/大厅栏只收公开发言，不收牌桌私聊；
 * - 牌桌栏只收 parlor.table.say；
 * - 信箱栏不走聊天日志。
 */
export function chatChannelAccepts(channel: ChatChannel, type: string): boolean {
  if (channel === 'mail') return false;
  if (channel === 'table') return type === 'parlor.table.say';
  return type !== 'parlor.table.say';
}

/** 事件带的桌号与「我的桌」不一致就跳过；老事件没有桌号时按「是」处理。 */
export function chatLineMatchesTable(eventTableId: unknown, myTableId: string): boolean {
  const id = typeof eventTableId === 'string' ? eventTableId : '';
  return !id || !myTableId || id === myTableId;
}
