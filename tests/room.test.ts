import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ParlorClient, ParlorHttpError } from '../src/room/client.ts';
import { RoomError, RoomKernel } from '../src/room/kernel.ts';
import { decideWake, type RoomEvent } from '../src/room/protocol.ts';
import { ParlorServer } from '../src/room/server.ts';

const until = async (predicate: () => boolean, timeout = 4000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待超时');
};

describe('可见性内核', () => {
  it('公开消息所有席位可见，私聊只有目标可见', () => {
    const kernel = new RoomKernel({ id: 'lobby', inviteCode: 'inv', maxSeats: 8 });
    const a = kernel.join({ name: '阿岚' });
    const b = kernel.join({ name: '小满' });
    const c = kernel.join({ name: '旁观' });

    const said = kernel.say(kernel.seatById(a.seat.id)!, '大家早');
    expect(kernel.history(b.seat.id, 0).map((event) => event.seq)).toContain(said.seq);
    expect(kernel.history(c.seat.id, 0).map((event) => event.seq)).toContain(said.seq);

    const quiet = kernel.whisper(kernel.seatById(a.seat.id)!, b.seat.id, '只告诉你');
    expect(kernel.history(b.seat.id, 0).map((event) => event.seq)).toContain(quiet.seq);
    expect(kernel.history(c.seat.id, 0).map((event) => event.seq)).not.toContain(quiet.seq);
  });

  it('游标之后的补看只给该席位看得见的事件', () => {
    const kernel = new RoomKernel({ id: 'lobby', inviteCode: 'inv', maxSeats: 8 });
    const a = kernel.join({ name: '阿岚' });
    const b = kernel.join({ name: '小满' });
    const c = kernel.join({ name: '旁观' });
    const from = kernel.latest();
    kernel.whisper(kernel.seatById(a.seat.id)!, b.seat.id, '悄悄话');
    kernel.say(kernel.seatById(a.seat.id)!, '公开话');

    expect(kernel.history(b.seat.id, from).map((event) => event.text)).toEqual(['悄悄话', '公开话']);
    expect(kernel.history(c.seat.id, from).map((event) => event.text)).toEqual(['公开话']);
  });

  it('会说话的席位有上限，观看者不占位', () => {
    const kernel = new RoomKernel({ id: 'lobby', inviteCode: 'inv', maxSeats: 2 });
    kernel.join({ name: '甲' });
    kernel.join({ name: '乙' });
    expect(() => kernel.join({ name: '丙' })).toThrow(RoomError);
    expect(() => kernel.join({ name: '观众', kind: 'observer' })).not.toThrow();
    expect(() => kernel.join({ name: '甲' })).toThrow(/已经有/);
  });

  it('令牌认席位，也认主人；名字冲突拒绝', () => {
    const kernel = new RoomKernel({ id: 'lobby', inviteCode: 'inv' });
    const a = kernel.join({ name: '阿岚' });
    expect(kernel.authenticate(a.token)?.role).toBe('pet');
    expect(kernel.authenticate(a.ownerToken)?.role).toBe('owner');
    expect(kernel.authenticate('nope')).toBeNull();
    expect(() => kernel.join({ name: '阿岚' })).toThrow(/已经有/);
  });

  it('@ 与私聊会唤醒，安静/离开挡位不叫闲聊', () => {
    let tick = 0;
    const kernel = new RoomKernel({ id: 'lobby', inviteCode: 'inv', now: () => (tick += 1000) });
    const a = kernel.join({ name: '阿岚' });
    const b = kernel.join({ name: '小满' });
    const seat = kernel.seatById(b.seat.id)!;
    const room = kernel.say(kernel.seatById(a.seat.id)!, '随便聊聊');
    const mention = kernel.say(kernel.seatById(a.seat.id)!, '@小满 来一下');
    const whisper = kernel.whisper(kernel.seatById(a.seat.id)!, b.seat.id, '在吗');

    expect(decideWake(room, seat).wake).toBe(false);
    expect(decideWake(mention, seat)).toMatchObject({ wake: true, addressed: true });
    expect(decideWake(whisper, seat)).toMatchObject({ wake: true, addressed: true });

    seat.tier = 'quiet';
    expect(decideWake(room, seat).wake).toBe(false);
    expect(decideWake(mention, seat).wake).toBe(true);

    seat.tier = 'off';
    expect(decideWake(mention, seat).wake).toBe(false);
    expect(decideWake(whisper, seat).wake).toBe(false);

    seat.tier = 'full';
    expect(decideWake(room, seat).wake).toBe(true);
  });

  it('骰子桌的私视图只给桌上该席位，公开桌面不含暗骰', () => {
    let now = 0;
    const kernel = new RoomKernel({ id: 'lobby', inviteCode: 'inv', now: () => (now += 1000) });
    const a = kernel.join({ name: '阿岚' });
    const b = kernel.join({ name: '小满' });
    const c = kernel.join({ name: '旁观' });
    const sa = kernel.seatById(a.seat.id)!;
    const sb = kernel.seatById(b.seat.id)!;
    kernel.openTable(sa);
    kernel.joinTable(sb);
    kernel.startTable(sa);

    const turns = (seatId: string) => kernel.history(seatId, 0, 100).filter((event) => event.type === 'parlor.table.turn');
    expect(turns(a.seat.id)).toHaveLength(1);
    expect(turns(b.seat.id)).toHaveLength(0);
    expect(turns(c.seat.id)).toHaveLength(0);
    expect(kernel.snapshot(a.seat.id, 0, 10).tablePrivate?.dice).toHaveLength(2);
    const table = kernel.tablePublic()!;
    expect(table.revealed).toBeUndefined();
    expect(JSON.stringify(table.seats)).not.toContain('dice');

    kernel.tableAction(sa, { type: 'stand' });
    expect(turns(b.seat.id)).toHaveLength(1);
  });

  it('tickTable 超时替当前席位停牌', () => {
    let now = 0;
    const kernel = new RoomKernel({ id: 'lobby', inviteCode: 'inv', now: () => now, tableTurnMs: 1000 });
    const a = kernel.join({ name: '阿岚' });
    const b = kernel.join({ name: '小满' });
    const sa = kernel.seatById(a.seat.id)!;
    const sb = kernel.seatById(b.seat.id)!;
    kernel.openTable(sa);
    kernel.joinTable(sb);
    kernel.startTable(sa);
    now = 2000;
    kernel.tickTable();
    expect(kernel.history(a.seat.id, 0, 100).map((event) => event.text).join('\n')).toContain('超时');
    expect(kernel.history(b.seat.id, 0, 100).some((event) => event.type === 'parlor.table.turn')).toBe(true);
  });

  it('一局结束按 cooId 记一条战绩，快照带摘要', () => {
    const kernel = new RoomKernel({ id: 'lobby', inviteCode: 'inv', now: () => 1000, tableTurnMs: 1000 });
    const a = kernel.join({ name: '阿岚' }, 'coo-aaaaaaaa');
    const b = kernel.join({ name: '小满' }, 'coo-bbbbbbbb');
    const sa = kernel.seatById(a.seat.id)!;
    const sb = kernel.seatById(b.seat.id)!;
    kernel.openTable(sa);
    kernel.joinTable(sb);
    kernel.startTable(sa);
    kernel.tableAction(sa, { type: 'stand' });
    kernel.tableAction(sb, { type: 'stand' });

    const snap = kernel.snapshot(a.seat.id, 0, 10);
    expect(snap.ledger?.cooId).toBe('coo-aaaaaaaa');
    expect(snap.ledger?.games).toBe(1);
    expect((snap.ledger?.wins ?? 0) + (snap.ledger?.losses ?? 0) + (snap.ledger?.draws ?? 0)).toBe(1);
    expect(snap.ledger?.byGame).toHaveLength(1);
    expect(snap.ledger?.byGame?.[0]).toMatchObject({ game: 'dice', label: '骰子', games: 1 });
    expect(
      (snap.ledger?.byGame?.[0]?.wins ?? 0)
      + (snap.ledger?.byGame?.[0]?.losses ?? 0)
      + (snap.ledger?.byGame?.[0]?.draws ?? 0),
    ).toBe(1);
    expect(snap.ledgerRoom).toHaveLength(1);
    expect(snap.ledgerRoom?.[0].text).toContain('骰子桌结束');
    expect(snap.ledgerRoom?.[0].game).toBe('dice');
    expect(kernel.snapshot(b.seat.id, 0, 10).ledger?.games).toBe(1);
  });

  it('老席位先用 legacy 身份，绑定后摘要改用 cooId', () => {
    const kernel = new RoomKernel({ id: 'lobby', inviteCode: 'inv' });
    const a = kernel.join({ name: '阿岚' });
    const seat = kernel.seatById(a.seat.id)!;
    expect(kernel.cooIdOf(seat)).toBe('legacy:lobby:s1');
    expect(kernel.snapshot(a.seat.id, 0, 1).ledger?.cooId).toBe('legacy:lobby:s1');
    expect(kernel.bindCooId(seat, 'coo-cccccccc')).toBe(true);
    expect(kernel.bindCooId(seat, 'coo-dddddddd')).toBe(false);
    expect(kernel.snapshot(a.seat.id, 0, 1).ledger?.cooId).toBe('coo-cccccccc');
  });
});

describe('房间服务器', () => {
  let scratch: string;
  let server: ParlorServer;

  beforeEach(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'parlor-room-'));
    server = new ParlorServer({ id: 'lobby', inviteCode: 'inv', port: 0, dataFile: join(scratch, 'room.json') });
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('邀请码不对拒绝加入，对了发两个令牌', async () => {
    const client = new ParlorClient(server.url);
    await expect(client.join('bad', { name: '阿岚' })).rejects.toMatchObject({ status: 403 });
    const joined = await client.join('inv', { name: '阿岚' });
    expect(joined.room).toBe('lobby');
    expect(joined.token).toBeTruthy();
    expect(joined.ownerToken).toBeTruthy();
    expect(joined.ownerToken).not.toBe(joined.token);
  });

  it('SSE 只推给能看见的席位，并记住在线', async () => {
    const client = new ParlorClient(server.url);
    const a = await client.join('inv', { name: '阿岚' });
    const b = await client.join('inv', { name: '小满' });
    const c = await client.join('inv', { name: '旁观' });
    const events: RoomEvent[] = [];
    const controller = new AbortController();
    const task = client.stream(b.token, 0, (event) => events.push(event), controller.signal).catch(() => {});
    await until(() => server.onlineSeats().includes(b.seat.id));

    const whisper = await client.action(a.token, { type: 'whisper', to: b.seat.id, text: '只给你' });
    await until(() => events.some((event) => event.seq === whisper.seq));
    const said = await client.action(a.token, { type: 'say', text: '大家好' });
    await until(() => events.some((event) => event.seq === said.seq));

    const snapshotC = await client.snapshot(c.token, 0, 50);
    expect(snapshotC.events.map((event) => event.text)).toContain('大家好');
    expect(snapshotC.events.map((event) => event.text)).not.toContain('只给你');

    controller.abort();
    await task;
  });

  it('断线后按游标补齐，不重复', async () => {
    const client = new ParlorClient(server.url);
    const a = await client.join('inv', { name: '阿岚' });
    const b = await client.join('inv', { name: '小满' });
    const first = await client.action(a.token, { type: 'say', text: '第一句' });
    const seen: number[] = [];
    const controller = new AbortController();
    const task = client.stream(b.token, first.seq, (event) => seen.push(event.seq), controller.signal).catch(() => {});
    await until(() => server.onlineSeats().includes(b.seat.id));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = await client.action(a.token, { type: 'say', text: '第二句' });
    await until(() => seen.includes(second.seq));
    expect(seen).not.toContain(first.seq);
    controller.abort();
    await task;
  });

  it('家长页能打开，令牌不对拒绝', async () => {
    const client = new ParlorClient(server.url);
    const a = await client.join('inv', { name: '阿岚' });
    const page = await fetch(`${server.url}/v1/owner?token=${encodeURIComponent(a.ownerToken)}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('家长页');
    expect(html).toContain('账本');
    const denied = await fetch(`${server.url}/v1/owner?token=nope`);
    expect(denied.status).toBe(401);
  });

  it('重启后席位与消息还在', async () => {
    const client = new ParlorClient(server.url);
    const a = await client.join('inv', { name: '阿岚' });
    await client.action(a.token, { type: 'say', text: '记住我' });
    await server.close();

    server = new ParlorServer({ id: 'lobby', inviteCode: 'inv', port: 0, dataFile: join(scratch, 'room.json') });
    await server.listen();
    const again = new ParlorClient(server.url);
    const snapshot = await again.snapshot(a.token, 0, 50);
    expect(snapshot.seat.name).toBe('阿岚');
    expect(snapshot.events.map((event) => event.text)).toContain('记住我');
    expect((await again.join('inv', { name: '新来的' })).room).toBe('lobby');
  });

  it('家长页改不了别人的挡位，也发不了消息', async () => {
    const client = new ParlorClient(server.url);
    const a = await client.join('inv', { name: '阿岚' });
    await expect(client.action(a.ownerToken, { type: 'say', text: '家长说话' })).rejects.toBeInstanceOf(ParlorHttpError);
    const result = await client.action(a.ownerToken, { type: 'set_tier', tier: 'quiet' });
    expect(result.ok).toBe(true);
    const snapshot = await client.snapshot(a.token, 0, 1);
    expect(snapshot.seat.tier).toBe('quiet');
  });

  it('桌子动作走 /v1/action，快照带桌面与自己的私视图', async () => {
    const client = new ParlorClient(server.url);
    const a = await client.join('inv', { name: '阿岚' });
    const b = await client.join('inv', { name: '小满' });
    await client.action(a.token, { type: 'table_open' });
    await client.action(b.token, { type: 'table_join' });
    await expect(client.action(b.token, { type: 'table_start' })).rejects.toMatchObject({ status: 403 });
    await client.action(a.token, { type: 'table_start' });

    const snapA = await client.snapshot(a.token, 0, 10);
    expect(snapA.table?.status).toBe('playing');
    expect(snapA.tablePrivate?.dice).toHaveLength(2);
    expect(snapA.tablePrivate?.yourTurn).toBe(true);

    await client.action(a.token, { type: 'table_action', action: 'stand' });
    const snapB = await client.snapshot(b.token, 0, 10);
    expect(snapB.tablePrivate?.yourTurn).toBe(true);
    expect(snapB.tablePrivate?.dice).toHaveLength(2);
  });

  it('同一个 cooId 换 secret 会被拒', async () => {
    const identity = { cooId: 'coo-aaaaaaaa', cooSecret: 'secret-1234567890' };
    const a = await new ParlorClient(server.url, identity).join('inv', { name: '阿岚' });
    expect(a.seat.name).toBe('阿岚');
    await expect(new ParlorClient(server.url, {
      cooId: 'coo-aaaaaaaa',
      cooSecret: 'other-secret-1234',
    }).join('inv', { name: '小满' })).rejects.toMatchObject({ status: 409 });
  });

  it('账本跟着 ledger.json 落盘，重启后还在', async () => {
    const identity = { cooId: 'coo-aaaaaaaa', cooSecret: 'secret-1234567890' };
    const client = new ParlorClient(server.url, identity);
    const a = await client.join('inv', { name: '阿岚' });
    const b = await new ParlorClient(server.url, {
      cooId: 'coo-bbbbbbbb',
      cooSecret: 'secret-bbbbbbbbbb',
    }).join('inv', { name: '小满' });
    await client.action(a.token, { type: 'table_open' });
    await client.action(b.token, { type: 'table_join' });
    await client.action(a.token, { type: 'table_start' });
    await client.action(a.token, { type: 'table_action', action: 'stand' });
    await client.action(b.token, { type: 'table_action', action: 'stand' });
    expect((await client.snapshot(a.token, 0, 1)).ledger?.games).toBe(1);

    await server.close();
    server = new ParlorServer({ id: 'lobby', inviteCode: 'inv', port: 0, dataFile: join(scratch, 'room.json') });
    await server.listen();
    const after = await new ParlorClient(server.url, identity).snapshot(a.token, 0, 1);
    expect(after.ledger?.games).toBe(1);
    expect(after.ledgerRoom?.[0].text).toContain('骰子桌结束');
  });
});

describe('账本事件与服务器时钟', () => {
  it('每秒时钟会把到期承诺记成失约，双方各收到一条私密通知', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parlor-clock-'));
    const server = new ParlorServer({ id: 'lobby', inviteCode: 'inv', port: 0, dataFile: join(dir, 'room.json') });
    await server.listen();
    try {
      const client = new ParlorClient(server.url);
      const a = await client.join('inv', { name: '阿岚' });
      const b = await client.join('inv', { name: '小满' });
      const c = await client.join('inv', { name: '旁观' });
      const seatA = server.kernel.seatById(a.seat.id)!;
      const seatB = server.kernel.seatById(b.seat.id)!;

      const promise = server.kernel.promise(seatA, '小满', '这杯奶茶要还', Date.now() + 300, 20);
      server.kernel.respond(seatB, promise.id, 'accept');

      await until(() => server.kernel.snapshot(b.seat.id, 0, 200).ledger?.open.length === 0, 6000);
      const eventOf = (seatId: string) => server.kernel.history(seatId, 0, 200)
        .filter((event) => event.type === 'parlor.ledger' && event.data?.action === 'default');
      expect(eventOf(a.seat.id)).toHaveLength(1);
      expect(eventOf(b.seat.id)).toHaveLength(1);
      expect(eventOf(c.seat.id)).toHaveLength(0);
      expect(server.kernel.snapshot(b.seat.id, 0, 1).ledger?.chips).toBe(0);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('信箱接口', () => {
  it('私聊落进收件人信箱；读一次标已读；第三席看不到', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parlor-mail-http-'));
    const server = new ParlorServer({ id: 'lobby', inviteCode: 'inv', port: 0, dataFile: join(dir, 'room.json') });
    await server.listen();
    try {
      const client = new ParlorClient(server.url);
      const a = await client.join('inv', { name: '阿岚' });
      const b = await client.join('inv', { name: '小满' });
      const c = await client.join('inv', { name: '旁观' });

      await client.action(a.token, { type: 'whisper', to: '小满', text: '你来之前留的话' });
      const peek = await client.mail(b.token, 10, true);
      expect(peek).toMatchObject({ unread: 1, marked: false });
      expect(peek.items[0]).toMatchObject({ kind: 'whisper', fromName: '阿岚', text: '你来之前留的话' });

      const read = await client.mail(b.token, 10);
      expect(read).toMatchObject({ unread: 1, marked: true });
      const again = await client.mail(b.token, 10);
      expect(again).toMatchObject({ unread: 0 });
      expect(again.items).toHaveLength(0);

      expect((await client.mail(a.token, 10)).items).toHaveLength(0);
      expect((await client.mail(c.token, 10)).items).toHaveLength(0);

      const recent = await server.mail.recent(server.kernel.cooIdOf(server.kernel.seatById(b.seat.id)!), 'lobby', 3);
      expect(recent[0]?.text).toBe('你来之前留的话');
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
