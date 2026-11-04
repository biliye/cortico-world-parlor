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
  // 默认落在仓库内，但**必须**允许挪出去：本仓所在的 Windows 工作树上挂了
  // `Everyone: Deny DeleteSubdirectoriesAndFiles`（向下继承到每个子目录），
  // 而 PostgreSQL 运行时要 rename/unlink 数据目录里的文件、收尾要删整棵目录。
  // 一旦 scratch 落在这棵树里，initdb 能建、PG 一起就 `Permission denied`，
  // 而且 tmpdir() 被全局改写，二十多个用例的 mkdtemp 也会一起进去。
  // 设 PARLOR_TEST_TMP 指向仓库外目录即可整包跑通。
  const scratch = resolve(process.env.PARLOR_TEST_TMP ?? '.task-tmp/pg-tests');
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
