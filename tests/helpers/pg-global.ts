/**
 * PostgreSQL 模式的全量测试：全局起停与收尾。
 *
 * 为什么放在 globalSetup 而不是每个测试文件里：vitest 用 forks 池，每个测试文件
 * 一个子进程；如果每进程各起一个嵌入式 PG，会抢同一个端口和数据目录。
 * 这里在主进程起一次，把连接串塞进 PARLOR_TEST_PG_URL，子进程直接继承。
 *
 * 收尾时把本套测试建的库全删掉（只删 `parlor_t_*` 与 `parlor_file_*`），
 * 否则一次全量跑下来会留下几百个空库（实测 898 个、8.8GB）。
 */
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface EmbeddedHandle {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

let embedded: EmbeddedHandle | undefined;
let dataDir: string | undefined;

export async function setup(): Promise<void> {
  const scratch = resolve('.task-tmp', 'pg-tests');
  mkdirSync(scratch, {recursive:true});
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = scratch;
  if (process.env.PARLOR_TEST_PG_URL) return;
  process.env.PARLOR_TEST_PG = '1';
  const module = await import('embedded-postgres');
  const EmbeddedPostgres = module.default;
  const dir = mkdtempSync(join(tmpdir(), 'parlor-pg-'));
  dataDir = dir;
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
  process.env.PARLOR_TEST_PG_URL = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
}

export async function teardown(): Promise<void> {
  const url = process.env.PARLOR_TEST_PG_URL;
  if (url) {
    try {
      const { Client } = await import('pg');
      const client = new Client({ connectionString: url });
      await client.connect();
      const found = await client.query(
        "SELECT datname FROM pg_database WHERE datname LIKE 'parlor_t\\_%' ESCAPE '\\' OR datname LIKE 'parlor_file\\_%' ESCAPE '\\'",
      );
      for (const row of found.rows as { datname: string }[]) {
        try {
          await client.query(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`);
        } catch { /* 还有一个连接挂着：下次再删 */ }
      }
      await client.end();
    } catch { /* 库已经停了也不影响 */ }
  }
  if (embedded) {
    const handle = embedded;
    embedded = undefined;
    try { await handle.stop(); } catch { /* Windows 上偶尔还有句柄没释放 */ }
    // stop() 在 Windows 上可能来不及删干净临时目录：重试几次，删不掉就算了。
    const dir = dataDir;
    dataDir = undefined;
    if (dir) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try { rmSync(dir, { recursive: true, force: true }); break; } catch {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    }
  }
}
