import { describe, expect, it } from 'vitest';
import { MonopolyTable, BOT_DELAY_MS, GAME_LIMIT_MS, compactBoard } from '../src/room/games/monopoly-table.ts';
import { TableError } from '../src/room/table-engine.ts';

const NOW = Date.parse('2026-10-28T10:00:00+08:00');

const seats = (ids = ['a', 'b', 'c']) => ids.map((id) => ({ id, name: id.toUpperCase() }));

function make(options: Partial<ConstructorParameters<typeof MonopolyTable>[0]> = {}): MonopolyTable {
  return new MonopolyTable({
    host: 'a',
    seats: seats(),
    now: NOW,
    rng: () => [1, 1],
    shuffle: (list) => [...list],
    turnMs: 60_000,
    ...options,
  });
}

const expectThrow = (run: () => unknown, code: string): void => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TableError);
    expect((error as TableError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛 ${code}`);
};

describe('开局与席位', () => {
  it('开局即进行中，轮序与截止都定下来', () => {
    const table = make();
    expect(table.status).toBe('playing');
    expect(table.game).toBe('monopoly');
    expect(table.label).toBe('大富翁');
    expect(table.host).toBe('a');
    expect(table.seatIds()).toEqual(['a', 'b', 'c']);
    const view = table.view('a') as Record<string, unknown>;
    expect(view.yourTurn).toBe(true);
    expect(view.round).toBe(1);
    expect(view.deadline).toBe(NOW + 60_000);
  });

  it('开局后不能加人，也不能再开始一次', () => {
    const table = make();
    expectThrow(() => table.join({ id: 'd', name: 'D' }), 'not_open');
    expectThrow(() => table.start('a', NOW), 'not_open');
  });

  it('不是自己的回合不能动作', () => {
    const table = make();
    expectThrow(() => table.act('b', { type: 'roll' }, NOW), 'not_turn');
  });

  it('不认识的动作有明确回话', () => {
    const table = make();
    expectThrow(() => table.act('a', { type: 'dance' }, NOW), 'bad_action');
  });
});

describe('回合推进与私视图', () => {
  it('掷骰进入落地选择，同一回合的第二步不另推私视图', () => {
    const table = make();
    const step = table.act('a', { type: 'roll' }, NOW);
    expect(step.views).toEqual([]);
    expect(step.events.some((event) => event.text.includes('掷出 1 + 1 = 2'))).toBe(true);
    const view = table.view('a') as Record<string, unknown>;
    expect(view.phase).toBe('buy');
    expect(view.pending).toBe(2);
  });

  it('买完地进入下一位，并只给下一位推私视图', () => {
    const table = make();
    table.act('a', { type: 'roll' }, NOW);
    const step = table.act('a', { type: 'buy' }, NOW);
    expect(step.views).toEqual(['b']);
    expect(table.view('a')).not.toBeNull();
    const own = table.view('a') as Record<string, unknown>;
    expect(own.yourTurn).toBe(false);
    expect((own.legal as unknown)).toBeUndefined();
  });

  it('公开文本不泄露别人手上的牌', () => {
    const table = make();
    const text = table.publicText();
    expect(text).toContain('大富翁');
    expect(text).not.toContain('路标卡');
    const privateText = table.privateText('a', NOW)!;
    expect(privateText).toContain('路标卡');
    expect(privateText).toContain('地图：');
  });

  it('不是本人就看不到私视图', () => {
    const table = make();
    expect(table.view('zzz')).toBeNull();
    expect(table.privateText('zzz', NOW)).toBeNull();
  });
});

describe('截止与托管', () => {
  it('截止前不动，到点按默认动作走完', () => {
    const table = make();
    expect(table.tick(NOW + 59_999)).toBeNull();
    const step = table.tick(NOW + 60_000)!;
    expect(step.events.some((event) => event.text.includes('掷出'))).toBe(true);
    expect(step.views).toEqual(['b']);
  });

  it('托管席位下一拍就出手，不再等截止', () => {
    const table = make();
    table.act('a', { type: 'set_auto', on: true }, NOW);
    table.act('a', { type: 'roll' }, NOW);
    table.act('a', { type: 'buy' }, NOW); // 轮到 b
    table.act('b', { type: 'set_auto', on: true }, NOW);
    const step = table.tick(NOW + 1);
    expect(step).not.toBeNull();
    expect(step!.events.some((event) => event.text.includes('托管') || event.text.includes('掷出'))).toBe(true);
  });

  it('托管在准备阶段也照常掷骰，不会原地跳过', () => {
    const table = make();
    table.act('a', { type: 'set_auto', on: true }, NOW);
    const step = table.tick(NOW + 1)!;
    expect(step.events.some((event) => event.text.includes('掷出 1 + 1'))).toBe(true);
  });

  it('脚本陪练要等一下才出手', () => {
    const table = make({ seats: [seats()[0]!, { id: 'bot', name: '脚本', bot: true }] });
    table.act('a', { type: 'roll' }, NOW);
    table.act('a', { type: 'buy' }, NOW); // 轮到脚本
    expect(table.tick(NOW + BOT_DELAY_MS - 1)).toBeNull();
    const step = table.tick(NOW + BOT_DELAY_MS)!;
    expect(step.events.length).toBeGreaterThan(0);
  });

  it('整局时限到就按资产结算', () => {
    const table = make({ gameLimitMs: 5_000 });
    const step = table.tick(NOW + 5_000)!;
    expect(step.ended).toBe(true);
    const end = step.events.find((event) => event.type === 'parlor.table.end')!;
    expect(end.data?.reason).toBe('time');
    expect(end.data?.game).toBe('monopoly');
    expect(end.data?.gameLabel).toBe('大富翁');
    expect(Array.isArray(end.data?.winners)).toBe(true);
    expect(table.status).toBe('ended');
  });

  it('结束后 tick 不再推进', () => {
    const table = make({ gameLimitMs: 5_000 });
    table.tick(NOW + 5_000);
    expect(table.tick(NOW + 60_000)).toBeNull();
  });
});

describe('存档', () => {
  it('快照 → 恢复 → 继续，截止与托管都还在', () => {
    const table = make();
    table.act('a', { type: 'roll' }, NOW);
    table.act('a', { type: 'buy' }, NOW);
    table.act('b', { type: 'set_auto', on: true }, NOW);
    const snapshot = table.snapshot();
    const restored = MonopolyTable.restore(snapshot, {
      host: 'a', seats: seats(), now: NOW + 10_000, rng: () => [1, 1], shuffle: (list) => [...list], turnMs: 60_000,
    });
    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.isAuto('b')).toBe(true);
    // 截止没有被「恢复时刻」重算
    expect(snapshot.deadline).toBe(NOW + 60_000);
  });

  it('存档版本不认识就拒绝', () => {
    const table = make();
    const snapshot = { ...table.snapshot(), version: 9 as 1 };
    expect(() => MonopolyTable.restore(snapshot, {
      host: 'a', seats: seats(), now: NOW, rng: () => [1, 1], shuffle: (list) => [...list],
    })).toThrow(TableError);
  });
});

describe('给模型看的话', () => {
  it('地图是紧凑一行，包含 24 格与价格', () => {
    const board = compactBoard();
    expect(board).toContain('0客厅门口');
    expect(board).toContain('21小剧场F 360');
    expect(board.split('·')).toHaveLength(24);
  });

  it('轮到本人时私文本带合法动作与截止', () => {
    const table = make();
    const text = table.privateText('a', NOW)!;
    expect(text).toContain('轮到你');
    expect(text).toContain('parlor_monopoly');
    expect(text).toContain('服务器时刻');
  });

  it('等别人时只写下一个截止，不给动作提示', () => {
    const table = make();
    table.act('a', { type: 'roll' }, NOW);
    table.act('a', { type: 'buy' }, NOW);
    const text = table.privateText('a', NOW)!;
    expect(text).toContain('等 B');
    expect(text).not.toContain('parlor_monopoly');
  });
});

describe('常量', () => {
  it('整局上限是 48 小时', () => {
    expect(GAME_LIMIT_MS).toBe(48 * 60 * 60_000);
  });
});
