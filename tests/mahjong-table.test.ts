import { describe, expect, it } from 'vitest';
import { MahjongTable } from '../src/room/games/mahjong-table.ts';
import { MAHJONG_GAMES, RED, canHu, suitOf, tileCounts, tileKinds, type MahjongGame } from '../src/room/games/mahjong-rules.ts';

const seat = (index: number) => ({ id: 's' + index, name: '玩家' + index });
const ids = [0, 1, 2, 3].map(index => seat(index).id);
const sichuan = 'mahjong-sichuan';
const guangdong = 'mahjong-guangdong';

function table(game: MahjongGame) {
  const t = new MahjongTable(game, seat(0), 100);
  for (let i = 1; i < 4; i++) t.join(seat(i));
  t.start(ids[0], 1000);
  return t;
}

function play(t: MahjongTable, index: number, action: string, args: Record<string, unknown> = {}) {
  return t.act(ids[index], { action, windowId: t.view(ids[index])!.windowId, ...args }, 1001);
}

function arranged(game: MahjongGame, hands: number[][], draw: number, future: number[] = []) {
  const t = table(game);
  const s = t.exportState();
  s.phase = 'discard';
  s.draw = draw;
  if (game === sichuan) s.exchangeDone = true;
  const counts = tileCounts([...hands.flat(), ...future], tileKinds(game));
  expect(counts.every(count => count <= 4)).toBe(true);
  const wall = counts.flatMap((count, tile) => Array<number>(4 - count).fill(tile));
  s.players.forEach((p, i) => {
    p.hand = hands[i].slice();
    if (game === sichuan) p.missing = 2;
    // Put filler in the missing suit first, so unused Sichuan seats cannot claim a win.
    while (p.hand.length < (i === 0 ? 14 : 13)) p.hand.push(wall.pop()!);
  });
  s.wall = [...wall, ...future.slice().reverse()];
  t.restoreState(s);
  return t;
}

describe('麻将胡牌', () => {
  it('红中可以补顺子、刻子、将和七对，字牌不能连顺', () => {
    const almost = [0, 1, 9, 10, 11, 18, 19, 20, 27, 27, 27, 33, 33];
    expect(canHu(guangdong, [...almost, RED], 0, null)).toBe(true);
    expect(canHu(guangdong, [29, RED, RED, 33, 33], 3, null)).toBe(true);
    expect(canHu(guangdong, [0, 1, 2, 33, RED], 3, null)).toBe(true);
    expect(canHu(guangdong, [0, 0, 1, 1, 2, 2, 9, 9, 27, 27, 32, 32, 33, RED], 0, null)).toBe(true);
    expect(canHu(guangdong, [28, 29, 30, 33, 33], 3, null)).toBe(false);
    expect(canHu(guangdong, [8, 9, 10, 33, 33], 3, null)).toBe(false);
    expect(canHu(sichuan, [0, 1, 2, 0, 0], 3, 0)).toBe(false);
    expect(canHu(sichuan, [0, 1, 2, 0, 0], 3, 2)).toBe(true);
  });

  it('广东 136 张，拒绝点胡，红中不能碰，合法自摸后一家结算', () => {
    const waiting = [0, 1, 9, 10, 11, 18, 19, 20, 27, 27, 27, 33, 33];
    const t = arranged(guangdong, [[RED], waiting, [RED, RED], []], RED, [RED]);
    expect(t.public().wallCount).toBe(83);
    expect(t.public().seats.every(p => p.revealed === undefined)).toBe(true);
    play(t, 0, 'discard', { tile: RED });
    expect(t.public().turn).toBe(ids[1]);
    expect(t.view(ids[2])?.actions).toEqual([]);
    expect(t.view(ids[1])?.actions).toContain('hu');
    const end = play(t, 1, 'hu');
    expect(end.ended).toBe(true);
    expect(end.seatResults).toEqual([
      { seatId: 's0', rank: 2, score: -1 }, { seatId: 's1', rank: 1, score: 3 },
      { seatId: 's2', rank: 2, score: -1 }, { seatId: 's3', rank: 2, score: -1 },
    ]);
    expect(t.public().seats.map(p => p.score)).toEqual([-1, 3, -1, -1]);
  });

  it('四川同一弃牌两家胡，之后仍摸打，第三家胡时结算', () => {
    const hand1 = [0, 1, 2, 0, 1, 2, 3, 4, 5, 9, 10, 11, 8];
    const hand2 = [0, 1, 2, 3, 4, 5, 9, 10, 11, 12, 13, 14, 8];
    const hand3 = [3, 4, 5, 6, 6, 6, 9, 10, 11, 12, 13, 14, 15];
    const dealer = [8, 7, 7, 7, 15, 15, 16, 16, 16, 16, 17, 17, 17, 17];
    const t = arranged(sichuan, [dealer, hand1, hand2, hand3], 8, [15]);
    expect(play(t, 0, 'discard', { tile: 8 }).views).toEqual(['s1', 's2']);
    const first = play(t, 2, 'hu');
    expect(first.events).toEqual([]);
    expect(t.public().seats[2].win).toBeNull();
    const copy = new MahjongTable(sichuan, seat(0), 100);
    copy.restoreState(t.exportState());
    expect(play(copy, 1, 'hu').ended).toBeUndefined();
    expect(copy.public().seats[0].river[0]).toMatchObject({ taken: 'hu', claimedBy: ['s1', 's2'] });
    expect(copy.public().seats.map(p => p.score)).toEqual([-2, 1, 1, 0]);
    expect(copy.view('s1')?.actions).toEqual([]);
    expect(copy.public().turn).toBe('s3');
    const end = play(copy, 3, 'hu');
    expect(end.ended).toBe(true);
    expect(end.seatResults?.map(result => result.rank)).toEqual([4, 1, 1, 1]);
    expect(copy.public().seats.map(p => p.score)).toEqual([-3, 1, 1, 1]);
  });

  it('四川流局仍按杠后净分排名，普通账本没有胡牌赢家', () => {
    const t = arranged(sichuan, [[0, 0, 0, 0], [], [], []], 0);
    const s = t.exportState();
    const last = s.wall.pop()!;
    s.players[1].river = s.wall.map(tile => ({ tile, order: ++s.discards }));
    s.wall = [last];
    t.restoreState(s);
    play(t, 0, 'kong', { tile: 0 });
    let end = play(t, 0, 'discard', { tile: t.view('s0')!.discardable[0] });
    if (t.public().phase === 'claim') end = t.tick(t.nextWakeAt()!)!;
    expect(end.ended).toBe(true);
    expect(end.events.at(-1)).toMatchObject({
      data: { winners: [], tie: true }, text: expect.stringContaining('等级分按含杠分的结算净分排名'),
    });
    expect(end.seatResults).toEqual([
      { seatId: 's0', rank: 1, score: 6 }, { seatId: 's1', rank: 2, score: -2 },
      { seatId: 's2', rank: 2, score: -2 }, { seatId: 's3', rank: 2, score: -2 },
    ]);
  });
});

describe('麻将桌与记牌', () => {
  it('换牌在全员提交后一次交换，旧窗口被拒，定缺优先打缺', () => {
    const t = table(sichuan);
    const original = t.exportState();
    const choices = original.players.map(({ hand }) => {
      const suit = [0, 1, 2].find(i => hand.filter(tile => suitOf(tile) === i).length >= 3)!;
      return hand.filter(tile => suitOf(tile) === suit).slice(0, 3);
    });
    expect(t.public().direction).toBeUndefined();
    expect(() => play(t, 0, 'exchange', { tiles: [0, 9, 18] })).toThrow(/同门/);
    for (let i = 0; i < 4; i++) play(t, i, 'exchange', { tiles: choices[i] });
    expect(t.public().phase).toBe('missing');
    const direction = t.public().direction!;
    for (let i = 0; i < 4; i++) {
      const remaining = original.players[i].hand.slice();
      for (const tile of choices[i]) remaining.splice(remaining.indexOf(tile), 1);
      const received = choices[(i + 4 - direction) % 4];
      expect(t.view(ids[i])?.hand).toEqual([...remaining, ...received].sort((a, b) => a - b));
    }
    expect(() => t.act('s0', { action: 'missing', windowId: 'm1', suit: 0 }, 1001)).toThrow(/过去/);
    const missing = suitOf(t.view('s0')!.hand[0]);
    play(t, 0, 'missing', { suit: missing });
    expect(t.public().seats[0].missing).toBeNull();
    for (let i = 1; i < 4; i++) play(t, i, 'missing', { suit: 0 });
    expect(t.public().seats[0].missing).toBe(missing);
    const active = t.view('s0')!;
    expect(active.discardable.every(tile => suitOf(tile) === missing)).toBe(true);
    expect(active.hints.every(hint => active.discardable.includes(hint.tile))).toBe(true);
  });

  it('碰后旧弃牌留记号，记牌只计一次，补杠后扣足四张及基础分', () => {
    const t = arranged(guangdong, [[0], [0, 0], [], []], 0, [3, 4, 5, 0, 6]);
    play(t, 0, 'discard', { tile: 0 });
    play(t, 1, 'pung');
    expect(t.public().seats[0].river[0]).toMatchObject({ taken: 'pung', claimedBy: ['s1'] });
    expect(t.view('s2')?.unseen[0]).toBe(1);
    expect(t.view('s1')?.kongs).toEqual([]);
    for (const i of [1, 2, 3, 0]) {
      play(t, i, 'discard', { tile: t.view(ids[i])!.drawn ?? t.view(ids[i])!.discardable[0] });
      while (t.public().phase === 'claim') t.tick(t.nextWakeAt()!);
    }
    expect(t.view('s1')?.kongs).toContain(0);
    play(t, 1, 'kong', { tile: 0 });
    expect(t.public().seats[1].melds).toEqual([{ kind: 'kong', tile: 0 }]);
    expect(t.view('s2')?.unseen[0]).toBe(0);
    expect(t.public().seats.map(p => p.score)).toEqual([-1, 3, -1, -1]);
  });

  it('直杠只由出牌者扣分，暗杠牌种仅参与者自己可见', () => {
    const exposed = arranged(guangdong, [[0], [0, 0, 0], [], []], 0);
    play(exposed, 0, 'discard', { tile: 0 });
    play(exposed, 1, 'kong');
    expect(exposed.public().seats.map(p => p.score)).toEqual([-2, 2, 0, 0]);
    const hidden = arranged(guangdong, [[0, 0, 0, 0], [], [], []], 0);
    play(hidden, 0, 'kong', { tile: 0 });
    expect(hidden.public().seats[0].melds).toEqual([{ kind: 'kong', tile: null }]);
    expect(hidden.view('s1')?.unseen[0]).toBe(4);
    expect(hidden.view('s0')?.unseen[0]).toBe(0);
    expect(hidden.public().seats.map(p => p.score)).toEqual([6, -2, -2, -2]);
  });

  for (const game of MAHJONG_GAMES) {
    it(game + ' 逐次超时可打完，提交后的状态能还原且牌张守恒', () => {
      const t = table(game);
      for (let i = 0; i < 300 && t.status === 'playing'; i++) {
        const copy = new MahjongTable(game, seat(0), 100);
        copy.restoreState(t.exportState());
        expect(copy.public()).toEqual(t.public());
        expect(t.tick(t.nextWakeAt()!)).toBeTruthy();
      }
      expect(t.status).toBe('ended');
      expect(t.public().seats.reduce((score, p) => score + p.score, 0)).toBe(0);
      expect(t.view('visitor')).toBeNull();
    });
  }
});
