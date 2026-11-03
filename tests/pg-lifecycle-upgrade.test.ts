import { afterEach, expect, it } from 'vitest';
import { openTestDb, closeTestDb } from './helpers/test-db.ts';
import { migrate, type Db } from '../src/room/db.ts';
import { CooAccountDb } from '../src/room/coo-account-db.ts';
import { createRoom } from '../src/room/room-seat-db.ts';
import { RoomHost } from '../src/room/room-host.ts';
import { LedgerDb } from '../src/room/ledger-db.ts';
import { openStorage, parseStorageKind } from '../src/room/storage/open.ts';

let db:Db|undefined;
afterEach(async()=>{ if(db) await closeTestDb(db);db=undefined; });
it('PG v3 升到 v4 给旧房间/席位完整宽限，保留身份、令牌、余额，重跑不延长宽限',async()=>{
  db=await openTestDb();
  const id='coo-upgrade-aaa';
  const accounts=new CooAccountDb(db);
  expect(await accounts.registerCoo(id,'upgrade-secret-0123456789','pet','旧玩家')).toBe('ok');
  await createRoom(db,{id:'r-upgrade',ownerCooId:id,name:'旧客厅'},1);
  const host=await RoomHost.create(db,'r-upgrade',{now:()=>1});
  const joined=await host.join(id,{name:'旧玩家'});
  const balance=await new LedgerDb(db).balanceOf(id);
  // Reconstruct the published v3 columns, then exercise the real versioned migration.
  await db.exec(`ALTER TABLE rooms DROP COLUMN business_active_at;ALTER TABLE rooms DROP COLUMN archive_reason;
    ALTER TABLE room_seats DROP COLUMN business_active_at;ALTER TABLE room_seats DROP COLUMN location_capable;
    ALTER TABLE coo_sessions DROP COLUMN return_room_id;
    DELETE FROM meta WHERE key='promises_disabled';UPDATE meta SET value='3' WHERE key='schema_version';`);
  const started=Date.now();
  await migrate(db);
  const room=await db.prepare('SELECT business_active_at FROM rooms WHERE id=?').get('r-upgrade') as {business_active_at:number};
  expect(Number(room.business_active_at)).toBeGreaterThanOrEqual(started);
  const seat=await db.prepare('SELECT business_active_at,token_hash FROM room_seats WHERE id=?').get(joined.seat.id) as {business_active_at:number;token_hash:string};
  expect(Number(seat.business_active_at)).toBeGreaterThanOrEqual(started);
  expect(seat.token_hash).toBe(joined.seat.tokenHash);
  expect(await new LedgerDb(db).balanceOf(id)).toBe(balance);
  await migrate(db);
  expect((await db.prepare('SELECT business_active_at FROM rooms WHERE id=?').get('r-upgrade') as typeof room).business_active_at).toBe(room.business_active_at);
});
it('服务端拒绝 SQLite 和缺连接串，不创建空库',async()=>{
  expect(()=>parseStorageKind('sqlite')).toThrow('只支持 PostgreSQL');
  await expect(openStorage()).rejects.toThrow('PARLOR_DATABASE_URL');
  await expect(openStorage({storage:'postgres',file:'should-not-create.db',url:'postgres://invalid'})).rejects.toThrow('--db');
});
