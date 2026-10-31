import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDb, withTransaction, type Db } from '../src/room/db.ts';

let db: Db;

beforeEach(() => {
  db = openDb();
  migrate(db);
});

afterEach(() => {
  db.close();
});

const coo = (id: string, kind = 'pet'): void => {
  db.prepare('INSERT INTO coos(id, kind, display_name, created_at) VALUES (?, ?, ?, ?)').run(id, kind, id, 1);
};

const room = (id: string, owner: string, capacity = 8, kind = 'room'): void => {
  db.prepare(
    'INSERT INTO rooms(id, kind, name, owner_coo_id, visibility, capacity, epoch, seq, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 1)',
  ).run(id, kind, id, kind === 'hall' ? null : owner, 'unlisted', capacity, `epoch-${id}`);
};

const seat = (roomId: string, id: string, cooId: string, name: string, token: string): void => {
  db.prepare(
    'INSERT INTO room_seats(room_id, id, coo_id, kind, name, tier, token_hash, joined_at, visible_from_seq) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)',
  ).run(roomId, id, cooId, 'pet', name, 'digest', token);
};

describe('SQLite 地基', () => {
  it('migrate 可重复执行，schema 版本写进 meta', () => {
    migrate(db);
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string };
    expect(row.value).toBe('6');
    const mode = db.prepare('SELECT value FROM meta WHERE key = ?').get('storage_mode') as { value: string };
    expect(mode.value).toBe('sqlite');
  });

  it('老库没有 from_coo_id 时能补列并建索引（不能在建索引那步炸）', () => {
    migrate(db);
    db.exec('DROP INDEX IF EXISTS ix_mail_peer');
    db.exec('ALTER TABLE mail DROP COLUMN from_coo_id');
    db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    expect(() => migrate(db)).not.toThrow();
    const cols = (db.prepare('PRAGMA table_info(mail)').all() as { name: string }[]).map((row) => row.name);
    expect(cols).toContain('from_coo_id');
    const index = db.prepare("SELECT name FROM sqlite_master WHERE name = 'ix_mail_peer'").get();
    expect(index).toBeTruthy();
  });

  it('老库 capacity CHECK 只有 64：迁移重建 rooms，数据与外键都保住', () => {
    const oldDb = openDb();
    try {
      // 0.20/0.21 时代的 rooms 建表（CHECK 2–64）；coos 先建出来，后面要插外键。
      oldDb.exec(`
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
      oldDb.prepare('INSERT INTO coos(id, kind, display_name, created_at) VALUES (?, ?, ?, ?)')
        .run('coo-aaaaaaaa', 'human', '爸爸', 1);
      oldDb.prepare(
        `INSERT INTO rooms(id, kind, name, owner_coo_id, visibility, capacity, epoch, seq, created_at, last_active_at)
         VALUES ('hall', 'hall', '大厅', NULL, 'public', 32, 'e-hall', 0, 1, 1)`,
      ).run();
      oldDb.prepare(
        `INSERT INTO rooms(id, kind, name, owner_coo_id, visibility, capacity, epoch, seq, created_at, last_active_at)
         VALUES ('big', 'room', '大房', 'coo-aaaaaaaa', 'public', 64, 'e-big', 0, 1, 1)`,
      ).run();

      migrate(oldDb);

      // 大厅从 32 抬到 400；普通客厅从 64 收到 30。
      const hall = oldDb.prepare("SELECT capacity FROM rooms WHERE id = 'hall'").get() as { capacity: number };
      expect(hall.capacity).toBe(400);
      const big = oldDb.prepare("SELECT capacity FROM rooms WHERE id = 'big'").get() as { capacity: number };
      expect(big.capacity).toBe(30);

      // 库级 CHECK 仍允许 300、拒绝 501（这是最后兜底；接口层才是 30）。
      oldDb.prepare("UPDATE rooms SET capacity = 300 WHERE id = 'big'").run();
      expect(() => oldDb.prepare("UPDATE rooms SET capacity = 501 WHERE id = 'hall'").run())
        .toThrow(/CHECK/);

      // 再跑一次 migrate：大房被收回 30，大厅不动。
      migrate(oldDb);
      expect((oldDb.prepare("SELECT capacity FROM rooms WHERE id = 'big'").get() as { capacity: number }).capacity).toBe(30);
      expect((oldDb.prepare("SELECT capacity FROM rooms WHERE id = 'hall'").get() as { capacity: number }).capacity).toBe(400);

      // 外键、索引与触发器都还在。
      expect(oldDb.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const indexes = (oldDb.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'rooms'",
      ).all() as { name: string }[]).map((row) => row.name);
      expect(indexes).toEqual(expect.arrayContaining([
        'ux_rooms_hall', 'ux_rooms_invite', 'ix_rooms_directory', 'ix_rooms_owner',
      ]));
      oldDb.prepare(
        `INSERT INTO room_seats(room_id, id, coo_id, kind, name, tier, token_hash, joined_at, visible_from_seq)
         VALUES ('big', 's1', 'coo-aaaaaaaa', 'human', '爸爸', 'full', 'token-1', 1, 0)`,
      ).run();
      expect(oldDb.prepare("SELECT COUNT(*) AS n FROM room_seats WHERE room_id = 'big'").get())
        .toEqual({ n: 1 });

      const version = oldDb.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
      expect(version.value).toBe('6');
    } finally {
      oldDb.close();
    }
  });

  it('身份 → 账户 → 客厅 → 席位的基本写入', () => {
    coo('coo-aaaaaaaa');
    db.prepare(
      'INSERT INTO accounts(id, coo_id, display_name, owner_key_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('a1', 'coo-aaaaaaaa', '爸爸', 'a'.repeat(64), 1);
    room('lobby', 'coo-aaaaaaaa');
    seat('lobby', 's1', 'coo-aaaaaaaa', '阿岚', 'token-1');

    const account = db.prepare('SELECT coo_id, display_name FROM accounts WHERE id = ?').get('a1') as { coo_id: string; display_name: string };
    expect(account).toEqual({ coo_id: 'coo-aaaaaaaa', display_name: '爸爸' });
    const row = db.prepare('SELECT COUNT(*) AS n FROM room_seats WHERE released_at IS NULL').get() as { n: number };
    expect(row.n).toBe(1);
  });

  it('一个 Coo 全局只能一个活跃席位', () => {
    coo('coo-aaaaaaaa');
    room('lobby', 'coo-aaaaaaaa');
    room('other', 'coo-aaaaaaaa');
    seat('lobby', 's1', 'coo-aaaaaaaa', '阿岚', 'token-1');
    expect(() => seat('other', 's1', 'coo-aaaaaaaa', '阿岚', 'token-2')).toThrow(/UNIQUE/);
  });

  it('一个客厅一个活跃席位的名字唯一；释放后可以复用', () => {
    coo('coo-aaaaaaaa');
    coo('coo-bbbbbbbb');
    room('lobby', 'coo-aaaaaaaa');
    seat('lobby', 's1', 'coo-aaaaaaaa', '阿岚', 'token-1');
    expect(() => seat('lobby', 's2', 'coo-bbbbbbbb', '阿岚', 'token-2')).toThrow(/UNIQUE/);

    db.prepare('UPDATE room_seats SET released_at = 2, visible_to_seq = 0 WHERE room_id = ? AND id = ?').run('lobby', 's1');
    expect(() => seat('lobby', 's3', 'coo-bbbbbbbb', '阿岚', 'token-3')).not.toThrow();
  });

  it('容量 trigger：只算活跃的非 observer 席位', () => {
    coo('coo-aaaaaaaa');
    coo('coo-bbbbbbbb');
    coo('coo-cccccccc');
    room('lobby', 'coo-aaaaaaaa', 2);
    seat('lobby', 's1', 'coo-aaaaaaaa', '甲', 'token-1');
    seat('lobby', 's2', 'coo-bbbbbbbb', '乙', 'token-2');
    expect(() => seat('lobby', 's3', 'coo-cccccccc', '丙', 'token-3')).toThrow(/room_full/);
  });

  it('一个 Coo 一个账户', () => {
    coo('coo-aaaaaaaa');
    db.prepare('INSERT INTO accounts(id, coo_id, display_name, owner_key_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('a1', 'coo-aaaaaaaa', '爸爸', 'a'.repeat(64), 1);
    expect(() => db.prepare('INSERT INTO accounts(id, coo_id, display_name, owner_key_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('a2', 'coo-aaaaaaaa', '妈妈', 'b'.repeat(64), 1)).toThrow(/UNIQUE/);
  });

  it('外键打开：账户必须有对应 coo', () => {
    expect(() => db.prepare('INSERT INTO accounts(id, coo_id, display_name, owner_key_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('a1', 'coo-missing', '爸爸', 'a'.repeat(64), 1)).toThrow(/FOREIGN KEY/);
  });

  it('事务回滚：写一半失败不留行；提交成功才留', () => {
    coo('coo-aaaaaaaa');
    expect(() => withTransaction(db, () => {
      room('lobby', 'coo-aaaaaaaa');
      throw new Error('stop');
    })).toThrow('stop');
    expect((db.prepare('SELECT COUNT(*) AS n FROM rooms').get() as { n: number }).n).toBe(0);

    withTransaction(db, () => { room('lobby', 'coo-aaaaaaaa'); });
    expect((db.prepare('SELECT COUNT(*) AS n FROM rooms').get() as { n: number }).n).toBe(1);
  });

  it('嵌套事务：内层失败只回滚内层，外层继续提交', () => {
    coo('coo-aaaaaaaa');
    withTransaction(db, () => {
      room('lobby', 'coo-aaaaaaaa');
      expect(() => withTransaction(db, () => {
        room('inner', 'coo-aaaaaaaa');
        throw new Error('inner');
      })).toThrow('inner');
      room('outer2', 'coo-aaaaaaaa');
    });
    const ids = (db.prepare('SELECT id FROM rooms ORDER BY id').all() as { id: string }[]).map((row) => row.id);
    expect(ids).toEqual(['lobby', 'outer2']);
  });

  it('嵌套事务：外层失败时内层成功也一起回滚', () => {
    coo('coo-aaaaaaaa');
    expect(() => withTransaction(db, () => {
      withTransaction(db, () => { room('lobby', 'coo-aaaaaaaa'); });
      throw new Error('outer');
    })).toThrow('outer');
    expect((db.prepare('SELECT COUNT(*) AS n FROM rooms').get() as { n: number }).n).toBe(0);
  });

  it('信箱逐封 read_at：未读只数 read_at IS NULL', () => {
    coo('coo-aaaaaaaa');
    room('lobby', 'coo-aaaaaaaa');
    db.prepare('INSERT INTO mail(id, ts, coo_id, room_id, kind, from_name, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('m1', 1, 'coo-aaaaaaaa', 'lobby', 'whisper', '阿岚', '在吗');
    db.prepare('INSERT INTO mail(id, ts, coo_id, room_id, kind, from_name, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('m2', 2, 'coo-aaaaaaaa', 'lobby', 'gift', '小满', '礼物');

    expect((db.prepare('SELECT COUNT(*) AS n FROM mail WHERE coo_id = ? AND read_at IS NULL').get('coo-aaaaaaaa') as { n: number }).n).toBe(2);
    db.prepare('UPDATE mail SET read_at = 3 WHERE id = ?').run('m1');
    expect((db.prepare('SELECT COUNT(*) AS n FROM mail WHERE coo_id = ? AND read_at IS NULL').get('coo-aaaaaaaa') as { n: number }).n).toBe(1);
  });

  it('信箱支持 invite（跨厅邀请）', () => {
    coo('coo-aaaaaaaa');
    room('lobby', 'coo-aaaaaaaa');
    db.prepare('INSERT INTO mail(id, ts, coo_id, room_id, kind, from_name, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('m1', 1, 'coo-aaaaaaaa', 'lobby', 'invite', '阿岚', '来我客厅');
    const row = db.prepare('SELECT kind FROM mail WHERE id = ?').get('m1') as { kind: string };
    expect(row.kind).toBe('invite');
  });

  it('账本 grant 只发一次；refill 可另记', () => {
    coo('coo-aaaaaaaa');
    room('lobby', 'coo-aaaaaaaa');
    const grant = (id: string, refill: number): void => {
      db.prepare(
        'INSERT INTO ledger_entries(id, ts, room_id, kind, visibility, from_kind, to_kind, to_coo_id, text, is_refill) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, 1, 'lobby', 'grant', 'private', 'room', 'coo', 'coo-aaaaaaaa', '筹码', refill);
    };
    grant('g1', 0);
    expect(() => grant('g2', 0)).toThrow(/UNIQUE/);
    expect(() => grant('g3', 1)).not.toThrow();
  });
});

describe('schema 5：多桌 / 可靠存档 / 准入', () => {
  const columns = (table: string): string[] => (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((row) => row.name);

  it('tables 与 table_seats 的新列都在，一房一桌的索引已删', () => {
    expect(columns('tables')).toEqual(expect.arrayContaining([
      'revision', 'state_version', 'frozen_at', 'recovery_error',
    ]));
    expect(columns('table_seats')).toContain('auto');
    const indexes = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tables'",
    ).all() as { name: string }[]).map((row) => row.name);
    expect(indexes).not.toContain('ux_live_table_per_room');
  });

  it('回执、终态、一人一桌、准入与邀请的表都在', () => {
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all() as { name: string }[]).map((row) => row.name);
    for (const table of [
      'action_receipts', 'table_finalizations', 'active_table_players', 'room_access', 'room_invitations',
    ]) {
      expect(names).toContain(table);
    }
  });

  it('比本程序新的库拒绝打开', () => {
    db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
    expect(() => migrate(db)).toThrow(/schema 99/);
  });
});
