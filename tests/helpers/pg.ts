/**
 * 测试用的 PostgreSQL 供给。
 *
 * 受管入口一轮只启动一个工位内隔离PG；这里仅消费其连接串，
 * 不在worker另起PG或连接外部业务库。库名含本轮ID，清理只认自己登记的库。
 *
 * 文件路径的测试（关了再开同一个库）在 PG 下按路径哈希映射成同名库：
 * 第一次打开重建，之后复用——与 SQLite 下「同一个文件」的语义对齐。
 */
import { createHash, randomBytes } from 'node:crypto';
import { migrate, type Db } from '../../src/room/db.ts';
import { PgDb } from '../../src/room/storage/postgres.ts';

interface TestDbMeta {
  adminUrl: string;
  name: string;
  ephemeral: boolean;
}

const meta = new WeakMap<Db, TestDbMeta>();
const created = new Set<string>();
const ephemeralDbs = new Set<string>();

let adminUrl: string | undefined;

export const pgTestEnabled = (): boolean => (
  Boolean(process.env.PARLOR_TEST_PG_URL) || process.env.PARLOR_TEST_PG === '1'
);

const ensureAdmin = async (): Promise<string> => {
  if (adminUrl) return adminUrl;
  const url = process.env.PARLOR_TEST_PG_URL;
  if (!url || !/^[a-z0-9]{6}$/.test(process.env.PARLOR_TEST_RUN_ID || '')) {
    throw new Error('缺少受管隔离PG；请用 pnpm test:pg 或 test:all，不在worker内另起PG');
  }
  adminUrl = url;
  return adminUrl;
};

const adminClient = async () => {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: await ensureAdmin() });
  await client.connect();
  return client;
};

const databaseName = (file: string): { name: string; ephemeral: boolean } => {
  if (file === ':memory:' || file === '') {
    const name = `parlor_t_${process.env.PARLOR_TEST_RUN_ID || 'local'}_${randomBytes(6).toString('hex')}`;
    ephemeralDbs.add(name);
    return { name, ephemeral: true };
  }
  const hash = createHash('sha1').update(file).digest('hex').slice(0, 16);
  return { name: `parlor_file_${process.env.PARLOR_TEST_RUN_ID || 'local'}_${hash}`, ephemeral: false };
};

const createDatabase = async (name: string): Promise<void> => {
  const client = await adminClient();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
  created.add(name);
};

export const openPgTestDb = async (file = ':memory:'): Promise<Db> => {
  const base = await ensureAdmin();
  const { name, ephemeral } = databaseName(file);
  if (!created.has(name)) await createDatabase(name);
  const url = new URL(base);
  url.pathname = `/${name}`;
  const db = await PgDb.open({ url: url.toString(), poolMax: 2 });
  await migrate(db);
  meta.set(db, { adminUrl: base, name, ephemeral });
  return db;
};

/** 关掉测试库；「内存库」语义的库顺手删掉，文件语义的留着给同一文件的下一次打开。 */
export const closePgTestDb = async (db: Db): Promise<void> => {
  const info = meta.get(db);
  await db.close();
  if (!info || !info.ephemeral) return;
  const client = await adminClient();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${info.name} WITH (FORCE)`);
    created.delete(info.name);
    ephemeralDbs.delete(info.name);
  } finally {
    await client.end();
  }
};

export const cleanupClosedPgTestDbs = async ():Promise<void> => {
  if (ephemeralDbs.size===0) return;
  const client=await adminClient();
  try {
    for (const name of [...ephemeralDbs]) {
      if (!created.has(name)) {ephemeralDbs.delete(name);continue;}
      const active=await client.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1 LIMIT 1',[name]);
      if (active.rowCount) continue;
      await client.query(`DROP DATABASE IF EXISTS "${name}"`);
      created.delete(name);ephemeralDbs.delete(name);
    }
  } finally {await client.end();}
};

/**
 * 给 `WorldServer.create({...})` 用的存储参数。
 *
 * 返回 `{ storage: 'postgres', databaseUrl }`，没有SQLite回退；
 * 库名按 dbFile 路径哈希映射（`:memory:` 每次一个新库），语义与「同一个文件」一致。
 */
export const pgServerStorage = async (
  file: string,
): Promise<{ dbFile?: string; storage?: 'postgres'; databaseUrl?: string }> => {
  if (!pgTestEnabled()) throw new Error('测试必须使用真实 PostgreSQL');
  const base = await ensureAdmin();
  const { name } = databaseName(file);
  if (!created.has(name)) await createDatabase(name);
  const url = new URL(base);
  url.pathname = `/${name}`;
  return { storage: 'postgres', databaseUrl: url.toString() };
};
