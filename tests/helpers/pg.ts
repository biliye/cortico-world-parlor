/**
 * 测试用的 PostgreSQL 供给。
 *
 * 两种模式：
 * - `PARLOR_TEST_PG=1`：在本机起一个嵌入式 PostgreSQL（embedded-postgres，
 *   数据目录在系统临时目录，进程退出即删），每个测试文件一个独立库；
 * - `PARLOR_TEST_PG_URL=postgres://…`：连外部 PG。库仍然按测试文件隔离，
 *   测试结束不会删别人的库，只会删本进程用「内存库」语义创建的库。
 *
 * 文件路径的测试（关了再开同一个库）在 PG 下按路径哈希映射成同名库：
 * 第一次打开重建，之后复用——与 SQLite 下「同一个文件」的语义对齐。
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, type Db } from '../../src/room/db.ts';
import { PgDb } from '../../src/room/storage/postgres.ts';

interface EmbeddedHandle {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface TestDbMeta {
  adminUrl: string;
  name: string;
  ephemeral: boolean;
}

const meta = new WeakMap<Db, TestDbMeta>();
const created = new Set<string>();

let embedded: EmbeddedHandle | undefined;
let adminUrl: string | undefined;
let starting: Promise<string> | undefined;

export const pgTestEnabled = (): boolean => (
  Boolean(process.env.PARLOR_TEST_PG_URL) || process.env.PARLOR_TEST_PG === '1'
);

const startEmbedded = async (): Promise<string> => {
  const module = await import('embedded-postgres');
  const EmbeddedPostgres = module.default;
  const dir = mkdtempSync(join(tmpdir(), 'parlor-pg-'));
  const port = Number(process.env.PARLOR_TEST_PG_PORT ?? 55433);
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    initdbFlags: ['--locale=C', '--encoding=UTF8'],
    // 全量并行跑时每个测试文件一个池，默认 100 条连接不够。
    postgresFlags: ['-c', 'max_connections=200'],
    onLog: () => {},
    onError: () => {},
  }) as unknown as EmbeddedHandle;
  await pg.initialise();
  await pg.start();
  embedded = pg;
  return `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
};

const ensureAdmin = async (): Promise<string> => {
  if (adminUrl) return adminUrl;
  if (!starting) {
    starting = (async () => {
      const external = process.env.PARLOR_TEST_PG_URL;
      adminUrl = external ?? await startEmbedded();
      return adminUrl;
    })();
  }
  return starting;
};

const adminClient = async () => {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: await ensureAdmin() });
  await client.connect();
  return client;
};

const databaseName = (file: string): { name: string; ephemeral: boolean } => {
  if (file === ':memory:' || file === '') {
    return { name: `parlor_t_${randomBytes(6).toString('hex')}`, ephemeral: true };
  }
  const hash = createHash('sha1').update(file).digest('hex').slice(0, 16);
  return { name: `parlor_file_${hash}`, ephemeral: false };
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
  } finally {
    await client.end();
  }
};

/** 手动停掉嵌入式 PG（vitest globalTeardown 用）。 */
export const stopPgTestServer = async (): Promise<void> => {
  if (!embedded) return;
  const handle = embedded;
  embedded = undefined;
  adminUrl = undefined;
  starting = undefined;
  await handle.stop();
};

process.once('exit', () => {
  // 嵌入式实例是 persistent:false，进程退出时它会自己停；这里只兜个底。
});

/**
 * 给 `WorldServer.create({...})` 用的存储参数。
 *
 * SQLite 模式原样返回 `{ dbFile }`；PG 模式返回 `{ storage: 'postgres', databaseUrl }`，
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
