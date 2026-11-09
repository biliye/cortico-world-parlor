import { afterEach, expect, it } from 'vitest';
import { openTestDb, closeTestDb } from './helpers/test-db.ts';
import { migrate, type Db } from '../src/room/db.ts';
import { CooAccountDb } from '../src/room/coo-account-db.ts';
import { createRoom } from '../src/room/room-seat-db.ts';
import { RoomHost } from '../src/room/room-host.ts';
import { LedgerDb } from '../src/room/ledger-db.ts';
import { openStorage, parseStorageKind } from '../src/room/storage/open.ts';
import { PG_SCHEMA_VERSION } from '../src/room/storage/pg-schema.ts';

let db:Db|undefined;
afterEach(async()=>{ if(db) await closeTestDb(db);db=undefined; });
it('PG v3 升到 v4 给旧房间/席位完整宽限，保留身份、令牌、账本条目，重跑不延长宽限',async()=>{
  db=await openTestDb();
  const id='coo-upgrade-aaa';
  const accounts=new CooAccountDb(db);
  expect(await accounts.registerCoo(id,'upgrade-secret-0123456789','pet','旧玩家')).toBe('ok');
  await createRoom(db,{id:'r-upgrade',ownerCooId:id,name:'旧客厅'},1);
  const host=await RoomHost.create(db,'r-upgrade',{now:()=>1});
  const joined=await host.join(id,{name:'旧玩家'});
  const entries=await new LedgerDb(db).count();
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
  expect(await new LedgerDb(db).count()).toBe(entries);
  await migrate(db);
  expect((await db.prepare('SELECT business_active_at FROM rooms WHERE id=?').get('r-upgrade') as typeof room).business_active_at).toBe(room.business_active_at);
});
it('服务端拒绝 SQLite 和缺连接串，不创建空库',async()=>{
  expect(()=>parseStorageKind('sqlite')).toThrow('只支持 PostgreSQL');
  await expect(openStorage()).rejects.toThrow('PARLOR_DATABASE_URL');
  await expect(openStorage({storage:'postgres',file:'should-not-create.db',url:'postgres://invalid'})).rejects.toThrow('--db');
});

/** tables 的最小一行：只填 NOT NULL 与 game，用来单独验证 CHECK 约束。 */
const insertTable = (d:Db, id:string, roomId:string, game:string) => d.prepare(
  `INSERT INTO tables(id,room_id,room_epoch,game,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`,
).run(id, roomId, 'epoch-v5', game, 'open', 1, 1);

const schemaVersion = async (d:Db): Promise<number> => Number(
  ((await d.prepare("SELECT value FROM meta WHERE key='schema_version'").get()) as {value:string}).value,
);

/** 把库退回 v4 的样子：约束只认四个旧值，版本号也退回去。 */
const downgradeToV4 = async (d:Db): Promise<void> => {
  await d.exec(`ALTER TABLE tables DROP CONSTRAINT IF EXISTS tables_game_check;
    ALTER TABLE tables ADD CONSTRAINT tables_game_check CHECK (game IN ('dice','ddz','monopoly','werewolf'));
    UPDATE meta SET value='4' WHERE key='schema_version';`);
};

it('空库直接建到最新版本，tables.game 放行快局大富翁和五子棋，未知值仍被拒绝', async () => {
  db = await openTestDb();
  expect(await schemaVersion(db)).toBe(PG_SCHEMA_VERSION);
  const id = 'coo-v5-fresh';
  await new CooAccountDb(db).registerCoo(id, 'upgrade-secret-0123456789', 'pet', '新玩家');
  await createRoom(db, { id: 'r-v5-fresh', ownerCooId: id, name: '新客厅' }, 4);
  await insertTable(db, 't-v5-new', 'r-v5-fresh', 'monopoly2d');
  await insertTable(db, 't-v6-new', 'r-v5-fresh', 'gomoku');
  await insertTable(db, 't-v5-old', 'r-v5-fresh', 'dice');
  await expect(insertTable(db, 't-v5-bad', 'r-v5-fresh', 'not-a-game'))
    .rejects.toThrow(/tables_game_check/);
});

it('v4 库经 v5 升到最新版本：旧桌原样保留，新玩法放行，重复启动不重复改约束', async () => {
  db = await openTestDb();
  const id = 'coo-v5-upgrade';
  await new CooAccountDb(db).registerCoo(id, 'upgrade-secret-0123456789', 'pet', '旧玩家');
  await createRoom(db, { id: 'r-v5-upgrade', ownerCooId: id, name: '旧客厅' }, 4);
  await insertTable(db, 't-v5-legacy', 'r-v5-upgrade', 'monopoly');

  await downgradeToV4(db);
  expect(await schemaVersion(db)).toBe(4);
  // 退回 v4 之后，快局大富翁这条正是老库插不进去的那个值。
  await expect(insertTable(db, 't-v5-blocked', 'r-v5-upgrade', 'monopoly2d'))
    .rejects.toThrow(/tables_game_check/);

  await migrate(db);
  expect(await schemaVersion(db)).toBe(PG_SCHEMA_VERSION);
  const legacy = await db.prepare('SELECT game,room_id FROM tables WHERE id=?').get('t-v5-legacy') as {game:string;room_id:string};
  expect(legacy).toEqual({ game: 'monopoly', room_id: 'r-v5-upgrade' });
  await insertTable(db, 't-v5-after', 'r-v5-upgrade', 'monopoly2d');
  await insertTable(db, 't-v5-dice', 'r-v5-upgrade', 'dice');
  await expect(insertTable(db, 't-v5-still-bad', 'r-v5-upgrade', 'nope'))
    .rejects.toThrow(/tables_game_check/);

  // 重复启动：版本已经是最新，迁移段跳过。
  await migrate(db);
  expect(await schemaVersion(db)).toBe(PG_SCHEMA_VERSION);
  await db.prepare('DELETE FROM tables WHERE id=?').run('t-v5-after');
  await insertTable(db, 't-v5-again', 'r-v5-upgrade', 'monopoly2d');
});

it('v5 单独升级到最新版本：保留快局大富翁桌并开放五子棋', async () => {
  db = await openTestDb();
  const id = 'coo-v6-upgrade';
  await new CooAccountDb(db).registerCoo(id, 'upgrade-secret-0123456789', 'pet', '旧玩家');
  await createRoom(db, { id: 'r-v6-upgrade', ownerCooId: id, name: '旧客厅' }, 4);
  await db.exec(`ALTER TABLE tables DROP CONSTRAINT tables_game_check;
    ALTER TABLE tables ADD CONSTRAINT tables_game_check CHECK (game IN ('dice','ddz','monopoly','werewolf','monopoly2d'));
    UPDATE meta SET value='5' WHERE key='schema_version';`);
  await insertTable(db, 't-v6-monopoly', 'r-v6-upgrade', 'monopoly2d');
  await expect(insertTable(db, 't-v6-gomoku', 'r-v6-upgrade', 'gomoku')).rejects.toThrow(/tables_game_check/);
  await migrate(db);
  expect(await schemaVersion(db)).toBe(PG_SCHEMA_VERSION);
  expect(await db.prepare('SELECT game FROM tables WHERE id=?').get('t-v6-monopoly')).toEqual({ game: 'monopoly2d' });
  await insertTable(db, 't-v6-gomoku', 'r-v6-upgrade', 'gomoku');
});

it('v7 升到 v8：新闻表与招募版本列都是纯增量，老桌保留、重跑不丢数据', async () => {
  db = await openTestDb();
  const id = 'coo-v8-upgrade';
  await new CooAccountDb(db).registerCoo(id, 'upgrade-secret-0123456789', 'pet', '旧玩家');
  await createRoom(db, { id: 'r-v8-upgrade', ownerCooId: id, name: '旧客厅' }, 4);
  await insertTable(db, 't-v8-legacy', 'r-v8-upgrade', 'ddz');
  await db.prepare(
    'INSERT INTO table_discovery(table_id, match_open, recruit_text, updated_at) VALUES (?, 1, ?, ?)',
  ).run('t-v8-legacy', '旧招募', 11);

  // 退回 v7 的样子：没有新闻表，也没有 recruit_version。
  await db.exec(`DROP TABLE IF EXISTS news_items;
    ALTER TABLE table_discovery DROP COLUMN IF EXISTS recruit_version;
    UPDATE meta SET value='7' WHERE key='schema_version';`);
  expect(await schemaVersion(db)).toBe(7);

  await migrate(db);
  expect(await schemaVersion(db)).toBe(PG_SCHEMA_VERSION);
  const discovery = await db.prepare(
    'SELECT match_open, recruit_text, recruit_version FROM table_discovery WHERE table_id=?',
  ).get('t-v8-legacy') as { match_open: number; recruit_text: string; recruit_version: string | number };
  expect(discovery.match_open).toBe(1);
  expect(discovery.recruit_text).toBe('旧招募');
  // 迁移前的老桌没有版本可比，从 0 起算；下一次招募变动才递增到 1。
  expect(Number(discovery.recruit_version)).toBe(0);
  expect(Number((await db.prepare('SELECT COUNT(*) AS n FROM news_items').get() as { n: string | number }).n)).toBe(0);

  // 一天一版是库级约束，不是应用层约定。
  const insertNews = (newsId: string, date: string) => db!.prepare(
    `INSERT INTO news_items(id, issue_date, title, summary, body, publish_at, auto_push, created_at)
     VALUES (?, ?, 't', 's', 'b', 1, 1, 1)`,
  ).run(newsId, date);
  await insertNews('n-v8-a', '2026-11-09');
  await expect(insertNews('n-v8-b', '2026-11-09')).rejects.toThrow(/unique|duplicate/i);

  // 重复启动：版本已是最新，迁移段跳过，新闻与版本号都还在。
  await migrate(db);
  expect(await schemaVersion(db)).toBe(PG_SCHEMA_VERSION);
  expect(Number((await db.prepare('SELECT COUNT(*) AS n FROM news_items').get() as { n: string | number }).n)).toBe(1);
  expect(Number((await db.prepare('SELECT recruit_version FROM table_discovery WHERE table_id=?')
    .get('t-v8-legacy') as { recruit_version: string | number }).recruit_version)).toBe(0);
});
