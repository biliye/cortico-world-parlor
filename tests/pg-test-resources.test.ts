import { expect, it } from 'vitest';
import { Client } from 'pg';
import { PgDb } from '../src/room/storage/postgres.ts';
import { cleanupClosedPgTestDbs, pgServerStorage } from './helpers/pg.ts';

it('测试库只在连接池关闭后回收，活跃库不被清理；库名归本轮所有',async()=>{
  const config=await pgServerStorage(':memory:');
  const name=new URL(config.databaseUrl!).pathname.slice(1);
  expect(name).toMatch(new RegExp(`^parlor_t_${process.env.PARLOR_TEST_RUN_ID}_`));
  const db=await PgDb.open({url:config.databaseUrl!});
  const admin=new Client({connectionString:process.env.PARLOR_TEST_PG_URL});
  await admin.connect();
  try {
    await db.prepare('SELECT 1 AS value').get();
    await cleanupClosedPgTestDbs();
    expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount).toBe(1);
    await db.close();
    await cleanupClosedPgTestDbs();
    expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount).toBe(0);
  } finally {await db.close();await admin.end();}
});

it('文件语义的库可在同一测试内关闭重开，逐项清理不丢持久化夹具',async()=>{
  const config=await pgServerStorage('resource-reopen-fixture');
  const first=await PgDb.open({url:config.databaseUrl!});
  try {await first.exec('CREATE TABLE preserved_marker(value INTEGER); INSERT INTO preserved_marker VALUES (42);');}
  finally {await first.close();}
  await cleanupClosedPgTestDbs();
  const again=await pgServerStorage('resource-reopen-fixture');
  expect(again.databaseUrl).toBe(config.databaseUrl);
  const second=await PgDb.open({url:again.databaseUrl!});
  try {expect(await second.prepare('SELECT value FROM preserved_marker').get()).toEqual({value:42});}
  finally {await second.close();}
});
