import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTransaction, type Db } from '../src/room/db.ts';
import {
  CooAccountDb,
  type CooKind,
} from '../src/room/coo-account-db.ts';
import { closeTestDb, openTestDb } from './helpers/test-db.ts';
import { pgTestEnabled } from './helpers/pg.ts';

const itSqlite = pgTestEnabled() ? it.skip : it;

const COO = 'd3953d2f-0000-4000-8000-000000000001';
const COO_B = 'd3953d2f-0000-4000-8000-000000000002';
const COO_C = 'd3953d2f-0000-4000-8000-000000000003';
const SECRET = 'secret-1234567890';

let db: Db;
let store: CooAccountDb;
let clock: number;

beforeEach(async () => {
  clock = 1_000;
  db = await openTestDb();
  store = new CooAccountDb(db, { now: () => clock });
});

afterEach(async () => {
  await closeTestDb(db);
});

describe('全局 Coo 身份', () => {
  it('registerCoo 自动注册身份；重复注册幂等，换 secret 是 mismatch', async () => {
    expect(await store.registerCoo(COO, SECRET, 'pet', '阿岚')).toBe('ok');
    expect(await store.findCoo(COO)).toMatchObject({
      id: COO,
      kind: 'pet',
      displayName: '阿岚',
      status: 'active',
      hasSecret: true,
    });

    clock = 2_000;
    expect(await store.registerCoo(COO, SECRET, 'human', '换个名字')).toBe('ok');
    expect((await store.findCoo(COO))?.kind).toBe('pet');
    expect((await store.findCoo(COO))?.displayName).toBe('阿岚');
    expect((await store.findCoo(COO))?.lastSeenAt).toBe(2_000);
    expect((await store.findCoo(COO))?.createdAt).toBe(1_000);

    expect(await store.registerCoo(COO, 'another-secret-1234', 'pet')).toBe('mismatch');
  });

  it('claimIdentity：对 ok、错 mismatch、未知/非法 invalid', async () => {
    await store.registerCoo(COO, SECRET, 'pet', '阿岚');
    expect(await store.claimIdentity(COO, SECRET)).toBe('ok');
    expect(await store.claimIdentity(COO, 'another-secret-1234')).toBe('mismatch');
    expect(await store.claimIdentity(COO_B, SECRET)).toBe('invalid');
    expect(await store.claimIdentity('x', SECRET)).toBe('invalid');
    expect(await store.claimIdentity(COO, 'short')).toBe('invalid');
    expect(await store.findCoo(COO_B)).toBeUndefined();
  });

  it('同一个 secret 不能绑到两个 coo', async () => {
    expect(await store.registerCoo(COO, SECRET, 'pet')).toBe('ok');
    expect(await store.registerCoo(COO_B, SECRET, 'pet')).toBe('invalid');
    expect(await store.findCoo(COO_B)).toBeUndefined();
  });

  it('ensureAccount 先建的占位身份可以被 registerCoo 认领', async () => {
    const created = await store.ensureAccount(COO, '家长');
    expect((await store.findCoo(COO))?.hasSecret).toBe(false);
    expect(await store.claimIdentity(COO, SECRET)).toBe('invalid');

    expect(await store.registerCoo(COO, SECRET, 'human', '阿岚')).toBe('ok');
    expect(await store.findCoo(COO)).toMatchObject({ kind: 'human', displayName: '阿岚', hasSecret: true });
    expect(await store.claimIdentity(COO, SECRET)).toBe('ok');
    expect((await store.byCooId(COO))?.id).toBe(created.account.id);
  });
});

describe('家长账户', () => {
  it('ensureAccount 自动建 1:1 账户，ownerKey 只返回一次', async () => {
    const first = await store.ensureAccount(COO, '爸爸');
    expect(first.created).toBe(true);
    expect(first.ownerKey).toBeTruthy();
    expect(first.ownerKey!.length).toBeGreaterThanOrEqual(32);
    expect(first.account.displayName).toBe('爸爸');
    expect(first.account.cooId).toBe(COO);
    expect(first.account.sessionVersion).toBe(1);
    expect(await store.count()).toBe(1);

    const second = await store.ensureAccount(COO, '另一个名字');
    expect(second.created).toBe(false);
    expect(second.ownerKey).toBeUndefined();
    expect(second.account.id).toBe(first.account.id);
    expect(second.account.displayName).toBe('爸爸');
    expect(await store.count()).toBe(1);
  });

  it('一个 Coo 一个账户：库里 UNIQUE 兜底', async () => {
    const { account } = await store.ensureAccount(COO);
    await expect(db.prepare(
      'INSERT INTO accounts(id, coo_id, display_name, owner_key_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('a-second', COO, '妈妈', 'b'.repeat(64), 1)).rejects.toThrow(/UNIQUE|duplicate key/i);
    expect(await store.count()).toBe(1);
    expect((await store.byCooId(COO))?.id).toBe(account.id);
  });

  it('ownerKey 验证：对的认，错的/别的账户的认到各自账户', async () => {
    const a = await store.ensureAccount(COO);
    const b = await store.ensureAccount(COO_B);
    expect((await store.verifyOwnerKey(a.ownerKey!))?.id).toBe(a.account.id);
    expect(await store.verifyOwnerKey(`${a.ownerKey!}x`)).toBeNull();
    expect(await store.verifyOwnerKey('x'.repeat(32))).toBeNull();
    expect(await store.verifyOwnerKey('')).toBeNull();
    expect((await store.verifyOwnerKey(b.ownerKey!))?.id).toBe(b.account.id);
    expect((await store.verifyOwnerKey(b.ownerKey!))?.cooId).toBe(COO_B);
  });

  it('轮换后旧 key 失效，新 key 可用，sessionVersion +1', async () => {
    const first = await store.ensureAccount(COO);
    const before = first.account.sessionVersion;
    const next = await store.rotateOwnerKey(COO);
    expect(next).toBeTruthy();
    expect(next).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(next).not.toBe(first.ownerKey);
    expect(await store.verifyOwnerKey(first.ownerKey!)).toBeNull();
    expect((await store.verifyOwnerKey(next!))?.id).toBe(first.account.id);
    expect((await store.byCooId(COO))?.sessionVersion).toBe(before + 1);
    expect(await store.rotateOwnerKey(COO_B)).toBeNull();
  });

  it('改名：去掉多余空白；空名字拒绝', async () => {
    const { account } = await store.ensureAccount(COO, '家长');
    expect(await store.rename(account.id, '  妈妈  ')).toMatchObject({ displayName: '妈妈' });
    expect((await store.byId(account.id))?.displayName).toBe('妈妈');
    expect(await store.rename(account.id, '   ')).toBeNull();
    expect(await store.rename('missing-account', '爸爸')).toBeNull();
    expect((await store.byId(account.id))?.displayName).toBe('妈妈');
  });

  it('退出所有设备只动 sessionVersion，ownerKey 仍有效', async () => {
    const { account, ownerKey } = await store.ensureAccount(COO);
    const before = account.sessionVersion;
    expect(await store.bumpSession(account.id)).toBe(true);
    expect(await store.bumpSession(account.id)).toBe(true);
    expect((await store.byId(account.id))?.sessionVersion).toBe(before + 2);
    expect(await store.verifyOwnerKey(ownerKey!)).not.toBeNull();
    expect(await store.bumpSession('missing-account')).toBe(false);
  });

  it('账户视图不带 ownerKeyHash', async () => {
    const { account } = await store.ensureAccount(COO, '爸爸');
    const views = await store.views();
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

  it('库里只有 sha256 哈希，没有明文 ownerKey', async () => {
    const { account, ownerKey } = await store.ensureAccount(COO);
    const row = await db.prepare('SELECT owner_key_hash FROM accounts WHERE id = ?')
      .get(account.id) as { owner_key_hash: string };
    expect(row.owner_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.owner_key_hash).not.toBe(ownerKey);
    expect(row.owner_key_hash).toBe(createHash('sha256').update(ownerKey!).digest('hex'));
    expect(JSON.stringify(await db.prepare('SELECT * FROM accounts').all())).not.toContain(ownerKey!);
  });
});

describe('持久化、事务与上限', () => {
  it('关掉重开后账户、key、版本、coo 身份都还在', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parlor-coo-account-'));
    try {
      const file = join(dir, 'parlor.db');
      let first = new CooAccountDb(await openTestDb(file), { now: () => 1_000 });
      await first.registerCoo(COO, SECRET, 'human', '阿岚');
      const created = await first.ensureAccount(COO, '爸爸');
      await first.rename(created.account.id, '妈妈');
      await first.bumpSession(created.account.id);
      await closeTestDb(first.db);

      const reopened = new CooAccountDb(await openTestDb(file));
      try {
        expect(await reopened.count()).toBe(1);
        expect(await reopened.byCooId(COO)).toMatchObject({
          id: created.account.id,
          displayName: '妈妈',
          sessionVersion: 2,
        });
        expect((await reopened.verifyOwnerKey(created.ownerKey!))?.id).toBe(created.account.id);
        expect(await reopened.claimIdentity(COO, SECRET)).toBe('ok');
        expect(await reopened.findCoo(COO)).toMatchObject({ kind: 'human', displayName: '阿岚', hasSecret: true });
      } finally {
        await closeTestDb(reopened.db);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('外层事务回滚：改名/轮换/退出都退回', async () => {
    const created = await store.ensureAccount(COO, '爸爸');
    const ownerKey = created.ownerKey!;
    const before = (await store.byId(created.account.id))!.sessionVersion;

    await expect(withTransaction(db, async () => {
      await store.rename(created.account.id, '妈妈');
      const next = await store.rotateOwnerKey(COO);
      expect(next).toBeTruthy();
      expect(await store.verifyOwnerKey(ownerKey)).toBeNull();
      expect(await store.bumpSession(created.account.id)).toBe(true);
      throw new Error('stop');
    })).rejects.toThrow('stop');

    expect(await store.byId(created.account.id)).toMatchObject({
      displayName: '爸爸',
      sessionVersion: before,
    });
    expect((await store.verifyOwnerKey(ownerKey))?.id).toBe(created.account.id);
  });

  itSqlite('建账户中途失败整段回滚，不留占位 coo', async () => {
    await db.exec("CREATE TRIGGER t_fail_account BEFORE INSERT ON accounts BEGIN SELECT RAISE(ABORT, 'boom'); END");
    await expect(store.ensureAccount(COO)).rejects.toThrow(/boom/);
    expect(await store.count()).toBe(0);
    expect(await store.findCoo(COO)).toBeUndefined();

    await db.exec('DROP TRIGGER t_fail_account');
    expect((await store.ensureAccount(COO)).created).toBe(true);
    expect(await store.count()).toBe(1);
  });

  it('账户上限：满了拒绝，不留下半截数据', async () => {
    const limited = new CooAccountDb(db, { now: () => 1_000, limit: 1 });
    await limited.ensureAccount(COO);
    await expect(limited.ensureAccount(COO_B)).rejects.toThrow(/满了/);
    expect(await limited.count()).toBe(1);
    expect(await limited.findCoo(COO_B)).toBeUndefined();
  });

  it('非法 cooId / secret / kind 拒绝', async () => {
    await expect(store.ensureAccount('x')).rejects.toThrow(/cooId/);
    await expect(store.ensureAccount('')).rejects.toThrow(/cooId/);

    expect(await store.registerCoo('x', SECRET, 'pet')).toBe('invalid');
    expect(await store.registerCoo('', SECRET, 'pet')).toBe('invalid');
    expect(await store.registerCoo(COO, 'short', 'pet')).toBe('invalid');
    expect(await store.registerCoo(COO, SECRET, 'dragon' as CooKind)).toBe('invalid');
    expect(await store.findCoo(COO)).toBeUndefined();

    expect(await store.claimIdentity('x', SECRET)).toBe('invalid');
    expect(await store.byCooId('x')).toBeUndefined();
    expect(await store.rotateOwnerKey('x')).toBeNull();
    expect(await store.verifyOwnerKey('short')).toBeNull();
  });

  it('三个 Coo 各自一份账户，互不影响', async () => {
    const a = await store.ensureAccount(COO, '爸爸');
    const b = await store.ensureAccount(COO_B, '妈妈');
    const c = await store.ensureAccount(COO_C);
    expect(await store.count()).toBe(3);
    expect(new Set([a.account.id, b.account.id, c.account.id]).size).toBe(3);

    await store.bumpSession(b.account.id);
    expect((await store.byCooId(COO))?.sessionVersion).toBe(1);
    expect((await store.byCooId(COO_B))?.sessionVersion).toBe(2);
    expect((await store.byCooId(COO_C))?.sessionVersion).toBe(1);
    expect((await store.verifyOwnerKey(a.ownerKey!))?.cooId).toBe(COO);
  });
});
