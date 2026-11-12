import { describe, expect, it } from 'vitest';
import { FINISH, HANGAR, HOME_START, destination } from '../src/room/games/aeroplane-rules.ts';
import { AeroplaneTable } from '../src/room/games/aeroplane-table.ts';

const host = { id: 'a', name: '阿红' };
const guest = { id: 'b', name: '阿绿' };
const options = { host, turnMs: 100, firstSeat: () => 0 };

function started(rollDie: () => number = () => 6) {
  const table = new AeroplaneTable({ ...options, rollDie });
  table.join(guest);
  table.start(host.id, 1000);
  return table;
}

function setPlanes(table: AeroplaneTable, red: number[], green: number[]) {
  const state = table.exportState() as { seats: Array<{ planes: number[] }> };
  state.seats[0].planes = red;
  state.seats[1].planes = green;
  table.restoreState(state);
}

describe('经典飞行棋', () => {
  it('两至四人由桌主开局，使用实际入座人数决定先手与颜色', () => {
    const table = new AeroplaneTable({ ...options, firstSeat: seats => seats - 1 });
    expect(() => table.start(host.id, 1000)).toThrow(/至少/);
    table.join(guest);
    table.join({ id: 'c', name: '阿蓝' });
    table.join({ id: 'd', name: '阿黄' });
    expect(() => table.join({ id: 'e', name: '第五位' })).toThrow(/最多四人/);
    expect(() => table.start(guest.id, 1000)).toThrow(/开桌/);
    table.leave('c');
    expect(table.start(host.id, 1000).views).toEqual(['d']);
    expect(table.public().seats.map(seat => seat.colour)).toEqual([0, 1, 2]);
    expect(() => table.leave(guest.id)).toThrow(/已经开始/);
  });

  it('没掷到六时自动交棒，掷六后可选任一停机位并再掷', () => {
    const dice = [3, 6, 5];
    const table = started(() => dice.shift()!);
    expect(() => table.act('b', { action: 'roll' }, 1001)).toThrow(/轮到/);
    expect(table.act('a', { action: 'roll' }, 1001).views).toEqual(['b']);
    expect(table.public()).toMatchObject({ phase: 'await_roll', die: null, turn: 'b' });
    expect(table.act('b', { action: 'roll' }, 1002).views).toEqual(['b']);
    expect(table.view('b')?.moves.map(move => move.plane)).toEqual([1, 2, 3, 4]);
    expect(table.view('a')?.moves).toEqual([]);
    expect(table.view('spectator')).toBeNull();
    expect(() => table.act('b', { action: 'roll' }, 1003)).toThrow(/请选择/);
    expect(() => table.act('b', { action: 'move', plane: 5 }, 1003)).toThrow(/编号/);
    expect(table.act('b', { action: 'move', plane: 4 }, 1003).views).toEqual(['b']);
    expect(table.public().seats[1]).toMatchObject({ colour: 2, planes: [-1, -1, -1, 0] });
    table.act('b', { action: 'roll' }, 1004);
    expect(table.view('b')?.moves).toEqual([{ plane: 4, from: 0, to: 5, jumped: false, captures: 0 }]);
  });

  it('在同色格跳四格，只撞回最终落点的其他颜色飞机', () => {
    const table = started(() => 4);
    setPlanes(table, [0, 8, -1, -1], [30, 34, 34, 35]);
    table.act('a', { action: 'roll' }, 1001);
    expect(table.view('a')?.moves[0]).toEqual({ plane: 1, from: 0, to: 8, jumped: true, captures: 2 });
    table.act('a', { action: 'move', plane: 1 }, 1002);
    expect(table.public().seats.map(seat => seat.planes)).toEqual([[8, 8, -1, -1], [30, -1, -1, 35]]);
  });

  it('进入专属航道后按点数前进或折返，第四架到达立即结算', () => {
    expect(destination(HOME_START - 3, 4, 0)).toEqual({ to: HOME_START + 1, jumped: false });
    expect(destination(FINISH - 1, 4, 0)).toEqual({ to: FINISH - 3, jumped: false });
    expect(destination(FINISH, 4, 0)).toBeNull();
    const table = started(() => 1);
    setPlanes(table, [FINISH, FINISH - 1, FINISH, FINISH], [HANGAR, HANGAR, HANGAR, HANGAR]);
    table.act('a', { action: 'roll' }, 1001);
    expect(table.act('a', { action: 'move', plane: 2 }, 1002)).toMatchObject({ ended: true, seatResults: null, views: [] });
    expect(table.public()).toMatchObject({ status: 'ended', winners: ['a'], phase: null });
    expect(table.nextWakeAt()).toBeUndefined();
    expect(table.autoPlay('a', 2000)).toBeNull();
  });

  it('从待走棋快照重连后保留骰点，超时按原骰点代打', () => {
    const table = started();
    table.act('a', { action: 'roll' }, 1001);
    const saved = table.exportState();
    const resumed = new AeroplaneTable({ ...options, rollDie: () => { throw new Error('骰点已经提交'); } });
    resumed.restoreState(JSON.parse(JSON.stringify(saved)));
    expect(resumed.public()).toEqual(table.public());
    expect(resumed.view('a')).toEqual(table.view('a'));
    expect(() => resumed.restoreState({ ...saved as object, version: 9 })).toThrow(/存档/);
    resumed.rearm(2000, 1000, 500);
    expect(resumed.tick(2499)).toBeNull();
    expect(() => resumed.act('a', { action: 'move', plane: 1 }, 2500)).toThrow(/到期/);
    expect(resumed.tick(2500)?.events[0].data).toMatchObject({ action: 'move', die: 6, auto: true });
    expect(resumed.public()).toMatchObject({ turn: 'a', phase: 'await_roll', die: null });
  });
});
