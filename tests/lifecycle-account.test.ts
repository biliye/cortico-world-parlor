import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorldServer } from '../src/room/world-server.ts';
import { CooAccountDb } from '../src/room/coo-account-db.ts';
import { createRoom, activeSeatForCoo, getRoom, hashSeatToken, archive, joinSeat } from '../src/room/room-seat-db.ts';
import { RoomHost } from '../src/room/room-host.ts';
import { LedgerDb } from '../src/room/ledger-db.ts';
import { personalHistory } from '../src/room/personal-account.ts';
import { pgServerStorage } from './helpers/pg.ts';
import { withTransaction } from '../src/room/db.ts';
import { PgDb } from '../src/room/storage/postgres.ts';
import { lockRoomRow } from '../src/room/storage/locks.ts';
import { touchActivity } from '../src/room/activity.ts';

const A = 'coo-lifecycle-a';
const B = 'coo-lifecycle-b';
const HOUR = 3_600_000;
let app: WorldServer;
let now: number;
let room: RoomHost;
let token: string;
let storage: Awaited<ReturnType<typeof pgServerStorage>>;
beforeEach(async () => {
  now = Date.now();
  storage = await pgServerStorage(':memory:');
  app = await WorldServer.create({ ...storage, inviteCode:'life-test', now:() => now });
  const coos = new CooAccountDb(app.dbHandle, { now:() => now });
  for (const id of [A, B]) expect(await coos.registerCoo(id, `test-secret-${id}-0123456789`, 'pet', id)).toBe('ok');
  await createRoom(app.dbHandle, { id:'r-life', name:'测试客厅', ownerCooId:A, visibility:'public' }, now);
  room = await RoomHost.create(app.dbHandle, 'r-life', { now:() => now });
  token = (await room.join(A, { name:'小满', kind:'pet' })).token;
  await app.dbHandle.prepare('UPDATE room_seats SET location_capable=1 WHERE coo_id=?').run(A);
});
afterEach(async () => { await app?.close(); });

describe('300 分钟闲置、48 小时归档与全局账户', () => {
  it('迁厅后再释放席位，旧地址重新入座只读一次请求体并保留入场码/名字/类型/挡位', async () => {
    const {url} = await app.listen();
    now += 5 * HOUR;
    expect((await app.runLifecycle()).moved).toBe(1);
    const hall = await RoomHost.create(app.dbHandle, 'hall', { now:() => now });
    await hall.leave(A);
    const response = await fetch(url + '/v1/rooms/r-life/join', {
      method:'POST', signal:AbortSignal.timeout(3000),
      headers:{'content-type':'application/json','x-parlor-coo':A,'x-parlor-coo-secret':`test-secret-${A}-0123456789`},
      body:JSON.stringify({invite:'life-test',name:'回厅新名字',kind:'pet',tier:'quiet'}),
    });
    expect(response.status).toBe(200);
    const joined = await response.json() as {room:string;seat:{name:string;kind:string;tier:string}};
    expect(joined).toMatchObject({room:'hall',seat:{name:'回厅新名字',kind:'pet',tier:'quiet'}});
    expect((await activeSeatForCoo(app.dbHandle,A))?.roomId).toBe('hall');
    expect(await app.dbHandle.prepare('SELECT return_room_id FROM coo_sessions WHERE coo_id=?').get(A)).toMatchObject({return_room_id:null});
  });
  it('同一席位新旧连接混用时暂缓闲置迁厅，最后一个旧连接关闭后才迁移', async () => {
    const {url} = await app.listen();
    const modern = new AbortController();
    const legacy = new AbortController();
    try {
      await fetch(url + `/v1/rooms/r-life/stream?token=${token}&cap=seat-location-v1`,{signal:modern.signal});
      await fetch(url + `/v1/rooms/r-life/stream?token=${token}`,{signal:legacy.signal});
      now += 5 * HOUR;
      expect((await app.runLifecycle()).moved).toBe(0);
      modern.abort();
      expect((await app.runLifecycle()).moved).toBe(0);
      legacy.abort();
      await vi.waitFor(async () => { expect((await app.runLifecycle()).moved).toBe(1); }, {timeout:3000,interval:20});
    } finally { modern.abort(); legacy.abort(); }
  });
  it.each(['pet','observer'] as const)('归档先取得房间锁：并发 %s 入座必须等提交后拒绝，不留下席位或续活动时钟', async kind => {
    await room.leave(A);
    const before = await app.dbHandle.prepare('SELECT business_active_at FROM rooms WHERE id=?').get('r-life');
    const joiner = await PgDb.open({url:storage.databaseUrl!,applicationName:'parlor-join-race'});
    let unlock!:()=>void;
    let locked!:()=>void;
    const gate = new Promise<void>(resolve => {unlock=resolve;});
    const ready = new Promise<void>(resolve => {locked=resolve;});
    const archiving = withTransaction(app.dbHandle, async () => {
      await lockRoomRow(app.dbHandle,'r-life');
      await archive(app.dbHandle,'r-life',now);
      locked(); await gate;
    });
    await ready;
    const host = await RoomHost.create(joiner,'r-life',{now:()=>now+1000});
    const entering = (kind === 'pet' ? host.join(B,{name:'并发来客',kind}) : joinSeat(joiner,{
      roomId:'r-life',cooId:B,name:'并发观察者',kind,token:'observer-race-token',visibleFromSeq:0,now:now+1000,
    })).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    try {
      await vi.waitFor(async () => {
        const waiting = await app.dbHandle.prepare("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name='parlor-join-race' AND wait_event_type='Lock'").get();
        expect(waiting).toBeTruthy();
      },{timeout:3000,interval:20});
      unlock();await archiving;
      expect((await entering).error?.code).toBe(kind === 'pet' ? 'conflict' : 'room_archived');
      expect(await activeSeatForCoo(app.dbHandle,B)).toBeNull();
      expect(await app.dbHandle.prepare('SELECT business_active_at FROM rooms WHERE id=?').get('r-life')).toEqual(before);
    } finally {unlock();await archiving;await entering;await joiner.close();}
  });
  it('入座先完成：新的真实活动阻止48小时归档；业务位置冲突使用可恢复错误码', async () => {
    now += 48*HOUR;
    await room.join(B,{name:'及时进来的客人'});
    expect((await app.runLifecycle()).archived).toBe(0);
    await expect(touchActivity(app.dbHandle,'missing-room',A,now)).rejects.toMatchObject({code:'conflict'});
    await archive(app.dbHandle,'r-life',now);
    await expect(withTransaction(app.dbHandle,()=>touchActivity(app.dbHandle,'r-life',B,now))).rejects.toMatchObject({code:'conflict'});
  });
  it('旧客户端未声明位置恢复能力时不强制闲置迁厅，升级后才启用', async () => {
    await app.dbHandle.prepare('UPDATE room_seats SET location_capable=0 WHERE coo_id=?').run(A);
    now += 5 * HOUR;
    expect((await app.runLifecycle()).moved).toBe(0);
    await app.dbHandle.prepare('UPDATE room_seats SET location_capable=1 WHERE coo_id=?').run(A);
    expect((await app.runLifecycle()).moved).toBe(1);
  });
  it('299 分钟不迁，300 分钟原子迁厅，原令牌仅在新席位有效，重复扫描幂等', async () => {
    now += 299 * 60_000;
    expect((await app.runLifecycle()).moved).toBe(0);
    // Snapshot / background reads do not renew the business timestamp.
    await room.snapshot(A);
    now += 60_000;
    expect((await app.runLifecycle()).moved).toBe(1);
    const moved = await activeSeatForCoo(app.dbHandle, A);
    expect(moved?.roomId).toBe('hall');
    expect(moved?.tokenHash).toBe(hashSeatToken(token));
    await expect(room.seatByToken(token)).rejects.toThrow();
    expect((await app.runLifecycle()).moved).toBe(0);
    // 迁厅只动席位，不动账本条目。
    expect(await new LedgerDb(app.dbHandle).count()).toBe(0);
  });
  it('本人成功聊天续时，持续 SSE 不作为活动；满大厅时源席位完整保留', async () => {
    now += 299 * 60_000;
    await room.say(A, '我还在这里');
    now += 2 * 60_000;
    expect((await app.runLifecycle()).moved).toBe(0);
    // A full hall produces a readable store refusal and rolls the source release back.
    await app.dbHandle.prepare("UPDATE rooms SET capacity=2 WHERE id='hall'").run();
    const hall = await RoomHost.create(app.dbHandle, 'hall', { now:() => now });
    await hall.join(B, { name:'另一位', kind:'pet' });
    const coos = new CooAccountDb(app.dbHandle);
    expect(await coos.registerCoo('coo-lifecycle-c', 'test-secret-coo-c-0123456789', 'pet', '第三位')).toBe('ok');
    await hall.join('coo-lifecycle-c', { name:'第三位', kind:'pet' });
    now += 5 * HOUR;
    expect((await app.runLifecycle()).moved).toBe(0);
    expect((await activeSeatForCoo(app.dbHandle, A))?.roomId).toBe('r-life');
    expect((await room.seatByToken(token)).cooId).toBe(A);
  });
  it('等人牌桌也保护席位与客厅，归档不能中断活动桌', async () => {
    await room.openTable(A, { game:'ddz' }, 'open-protected');
    now += 49 * HOUR;
    const result = await app.runLifecycle();
    expect(result).toEqual({ moved:0, archived:0 });
    expect((await getRoom(app.dbHandle, 'r-life'))?.archivedAt).toBeNull();
  });
  it('48 小时归档保留战绩与礼物流水，在大厅查询自己的跨厅记录且不能读别人的流水', async () => {
    const ledger = new LedgerDb(app.dbHandle, { now:() => now });
    await ledger.record({ kind:'game', game:'ddz', room:'r-life', from:'room', participants:[A], winners:[A], effectId:'game-test/result', data:{tableId:'game-test'}, text:'地主胜', visibility:'room' });
    await ledger.record({ kind:'gift', room:'r-life', from:'room', to:A, text:'一份龙井', visibility:'private', data:{itemId:'longjing',itemName:'龙井'} });
    const before = await ledger.count();
    now += 48 * HOUR;
    expect((await app.runLifecycle()).archived).toBe(1);
    expect((await getRoom(app.dbHandle, 'r-life'))?.archivedAt).not.toBeNull();
    // 归档不裁条目：战绩与礼物都还在。
    expect(await ledger.count()).toBe(before);
    const page = await personalHistory(app.dbHandle, A);
    expect(page.items[0]).toMatchObject({ room:'r-life', result:'win' });
    expect((await personalHistory(app.dbHandle, A, { kind:'gifts' })).items[0])
      .toMatchObject({ itemId:'longjing', direction:'in' });
    expect((await personalHistory(app.dbHandle, B)).items).toEqual([]);
    expect((await personalHistory(app.dbHandle, B, { kind:'gifts' })).items).toEqual([]);
    expect((await ledger.summaryFor(A)).games).toBe(1);
  });
  it('真实业务活动阻止归档，系统自动迁厅不会给原客厅续时', async () => {
    now += 47 * HOUR;
    await room.say(A, '有人在');
    now += 2 * HOUR;
    expect((await app.runLifecycle()).archived).toBe(0);
    now += 46 * HOUR;
    expect((await app.runLifecycle()).archived).toBe(1);
    expect((await getRoom(app.dbHandle, app.hallId))?.archivedAt).toBeNull();
    expect((await getRoom(app.dbHandle, 'lobby'))?.archivedAt).toBeNull();
  });
  it('全局记录分页不重复，筛选按身份和发生地点；非法参数拒绝', async () => {
    const ledger = new LedgerDb(app.dbHandle, { now:() => now });
    for (let i=0;i<4;i++) await ledger.record({ kind:'game', game:i===3?'dice':'ddz', room:'r-life', from:'room', participants:[A], winners:[], text:`结果${i}`, visibility:'room' });
    const first = await personalHistory(app.dbHandle, A, { limit:2 });
    const second = await personalHistory(app.dbHandle, A, { limit:2, before:first.next! });
    expect(new Set([...first.items,...second.items].map(row => row.id)).size).toBe(4);
    expect(second.next).toBeNull();
    expect((await personalHistory(app.dbHandle, A, { game:'dice', room:'r-life' })).items).toHaveLength(1);
    await expect(personalHistory(app.dbHandle, A, { from:100, until:99 })).rejects.toThrow();
  });
  it('HTTP 位置查询跟随迁厅，旧厅拒绝访问；承诺新写入返回停用且不写条目', async () => {
    const {url} = await app.listen();
    now += 5 * HOUR;
    await app.runLifecycle();
    const headers = { authorization:`Bearer ${token}` };
    const current = await fetch(url + '/v1/me/location', { headers });
    expect(current.status).toBe(200);
    expect((await current.json() as {room:string}).room).toBe('hall');
    expect((await fetch(url + '/v1/rooms/r-life/room', { headers })).status).toBe(401);
    const ledger = new LedgerDb(app.dbHandle);
    const before = await ledger.count();
    const response = await fetch(url + '/v1/rooms/hall/action', { method:'POST', headers:{...headers,'content-type':'application/json'}, body:JSON.stringify({type:'promise',to:'另一位',text:'不再创建'}) });
    expect(response.status).toBe(410);
    // 停用的功能不写任何条目。
    expect(await ledger.count()).toBe(before);
    expect((await fetch(url + '/v1/me/history', { headers })).status).toBe(200);
  });
});
