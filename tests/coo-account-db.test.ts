import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDb, withTransaction, type Db } from '../src/room/db.ts';
import {
  CooAccountDb,
  openCooAccountDb,
  type CooKind,
} from '../src/room/coo-account-db.ts';

const COO = 'd3953d2f-0000-4000-8000-000000000001';
const COO_B = 'd3953d2f-0000-4000-8000-000000000002';
const COO_C = 'd3953d2f-0000-4000-8000-000000000003';
const SECRET = 'secret-1234567890';

let db: Db;
let store: CooAccountDb;
let clock: number;

beforeEach(() => {
  clock = 1_000;
  db = openDb();
  migrate(db);
  store = new CooAccountDb(db, { now: () => clock });
});

afterEach(() => {
  db.close();
});

describe('全局 Coo 身份', () => {
  it('registerCoo 自动注册身份；重复注册幂等，换 secret 是 mismatch', () => {
    expect(store.registerCoo(COO, SECRET, 'pet', '阿岚')).toBe('ok');
    expect(store.findCoo(COO)).toMatchObject({
      id: COO,
      kind: 'pet',
      displayName: '阿岚',
      status: 'active',
      hasSecret: true,
    });

    clock = 2_000;
    expect(store.registerCoo(COO, SECRET, 'human', '换个名字')).toBe('ok');
    expect(store.findCoo(COO)?.kind).toBe('pet');
    expect(store.findCoo(COO)?.displayName).toBe('阿岚');
    expect(store.findCoo(COO)?.lastSeenAt).toBe(2_000);
    expect(store.findCoo(COO)?.createdAt).toBe(1_000);

    expect(store.registerCoo(COO, 'another-secret-1234', 'pet')).toBe('mismatch');
  });

  it('claimIdentity：对 ok、错 mismatch、未知/非法 invalid', () => {
    store.registerCoo(COO, SECRET, 'pet', '阿岚');
    expect(store.claimIdentity(COO, SECRET)).toBe('ok');
    expect(store.claimIdentity(COO, 'another-secret-1234')).toBe('mismatch');
    expect(store.claimIdentity(COO_B, SECRET)).toBe('invalid');
    expect(store.claimIdentity('x', SECRET)).toBe('invalid');
    expect(store.claimIdentity(COO, 'short')).toBe('invalid');
    expect(store.findCoo(COO_B)).toBeUndefined();
  });

  it('同一个 secret 不能绑到两个 coo', () => {
    expect(store.registerCoo(COO, SECRET, 'pet')).toBe('ok');
    expect(store.registerCoo(COO_B, SECRET, 'pet')).toBe('invalid');
    expect(store.findCoo(COO_B)).toBeUndefined();
  });

  it('ensureAccount 先建的占位身份可以被 registerCoo 认领', () => {
    const created = store.ensureAccount(COO, '家长');
    expect(store.findCoo(COO)?.hasSecret).toBe(false);
    expect(store.claimIdentity(COO, SECRET)).toBe('invalid');

    expect(store.registerCoo(COO, SECRET, 'human', '阿岚')).toBe('ok');
    expect(store.findCoo(COO)).toMatchObject({ kind: 'human', displayName: '阿岚', hasSecret: true });
    expect(store.claimIdentity(COO, SECRET)).toBe('ok');
    expect(store.byCooId(COO)?.id).toBe(created.account.id);
  });
});

describe('家长账户', () => {
  it('ensureAccount 自动建 1:1 账户，ownerKey 只返回一次', () => {
    const first = store.ensureAccount(COO, '爸爸');
    expect(first.created).toBe(true);
    expect(first.ownerKey).toBeTruthy();
    expect(first.ownerKey!.length).toBeGreaterThanOrEqual(32);
    expect(first.account.displayName).toBe('爸爸');
    expect(first.account.cooId).toBe(COO);
    expect(first.account.sessionVersion).toBe(1);
    expect(store.count()).toBe(1);

    const second = store.ensureAccount(COO, '另一个名字');
    expect(second.created).toBe(false);
    expect(second.ownerKey).toBeUndefined();
    expect(second.account.id).toBe(first.account.id);
    expect(second.account.displayName).toBe('爸爸');
    expect(store.count()).toBe(1);
  });

  it('一个 Coo 一个账户：库里 UNIQUE 兜底', () => {
    const { account } = store.ensureAccount(COO);
    expect(() => db.prepare(
      'INSERT INTO accounts(id, coo_id, display_name, owner_key_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('a-second', COO, '妈妈', 'b'.repeat(64), 1)).toThrow(/UNIQUE/);
    expect(store.count()).toBe(1);
    expect(store.byCooId(COO)?.id).toBe(account.id);
  });

  it('ownerKey 验证：对的认，错的/别的账户的认到各自账户', () => {
    const a = store.ensureAccount(COO);
    const b = store.ensureAccount(COO_B);
    expect(store.verifyOwnerKey(a.ownerKey!)?.id).toBe(a.account.id);
    expect(store.verifyOwnerKey(`${a.ownerKey!}x`)).toBeNull();
    expect(store.verifyOwnerKey('x'.repeat(32))).toBeNull();
    expect(store.verifyOwnerKey('')).toBeNull();
    expect(store.verifyOwnerKey(b.ownerKey!)?.id).toBe(b.account.id);
    expect(store.verifyOwnerKey(b.ownerKey!)?.cooId).toBe(COO_B);
  });

  it('轮换后旧 key 失效，新 key 可用，sessionVersion +1', () => {
    const first = store.ensureAccount(COO);
    const before = first.account.sessionVersion;
    const next = store.rotateOwnerKey(COO);
    expect(next).toBeTruthy();
    expect(next).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(next).not.toBe(first.ownerKey);
    expect(store.verifyOwnerKey(first.ownerKey!)).toBeNull();
    expect(store.verifyOwnerKey(next!)?.id).toBe(first.account.id);
    expect(store.byCooId(COO)?.sessionVersion).toBe(before + 1);
    expect(store.rotateOwnerKey(COO_B)).toBeNull();
  });

  it('改名：去掉多余空白；空名字拒绝', () => {
    const { account } = store.ensureAccount(COO, '家长');
    expect(store.rename(account.id, '  妈妈  ')).toMatchObject({ displayName: '妈妈' });
    expect(store.byId(account.id)?.displayName).toBe('妈妈');
    expect(store.rename(account.id, '   ')).toBeNull();
    expect(store.rename('missing-account', '爸爸')).toBeNull();
    expect(store.byId(account.id)?.displayName).toBe('妈妈');
  });

  it('退出所有设备只动 sessionVersion，ownerKey 仍有效', () => {
    const { account, ownerKey } = store.ensureAccount(COO);
    const before = account.sessionVersion;
    expect(store.bumpSession(account.id)).toBe(true);
    expect(store.bumpSession(account.id)).toBe(true);
    expect(store.byId(account.id)?.sessionVersion).toBe(before + 2);
    expect(store.verifyOwnerKey(ownerKey!)).not.toBeNull();
    expect(store.bumpSession('missing-account')).toBe(false);
  });

  it('账户视图不带 ownerKeyHash', () => {
    const { account } = store.ensureAccount(COO, '爸爸');
    const views = store.views();
    expect(views).toEqual([{
      id: account.id,
      cooId: COO,
      displayName: '爸爸',
      createdAt: 1_000,
    }]);
    expect('ownerKeyHash' in views[0]).toBe(false);
    expect(JSON.stringify(views)).not.toContain(account.ownerKeyHash);
    expect(JSON.stringify(store.view(account))).not.toContain(account.ownerKeyHash);
  });

  it('库里只有 sha256 哈希，没有明文 ownerKey', () => {
    const { account, ownerKey } = store.ensureAccount(COO);
    const row = db.prepare('SELECT owner_key_hash FROM accounts WHERE id = ?')
      .get(account.id) as { owner_key_hash: string };
    expect(row.owner_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.owner_key_hash).not.toBe(ownerKey);
    expect(row.owner_key_hash).toBe(createHash('sha256').update(ownerKey!).digest('hex'));
    expect(JSON.stringify(db.prepare('SELECT * FROM accounts').all())).not.toContain(ownerKey!);
  });
});

describe('持久化、事务与上限', () => {
  it('关掉重开后账户、key、版本、coo 身份都还在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parlor-coo-account-'));
    try {
      const file = join(dir, 'parlor.db');
      let first = openCooAccountDb(file, { now: () => 1_000 });
      first.registerCoo(COO, SECRET, 'human', '阿岚');
      const created = first.ensureAccount(COO, '爸爸');
      first.rename(created.account.id, '妈妈');
      first.bumpSession(created.account.id);
      first.db.close();

      const reopened = openCooAccountDb(file);
      try {
        expect(reopened.count()).toBe(1);
        expect(reopened.byCooId(COO)).toMatchObject({
          id: created.account.id,
          displayName: '妈妈',
          sessionVersion: 2,
        });
        expect(reopened.verifyOwnerKey(created.ownerKey!)?.id).toBe(created.account.id);
        expect(reopened.claimIdentity(COO, SECRET)).toBe('ok');
        expect(reopened.findCoo(COO)).toMatchObject({ kind: 'human', displayName: '阿岚', hasSecret: true });
      } finally {
        reopened.db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('外层事务回滚：改名/轮换/退出都退回', () => {
    const created = store.ensureAccount(COO, '爸爸');
    const ownerKey = created.ownerKey!;
    const before = store.byId(created.account.id)!.sessionVersion;

    expect(() => withTransaction(db, () => {
      store.rename(created.account.id, '妈妈');
      const next = store.rotateOwnerKey(COO);
      expect(next).toBeTruthy();
      expect(store.verifyOwnerKey(ownerKey)).toBeNull();
      expect(store.bumpSession(created.account.id)).toBe(true);
      throw new Error('stop');
    })).toThrow('stop');

    expect(store.byId(created.account.id)).toMatchObject({
      displayName: '爸爸',
      sessionVersion: before,
    });
    expect(store.verifyOwnerKey(ownerKey)?.id).toBe(created.account.id);
  });

  it('建账户中途失败整段回滚，不留占位 coo', () => {
    db.exec("CREATE TRIGGER t_fail_account BEFORE INSERT ON accounts BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => store.ensureAccount(COO)).toThrow(/boom/);
    expect(store.count()).toBe(0);
    expect(store.findCoo(COO)).toBeUndefined();

    db.exec('DROP TRIGGER t_fail_account');
    expect(store.ensureAccount(COO).created).toBe(true);
    expect(store.count()).toBe(1);
  });

  it('账户上限：满了拒绝，不留下半截数据', () => {
    const limited = new CooAccountDb(db, { now: () => 1_000, limit: 1 });
    limited.ensureAccount(COO);
    expect(() => limited.ensureAccount(COO_B)).toThrow(/满了/);
    expect(limited.count()).toBe(1);
    expect(limited.findCoo(COO_B)).toBeUndefined();
  });

  it('非法 cooId / secret / kind 拒绝', () => {
    expect(() => store.ensureAccount('x')).toThrow(/cooId/);
    expect(() => store.ensureAccount('')).toThrow(/cooId/);

    expect(store.registerCoo('x', SECRET, 'pet')).toBe('invalid');
    expect(store.registerCoo('', SECRET, 'pet')).toBe('invalid');
    expect(store.registerCoo(COO, 'short', 'pet')).toBe('invalid');
    expect(store.registerCoo(COO, SECRET, 'dragon' as CooKind)).toBe('invalid');
    expect(store.findCoo(COO)).toBeUndefined();

    expect(store.claimIdentity('x', SECRET)).toBe('invalid');
    expect(store.byCooId('x')).toBeUndefined();
    expect(store.rotateOwnerKey('x')).toBeNull();
    expect(store.verifyOwnerKey('short')).toBeNull();
  });

  it('三个 Coo 各自一份账户，互不影响', () => {
    const a = store.ensureAccount(COO, '爸爸');
    const b = store.ensureAccount(COO_B, '妈妈');
    const c = store.ensureAccount(COO_C);
    expect(store.count()).toBe(3);
    expect(new Set([a.account.id, b.account.id, c.account.id]).size).toBe(3);

    store.bumpSession(b.account.id);
    expect(store.byCooId(COO)?.sessionVersion).toBe(1);
    expect(store.byCooId(COO_B)?.sessionVersion).toBe(2);
    expect(store.byCooId(COO_C)?.sessionVersion).toBe(1);
    expect(store.verifyOwnerKey(a.ownerKey!)?.cooId).toBe(COO);
  });
});
