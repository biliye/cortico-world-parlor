import { describe, expect, it } from 'vitest';
import {
  eventVisibleInInterval, scopeVisibleTo, type RoomEvent, type Scope,
} from '../src/room/protocol.ts';

const event = (seq: number, scope: Scope): RoomEvent => ({
  seq, ts: seq, type: 'parlor.say', from: 's2', scope, text: `#${seq}`,
});

describe('席位可见区间', () => {
  it('visibleFromSeq 不含：入厅前的事件看不到，入厅事件本身看得到', () => {
    const interval = { visibleFromSeq: 4 };
    expect(eventVisibleInInterval(event(4, { kind: 'room' }), 's1', interval)).toBe(false);
    expect(eventVisibleInInterval(event(5, { kind: 'room' }), 's1', interval)).toBe(true);
  });

  it('visibleUntilSeq 含：离厅事件本身看得到，之后看不到', () => {
    const interval = { visibleFromSeq: 0, visibleUntilSeq: 8 };
    expect(eventVisibleInInterval(event(8, { kind: 'room' }), 's1', interval)).toBe(true);
    expect(eventVisibleInInterval(event(9, { kind: 'room' }), 's1', interval)).toBe(false);
  });

  it('null/undefined 的上界表示还在厅里', () => {
    expect(eventVisibleInInterval(event(99, { kind: 'room' }), 's1', { visibleFromSeq: 0, visibleUntilSeq: null })).toBe(true);
    expect(eventVisibleInInterval(event(99, { kind: 'room' }), 's1', { visibleFromSeq: 0 })).toBe(true);
  });

  it('区间内还要过 scope：私聊只给目标席位', () => {
    const interval = { visibleFromSeq: 0 };
    expect(eventVisibleInInterval(event(5, { kind: 'seat', seatId: 's1' }), 's1', interval)).toBe(true);
    expect(eventVisibleInInterval(event(5, { kind: 'seat', seatId: 's9' }), 's1', interval)).toBe(false);
  });

  it('牌桌聊只看当时在桌的席位', () => {
    const scope: Scope = { kind: 'table', tableId: 't1', seats: ['s1', 's2'] };
    expect(scopeVisibleTo(scope, 's1')).toBe(true);
    expect(scopeVisibleTo(scope, 's3')).toBe(false);
  });

  it('大厅与客厅的公开事件对厅内席位可见', () => {
    expect(scopeVisibleTo({ kind: 'hall' }, 's1')).toBe(true);
    expect(scopeVisibleTo({ kind: 'room' }, 's1')).toBe(true);
  });

  it('区间优先于 scope：区间外即使是公开/私聊也不可见', () => {
    const privateScope: Scope = { kind: 'seat', seatId: 's1' };
    expect(eventVisibleInInterval(event(3, privateScope), 's1', { visibleFromSeq: 4 })).toBe(false);
    expect(eventVisibleInInterval(event(10, privateScope), 's1', { visibleFromSeq: 0, visibleUntilSeq: 9 })).toBe(false);
  });

  it('入厅第一条事件：from=0 时 seq=1 可见，seq=0 不可见', () => {
    expect(eventVisibleInInterval(event(1, { kind: 'room' }), 's1', { visibleFromSeq: 0 })).toBe(true);
    expect(eventVisibleInInterval(event(0, { kind: 'room' }), 's1', { visibleFromSeq: 0 })).toBe(false);
  });
});
