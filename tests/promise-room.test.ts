import { describe, expect, it } from 'vitest';
import { LedgerStore } from '../src/room/ledger.ts';
import { RoomKernel } from '../src/room/kernel.ts';

const A = 'coo-aaaaaaaa';
const B = 'coo-bbbbbbbb';

const make = (): { ledger: LedgerStore; kernel: RoomKernel } => {
  const ledger = new LedgerStore({ now: () => 1000 });
  const kernel = new RoomKernel({ id: 'lobby', inviteCode: 'inv', ledger });
  return { ledger, kernel };
};

const promiseIn = (ledger: LedgerStore, room: string, due = 2000) => ledger.record({
  kind: 'promise',
  room,
  from: A,
  to: B,
  text: '一杯奶茶',
  visibility: 'private',
  due,
  data: { fromName: '阿岚', toName: '小满' },
});

describe('承诺只在本客厅有效', () => {
  it('不能在这个客厅回应另一个客厅的承诺', () => {
    const { ledger, kernel } = make();
    const a = kernel.join({ name: '阿岚' }, A);
    const b = kernel.join({ name: '小满' }, B);
    const elsewhere = promiseIn(ledger, 'other');

    expect(() => kernel.respond(kernel.seatById(b.seat.id)!, elsewhere.id, 'accept'))
      .toThrow(/不在这个客厅/);
    expect(ledger.promiseStatus(elsewhere)).toBe('pending');
    expect(kernel.seatById(a.seat.id)?.cooId).toBe(A);
  });

  it('本客厅的承诺照常能回应', () => {
    const { ledger, kernel } = make();
    const a = kernel.join({ name: '阿岚' }, A);
    const b = kernel.join({ name: '小满' }, B);
    const here = promiseIn(ledger, 'lobby');

    kernel.respond(kernel.seatById(b.seat.id)!, here.id, 'accept');
    expect(ledger.promiseStatus(here)).toBe('accepted');
    expect(kernel.seatById(a.seat.id)?.cooId).toBe(A);
  });

  it('到期扫描只处理本客厅的承诺', () => {
    const { ledger, kernel } = make();
    kernel.join({ name: '阿岚' }, A);
    kernel.join({ name: '小满' }, B);
    const here = promiseIn(ledger, 'lobby');
    const elsewhere = promiseIn(ledger, 'other');
    ledger.record({ kind: 'accept', ref: here.id, room: 'lobby', from: B, to: A, text: '', visibility: 'private' });
    ledger.record({ kind: 'accept', ref: elsewhere.id, room: 'other', from: B, to: A, text: '', visibility: 'private' });

    const created = kernel.expireLedger(3000);
    expect(created.map((entry) => entry.ref)).toEqual([here.id]);
    expect(ledger.promiseStatus(here)).toBe('defaulted');
    expect(ledger.promiseStatus(elsewhere)).toBe('accepted');
  });
});
