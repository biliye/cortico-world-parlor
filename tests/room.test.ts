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
    expect(await page.text()).toContain('家长页');
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
});
