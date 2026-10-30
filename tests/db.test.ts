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
    expect(row.value).toBe('3');
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
