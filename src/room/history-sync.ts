import type { RoomEvent } from './protocol.ts';

/** 本机消息档案只用正文及收发标记，不需要牌桌状态、手牌或整段发言副本。 */
export type HistorySyncEvent = Pick<RoomEvent, 'seq' | 'ts' | 'type' | 'from' | 'text' | 'data'>;

export interface HistorySyncPage {
  events: HistorySyncEvent[];
  more: boolean;
}

export function historySyncEvent(event: HistorySyncEvent): HistorySyncEvent {
  const data: Record<string, unknown> = {};
  for (const key of ['actorSeatId', 'actorName', 'name', 'to']) {
    if (typeof event.data?.[key] === 'string') data[key] = event.data[key];
  }
  const mail = event.data?.mail as { seq?: unknown; ts?: unknown; room?: unknown } | undefined;
  if (mail && typeof mail.seq === 'number' && typeof mail.ts === 'number' && typeof mail.room === 'string') {
    data.mail = { seq: mail.seq, ts: mail.ts, room: mail.room };
  }
  return {
    seq: event.seq, ts: event.ts, type: event.type, from: event.from, text: event.text,
    ...(Object.keys(data).length ? { data } : {}),
  };
}
