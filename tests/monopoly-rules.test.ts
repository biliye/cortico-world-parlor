import { describe, expect, it } from 'vitest';
import {
  BOARD, BOARD_SIZE, GROUPS, ITEM_LABELS, MONOPOLY_RULES, MonopolyError, MonopolyGame, PROPERTY_INDICES,
  cellAt, validateState, type ItemKind, type MonopolyState,
} from '../src/room/games/monopoly-rules.ts';

const SEATS = ['a', 'b', 'c', 'd'];

const namesOf = (seats: readonly string[]): Map<string, string> => (
  new Map(seats.map((id) => [id, id.toUpperCase()]))
);

function make(seats: readonly string[] = SEATS): MonopolyGame {
  return MonopolyGame.start({
    seats: seats.map((seatId) => ({ seatId, name: seatId.toUpperCase() })),
    shuffle: (list) => [...list],
  });
}

/** 把某个席位挪到指定格、改成指定现金；其余状态原样。 */
function patch(game: MonopolyGame, seats: readonly string[], edit: (state: MonopolyState) => void): MonopolyGame {
  const state = game.snapshot();
  edit(state);
  return MonopolyGame.restore(state, namesOf(seats));
}

function at(game: MonopolyGame, seats: readonly string[], seatId: string, pos: number, cash?: number): MonopolyGame {
  return patch(game, seats, (state) => {
    state.players[seatId]!.pos = pos;
    if (cash !== undefined) state.players[seatId]!.cash = cash;
  });
}

const player = (game: MonopolyGame, seatId: string) => game.player(seatId);

const expectError = (run: () => unknown, code: string): void => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(MonopolyError);
    expect((error as MonopolyError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛 ${code}，实际没有抛`);
};

describe('地图与数值', () => {
  it('24 格无重无漏，12 块地成 6 组，每组两块', () => {
    expect(BOARD_SIZE).toBe(24);
    expect(BOARD.map((cell) => cell.index)).toEqual([...Array(24).keys()]);
    expect(PROPERTY_INDICES).toHaveLength(12);
    const groups = Object.keys(GROUPS);
    expect(groups).toHaveLength(6);
    for (const group of groups) expect(GROUPS[group as keyof typeof GROUPS]).toHaveLength(2);
    expect(PROPERTY_INDICES.every((index) => cellAt(index).kind === 'property')).toBe(true);
  });

  it('冻结的数值和稿子一致', () => {
    expect(MONOPOLY_RULES.startingCash).toBe(1200);
    expect(MONOPOLY_RULES.startBonus).toBe(120);
    expect(MONOPOLY_RULES.rounds).toBe(12);
    expect(MONOPOLY_RULES.diceCount).toBe(2);
    expect(MONOPOLY_RULES.idleRoundsToEnd).toBe(3);
  });
});

describe('开局', () => {
  it('每人 1200、站在起点、三种道具各一张', () => {
    const game = make();
    for (const seatId of SEATS) {
      const seat = player(game, seatId);
      expect(seat.cash).toBe(1200);
      expect(seat.pos).toBe(0);
      expect(seat.items).toEqual({ signpost: 1, pass: 1, repair: 1 });
      expect(seat.bankrupt).toBe(false);
    }
    expect(game.round).toBe(1);
    expect(game.currentSeatId).toBe('a');
  });

  it('同一个席位不能占两次，少于两人不能开局', () => {
    expect(() => MonopolyGame.start({ seats: [{ seatId: 'a', name: 'A' }, { seatId: 'a', name: 'A2' }] })).toThrow(MonopolyError);
    expect(() => MonopolyGame.start({ seats: [{ seatId: 'a', name: 'A' }] })).toThrow(MonopolyError);
  });
});

describe('移动与起点奖励', () => {
  it('没越过起点不发钱', () => {
    let game = make();
    game = at(game, SEATS, 'a', 0);
    const out = game.roll('a', [1, 2]);
    expect(player(game, 'a').pos).toBe(3);
    expect(player(game, 'a').cash).toBe(1200);
    expect(out.facts.join('\n')).toContain('客厅门口 走到 街角工坊');
  });

  it('越过起点发一次，恰好落到起点也发一次', () => {
    let game = make();
    game = at(game, SEATS, 'a', 20);
    game.roll('a', [1, 2]);
    expect(player(game, 'a').pos).toBe(23);
    expect(player(game, 'a').cash).toBe(1200);

    let crossing = make();
    crossing = at(crossing, SEATS, 'a', 20);
    crossing.roll('a', [6, 5]);
    // 20 + 11 = 31 → 7，越过门口
    expect(player(crossing, 'a').pos).toBe(7);
    expect(player(crossing, 'a').cash).toBe(1320);

    let landing = make();
    landing = at(landing, SEATS, 'a', 12);
    landing.roll('a', [6, 6]);
    expect(player(landing, 'a').pos).toBe(0);
    expect(player(landing, 'a').cash).toBe(1320);
  });
});

describe('买地与租金', () => {
  it('买地扣钱、过户、进入下一位', () => {
    let game = make();
    const out = game.roll('a', [1, 1]); // 从起点走两步，落到 2 号面包房
    expect(out.nextTurn).toBeNull();
    expect(game.phase).toBe('buy');
    const bought = game.buy('a');
    expect(player(game, 'a').cash).toBe(1200 - 160);
    expect(game.property(2)!.owner).toBe('a');
    expect(bought.nextTurn).toEqual({ seatId: 'b', round: 1 });
    expect(game.currentSeatId).toBe('b');
  });

  it('别人的地自动付租，地主不在线也照付', () => {
    let game = make();
    game = patch(game, SEATS, (state) => {
      state.properties.find((property) => property.index === 2)!.owner = 'b';
    });
    game.roll('a', [1, 1]);
    expect(player(game, 'a').cash).toBe(1200 - 40);
    expect(player(game, 'b').cash).toBe(1200 + 40);
  });

  it('升级翻倍、集齐同组再乘 1.5、通行卡减半后向上取整', () => {
    let base = make();
    base = patch(base, SEATS, (state) => {
      state.properties.find((property) => property.index === 2)!.owner = 'b';
    });
    base.roll('a', [1, 1]);
    expect(1200 - player(base, 'a').cash).toBe(40);

    let upgraded = make();
    upgraded = patch(upgraded, SEATS, (state) => {
      const property = state.properties.find((entry) => entry.index === 2)!;
      property.owner = 'b';
      property.level = 1;
      property.upgradePaid = 80;
    });
    upgraded.roll('a', [1, 1]);
    expect(1200 - player(upgraded, 'a').cash).toBe(80);

    let fullGroup = make();
    fullGroup = patch(fullGroup, SEATS, (state) => {
      for (const index of [1, 2]) state.properties.find((entry) => entry.index === index)!.owner = 'b';
    });
    fullGroup.roll('a', [1, 1]);
    expect(1200 - player(fullGroup, 'a').cash).toBe(60);

    let halved = make();
    halved = patch(halved, SEATS, (state) => {
      const property = state.properties.find((entry) => entry.index === 2)!;
      property.owner = 'b';
      property.level = 1;
      property.upgradePaid = 80;
    });
    halved.useItem('a', { item: 'pass' });
    halved.roll('a', [1, 1]);
    expect(1200 - player(halved, 'a').cash).toBe(40); // 80 × 0.5
    expect(player(halved, 'b').cash).toBe(1240);
  });

  it('自己的地没升级就停在自己的地，不付钱', () => {
    let game = make();
    game = patch(game, SEATS, (state) => {
      state.properties.find((property) => property.index === 2)!.owner = 'a';
    });
    game.roll('a', [1, 1]);
    expect(game.phase).toBe('upgrade');
    expect(player(game, 'a').cash).toBe(1200);
  });
});

describe('强制付款与破产', () => {
  it('现金不够按格号从小到大卖地，回收价是标价与实付升级各 50%', () => {
    let game = make();
    game = patch(game, SEATS, (state) => {
      const first = state.properties.find((property) => property.index === 1)!;
      first.owner = 'a';
      first.upgradePaid = 0;
      const second = state.properties.find((property) => property.index === 5)!;
      second.owner = 'a';
      second.level = 1;
      second.upgradePaid = 100;
      state.players.a!.cash = 0;
      state.players.a!.pos = 6;
    });
    // 落到 8 号街区维护：交 80
    const out = game.roll('a', [1, 1]);
    expect(player(game, 'a').cash).toBe(0);
    expect(game.property(1)!.owner).toBeNull();
    expect(game.property(5)!.owner).toBe('a'); // 卖第一块就够，第二块不动
    expect(out.facts.join('\n')).toContain('卖掉 早餐铺，回收 80');
  });

  it('恰好付清余额为 0 不算破产', () => {
    let game = make();
    game = at(game, SEATS, 'a', 6, 80);
    game.roll('a', [1, 1]); // 8 号交 80
    expect(player(game, 'a').cash).toBe(0);
    expect(player(game, 'a').bankrupt).toBe(false);
  });

  it('卖光还不够：付掉剩余现金、欠款注销、破产退出、道具作废', () => {
    let game = make();
    game = patch(game, SEATS, (state) => {
      state.players.a!.cash = 0;
      state.players.a!.pos = 6;
    });
    game.roll('a', [1, 1]);
    expect(player(game, 'a').bankrupt).toBe(true);
    expect(player(game, 'a').cash).toBe(0);
    expect(player(game, 'a').items).toEqual({ signpost: 0, pass: 0, repair: 0 });
  });

  it('租金付给地主的是实付额', () => {
    let game = make();
    game = patch(game, SEATS, (state) => {
      state.properties.find((property) => property.index === 2)!.owner = 'b';
      state.players.a!.cash = 5;
    });
    game.roll('a', [1, 1]);
    expect(player(game, 'a').bankrupt).toBe(true);
    expect(player(game, 'b').cash).toBe(1205);
  });
});

describe('道具', () => {
  it('路标卡指定步数、不掷骰、照常触发落地', () => {
    let game = make();
    game = at(game, SEATS, 'a', 20);
    const out = game.useItem('a', { item: 'signpost', steps: 11 });
    expect(player(game, 'a').pos).toBe(7);
    expect(player(game, 'a').cash).toBe(1320);
    expect(player(game, 'a').items.signpost).toBe(0);
    expect(out.facts.join('\n')).toContain('用了路标卡');
  });

  it('路标卡不能站住不走，也不能超过 12 格', () => {
    let game = make();
    expectError(() => game.useItem('a', { item: 'signpost', steps: 0 }), 'bad_input');
    expectError(() => game.useItem('a', { item: 'signpost', steps: 13 }), 'bad_input');
    expect(player(game, 'a').items.signpost).toBe(1);
  });

  it('一回合只能用一张道具', () => {
    let game = make();
    game.useItem('a', { item: 'pass' });
    expectError(() => game.useItem('a', { item: 'signpost', steps: 2 }), 'wrong_phase');
    expect(player(game, 'a').items.signpost).toBe(1);
  });

  it('修缮卡半价升级，不需要站在那块地上；目标非法不耗卡', () => {
    let game = make();
    game = patch(game, SEATS, (state) => {
      state.properties.find((property) => property.index === 9)!.owner = 'a';
    });
    expectError(() => game.useItem('a', { item: 'repair', target: 10 }), 'not_available');
    expect(player(game, 'a').items.repair).toBe(1);
    game.useItem('a', { item: 'repair', target: 9 });
    expect(player(game, 'a').cash).toBe(1200 - 60);
    expect(game.property(9)!.level).toBe(1);
    expect(game.property(9)!.upgradePaid).toBe(60);
    expect(player(game, 'a').items.repair).toBe(0);
    // 升过的地不能再升
    expectError(() => game.useItem('a', { item: 'repair', target: 9 }), 'wrong_phase');
  });

  it('工坊补卡，补到的不会是已有的；三种都齐了就直接结束', () => {
    let game = make();
    game = patch(game, SEATS, (state) => {
      state.players.a!.pos = 0;
      state.players.a!.items.signpost = 0;
    });
    game.roll('a', [1, 2]); // 3 号工坊
    expect(game.phase).toBe('workshop');
    expect(game.legal().workshop).toEqual(['signpost']);
    const drawn = game.takeItem('a', { item: 'signpost' });
    expect(drawn.notes.a?.join('')).toContain('路标卡');
    expect(drawn.facts.join('')).not.toContain('路标卡');
    expect(player(game, 'a').items.signpost).toBe(1);
  });

  it('工坊三种都齐时不给选择，直接结束', () => {
    const game = make();
    game.roll('a', [1, 2]); // 3 号工坊，三种道具都在手上
    expect(game.phase).toBe('prepare');
    expect(game.currentSeatId).toBe('b');
  });
});

describe('轮转、轮数与结局', () => {
  it('12 轮走满就结束，按现金 + 地产标价 + 实付升级排名', () => {
    let game = make(['a', 'b']);
    game = patch(game, ['a', 'b'], (state) => {
      state.round = 12;
      state.turnIndex = 1;
      state.players.a!.cash = 900;
      state.players.b!.cash = 800;
      state.properties.find((property) => property.index === 1)!.owner = 'a';
      const second = state.properties.find((property) => property.index === 2)!;
      second.owner = 'a';
      second.level = 1;
      second.upgradePaid = 80;
    });
    const out = game.roll('b', [1, 1]);
    const ended = out.ended!;
    expect(ended.reason).toBe('rounds');
    expect(ended.winners).toEqual(['a']);
    const rankA = ended.ranking.find((entry) => entry.seatId === 'a')!;
    // b 落到 2 号，给 a 交 120（同组 1.5 × 升级 2 × 40）
    expect(rankA.assets).toBe(900 + 120 + 160 + 160 + 80);
    expect(rankA.bankrupt).toBe(false);
  });

  it('只剩一名未破产玩家时直接获胜，不和破产者比资产', () => {
    let game = make(['a', 'b']);
    game = patch(game, ['a', 'b'], (state) => {
      state.players.b!.cash = 0;
      state.players.b!.pos = 6;
      state.turnIndex = 1;
    });
    const out = game.roll('b', [1, 1]); // 交 80，付不起 → 破产
    expect(out.ended!.reason).toBe('last-standing');
    expect(out.ended!.winners).toEqual(['a']);
  });

  it('并列第一给 tie，破产者列末位', () => {
    let game = make(['a', 'b']);
    game = patch(game, ['a', 'b'], (state) => {
      state.players.a!.cash = 700;
      state.players.b!.cash = 700;
    });
    const out = game.finish('time');
    expect(out.ended!.tie).toBe(true);
    expect(out.ended!.winners).toEqual(['a', 'b']);
  });

  it('破产者的席位被跳过', () => {
    let game = make(['a', 'b', 'c']);
    game = patch(game, ['a', 'b', 'c'], (state) => {
      state.players.b!.bankrupt = true;
    });
    game.roll('a', [1, 1]);
    expect(game.phase).toBe('buy');
    const out = game.pass('a', [1, 1]);
    expect(out.nextTurn).toEqual({ seatId: 'c', round: 1 });
  });

  it('连续 3 个整轮没人主动动作就提前结束', () => {
    let game = make(['a', 'b']);
    let out = game.timeout([1, 1]);
    // 每轮两人各托管一次；第三轮走完时结束
    for (let step = 0; step < 5 && !game.ended; step++) {
      out = game.timeout([1, 1]);
    }
    expect(out.ended?.reason).toBe('idle');
    expect(game.ended?.reason).toBe('idle');
  });

  it('主动动作会清零空转计数', () => {
    let game = make(['a', 'b']);
    game.timeout([1, 1]); // b
    game.timeout([1, 1]); // a，第二轮
    expect(game.ended).toBeNull();
    game.pass('a', [1, 1]); // 主动
    game.timeout([1, 1]); // b
    game.timeout([1, 1]); // a
    expect(game.ended).toBeNull();
  });
});

describe('动作合法性', () => {
  it('不是自己的回合、相位不对都拒绝', () => {
    const game = make();
    expectError(() => game.roll('b', [1, 1]), 'not_your_turn');
    expectError(() => game.buy('a'), 'wrong_phase');
    expectError(() => game.takeItem('a', { item: 'pass' }), 'wrong_phase');
  });

  it('买不起就不给买这个选项', () => {
    let game = make();
    game = at(game, SEATS, 'a', 0, 100);
    game.roll('a', [1, 1]);
    expect(game.phase).not.toBe('buy');
    expect(game.currentSeatId).toBe('b');
  });

  it('骰点必须两颗、各 1–6', () => {
    const game = make();
    expectError(() => game.roll('a', [1]), 'bad_input');
    expectError(() => game.roll('a', [1, 7]), 'bad_input');
    expectError(() => game.roll('a', [0, 1]), 'bad_input');
  });
});

describe('存档', () => {
  it('存档自检拒收坏数据', () => {
    expect(() => validateState(null)).toThrow(MonopolyError);
    const state = make().snapshot();
    state.order.push('ghost');
    expect(() => validateState(state)).toThrow(MonopolyError);
  });

  it('快照 → 恢复 → 继续，和没断过一致', () => {
    const seats = ['a', 'b', 'c'];
    let game = make(seats);
    for (let step = 0; step < 7; step++) {
      const seatId = game.currentSeatId;
      if (game.phase === 'prepare') game.roll(seatId, [3 + (step % 4), 2]);
      if (game.phase === 'buy') game.pass(seatId, [1, 1]);
      else if (game.phase === 'upgrade') game.upgrade(seatId);
      else if (game.phase === 'workshop') game.takeItem(seatId, { item: 'signpost' });
    }
    const snapshot = game.snapshot();
    const restored = MonopolyGame.restore(snapshot, namesOf(seats));
    expect(restored.snapshot()).toEqual(snapshot);
    // 两边各走一步，结果仍然一致
    const seatId = restored.currentSeatId;
    restored.roll(seatId, [4, 5]);
    game.roll(seatId, [4, 5]);
    expect(restored.snapshot()).toEqual(game.snapshot());
  });

  it('规则版本对不上就拒绝加载', () => {
    const state = make().snapshot();
    state.mapVersion = 99;
    expect(() => MonopolyGame.restore(state, namesOf(SEATS))).toThrow(MonopolyError);
  });
});

describe('道具与地图文本', () => {
  it('三种道具都有中文名', () => {
    const kinds: ItemKind[] = ['signpost', 'pass', 'repair'];
    for (const kind of kinds) expect(ITEM_LABELS[kind]).toBeTruthy();
  });
});
