import { describe, expect, it } from 'vitest';
import { RoomKernel } from '../src/room/kernel.ts';
import { LedgerStore } from '../src/room/ledger.ts';

const A = 'coo-aaaaaaaa';
const B = 'coo-bbbbbbbb';
const C = 'coo-cccccccc';

const build = (start = 1_700_000_000_000) => {
  let now = start;
  const ledger = new LedgerStore({ now: () => now });
  const kernel = new RoomKernel({
    id: 'lobby',
    inviteCode: 'inv',
    now: () => now,
    tableTurnMs: 1_000,
    ledger,
  });
  const a = kernel.join({ name: '阿岚' }, A);
  const b = kernel.join({ name: '小满' }, B);
  const c = kernel.join({ name: '路人' }, C);
  return {
    kernel,
    ledger,
    a: kernel.seatById(a.seat.id)!,
    b: kernel.seatById(b.seat.id)!,
    c: kernel.seatById(c.seat.id)!,
    tick: (ms: number) => { now += ms; },
    now: () => now,
  };
};

const ledgerEvents = (kernel: RoomKernel, seatId: string, action?: string) => (
  kernel.history(seatId, 0, 200)
    .filter((event) => event.type === 'parlor.ledger')
    .filter((event) => (action ? event.data?.action === action : true))
);

describe('账本：礼物', () => {
  it('礼物是私密的：只有收礼的人收到通知，第三席看不见', () => {
    const room = build();
    room.kernel.gift(room.a, '小满', 'longjing', '一杯奶茶');

    expect(ledgerEvents(room.kernel, room.b.id, 'gift')).toHaveLength(1);
    expect(ledgerEvents(room.kernel, room.a.id)).toHaveLength(0);
    expect(ledgerEvents(room.kernel, room.c.id)).toHaveLength(0);
    expect(room.kernel.snapshot(room.c.id, 0, 50).events.map((event) => event.text).join('\n'))
      .not.toContain('龙井');
    // 礼物只是记一条条目：收的人手上多一件，送的人手上不多。
    expect(room.ledger.heldCount(B, 'longjing')).toBe(1);
    expect(room.ledger.heldCount(A, 'longjing')).toBe(0);
  });

  it('不能送给自己、不能送给不存在的席位、不能送茶单外的东西', () => {
    const room = build();
    expect(() => room.kernel.gift(room.a, '阿岚', 'longjing')).toThrow(/自己/);
    expect(() => room.kernel.gift(room.a, '没有这个人', 'longjing')).toThrow(/没有/);
    expect(() => room.kernel.gift(room.a, '小满', '螺蛳粉')).toThrow(/茶单/);
    expect(() => room.kernel.gift(room.a, '小满', '')).toThrow(/茶单/);

    // 全名、id、唯一前缀都认。
    room.kernel.gift(room.a, '小满', '碧螺春');
    room.kernel.gift(room.a, '小满', 'long');
    expect(room.ledger.heldCount(B, 'biluochun')).toBe(1);
    expect(room.ledger.heldCount(B, 'longjing')).toBe(1);
  });

  it('观看者不能送礼', () => {
    const room = build();
    const guest = room.kernel.join({ name: '看客', kind: 'observer' }, 'coo-dddddddd');
    const seat = room.kernel.seatById(guest.seat.id)!;
    expect(() => room.kernel.gift(seat, '阿岚', 'longjing')).toThrow(/观看者/);
  });
});

describe('账本：承诺', () => {
  it('答应后才算数；只有债权人能了结', () => {
    const room = build();
    const promise = room.kernel.promise(room.a, '小满', '帮你看一次代码');

    const openA = room.kernel.snapshot(room.a.id, 0, 1).ledger!.open;
    expect(openA).toHaveLength(1);
    expect(openA[0]).toMatchObject({ id: promise.id, direction: 'out', status: 'pending' });
    expect(room.kernel.snapshot(room.b.id, 0, 1).ledger!.open[0]).toMatchObject({ direction: 'in' });

    expect(() => room.kernel.respond(room.a, promise.id, 'accept')).toThrow(/只有被承诺/);
    room.kernel.respond(room.b, promise.id, 'accept');
    expect(room.kernel.snapshot(room.a.id, 0, 1).ledger!.open[0].status).toBe('accepted');

    expect(() => room.kernel.respond(room.a, promise.id, 'done')).toThrow(/债权人/);
    room.kernel.respond(room.b, promise.id, 'done');

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
    const promise = room.kernel.promise(room.a, '小满', '还一杯奶茶', due);
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
    // 失约只是记一笔：没有还就是没有还，不动任何持有量。
    expect(room.ledger.heldGifts(A)).toEqual({});
    expect(room.ledger.heldGifts(B)).toEqual({});
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
      room.kernel.gift(room.a, '小满', 'longjing');
    }
    expect(() => room.kernel.gift(room.a, '小满', 'longjing')).toThrow(/一小时/);

    // 一小时后就恢复。
    room.tick(3_600_001);
    expect(() => room.kernel.gift(room.a, '小满', 'longjing')).not.toThrow();
  });
});

describe('账本：喝掉与吃掉', () => {
  it('喝掉只动存货：收的减去用掉的，运气提示只是文字', () => {
    const room = build();
    room.kernel.gift(room.a, '小满', 'longjing');
    room.kernel.gift(room.a, '小满', 'guihuagao');
    expect(room.ledger.heldCount(B, 'longjing')).toBe(1);
    expect(room.ledger.heldCount(B, 'guihuagao')).toBe(1);

    const tea = room.kernel.consumeGift(room.b, 'longjing');
    expect(tea.remaining).toBe(0);
    expect(tea.luck.tone).toBe('up');
    expect(tea.luck.line).toContain('只是说说');
    expect(room.ledger.heldCount(B, 'longjing')).toBe(0);
    // 喝掉不产生新的可送之物，也不影响别人的存货。
    expect(room.ledger.heldCount(B, 'guihuagao')).toBe(1);
    expect(room.ledger.heldCount(A, 'longjing')).toBe(0);
    expect(room.ledger.usedSince(B, 0)).toBe(1);

    const snack = room.kernel.consumeGift(room.b, '桂花糕');
    expect(snack.remaining).toBe(0);
    expect(snack.luck.tone).toBe('up');
    expect(room.ledger.usedSince(B, 0)).toBe(2);
  });

  it('手上没有的东西喝不了；送出去的那份不算自己的', () => {
    const room = build();
    expect(() => room.kernel.consumeGift(room.b, 'longjing')).toThrow(/没有/);
    room.kernel.gift(room.b, '阿岚', 'moli');
    expect(() => room.kernel.consumeGift(room.b, 'moli')).toThrow(/没有/);
    expect(room.kernel.consumeGift(room.a, 'moli').remaining).toBe(0);
    expect(() => room.kernel.consumeGift(room.a, 'moli')).toThrow(/没有/);
  });

  it('两小时内第三份起说「喝太多」：文案转成运气下降，还是什么都不改', () => {
    const room = build();
    for (let index = 0; index < 3; index += 1) {
      room.kernel.gift(room.a, '小满', 'puer');
    }
    const first = room.kernel.consumeGift(room.b, 'puer');
    const second = room.kernel.consumeGift(room.b, 'puer');
    const third = room.kernel.consumeGift(room.b, 'puer');

    expect(first.luck.tone).toBe('up');
    expect(second.luck.tone).toBe('up');
    expect(third.luck.tone).toBe('down');
    expect(third.luck.delta).toBe(-1);
    expect(third.luck.line).toContain('运气 -1');
    expect(third.luck.nth).toBe(3);
    expect(third.remaining).toBe(0);
    expect(room.ledger.usedSince(B, 0)).toBe(3);
    // 吃喝不进战绩。
    expect(room.kernel.snapshot(room.b.id, 0, 50).ledger!.games).toBe(0);
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
    room.kernel.gift(room.a, '小满', 'longjing', '一杯茶');
    const giftMail = room.kernel.readMail(room.b, 10, false).items[0];
    expect(giftMail).toMatchObject({ kind: 'gift', fromName: '阿岚' });
    expect(giftMail.text).toContain('龙井');
    expect(giftMail.text).toContain('一杯茶');
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
});
