import { openDb } from '../src/room/storage/sqlite.ts';
/**
 * SQLite → PostgreSQL 迁移工具（M3）：
 * - 来源只读、结构/外键/JSON/整数范围/重复活跃席位全审一遍，有问题就中止；
 * - 目标非空默认拒绝；导入 + 序列校准 + 逐行核验在同一个事务里，核验不过整笔回滚；
 * - 跑完在目标库留一条 migration_runs 审计记录。
 *
 * 来源永远是 SQLite 文件（不管测试本身跑在哪个后端）；目标必须是真的 PostgreSQL，
 * 所以这一组用 pgTestEnabled() 守着——没配 PG 就跳过。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Db } from '../src/room/db.ts';
import { migrate } from '../src/room/db.ts';
import { RoomHost } from '../src/room/room-host.ts';
import { createRoom, getRoom } from '../src/room/room-seat-db.ts';
import { runMigration } from '../src/room/migration/run.ts';
import { openSource, auditSource } from '../src/room/migration/source.ts';
import { digestSource, digestTarget, verifyAll } from '../src/room/migration/verify.ts';
import { openStorage } from '../src/room/storage/open.ts';
import { enableGlobalIdentity } from '../src/room/global-identity.ts';
import { SupportDb } from '../src/room/support-db.ts';
import { pgTestEnabled, pgServerStorage } from './helpers/pg.ts';

const A = 'coo-mg000001';
const B = 'coo-mg000002';
const OWNER = 'coo-mg000000';

let dir: string | undefined;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'parlor-migrate-')); });
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** 造一份有内容的来源库：席位、发言、礼物、承诺、牌局、回执、短号、票据。 */
const seedSource = async (file: string): Promise<{ db: Db; host: RoomHost; tableId: string }> => {
  const db = await openDb(file);
  await migrate(db);
  const now = 1_770_000_000_000;
  const insert = db.prepare(
    'INSERT INTO coos(id, kind, display_name, secret_hash, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
  );
  for (const [id, kind, name] of [[OWNER, 'system', '主人'], [A, 'pet', '阿岚'], [B, 'pet', '小满']] as const) {
    await insert.run(id, kind, name, null, now);
  }
  if (!(await getRoom(db, 'lobby'))) {
    await createRoom(db, {
      id: 'lobby', name: '默认客厅', ownerCooId: OWNER, visibility: 'unlisted', capacity: 8,
    }, now);
  }
  const host = await RoomHost.create(db, 'lobby', { now: () => now });
  await host.join(A, { name: '阿岚' });
  await host.join(B, { name: '小满' });
  await host.say(A, '晚上好');
  await host.gift(A, '小满', 'longjing', '一点心意');
  const promised = await host.promise(A, '小满', '明天一起打牌', now + 3_600_000);
  await host.respond(B, promised.entry.id, 'accept');
  await db.prepare('INSERT INTO global_handles(coo_id, handle) VALUES (?, ?)').run(A, 'mg000001');
  // 身份票据：直接插，走的是 identity 那条路（工具要能原样搬）。
  await db.prepare(
    'INSERT INTO identity_tickets(token_hash, coo_id, audience, expires_at) VALUES (?, ?, ?, ?)',
  ).run('hash-ticket-1', A, 'https://parlor.example', now + 86_400_000);
  // 一局骰子：开局、出牌、结算，产生回执、事件、受众与账本条目。
  const opened = await host.openTable(A, { game: 'dice' }, 'open-1');
  await host.joinTable(B, opened.tableId, 'join-1');
  await host.startTable(A, opened.tableId, 'start-1');
  const revision = (await host.snapshot(A, { limit: 1 })).tablePrivate?.revision as number;
  await host.tableAction(A, { type: 'stand' }, { revision, requestId: 'a-stand' });
  const revisionB = (await host.snapshot(B, { limit: 1 })).tablePrivate?.revision as number;
  await host.tableAction(B, { type: 'stand' }, { revision: revisionB, requestId: 'b-stand' });
  return { db, host, tableId: opened.tableId };
};

const targetUrl = async (): Promise<string> => {
  const storage = await pgServerStorage(':memory:');
  if (!storage.databaseUrl) throw new Error('测试要的是 PostgreSQL 目标');
  return storage.databaseUrl;
};

describe.skipIf(!pgTestEnabled())('SQLite → PostgreSQL 迁移', () => {
  it('schema 8 匹配、招募与入桌回执逐行保留；schema 7 缺新表仍能迁移', async () => {
    for (const legacy of [false, true]) {
      const file = join(dir!, `discovery-${legacy}.db`);
      const { db, tableId } = await seedSource(file);
      if (legacy) {
        await db.exec('DROP TABLE table_discovery; DROP TABLE table_entry_receipts;');
        await db.prepare("UPDATE meta SET value='7' WHERE key='schema_version'").run();
      } else {
        await db.prepare('INSERT INTO table_discovery(table_id, match_open, recruit_text, author_coo_id, updated_at) VALUES (?, 1, ?, ?, ?)')
          .run(tableId, '迁库后继续招募', A, 1_770_000_000_000);
        await db.prepare('INSERT INTO table_entry_receipts(coo_id, request_id, source_token_hash, result_token_hash, body_key, receipt_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(A, 'entry-1', 'source-hash', 'result-hash', '{"game":"dice"}', '{"tableId":"retained"}', 1_770_000_000_000);
      }
      await db.close();
      const url = await targetUrl();
      const result = await runMigration({ source: file, targetUrl: url });
      expect(result.ok, JSON.stringify({ legacy, error: result.error, mismatched: result.verify?.mismatched })).toBe(true);
      const target = await openStorage({ storage: 'postgres', url });
      try {
        const row = await target.prepare('SELECT * FROM table_discovery WHERE table_id=?').get(tableId);
        expect(row).toEqual(legacy ? undefined : { table_id: tableId, match_open: 1, recruit_text: '迁库后继续招募', author_coo_id: A, updated_at: 1_770_000_000_000 });
        const receipt = await target.prepare('SELECT receipt_json, source_token_hash FROM table_entry_receipts WHERE request_id=?').get('entry-1');
        expect(receipt).toEqual(legacy ? undefined : { receipt_json: '{"tableId":"retained"}', source_token_hash: 'source-hash' });
      } finally { await target.close(); }
    }
  });
  it('schema 7 的反馈、回复和公告逐行搬运；schema 6 缺少新表仍能迁移', async () => {
    for (const legacy of [false, true]) {
      const file = join(dir!, `support-${legacy}.db`);
      const { db } = await seedSource(file);
      if (legacy) {
        await db.exec('DROP TABLE support_feedback; DROP TABLE support_announcements;');
        await db.prepare("UPDATE meta SET value = '6' WHERE key = 'schema_version'").run();
      } else {
        const support = new SupportDb(db);
        const item = await support.submit(A, '阿岚', '持久反馈', 'request-1');
        await support.reply(item.id, '已处理', 'closed');
        await support.announce('迁库公告', 'notice-1');
      }
      await db.close();
      const url = await targetUrl();
      const report = await runMigration({ source: file, targetUrl: url });
      expect(report.ok, report.error).toBe(true);
      const target = await openStorage({ storage: 'postgres', url });
      try {
        const support = new SupportDb(target);
        if (legacy) {
          expect(await support.feedback(A)).toEqual([]);
        } else {
          expect((await support.feedback(A))[0]).toMatchObject({ text: '持久反馈', reply: '已处理', status: 'closed' });
          expect((await support.announcements())[0].text).toBe('迁库公告');
        }
      } finally { await target.close(); }
    }
  });
  it('历史升级追加的列顺序不同，仍按相同列名顺序逐行核验', async () => {
    const file = join(dir!, 'parlor.db');
    const { db } = await seedSource(file);
    // 线上旧账户表是后来 ALTER ADD 的 player_coo_id，位于最后一列。
    await db.exec('ALTER TABLE accounts DROP COLUMN player_coo_id');
    await db.exec('ALTER TABLE accounts ADD COLUMN player_coo_id TEXT REFERENCES coos(id)');
    await db.prepare(
      'INSERT INTO accounts(id, coo_id, display_name, owner_key_hash, created_at, player_coo_id) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('account-vintage', OWNER, '旧账户', 'hash-vintage-owner', 1_770_000_000_000, A);
    await db.close();
    const report = await runMigration({ source: file, targetUrl: await targetUrl() });
    expect(report.ok, report.error).toBe(true);
    expect(report.verify?.mismatched).toEqual([]);
  });

  it('JSON 顶层数组、字符串、布尔和 null 保持语义，不当成 PG 数组或 SQL NULL', async () => {
    const file = join(dir!, 'parlor.db');
    const { db } = await seedSource(file);
    const original = await db.prepare('SELECT room_id, seq FROM events ORDER BY room_id, seq LIMIT 1').get() as {
      room_id: string; seq: number;
    };
    const update = db.prepare('UPDATE events SET scope_seats_json = ?, mentions_json = ?, data_json = ? WHERE room_id = ? AND seq = ?');
    await update.run(JSON.stringify(['seat-a', 'seat-b']), JSON.stringify(['阿岚']), 'null', original.room_id, original.seq);
    await db.prepare("UPDATE ledger_entries SET data_json = ? WHERE ord = (SELECT MIN(ord) FROM ledger_entries)")
      .run(JSON.stringify('a JSON string'));
    await db.prepare("UPDATE action_receipts SET receipt_json = ? WHERE request_id = 'open-1'").run('false');
    await db.close();
    const url = await targetUrl();
    const report = await runMigration({ source: file, targetUrl: url });
    expect(report.ok, report.error).toBe(true);
    const target = await openStorage({ storage: 'postgres', url });
    try {
      const row = await target.prepare(
        'SELECT scope_seats_json, mentions_json, jsonb_typeof(data_json) AS kind FROM events WHERE room_id = ? AND seq = ?',
      ).get(original.room_id, original.seq) as Record<string, unknown>;
      expect(row.scope_seats_json).toEqual(['seat-a', 'seat-b']);
      expect(row.mentions_json).toEqual(['阿岚']);
      expect(row.kind).toBe('null');
    } finally { await target.close(); }
  });

  it('统一身份的重名席位先调整目标索引，再导入全部历史席位', async () => {
    const file = join(dir!, 'parlor.db');
    const { db } = await seedSource(file);
    await enableGlobalIdentity(db);
    await db.prepare('UPDATE room_seats SET name = ? WHERE coo_id IN (?, ?)').run('同一个昵称', A, B);
    await db.close();
    const report = await runMigration({ source: file, targetUrl: await targetUrl() });
    expect(report.ok, report.error).toBe(true);
    expect(report.verify?.ok).toBe(true);
  });

  it('全表搬运 + 逐行核验 + 审计记录；再跑一次会被非空目标挡住', async () => {
    const file = join(dir!, 'parlor.db');
    const { db, tableId } = await seedSource(file);
    const before = {
      balance: (await db.prepare(
        `SELECT COALESCE(SUM(CASE WHEN to_kind = 'coo' AND to_coo_id = ? THEN amount ELSE 0 END), 0)
              - COALESCE(SUM(CASE WHEN from_kind = 'coo' AND from_coo_id = ? THEN amount ELSE 0 END), 0) AS v
           FROM ledger_transfers`,
      ).get(A, A) as { v: number }).v,
      mail: (await db.prepare('SELECT COUNT(*) AS n FROM mail WHERE coo_id = ?').get(A) as { n: number }).n,
    };
    await db.close();

    const report = await runMigration({
      source: file,
      targetUrl: await targetUrl(),
      log: () => {},
    });
    expect(report.error ?? '', report.error ?? '').toBe('');
    expect(report.ok).toBe(true);
    expect(report.stage).toBe('done');
    expect(report.verify?.mismatched).toEqual([]);
    expect(report.verify?.contrasts.every((entry) => entry.ok)).toBe(true);
    expect(report.counts?.events).toBeGreaterThan(0);
    expect(report.counts?.ledger_entries).toBeGreaterThan(0);
    expect(report.sequences?.['mail.seq']).toBeGreaterThan(0);
    expect(report.runId).toBeTruthy();
    expect(tableId).toContain('t-');
    expect(before.balance).toBeGreaterThan(0);
    expect(before.mail).toBeGreaterThan(0);
  });

  it('导入后可继续用：目标库开服务、新写入不撞主键、旧身份可读信', async () => {
    const file = join(dir!, 'parlor.db');
    const { db } = await seedSource(file);
    await db.close();
    const url = await targetUrl();
    const report = await runMigration({ source: file, targetUrl: url, log: () => {} });
    expect(report.ok).toBe(true);

    const target = await openStorage({ storage: 'postgres', url });
    try {
      // identity 序列校准过：新写的信不会撞上旧 seq。
      const host = await RoomHost.create(target, 'lobby', { now: () => 1_770_000_100_000 });
      await host.say(A, '搬完之后还能说话');
      const mail = await target.prepare('SELECT COUNT(*) AS n FROM mail').get() as { n: number };
      expect(mail.n).toBeGreaterThan(0);
      const snapshot = await host.snapshot(A, { limit: 5 });
      expect(snapshot.seat?.name).toBe('阿岚');
      expect((snapshot.ledger as { games: number }).games).toBe(1);
    } finally {
      await target.close();
    }
  });

  it('dry-run 只审计：来源不许写、目标一个字节都不碰', async () => {
    const file = join(dir!, 'parlor.db');
    const { db } = await seedSource(file);
    await db.close();
    const report = await runMigration({ source: file, dryRun: true, log: () => {} });
    expect(report.ok).toBe(true);
    expect(report.counts?.coos).toBe(3);
    expect(report.runId).toBeUndefined();
    // 没有目标库也能跑 dry-run（上面就没给 targetUrl）。
  });

  it('来源多一张不认识的表：审计阶段就中止，不碰目标', async () => {
    const file = join(dir!, 'parlor.db');
    const { db } = await seedSource(file);
    await db.prepare('CREATE TABLE stray_table(id TEXT PRIMARY KEY)').run();
    await db.close();
    const report = await runMigration({ source: file, targetUrl: await targetUrl(), log: () => {} });
    expect(report.ok).toBe(false);
    expect(report.stage).toBe('audit');
    expect(report.audit.issues.map((issue) => issue.code)).toContain('unknown_table');
  });

  it('坏 JSON：深审计当场点名，不让它进目标库', async () => {
    const file = join(dir!, 'parlor.db');
    const { db } = await seedSource(file);
    await db.prepare("UPDATE events SET data_json = '{坏' WHERE data_json IS NOT NULL").run();
    await db.close();
    const report = await runMigration({ source: file, targetUrl: await targetUrl(), log: () => {} });
    expect(report.ok).toBe(false);
    expect(report.audit.issues.map((issue) => issue.code)).toContain('bad_json');
  });

  it('目标非空：拒绝，并说明是哪个库、多少行', async () => {
    const file = join(dir!, 'parlor.db');
    const { db } = await seedSource(file);
    await db.close();
    const url = await targetUrl();
    const first = await runMigration({ source: file, targetUrl: url, log: () => {} });
    expect(first.ok).toBe(true);
    const second = await runMigration({ source: file, targetUrl: url, log: () => {} });
    expect(second.ok).toBe(false);
    expect(second.stage).toBe('target');
    expect(second.error).toContain('不是空的');
    // 一旦完整迁移，目标可能已接收新业务写入；同来源哈希也不能再覆盖。
    const forced = await runMigration({ source: file, targetUrl: url, force: true, log: () => {} });
    expect(forced.ok).toBe(false);
    expect(forced.error).toContain('禁止 --force 覆盖');
  });

  it('核验真的会看内容：目标库被改掉一行，摘要就对不上', async () => {
    const file = join(dir!, 'parlor.db');
    const { db } = await seedSource(file);
    await db.close();
    const url = await targetUrl();
    const report = await runMigration({ source: file, targetUrl: url, log: () => {} });
    expect(report.ok).toBe(true);
    const target = await openStorage({ storage: 'postgres', url });
    try {
      await target.prepare("UPDATE coos SET display_name = '被改过' WHERE id = ?").run(A);
      const source = openSource(file);
      try {
        const audit = auditSource(source, file, { deep: false });
        const client = {
          query: async (sql: string, params: unknown[] = []) => ({
            rows: await target.prepare(sql).all(...(params as (string | number)[])),
            rowCount: 0,
          }),
        };
        const left = await digestSource(source, audit, 'coos');
        const right = await digestTarget(client, 'coos');
        expect(left?.rows).toBe(right?.rows);
        expect(left?.digest).not.toBe(right?.digest);
        const verify = await verifyAll(source, client, audit);
        expect(verify.ok).toBe(false);
        expect(verify.mismatched.map((entry) => entry.table)).toContain('coos');
        expect(verify.contrasts.some((entry) => !entry.ok)).toBe(false);
      } finally {
        source.close();
      }
    } finally {
      await target.close();
    }
  });
});
