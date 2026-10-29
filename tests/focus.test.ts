import { describe, expect, it } from 'vitest';
import { decideWake, type RoomEvent, type Scope, type Seat } from '../src/room/protocol.ts';

const seat = (tier: Seat['tier'] = 'full', kind: Seat['kind'] = 'pet'): Seat => ({
  id: 's1', name: '阿岚', kind, tier, joinedAt: 1,
});

const event = (scope: Scope, mentions?: string[], type = 'parlor.say'): RoomEvent => ({
  seq: 1, ts: 1, type, from: 's2', scope, text: '一句话', ...(mentions ? { mentions } : {}),
});

describe('专注 B：上桌后客厅普通聊不直接叫醒', () => {
  it('full 挡位：不专注时客厅聊叫；专注时不叫', () => {
    const roomSay = event({ kind: 'room' });
    expect(decideWake(roomSay, seat('full'))).toMatchObject({ wake: true, reason: 'room' });
    expect(decideWake(roomSay, seat('full'), { focus: true })).toMatchObject({ wake: false, reason: 'focus' });
  });

  it('专注中 @ 仍叫', () => {
    const mention = event({ kind: 'room' }, ['s1']);
    expect(decideWake(mention, seat('full'), { focus: true })).toMatchObject({
      wake: true, addressed: true, reason: 'mention',
    });
  });

  it('专注中私聊仍叫', () => {
    const whisper = event({ kind: 'seat', seatId: 's1' }, undefined, 'parlor.whisper');
    expect(decideWake(whisper, seat('full'), { focus: true })).toMatchObject({
      wake: true, addressed: true, reason: 'whisper',
    });
  });

  it('专注中牌桌聊仍叫', () => {
    const tableSay = event({ kind: 'table', tableId: 't1', seats: ['s1'] }, undefined, 'parlor.table.say');
    expect(decideWake(tableSay, seat('full'), { focus: true })).toMatchObject({
      wake: true, addressed: true, reason: 'table',
    });
  });

  it('专注中轮到自己仍叫', () => {
    const turn = event({ kind: 'seat', seatId: 's1' }, undefined, 'parlor.table.turn');
    expect(decideWake(turn, seat('full'), { focus: true })).toMatchObject({
      wake: true, addressed: true, reason: 'whisper',
    });
  });

  it('专注中客厅里的牌桌动作不叫', () => {
    const end = event({ kind: 'room' }, undefined, 'parlor.table.end');
    expect(decideWake(end, seat('full'), { focus: true })).toMatchObject({ wake: false, reason: 'focus' });
  });

  it('离开挡位专注中连 @ 也不叫', () => {
    const mention = event({ kind: 'room' }, ['s1']);
    expect(decideWake(mention, seat('off'), { focus: true })).toMatchObject({ wake: false, reason: 'off' });
  });

  it('观看者不叫', () => {
    expect(decideWake(event({ kind: 'room' }), seat('full', 'observer'), { focus: true }))
      .toMatchObject({ wake: false, reason: 'observer' });
  });

  it('摘要挡位：不专注时是 room，专注时是 focus；都不叫', () => {
    const roomSay = event({ kind: 'room' });
    expect(decideWake(roomSay, seat('digest'))).toMatchObject({ wake: false, reason: 'room' });
    expect(decideWake(roomSay, seat('digest'), { focus: true })).toMatchObject({ wake: false, reason: 'focus' });
  });

  it('只 @ 挡位专注中 @ 仍叫', () => {
    const mention = event({ kind: 'room' }, ['s1']);
    expect(decideWake(mention, seat('quiet'), { focus: true })).toMatchObject({
      wake: true, addressed: true, reason: 'mention',
    });
  });

  it('focus:false 与不传等价', () => {
    const roomSay = event({ kind: 'room' });
    expect(decideWake(roomSay, seat('full'), { focus: false })).toEqual(decideWake(roomSay, seat('full')));
  });
});
