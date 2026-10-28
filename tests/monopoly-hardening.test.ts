import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MonopolyTable } from '../src/room/games/monopoly-table.ts';
import { MonopolyGame, MonopolyError, validateState, type MonopolyState } from '../src/room/games/monopoly-rules.ts';
import { LedgerStore, LedgerWriteError } from '../src/room/ledger.ts';
import { MailStore, MailWriteError } from '../src/room/mail.ts';
import { TableError } from '../src/room/table-engine.ts';

const NOW = Date.parse('2026-10-28T10:00:00+08:00');
const seats = (ids = ['a', 'b', 'c', 'd']) => ids.map((id) => ({ id, name: id.toUpperCase() }));

const make = (extra: Record<string, unknown> = {}): MonopolyTable => new MonopolyTable({
  host: 'a',
  seats: seats(),
  now: NOW,
  rng: () => [1, 1],
  shuffle: (list) => [...list],
  turnMs: 60_000,
  ...extra,
});

const currentOf = (table: MonopolyTable): string => (table.public() as { turn: string }).turn;

const expects = (run: () => unknown, code: string): void => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TableError);
    expect((error as TableError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛 ${code}`);
};

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'parlor-hardening-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('硬截止：动作入口自己判', () => {
  it('截止前一毫秒收，到点与之后都拒绝，状态一点没动', () => {
    const table = make();
    const deadline = table.snapshot().deadline;
    const before = table.snapshot();

    expect(() => table.act('a', { type: 'roll' }, deadline - 1)).not.toThrow();
    const settled = table.snapshot();

    const fresh = make();
    for (const offset of [0, 1, 10_000]) {
      const untouched = fresh.snapshot();
      expects(() => fresh.act('a', { type: 'roll' }, deadline + offset), 'expired');
      expect(fresh.snapshot()).toEqual(untouched);
    }
    expect(settled.game.phase).toBe('buy');
    expect(before.game.phase).toBe('prepare');
  });

  it('截止前掷骰、到点再买地：买地被拒绝', () => {
    const table = make();
    const deadline = table.snapshot().deadline;
    table.act('a', { type: 'roll' }, deadline - 1);
    const before = table.snapshot();
    expects(() => table.act('a', { type: 'buy' }, deadline), 'expired');
    expect(table.snapshot()).toEqual(before);
  });

  it('整局时限到了，玩家动作不再生效', () => {
    const table = make({ gameLimitMs: 5_000 });
    expects(() => table.act('a', { type: 'roll' }, NOW + 5_000), 'expired');
    expect(table.snapshot().status).toBe('playing');
    // tick 仍然会把这一局按时间收掉
    const step = table.tick(NOW + 5_000)!;
    expect(step.ended).toBe(true);
    expect(table.status).toBe('ended');
  });

  it('到点后 tick 照常托管，不会因为动作入口拒绝而卡住', () => {
    const table = make();
    const deadline = table.snapshot().deadline;
    expects(() => table.act('a', { type: 'roll' }, deadline), 'expired');
    const step = table.tick(deadline)!;
    expect(step.events.some((event) => event.text.includes('掷出'))).toBe(true);
    expect(table.snapshot().deadline).toBeGreaterThan(deadline);
  });
});

describe('失败动作不改状态', () => {
  it('非法路标 / 非法修缮 / 非法骰点 / 相位不对，快照完全不变', () => {
    const cases: Array<{ name: string; run: (table: MonopolyTable) => void; code: string }> = [
      { name: '路标走 0 格', run: (t) => t.act('a', { type: 'use_item', item: 'signpost', steps: 0 }, NOW), code: 'bad_action' },
      { name: '路标走 7 格', run: (t) => t.act('a', { type: 'use_item', item: 'signpost', steps: 7 }, NOW), code: 'bad_action' },
      { name: '修缮别人的地', run: (t) => t.act('a', { type: 'use_item', item: 'repair', target: 1 }, NOW), code: 'bad_action' },
      { name: '相位不对就买地', run: (t) => t.act('a', { type: 'buy' }, NOW), code: 'bad_action' },
      { name: '不认识的动作', run: (t) => t.act('a', { type: 'dance' }, NOW), code: 'bad_action' },
    ];
    for (const entry of cases) {
      const table = make();
      const before = table.snapshot();
      expects(() => entry.run(table), entry.code);
      expect(table.snapshot(), entry.name).toEqual(before);
    }
  });

  it('非法骰点不改变「本轮有没有主动动作」', () => {
    const engine = MonopolyGame.start({
      seats: seats(['a', 'b']).map((seat) => ({ seatId: seat.id, name: seat.name })),
      shuffle: (list) => [...list],
    });
    const before = engine.snapshot();
    expect(() => engine.roll('a', [0, 1])).toThrow(MonopolyError);
    expect(engine.snapshot()).toEqual(before);
  });

  it('每轮先交一次非法动作，仍然会按空转结束', () => {
    const table = make({ seats: seats(['a', 'b']) });
    const expire = (): void => { table.tick(table.snapshot().deadline); };
    for (let round = 0; round < 3; round++) {
      const current = currentOf(table);
      expects(() => table.act(current, { type: 'use_item', item: 'signpost', steps: 0 }, NOW), 'bad_action');
      expire();
      expire();
    }
    expect(table.snapshot().status).toBe('ended');
    expect(table.snapshot().ended?.reason).toBe('idle');
  });
});

describe('存档自检', () => {
  const state = (): MonopolyState => MonopolyGame.start({
    seats: seats(['a', 'b']).map((seat) => ({ seatId: seat.id, name: seat.name })),
    shuffle: (list) => [...list],
  }).snapshot();

  const rejects = (mutate: (value: MonopolyState) => void): void => {
    const value = structuredClone(state());
    mutate(value);
    expect(() => validateState(value)).toThrow(MonopolyError);
    expect(() => MonopolyGame.restore(value, new Map([['a', 'A'], ['b', 'B']]))).toThrow(MonopolyError);
  };

  it('缺道具、负现金、越界位置、越界下标全部拒绝', () => {
    rejects((value) => { delete (value.players.a as unknown as Record<string, unknown>).items; });
    rejects((value) => { value.players.a!.cash = -1; });
    rejects((value) => { value.players.a!.pos = 999; });
    rejects((value) => { value.turnIndex = 99; });
  });

  it('地产重复、陌生地主、负道具、破产却还有现金全部拒绝', () => {
    rejects((value) => { value.properties[1]!.index = value.properties[0]!.index; });
    rejects((value) => { value.properties[0]!.owner = 'ghost'; });
    rejects((value) => { value.players.a!.items.signpost = -1; });
    rejects((value) => { value.players.a!.bankrupt = true; });
  });

  it('相位与等待地块对不上、结局字段缺失都拒绝', () => {
    rejects((value) => { value.phase = 'buy'; value.pending = null; });
    rejects((value) => { value.phase = 'workshop'; value.pending = 2; });
    rejects((value) => { delete (value as unknown as Record<string, unknown>).ended; });
    rejects((value) => { value.pending = 3; });
  });

  it('桌子的席位、时间、状态也要对得上', () => {
    const table = make();
    const snapshot = table.snapshot();
    const options = { host: 'a', seats: seats(), now: NOW, rng: () => [1, 1] as [number, number], shuffle: (list: readonly string[]) => [...list] };

    expect(() => MonopolyTable.restore({ ...snapshot, seats: snapshot.seats.slice(0, 1) }, options)).toThrow(TableError);
    expect(() => MonopolyTable.restore({ ...snapshot, endsAt: snapshot.startedAt }, options)).toThrow(TableError);
    expect(() => MonopolyTable.restore({ ...snapshot, auto: ['ghost'] }, options)).toThrow(TableError);
    expect(() => MonopolyTable.restore({ ...snapshot, status: 'ended' }, options)).toThrow(TableError);
    expect(() => MonopolyTable.restore(
      { ...snapshot, game: { ...snapshot.game, order: ['a', 'b', 'ghost', 'd'] } },
      options,
    )).toThrow(TableError);
  });

  it('正常快照仍然能原样恢复', () => {
    const table = make();
    table.act('a', { type: 'roll' }, NOW);
    const snapshot = table.snapshot();
    const restored = MonopolyTable.restore(snapshot, {
      host: 'a', seats: seats(), now: NOW + 1000, rng: () => [1, 1], shuffle: (list) => [...list], turnMs: 60_000,
    });
    expect(restored.snapshot()).toEqual(snapshot);
  });
});

describe('故障要能看见', () => {
  it('托管时掷骰失败会抛错，不再假装「这次不用推进」', () => {
    const table = make({
      rng: () => { throw new Error('injected-rng-failure'); },
    });
    const deadline = table.snapshot().deadline;
    expect(() => table.tick(deadline)).toThrow('injected-rng-failure');
    expect(table.snapshot().status).toBe('playing');
  });
});

describe('副作用要确认落盘', () => {
  const blockedFile = (name: string): string => {
    writeFileSync(join(dir, 'blocker'), 'not a directory', 'utf8');
    return join(dir, 'blocker', name);
  };

  it('账本写不进去：抛错、回滚，不留内存里的成功', () => {
    const ledger = new LedgerStore({ file: blockedFile('ledger.json'), now: () => NOW });
    const input = {
      kind: 'game' as const,
      room: 'lobby',
      from: 'room',
      participants: ['coo-aaaaaaaa'],
      winners: ['coo-aaaaaaaa'],
      text: '大富翁结束',
      visibility: 'room' as const,
      data: { game: 'monopoly' },
    };
    expect(() => ledger.recordOnce('g1/result', input)).toThrow(LedgerWriteError);
    expect(ledger.count()).toBe(0);
  });

  it('账本修好重试：只写一条，重启后还在', () => {
    const file = blockedFile('ledger.json');
    const ledger = new LedgerStore({ file, now: () => NOW });
    const input = {
      kind: 'game' as const,
      room: 'lobby',
      from: 'room',
      participants: ['coo-aaaaaaaa'],
      winners: ['coo-aaaaaaaa'],
      text: '大富翁结束',
      visibility: 'room' as const,
      data: { game: 'monopoly' },
    };
    expect(() => ledger.recordOnce('g1/result', input)).toThrow(LedgerWriteError);
    rmSync(join(dir, 'blocker'));
    mkdirSync(join(dir, 'blocker'));
    const first = ledger.recordOnce('g1/result', input);
    const second = ledger.recordOnce('g1/result', input);
    expect(second.id).toBe(first.id);
    expect(ledger.count()).toBe(1);
    const reloaded = LedgerStore.load({ file, now: () => NOW });
    expect(reloaded.count()).toBe(1);
  });

  it('信箱写不进去：抛错、回滚、序号不跳号', () => {
    const file = blockedFile('mail.json');
    const mail = new MailStore({ file, now: () => NOW });
    expect(() => mail.appendOnce('g1/turn/1/coo-aaaaaaaa', {
      room: 'lobby', to: 'coo-aaaaaaaa', kind: 'ledger', fromName: '客厅', text: '轮到你',
    })).toThrow(MailWriteError);
    expect(mail.count()).toBe(0);

    rmSync(join(dir, 'blocker'));
    mkdirSync(join(dir, 'blocker'));
    const first = mail.appendOnce('g1/turn/1/coo-aaaaaaaa', {
      room: 'lobby', to: 'coo-aaaaaaaa', kind: 'ledger', fromName: '客厅', text: '轮到你',
    });
    expect(first.seq).toBe(1);
  });
});

describe('结局文本与工坊环', () => {
  it('六人结局把六个人都写出来，并带现金/地产构成', () => {
    const table = make({ seats: seats(['s0', 's1', 's2', 's3', 's4', 's5']), host: 's0' });
    table.tick(NOW + 48 * 60 * 60_000);
    const text = table.publicText();
    for (let index = 0; index < 6; index++) expect(text).toContain(`S${index} `);
    expect(text).toContain('现金');
    expect(text).toContain('地产');
  });

  it('路标卡最多 6 格：3 号工坊到不了 15 号，双工坊往返环断掉', () => {
    const engine = MonopolyGame.start({
      seats: seats(['a', 'b']).map((seat) => ({ seatId: seat.id, name: seat.name })),
      shuffle: (list) => [...list],
    });
    expect(() => engine.useItem('a', { item: 'signpost', steps: 12 })).toThrow(MonopolyError);
    expect(engine.snapshot().players.a!.items.signpost).toBe(1);
  });
});
