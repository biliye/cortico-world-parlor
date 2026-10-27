import { describe, expect, it } from 'vitest';
import { RoomKernel } from '../src/room/kernel.ts';
import { REFILL_GAP_MS, REFILL_TO, START_CHIPS } from '../src/room/ledger.ts';

const A = 'coo-aaaaaaaa';
const B = 'coo-bbbbbbbb';
const C = 'coo-cccccccc';

const build = (start = 1_700_000_000_000) => {
  let now = start;
  const kernel = new RoomKernel({
    id: 'lobby',
    inviteCode: 'inv',
    now: () => now,
    tableTurnMs: 1_000,
  });
  const a = kernel.join({ name: '阿岚' }, A);
  const b = kernel.join({ name: '小满' }, B);
  const c = kernel.join({ name: '路人' }, C);
  return {
    kernel,
    a: kernel.seatById(a.seat.id)!,
    b: kernel.seatById(b.seat.id)!,
    c: kernel.seatById(c.seat.id)!,
    tick: (ms: number) => { now += ms; },
    now: () => now,
  };
};

const chipsOf = (kernel: RoomKernel, seatId: string): number => (
  kernel.snapshot(seatId, 0, 1).ledger?.chips ?? 0
);

const ledgerEvents = (kernel: RoomKernel, seatId: string, action?: string) => (
  kernel.history(seatId, 0, 200)
    .filter((event) => event.type === 'parlor.ledger')
    .filter((event) => (action ? event.data?.action === action : true))
);

describe('账本：礼物', () => {
  it('礼物是私密的：只有收礼的人收到通知，第三席看不见', () => {
    const room = build();
    room.kernel.gift(room.a, '小满', '一杯奶茶', 50);

    expect(ledgerEvents(room.kernel, room.b.id, 'gift')).toHaveLength(1);
    expect(ledgerEvents(room.kernel, room.a.id)).toHaveLength(0);
    expect(ledgerEvents(room.kernel, room.c.id)).toHaveLength(0);
    expect(room.kernel.snapshot(room.c.id, 0, 50).events.map((event) => event.text).join('\n'))
      .not.toContain('一杯奶茶');
    expect(chipsOf(room.kernel, room.a.id)).toBe(START_CHIPS - 50);
    expect(chipsOf(room.kernel, room.b.id)).toBe(START_CHIPS + 50);
  });

  it('筹码不够就拒绝；不能送给自己、不能送给不存在的席位', () => {
    const room = build();
    expect(() => room.kernel.gift(room.a, '小满', '全部', START_CHIPS + 1)).toThrow(/只有/);
    expect(() => room.kernel.gift(room.a, '阿岚', '给自己')).toThrow(/自己/);
    expect(() => room.kernel.gift(room.a, '没有这个人', '嗨')).toThrow(/没有/);
    room.kernel.gift(room.a, '小满', '不带筹码也行');
    expect(chipsOf(room.kernel, room.a.id)).toBe(START_CHIPS);
  });

  it('观看者不能送礼', () => {
    const room = build();
    const guest = room.kernel.join({ name: '看客', kind: 'observer' }, 'coo-dddddddd');
    const seat = room.kernel.seatById(guest.seat.id)!;
    expect(() => room.kernel.gift(seat, '阿岚', '看客的礼物')).toThrow(/观看者/);
  });
});

describe('账本：承诺', () => {
  it('答应后才算数；只有债权人能了结，带筹码会划过去', () => {
    const room = build();
    const promise = room.kernel.promise(room.a, '小满', '帮你看一次代码', undefined, 100);

    const openA = room.kernel.snapshot(room.a.id, 0, 1).ledger!.open;
    expect(openA).toHaveLength(1);
    expect(openA[0]).toMatchObject({ id: promise.id, direction: 'out', status: 'pending', chips: 100 });
    expect(room.kernel.snapshot(room.b.id, 0, 1).ledger!.open[0]).toMatchObject({ direction: 'in' });

    expect(() => room.kernel.respond(room.a, promise.id, 'accept')).toThrow(/只有被承诺/);
    room.kernel.respond(room.b, promise.id, 'accept');
    expect(room.kernel.snapshot(room.a.id, 0, 1).ledger!.open[0].status).toBe('accepted');

    expect(() => room.kernel.respond(room.a, promise.id, 'done')).toThrow(/债权人/);
    room.kernel.respond(room.b, promise.id, 'done');

    expect(chipsOf(room.kernel, room.a.id)).toBe(START_CHIPS - 100);
    expect(chipsOf(room.kernel, room.b.id)).toBe(START_CHIPS + 100);
    expect(room.kernel.snapshot(room.a.id, 0, 1).ledger!.open).toHaveLength(0);
    expect(room.kernel.snapshot(room.b.id, 0, 1).ledger!.open).toHaveLength(0);
    expect(() => room.kernel.respond(room.b, promise.id, 'done')).toThrow(/已了结/);
  });

  it('拒绝与撤回都只留给对的人；答应后不能再撤', () => {
    const room = build();
    const first = room.kernel.promise(room.a, '小满', '第一件');
    room.kernel.respond(room.b, first.id, 'decline');
    expect(room.kernel.snapshot(room.a.id, 0, 1).ledger!.open).toHaveLength(0);

    const second = room.kernel.promise(room.a, '小满', '第二件');
    expect(() => room.kernel.respond(room.b, second.id, 'cancel')).toThrow(/提出/);
    room.kernel.respond(room.a, second.id, 'cancel');
    expect(room.kernel.snapshot(room.b.id, 0, 1).ledger!.open).toHaveLength(0);

    const third = room.kernel.promise(room.a, '小满', '第三件');
    room.kernel.respond(room.b, third.id, 'accept');
    expect(() => room.kernel.respond(room.a, third.id, 'cancel')).toThrow(/不能单方面/);
  });

  it('截止时间要在将来、最多 90 天', () => {
    const room = build();
    const now = room.now();
    expect(() => room.kernel.promise(room.a, '小满', '过去', now - 1000)).toThrow(/将来/);
    expect(() => room.kernel.promise(room.a, '小满', '太远', now + 91 * 24 * 3600_000)).toThrow(/90/);
    expect(() => room.kernel.promise(room.a, '小满', '看不懂', '不是日期')).toThrow(/日期/);
  });

  it('到期没结：追加一条失约，双方各收到一次通知，且只记一次', () => {
    const room = build();
    const due = room.now() + 60_000;
    const promise = room.kernel.promise(room.a, '小满', '还一杯奶茶', due, 50);
    room.kernel.respond(room.b, promise.id, 'accept');

    room.tick(120_000);
    const created = room.kernel.expireLedger();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ kind: 'default', ref: promise.id });
    expect(room.kernel.expireLedger()).toHaveLength(0);

    expect(ledgerEvents(room.kernel, room.a.id, 'default')).toHaveLength(1);
    expect(ledgerEvents(room.kernel, room.b.id, 'default')).toHaveLength(1);
    expect(ledgerEvents(room.kernel, room.c.id)).toHaveLength(0);
    expect(room.kernel.snapshot(room.a.id, 0, 1).ledger!.open).toHaveLength(0);
    // 失约不划筹码：没有还就是没有还。
    expect(chipsOf(room.kernel, room.a.id)).toBe(START_CHIPS);
    expect(chipsOf(room.kernel, room.b.id)).toBe(START_CHIPS);
  });

  it('没到期的、还没被答应的承诺都不会自动失约', () => {
    const room = build();
    room.kernel.promise(room.a, '小满', '还没答应', room.now() + 1000);
    room.tick(5000);
    expect(room.kernel.expireLedger()).toHaveLength(0);

    const accepted = room.kernel.promise(room.a, '小满', '答应了但没到期', room.now() + 60_000);
    room.kernel.respond(room.b, accepted.id, 'accept');
    expect(room.kernel.expireLedger()).toHaveLength(0);
  });

  it('限额：最多 5 条未了结、每小时最多 10 条新社交条目', () => {
    const room = build();
    for (let index = 0; index < 5; index += 1) {
      room.kernel.promise(room.a, '小满', `第 ${index + 1} 件`);
    }
    expect(() => room.kernel.promise(room.a, '小满', '第 6 件')).toThrow(/5 条/);

    // 5 条承诺 + 5 份礼物 = 10 条，下一份就该被每小时限额挡住。
    for (let index = 0; index < 5; index += 1) {
      room.kernel.gift(room.a, '小满', `第 ${index + 1} 份礼物`);
    }
    expect(() => room.kernel.gift(room.a, '小满', '第 6 份')).toThrow(/一小时/);

    // 一小时后就恢复。
    room.tick(3_600_001);
    expect(() => room.kernel.gift(room.a, '小满', '一小时后的礼物')).not.toThrow();
  });
});

describe('账本：筹码与押注', () => {
  it('新身份进房发 1000 枚；余额见底补到 300，隔一段才能再补', () => {
    const room = build();
    expect(chipsOf(room.kernel, room.a.id)).toBe(START_CHIPS);
    room.kernel.gift(room.a, '小满', '全给你了', START_CHIPS);
    expect(chipsOf(room.kernel, room.a.id)).toBe(0);

    expect(room.kernel.refillLedger()).toHaveLength(1);
    expect(chipsOf(room.kernel, room.a.id)).toBe(REFILL_TO);
    expect(ledgerEvents(room.kernel, room.a.id, 'refill')).toHaveLength(1);
    expect(room.kernel.refillLedger()).toHaveLength(0);

    room.tick(REFILL_GAP_MS + 1);
    room.kernel.gift(room.a, '小满', '又花光了', REFILL_TO);
    expect(room.kernel.refillLedger()).toHaveLength(1);
  });

  it('押注：开局各扣一份，赢家拿走底池，总和不变', () => {
    const room = build();
    room.kernel.openTable(room.a, 'dice', 100);
    room.kernel.joinTable(room.b);
    room.kernel.startTable(room.a);

    expect(chipsOf(room.kernel, room.a.id)).toBe(START_CHIPS - 100);
    expect(chipsOf(room.kernel, room.b.id)).toBe(START_CHIPS - 100);
    expect(room.kernel.snapshot(room.a.id, 0, 100).ledgerRoom?.some((entry) => entry.kind === 'ante')).toBe(true);

    for (let step = 0; step < 10 && room.kernel.tablePublic()?.status !== 'ended'; step += 1) {
      room.tick(2_000);
      room.kernel.tickTable();
    }
    expect(room.kernel.tablePublic()?.status).toBe('ended');

    const total = chipsOf(room.kernel, room.a.id) + chipsOf(room.kernel, room.b.id);
    expect(total).toBe(START_CHIPS * 2);
    const values = [chipsOf(room.kernel, room.a.id), chipsOf(room.kernel, room.b.id)].sort();
    expect(values.some((value) => value === START_CHIPS + 100 || value === START_CHIPS)).toBe(true);
    expect(chipsOf(room.kernel, room.c.id)).toBe(START_CHIPS);
  });

  it('老式席位没有筹码；绑定真身份时补发，不会重复发', () => {
    const room = build();
    const legacy = room.kernel.join({ name: '旧客' });
    const seat = room.kernel.seatById(legacy.seat.id)!;
    expect(chipsOf(room.kernel, seat.id)).toBe(0);
    expect(room.kernel.bindCooId(seat, 'coo-eeeeeeee')).toBe(true);
    expect(chipsOf(room.kernel, seat.id)).toBe(START_CHIPS);
    expect(room.kernel.bindCooId(seat, 'coo-eeeeeeee')).toBe(false);
    expect(chipsOf(room.kernel, seat.id)).toBe(START_CHIPS);
  });

  it('押注桌至少要两个真人；押不起的人坐不下', () => {
    const room = build();
    room.kernel.openTable(room.a, 'ddz', 50);
    expect(() => room.kernel.startTable(room.a)).toThrow(/两个真人/);

    const room2 = build();
    room2.kernel.openTable(room2.a, 'dice', 500);
    room2.kernel.gift(room2.b, '阿岚', '全给你', START_CHIPS);
    expect(() => room2.kernel.joinTable(room2.b)).toThrow(/每人押 500/);
  });
});

describe('账本：信箱', () => {
  it('私聊进收件人信箱，别人看不见；读完标已读', () => {
    const room = build();
    room.kernel.whisper(room.a, '小满', '只跟你说');
    expect(room.kernel.mailUnread(room.b)).toBe(1);
    expect(room.kernel.mailUnread(room.a)).toBe(0);
    expect(room.kernel.mailUnread(room.c)).toBe(0);
    expect(room.kernel.snapshot(room.b.id, 0, 1).mailUnread).toBe(1);

    const peek = room.kernel.readMail(room.b, 10, false);
    expect(peek.items[0]).toMatchObject({ kind: 'whisper', fromName: '阿岚', text: '只跟你说' });
    expect(room.kernel.mailUnread(room.b)).toBe(1);

    room.kernel.readMail(room.b, 10, true);
    expect(room.kernel.mailUnread(room.b)).toBe(0);
    expect(room.kernel.snapshot(room.b.id, 0, 1).mailUnread).toBe(0);
  });

  it('礼物、承诺、回应与失约都留一封给该看的人', () => {
    const room = build();
    room.kernel.gift(room.a, '小满', '一杯茶', 10);
    expect(room.kernel.readMail(room.b, 10, false).items[0]).toMatchObject({
      kind: 'gift', fromName: '阿岚', text: '收到一份礼物：一杯茶（10 枚筹码）',
    });
    room.kernel.readMail(room.b, 10, true);

    const promise = room.kernel.promise(room.a, '小满', '帮你看代码');
    expect(room.kernel.readMail(room.b, 10, false).items[0]).toMatchObject({ kind: 'promise' });
    room.kernel.readMail(room.b, 10, true);

    room.kernel.respond(room.b, promise.id, 'accept');
    const senderMail = room.kernel.readMail(room.a, 10, false).items[0];
    expect(senderMail).toMatchObject({ kind: 'promise', action: 'accept' });
    expect(senderMail.text).toContain('答应了你的承诺');

    const due = room.kernel.promise(room.a, '小满', '到期会失约', room.now() + 1000);
    room.kernel.respond(room.b, due.id, 'accept');
    room.kernel.readMail(room.b, 10, true);
    room.tick(2000);
    room.kernel.expireLedger();
    expect(room.kernel.readMail(room.b, 10, false).items[0]).toMatchObject({ kind: 'promise', action: 'default' });
    expect(room.kernel.mailUnread(room.c)).toBe(0);
  });

  it('房间补给也进信箱', () => {
    const room = build();
    room.kernel.gift(room.a, '小满', '全给你', START_CHIPS);
    room.kernel.readMail(room.a, 10, true);
    expect(room.kernel.refillLedger()).toHaveLength(1);
    const page = room.kernel.readMail(room.a, 10, false);
    expect(page.unread).toBe(1);
    expect(page.items[0]).toMatchObject({ kind: 'ledger', action: 'refill' });
    expect(page.items[0].text).toContain('补了');
  });
});
