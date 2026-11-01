import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDb, withTransaction, type Db } from '../src/room/db.ts';
import { closeTestDb, openTestDb } from './helpers/test-db.ts';
import { pgTestEnabled } from './helpers/pg.ts';

const itSqlite = pgTestEnabled() ? it.skip : it;

let db: Db;

beforeEach(async () => {
  db = await openTestDb();
});

afterEach(async () => {
  await closeTestDb(db);
});

const coo = async (id: string, kind = 'pet'): Promise<void> => {
  await db.prepare('INSERT INTO coos(id, kind, display_name, created_at) VALUES (?, ?, ?, ?)').run(id, kind, id, 1);
};

const room = async (id: string, owner: string, capacity = 8, kind = 'room'): Promise<void> => {
  await db.prepare(
    'INSERT INTO rooms(id, kind, name, owner_coo_id, visibility, capacity, epoch, seq, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 1)',
  ).run(id, kind, id, kind === 'hall' ? null : owner, 'unlisted', capacity, `epoch-${id}`);
};

const seat = async (roomId: string, id: string, cooId: string, name: string, token: string): Promise<void> => {
  await db.prepare(
    'INSERT INTO room_seats(room_id, id, coo_id, kind, name, tier, token_hash, joined_at, visible_from_seq) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)',
  ).run(roomId, id, cooId, 'pet', name, 'digest', token);
};

describe('SQLite 地基', () => {
  itSqlite('现有普通厅含归档厅统一到 30，大厅与席位数据保留，迁移幂等', async () => {
    await coo('coo-cap-owner');
    for (const capacity of [2, 8, 16, 30, 64]) await room('room-' + capacity, 'coo-cap-owner', capacity);
    await room('hall', 'coo-cap-owner', 400, 'hall');
    await db.prepare("UPDATE rooms SET archived_at = 123 WHERE id = 'room-8'").run();
    await seat('room-2', 'seat-kept', 'coo-cap-owner', '本人', 'token-kept');
    await migrate(db);
    await migrate(db);
    const rooms = await db.prepare("SELECT capacity FROM rooms WHERE kind = 'room'").all();
    expect(rooms).toHaveLength(5);
    expect(rooms.every(row => row.capacity === 30)).toBe(true);
    expect((await db.prepare("SELECT capacity FROM rooms WHERE id = 'hall'").get())?.capacity).toBe(400);
    expect((await db.prepare("SELECT archived_at FROM rooms WHERE id = 'room-8'").get())?.archived_at).toBe(123);
    expect((await db.prepare("SELECT token_hash FROM room_seats WHERE id = 'seat-kept'").get())?.token_hash).toBe('token-kept');
    expect(await db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  itSqlite('migrate 可重复执行，schema 版本写进 meta', async () => {
    await migrate(db);
    const row = await db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string };
    expect(row.value).toBe('6');
    const mode = await db.prepare('SELECT value FROM meta WHERE key = ?').get('storage_mode') as { value: string };
    expect(mode.value).toBe('sqlite');
  });

  itSqlite('老库没有 from_coo_id 时能补列并建索引（不能在建索引那步炸）', async () => {
    await migrate(db);
    await db.exec('DROP INDEX IF EXISTS ix_mail_peer');
    await db.exec('ALTER TABLE mail DROP COLUMN from_coo_id');
    await db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    await expect(migrate(db)).resolves.not.toThrow();
    const cols = ((await db.prepare('PRAGMA table_info(mail)').all()) as { name: string }[]).map((row) => row.name);
    expect(cols).toContain('from_coo_id');
    const index = await db.prepare("SELECT name FROM sqlite_master WHERE name = 'ix_mail_peer'").get();
    expect(index).toBeTruthy();
  });

  itSqlite('老库 capacity CHECK 只有 64：迁移重建 rooms，数据与外键都保住', async () => {
    const oldDb = openDb();
    try {
      // 0.20/0.21 时代的 rooms 建表（CHECK 2–64）；coos 先建出来，后面要插外键。
      await oldDb.exec(`
        CREATE TABLE coos (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          secret_hash TEXT,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER,
          status TEXT NOT NULL DEFAULT 'active'
        );
        CREATE TABLE rooms (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('hall','room')),
          name TEXT NOT NULL,
          owner_coo_id TEXT REFERENCES coos(id),
          visibility TEXT NOT NULL CHECK (visibility IN ('public','unlisted','private')),
          capacity INTEGER NOT NULL CHECK (capacity BETWEEN 2 AND 64),
          topic TEXT,
          invite_code_hash TEXT,
          epoch TEXT NOT NULL,
          seq INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0),
          created_at INTEGER NOT NULL,
          last_active_at INTEGER NOT NULL,
          archived_at INTEGER,
          CHECK (kind = 'hall' OR owner_coo_id IS NOT NULL),
          CHECK (kind = 'room' OR owner_coo_id IS NULL)
        );
      `);
      await oldDb.prepare('INSERT INTO coos(id, kind, display_name, created_at) VALUES (?, ?, ?, ?)')
        .run('coo-aaaaaaaa', 'human', '爸爸', 1);
      await oldDb.prepare(
        `INSERT INTO rooms(id, kind, name, owner_coo_id, visibility, capacity, epoch, seq, created_at, last_active_at)
         VALUES ('hall', 'hall', '大厅', NULL, 'public', 32, 'e-hall', 0, 1, 1)`,
      ).run();
      await oldDb.prepare(
        `INSERT INTO rooms(id, kind, name, owner_coo_id, visibility, capacity, epoch, seq, created_at, last_active_at)
         VALUES ('big', 'room', '大房', 'coo-aaaaaaaa', 'public', 64, 'e-big', 0, 1, 1)`,
      ).run();

      await migrate(oldDb);

      // 大厅从 32 抬到 400；普通客厅从 64 收到 30。
      const hall = await oldDb.prepare("SELECT capacity FROM rooms WHERE id = 'hall'").get() as { capacity: number };
      expect(hall.capacity).toBe(400);
      const big = await oldDb.prepare("SELECT capacity FROM rooms WHERE id = 'big'").get() as { capacity: number };
      expect(big.capacity).toBe(30);

      // 库级 CHECK 仍允许 300、拒绝 501（这是最后兜底；接口层才是 30）。
      await oldDb.prepare("UPDATE rooms SET capacity = 300 WHERE id = 'big'").run();
      await expect(oldDb.prepare("UPDATE rooms SET capacity = 501 WHERE id = 'hall'").run())
        .rejects.toThrow(/CHECK|check constraint/i);

      // 再跑一次 migrate：大房被收回 30，大厅不动。
      await migrate(oldDb);
      expect((await oldDb.prepare("SELECT capacity FROM rooms WHERE id = 'big'").get() as { capacity: number }).capacity).toBe(30);
      expect((await oldDb.prepare("SELECT capacity FROM rooms WHERE id = 'hall'").get() as { capacity: number }).capacity).toBe(400);

      // 外键、索引与触发器都还在。
      expect(await oldDb.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const indexes = ((await oldDb.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'rooms'",
      ).all()) as { name: string }[]).map((row) => row.name);
      expect(indexes).toEqual(expect.arrayContaining([
        'ux_rooms_hall', 'ux_rooms_invite', 'ix_rooms_directory', 'ix_rooms_owner',
      ]));
      await oldDb.prepare(
        `INSERT INTO room_seats(room_id, id, coo_id, kind, name, tier, token_hash, joined_at, visible_from_seq)
         VALUES ('big', 's1', 'coo-aaaaaaaa', 'human', '爸爸', 'full', 'token-1', 1, 0)`,
      ).run();
      expect(await oldDb.prepare("SELECT COUNT(*) AS n FROM room_seats WHERE room_id = 'big'").get())
        .toEqual({ n: 1 });

      const version = await oldDb.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
      expect(version.value).toBe('6');
    } finally {
      await closeTestDb(oldDb);
    }
  });

  it('身份 → 账户 → 客厅 → 席位的基本写入', async () => {
    await coo('coo-aaaaaaaa');
    await db.prepare(
      'INSERT INTO accounts(id, coo_id, display_name, owner_key_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('a1', 'coo-aaaaaaaa', '爸爸', 'a'.repeat(64), 1);
    await room('lobby', 'coo-aaaaaaaa');
    await seat('lobby', 's1', 'coo-aaaaaaaa', '阿岚', 'token-1');

    const account = await db.prepare('SELECT coo_id, display_name FROM accounts WHERE id = ?').get('a1') as { coo_id: string; display_name: string };
    expect(account).toEqual({ coo_id: 'coo-aaaaaaaa', display_name: '爸爸' });
    const row = await db.prepare('SELECT COUNT(*) AS n FROM room_seats WHERE released_at IS NULL').get() as { n: number };
    expect(row.n).toBe(1);
  });

  it('一个 Coo 全局只能一个活跃席位', async () => {
    await coo('coo-aaaaaaaa');
    await room('lobby', 'coo-aaaaaaaa');
    await room('other', 'coo-aaaaaaaa');
    await seat('lobby', 's1', 'coo-aaaaaaaa', '阿岚', 'token-1');
    await expect(seat('other', 's1', 'coo-aaaaaaaa', '阿岚', 'token-2')).rejects.toThrow(/UNIQUE|duplicate key/i);
  });

  it('一个客厅一个活跃席位的名字唯一；释放后可以复用', async () => {
    await coo('coo-aaaaaaaa');
    await coo('coo-bbbbbbbb');
    await room('lobby', 'coo-aaaaaaaa');
    await seat('lobby', 's1', 'coo-aaaaaaaa', '阿岚', 'token-1');
    await expect(seat('lobby', 's2', 'coo-bbbbbbbb', '阿岚', 'token-2')).rejects.toThrow(/UNIQUE|duplicate key/i);

    await db.prepare('UPDATE room_seats SET released_at = 2, visible_to_seq = 0 WHERE room_id = ? AND id = ?').run('lobby', 's1');
    await expect(seat('lobby', 's3', 'coo-bbbbbbbb', '阿岚', 'token-3')).resolves.not.toThrow();
  });

  it('容量 trigger：只算活跃的非 observer 席位', async () => {
    await coo('coo-aaaaaaaa');
    await coo('coo-bbbbbbbb');
    await coo('coo-cccccccc');
    await room('lobby', 'coo-aaaaaaaa', 2);
    await seat('lobby', 's1', 'coo-aaaaaaaa', '甲', 'token-1');
    await seat('lobby', 's2', 'coo-bbbbbbbb', '乙', 'token-2');
    await expect(seat('lobby', 's3', 'coo-cccccccc', '丙', 'token-3')).rejects.toThrow(/room_full/);
  });

  it('一个 Coo 一个账户', async () => {
    await coo('coo-aaaaaaaa');
    await db.prepare('INSERT INTO accounts(id, coo_id, display_name, owner_key_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('a1', 'coo-aaaaaaaa', '爸爸', 'a'.repeat(64), 1);
    await expect(db.prepare('INSERT INTO accounts(id, coo_id, display_name, owner_key_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('a2', 'coo-aaaaaaaa', '妈妈', 'b'.repeat(64), 1)).rejects.toThrow(/UNIQUE|duplicate key/i);
  });

  it('外键打开：账户必须有对应 coo', async () => {
    await expect(db.prepare('INSERT INTO accounts(id, coo_id, display_name, owner_key_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('a1', 'coo-missing', '爸爸', 'a'.repeat(64), 1)).rejects.toThrow(/FOREIGN KEY|foreign key/i);
  });

  it('事务回滚：写一半失败不留行；提交成功才留', async () => {
    await coo('coo-aaaaaaaa');
    await expect(withTransaction(db, async () => {
      await room('lobby', 'coo-aaaaaaaa');
      throw new Error('stop');
    })).rejects.toThrow('stop');
    expect(((await db.prepare('SELECT COUNT(*) AS n FROM rooms').get()) as { n: number }).n).toBe(0);

    await withTransaction(db, async () => { await room('lobby', 'coo-aaaaaaaa'); });
    expect(((await db.prepare('SELECT COUNT(*) AS n FROM rooms').get()) as { n: number }).n).toBe(1);
  });

  it('嵌套事务：内层失败只回滚内层，外层继续提交', async () => {
    await coo('coo-aaaaaaaa');
    await withTransaction(db, async () => {
      await room('lobby', 'coo-aaaaaaaa');
      await expect(withTransaction(db, async () => {
        await room('inner', 'coo-aaaaaaaa');
        throw new Error('inner');
      })).rejects.toThrow('inner');
      await room('outer2', 'coo-aaaaaaaa');
    });
    const ids = ((await db.prepare('SELECT id FROM rooms ORDER BY id').all()) as { id: string }[]).map((row) => row.id);
    expect(ids).toEqual(['lobby', 'outer2']);
  });

  it('嵌套事务：外层失败时内层成功也一起回滚', async () => {
    await coo('coo-aaaaaaaa');
    await expect(withTransaction(db, async () => {
      await withTransaction(db, async () => { await room('lobby', 'coo-aaaaaaaa'); });
      throw new Error('outer');
    })).rejects.toThrow('outer');
    expect(((await db.prepare('SELECT COUNT(*) AS n FROM rooms').get()) as { n: number }).n).toBe(0);
  });

  it('信箱逐封 read_at：未读只数 read_at IS NULL', async () => {
    await coo('coo-aaaaaaaa');
    await room('lobby', 'coo-aaaaaaaa');
    await db.prepare('INSERT INTO mail(id, ts, coo_id, room_id, kind, from_name, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('m1', 1, 'coo-aaaaaaaa', 'lobby', 'whisper', '阿岚', '在吗');
    await db.prepare('INSERT INTO mail(id, ts, coo_id, room_id, kind, from_name, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('m2', 2, 'coo-aaaaaaaa', 'lobby', 'gift', '小满', '礼物');

    expect(((await db.prepare('SELECT COUNT(*) AS n FROM mail WHERE coo_id = ? AND read_at IS NULL').get('coo-aaaaaaaa')) as { n: number }).n).toBe(2);
    await db.prepare('UPDATE mail SET read_at = 3 WHERE id = ?').run('m1');
    expect(((await db.prepare('SELECT COUNT(*) AS n FROM mail WHERE coo_id = ? AND read_at IS NULL').get('coo-aaaaaaaa')) as { n: number }).n).toBe(1);
  });

  it('信箱支持 invite（跨厅邀请）', async () => {
    await coo('coo-aaaaaaaa');
    await room('lobby', 'coo-aaaaaaaa');
    await db.prepare('INSERT INTO mail(id, ts, coo_id, room_id, kind, from_name, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('m1', 1, 'coo-aaaaaaaa', 'lobby', 'invite', '阿岚', '来我客厅');
    const row = await db.prepare('SELECT kind FROM mail WHERE id = ?').get('m1') as { kind: string };
    expect(row.kind).toBe('invite');
  });

  it('账本 grant 只发一次；refill 可另记', async () => {
    await coo('coo-aaaaaaaa');
    await room('lobby', 'coo-aaaaaaaa');
    const grant = async (id: string, refill: number): Promise<void> => {
      await db.prepare(
        'INSERT INTO ledger_entries(id, ts, room_id, kind, visibility, from_kind, to_kind, to_coo_id, text, is_refill) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, 1, 'lobby', 'grant', 'private', 'room', 'coo', 'coo-aaaaaaaa', '筹码', refill);
    };
    await grant('g1', 0);
    await expect(grant('g2', 0)).rejects.toThrow(/UNIQUE|duplicate key/i);
    await expect(grant('g3', 1)).resolves.not.toThrow();
  });
});

describe('schema 5：多桌 / 可靠存档 / 准入', () => {
  const columns = async (table: string): Promise<string[]> => (
    (await db.prepare(`PRAGMA table_info(${table})`).all()) as { name: string }[]
  ).map((row) => row.name);

  itSqlite('tables 与 table_seats 的新列都在，一房一桌的索引已删', async () => {
    expect(await columns('tables')).toEqual(expect.arrayContaining([
      'revision', 'state_version', 'frozen_at', 'recovery_error',
    ]));
    expect(await columns('table_seats')).toContain('auto');
    const indexes = ((await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tables'",
    ).all()) as { name: string }[]).map((row) => row.name);
    expect(indexes).not.toContain('ux_live_table_per_room');
  });

  itSqlite('回执、终态、一人一桌、准入与邀请的表都在', async () => {
    const names = ((await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all()) as { name: string }[]).map((row) => row.name);
    for (const table of [
      'action_receipts', 'table_finalizations', 'active_table_players', 'room_access', 'room_invitations',
    ]) {
      expect(names).toContain(table);
    }
  });

  it('比本程序新的库拒绝打开', async () => {
    await db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
    await expect(migrate(db)).rejects.toThrow(/schema 99/);
  });
});
