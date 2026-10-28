import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoomError, RoomKernel, type RoomKernelOptions } from '../src/room/kernel.ts';
import { ParlorClient } from '../src/room/client.ts';
import { ParlorServer } from '../src/room/server.ts';
import { LedgerStore } from '../src/room/ledger.ts';
import { MailStore } from '../src/room/mail.ts';
import { ReplayStore } from '../src/room/replay.ts';
import type { ActionRequest } from '../src/room/protocol.ts';

const NOW = Date.parse('2026-10-28T10:00:00+08:00');
type MonopolyBody = Extract<ActionRequest, { type: 'monopoly' }>;

let dir = '';

const stores = (clock: { now: number }) => ({
  ledger: new LedgerStore({ file: join(dir, 'ledger.json'), now: () => clock.now }),
  mail: new MailStore({ file: join(dir, 'mail.json'), now: () => clock.now }),
  replay: new ReplayStore({ file: join(dir, 'replay.jsonl'), now: () => clock.now }),
});

function setup(clock: { now: number }): { kernel: RoomKernel; options: RoomKernelOptions } {
  const options: RoomKernelOptions = {
    id: 'lobby',
    inviteCode: 'inv',
    maxSeats: 8,
    now: () => clock.now,
    activityFile: join(dir, 'activity.json'),
    ...stores(clock),
  };
  return { kernel: new RoomKernel(options), options };
}

/** 重启：同一批文件重新加载，账本/信箱/回放也从磁盘读。 */
function restart(kernel: RoomKernel, options: RoomKernelOptions, clock: { now: number }): RoomKernel {
  const raw = JSON.parse(JSON.stringify(kernel.toJSON()));
  return RoomKernel.fromJSON(raw, { ...options, ...stores(clock) });
}

const atom = (kernel: RoomKernel, seatId: string): ReturnType<RoomKernel['seatById']> => kernel.seatById(seatId);

function joinAll(kernel: RoomKernel): { a: string; b: string } {
  const a = kernel.join({ name: '阿岚' }, 'coo-aaaaaaaa');
  const b = kernel.join({ name: '小满' }, 'coo-bbbbbbbb');
  return { a: a.seat.id, b: b.seat.id };
}

const open = (kernel: RoomKernel, seatId: string, body: Partial<MonopolyBody> = {}): void => {
  kernel.monopolyAction(atom(kernel, seatId)!, { type: 'monopoly', action: 'open', ...body });
};

function startGame(kernel: RoomKernel, clock: { now: number }, seatId: string): void {
  kernel.monopolyAction(atom(kernel, seatId)!, { type: 'monopoly', action: 'start' });
  // 轮序是洗过的；先把脚本席位推到真人
  for (let step = 0; step < 10; step++) {
    const turn = (kernel.tablePublic() as { turn?: string } | undefined)?.turn ?? '';
    if (turn && kernel.seatById(turn)) return;
    clock.now += 4000;
    kernel.tickTable(clock.now);
  }
  throw new Error('轮不到真人');
}

const publicOf = (kernel: RoomKernel): Record<string, unknown> => kernel.tablePublic() as unknown as Record<string, unknown>;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'parlor-monopoly-int-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('报名与开局', () => {
  it('报名表不占桌子，够人之后发起人开局', () => {
    const clock = { now: NOW };
    const { kernel } = setup(clock);
    const { a, b } = joinAll(kernel);

    open(kernel, a, { size: 4 });
    expect(kernel.tablePublic()).toBeUndefined();
    const info = kernel.snapshot(a, 0).monopoly!;
    expect(info.signup).toMatchObject({ host: '阿岚', seats: ['阿岚'], size: 4, missing: 1, pace: 'standard' });

    kernel.monopolyAction(atom(kernel, b)!, { type: 'monopoly', action: 'join' });
    expect(kernel.snapshot(b, 0).monopoly?.signup?.missing).toBe(0);

    const receipt = kernel.monopolyAction(atom(kernel, a)!, { type: 'monopoly', action: 'start' });
    expect(receipt.seats).toEqual(['阿岚', '小满', '脚本1（脚本）', '脚本2（脚本）']);
    expect(kernel.snapshot(a, 0).monopoly?.signup).toBeUndefined();
    const table = publicOf(kernel);
    expect(table.game).toBe('monopoly');
    expect(table.round).toBe(1);
  });

  it('没有身份、没满人、非发起人都拒绝', () => {
    const clock = { now: NOW };
    const { kernel } = setup(clock);
    const { a, b } = joinAll(kernel);
    const legacy = kernel.join({ name: '老席位' }, undefined);

    open(kernel, a, { size: 4 });
    expect(() => kernel.monopolyAction(atom(kernel, legacy.seat.id)!, { type: 'monopoly', action: 'join' })).toThrow(RoomError);
    kernel.monopolyAction(atom(kernel, b)!, { type: 'monopoly', action: 'join' });
    expect(() => kernel.monopolyAction(atom(kernel, b)!, { type: 'monopoly', action: 'start' })).toThrow(/只有发起人/);
    // 两个真人 + 两个脚本刚好四人；六人局就还差人
    expect(() => {
      kernel.monopolyAction(atom(kernel, a)!, { type: 'monopoly', action: 'cancel' });
      open(kernel, a, { size: 6 });
      kernel.monopolyAction(atom(kernel, b)!, { type: 'monopoly', action: 'join' });
      kernel.monopolyAction(atom(kernel, a)!, { type: 'monopoly', action: 'start' });
    }).toThrow(/还差 2 个人/);
  });

  it('报名过期会自动取消', () => {
    const clock = { now: NOW };
    const { kernel } = setup(clock);
    const { a } = joinAll(kernel);
    open(kernel, a);
    clock.now += 24 * 60 * 60_000 + 1;
    kernel.tickTable(clock.now);
    expect(kernel.snapshot(a, 0).monopoly).toBeUndefined();
  });
});

describe('动作、截止与去重', () => {
  it('掷骰推进；同一个 requestId 拿回同一份回执', () => {
    const clock = { now: NOW };
    const { kernel } = setup(clock);
    const { a, b } = joinAll(kernel);
    open(kernel, a);
    kernel.monopolyAction(atom(kernel, b)!, { type: 'monopoly', action: 'join' });
    startGame(kernel, clock, a);

    const turn = publicOf(kernel).turn as string;
    const seat = atom(kernel, turn)!;
    const before = kernel.snapshot(turn, 0).tablePrivate as unknown as { turnSeq: number };
    const body: MonopolyBody = { type: 'monopoly', action: 'roll', requestId: 'r1', turnId: before.turnSeq };
    const first = kernel.monopolyAction(seat, body);
    expect(typeof first.text).toBe('string');
    expect(first.deadline).toBeGreaterThan(clock.now);

    const again = kernel.monopolyAction(seat, body);
    expect(again).toEqual(first);

    expect(() => kernel.monopolyAction(seat, { ...body, action: 'pass' })).toThrow(/换了内容/);
  });

  it('过期的视图（turnId 不对）会被拒绝，且不改状态', () => {
    const clock = { now: NOW };
    const { kernel } = setup(clock);
    const { a, b } = joinAll(kernel);
    open(kernel, a);
    kernel.monopolyAction(atom(kernel, b)!, { type: 'monopoly', action: 'join' });
    startGame(kernel, clock, a);
    const turn = publicOf(kernel).turn as string;
    const seat = atom(kernel, turn)!;
    const before = JSON.stringify(kernel.snapshot(turn, 0).table);
    expect(() => kernel.monopolyAction(seat, {
      type: 'monopoly', action: 'roll', requestId: 'stale', turnId: -1,
    })).toThrow(/过期/);
    expect(JSON.stringify(kernel.snapshot(turn, 0).table)).toBe(before);
  });

  it('过了回合截止，动作被拒绝，tick 接管', () => {
    const clock = { now: NOW };
    const { kernel } = setup(clock);
    const { a, b } = joinAll(kernel);
    open(kernel, a);
    kernel.monopolyAction(atom(kernel, b)!, { type: 'monopoly', action: 'join' });
    startGame(kernel, clock, a);
    const turn = publicOf(kernel).turn as string;
    const seat = atom(kernel, turn)!;
    const deadline = publicOf(kernel).deadline as number;
    clock.now = deadline;
    expect(() => kernel.monopolyAction(seat, {
      type: 'monopoly', action: 'roll', requestId: 'late',
    })).toThrow(/截止/);
    kernel.tickTable(deadline);
    expect(publicOf(kernel).deadline).toBeGreaterThan(deadline);
  });

  it('动作需要 requestId', () => {
    const clock = { now: NOW };
    const { kernel } = setup(clock);
    const { a, b } = joinAll(kernel);
    open(kernel, a);
    kernel.monopolyAction(atom(kernel, b)!, { type: 'monopoly', action: 'join' });
    startGame(kernel, clock, a);
    const seat = atom(kernel, publicOf(kernel).turn as string)!;
    expect(() => kernel.monopolyAction(seat, { type: 'monopoly', action: 'roll' })).toThrow(/requestId/);
  });
});

describe('存档与重启', () => {
  it('重启后局面、截止、报名表都还在', () => {
    const clock = { now: NOW };
    const first = setup(clock);
    const { a, b } = joinAll(first.kernel);
    open(first.kernel, a, { size: 4, pace: 'quick' });
    first.kernel.monopolyAction(atom(first.kernel, b)!, { type: 'monopoly', action: 'join' });
    startGame(first.kernel, clock, a);
    const seat = atom(first.kernel, publicOf(first.kernel).turn as string)!;
    first.kernel.monopolyAction(seat, { type: 'monopoly', action: 'roll', requestId: 'r1' });
    const before = publicOf(first.kernel);

    const second = restart(first.kernel, first.options, clock);
    const after = publicOf(second);
    expect(after.turn).toBe(before.turn);
    expect(after.round).toBe(before.round);
    expect(after.deadline).toBe(before.deadline);
    expect(after.players).toEqual(before.players);
    expect(second.snapshot(a, 0).monopoly?.fault).toBeUndefined();
  });

  it('上一手没提交完（pending）会在重启时重放，且不换骰点', () => {
    const clock = { now: NOW };
    const first = setup(clock);
    const { a, b } = joinAll(first.kernel);
    open(first.kernel, a);
    first.kernel.monopolyAction(atom(first.kernel, b)!, { type: 'monopoly', action: 'join' });
    startGame(first.kernel, clock, a);
    const turn = publicOf(first.kernel).turn as string;
    expect(first.kernel.seatById(turn)).toBeTruthy();

    // 手工伪造「已受理、没执行完」的存档：骰点已经写下来了
    const activityFile = join(dir, 'activity.json');
    const raw = JSON.parse(readFileSync(activityFile, 'utf8'));
    raw.pending = {
      key: 'k', seatId: turn, action: { type: 'roll' },
      turnSeq: raw.table.game.turnSeq, dice: [3, 4],
    };
    writeFileSync(activityFile, JSON.stringify(raw), 'utf8');

    const before = publicOf(first.kernel);
    const second = restart(first.kernel, first.options, clock);
    expect(second.snapshot(a, 0).monopoly?.fault).toBeUndefined();
    const after = JSON.parse(readFileSync(activityFile, 'utf8'));
    expect(after.pending).toBeUndefined();
    const moved = publicOf(second);
    expect(moved.phase !== 'prepare' || moved.turn !== before.turn).toBe(true);
  });

  it('服务停机不算玩家时间：重启后截止与整局时限等量顺延', () => {
    const clock = { now: NOW };
    const first = setup(clock);
    const { a, b } = joinAll(first.kernel);
    open(first.kernel, a);
    first.kernel.monopolyAction(atom(first.kernel, b)!, { type: 'monopoly', action: 'join' });
    startGame(first.kernel, clock, a);
    const before = publicOf(first.kernel) as { deadline: number; endsAt: number };

    clock.now += 60 * 60_000;
    const second = restart(first.kernel, first.options, clock);
    const after = publicOf(second) as { deadline: number; endsAt: number };
    expect(after.deadline - before.deadline).toBe(60 * 60_000);
    expect(after.endsAt - before.endsAt).toBe(60 * 60_000);
    expect(second.history(a, 0).some((event) => event.type === 'parlor.monopoly.shift')).toBe(true);
  });

  it('存档坏了就冻结并报出来，不当成没开', () => {
    const clock = { now: NOW };
    const first = setup(clock);
    const { a, b } = joinAll(first.kernel);
    open(first.kernel, a);
    first.kernel.monopolyAction(atom(first.kernel, b)!, { type: 'monopoly', action: 'join' });
    startGame(first.kernel, clock, a);

    const activityFile = join(dir, 'activity.json');
    writeFileSync(activityFile, '{坏掉的', 'utf8');
    writeFileSync(`${activityFile}.bak`, '{也坏', 'utf8');

    const second = restart(first.kernel, first.options, clock);
    expect(publicOf(second)).toBeUndefined();
    expect(second.snapshot(a, 0).monopoly?.fault).toMatch(/存档/);
  });

  it('报名表跟着房间数据重启，不用重新报名', () => {
    const clock = { now: NOW };
    const first = setup(clock);
    const { a } = joinAll(first.kernel);
    open(first.kernel, a, { size: 6 });
    const second = restart(first.kernel, first.options, clock);
    expect(second.snapshot(a, 0).monopoly?.signup?.size).toBe(6);
  });
});

describe('结局、账本与信箱', () => {
  it('整局时限到：只记一条大富翁战绩，并给每个人留一封结束信', () => {
    const clock = { now: NOW };
    const { kernel, options } = setup(clock);
    const { a, b } = joinAll(kernel);
    open(kernel, a);
    kernel.monopolyAction(atom(kernel, b)!, { type: 'monopoly', action: 'join' });
    startGame(kernel, clock, a);

    clock.now += 49 * 60 * 60_000;
    kernel.tickTable(clock.now);
    kernel.tickTable(clock.now + 1000);
    expect(publicOf(kernel).status).toBe('ended');

    const ledger = options.ledger as LedgerStore;
    const tally = ledger.summaryFor('coo-aaaaaaaa');
    expect(tally.byGame.find((row) => row.game === 'monopoly')?.games).toBe(1);
    const mail = options.mail as MailStore;
    const letters = mail.list('coo-aaaaaaaa', 'lobby', 20, false).items;
    expect(letters.some((item) => item.action === 'mail-end')).toBe(true);
    // 开局那一步只会通知第一个玩家；轮序是洗过的，所以看两个人的信箱合起来
    const both = [...letters, ...mail.list('coo-bbbbbbbb', 'lobby', 20, false).items];
    expect(both.some((item) => item.action === 'mail-turn')).toBe(true);
  });

  it('私密信息不泄漏：别人的回放与快照里没有你的道具', () => {
    const clock = { now: NOW };
    const { kernel } = setup(clock);
    const { a, b } = joinAll(kernel);
    open(kernel, a);
    kernel.monopolyAction(atom(kernel, b)!, { type: 'monopoly', action: 'join' });
    startGame(kernel, clock, a);
    const turn = publicOf(kernel).turn as string;
    const other = turn === a ? b : a;
    const snapshot = kernel.snapshot(other, 0);
    expect(snapshot.table?.text ?? '').not.toContain('路标卡');
    if (snapshot.tablePrivate) expect(snapshot.tablePrivate.legal).toBeUndefined();
    expect(snapshot.events.some((event) => event.type === 'parlor.table.turn')).toBe(false);
  });
});

describe('服务器线协议', () => {
  it('HTTP 上能报名、开局；服务器重启后这一局还在', async () => {
    const dataFile = join(dir, 'room.json');
    const server = new ParlorServer({ id: 'lobby', inviteCode: 'inv', dataFile, host: '127.0.0.1', port: 0 });
    await server.listen();
    try {
      const a = new ParlorClient(server.url, { cooId: 'coo-aaaaaaaa', cooSecret: 'secret-aaaaaaaaaaaa' });
      const b = new ParlorClient(server.url, { cooId: 'coo-bbbbbbbb', cooSecret: 'secret-bbbbbbbbbbbb' });
      const seatA = await a.join('inv', { name: '阿岚' });
      const seatB = await b.join('inv', { name: '小满' });

      await a.action(seatA.token, { type: 'monopoly', action: 'open', size: 4 });
      await b.action(seatB.token, { type: 'monopoly', action: 'join' });
      await a.action(seatA.token, { type: 'monopoly', action: 'start' });

      const snapshot = await a.snapshot(seatA.token, 0);
      expect(snapshot.table?.game).toBe('monopoly');
      expect(snapshot.monopoly?.signup).toBeUndefined();
    } finally {
      await server.close();
    }

    const second = new ParlorServer({ id: 'lobby', inviteCode: 'inv', dataFile, host: '127.0.0.1', port: 0 });
    await second.listen();
    try {
      const seat = second.kernel.seatsPublic().find((entry) => entry.name === '阿岚')!;
      const snapshot = second.kernel.snapshot(seat.id, 0);
      expect(snapshot.table?.game).toBe('monopoly');
      expect(snapshot.monopoly?.fault).toBeUndefined();
    } finally {
      await second.close();
    }
  });
});
