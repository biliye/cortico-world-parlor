import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore, publicAccount } from '../src/room/accounts.ts';

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const tempFile = (): string => {
  dir = mkdtempSync(join(tmpdir(), 'parlor-accounts-'));
  return join(dir, 'accounts.json');
};

const COO = 'd3953d2f-0000-4000-8000-000000000001';

describe('家长账户与全局 ownerKey', () => {
  it('第一次自动建账户并返回一次 ownerKey，第二次不再返回', () => {
    const store = new AccountStore();
    const first = store.ensureAccount(COO, '爸爸');
    expect(first.created).toBe(true);
    expect(first.ownerKey).toBeTruthy();
    expect(first.ownerKey!.length).toBeGreaterThanOrEqual(32);
    expect(first.account.displayName).toBe('爸爸');

    const second = store.ensureAccount(COO, '另一个名字');
    expect(second.created).toBe(false);
    expect(second.ownerKey).toBeUndefined();
    expect(second.account.id).toBe(first.account.id);
    expect(second.account.displayName).toBe('爸爸');
    expect(store.size).toBe(1);
  });

  it('一个 Coo 只能一个账户，一个账户只对应一个 Coo', () => {
    const store = new AccountStore();
    const a = store.ensureAccount(COO);
    const b = store.ensureAccount(COO);
    expect(a.account.id).toBe(b.account.id);
    expect(store.all().every((account) => account.cooId === COO)).toBe(true);
    expect(new Set(store.all().map((account) => account.cooId)).size).toBe(store.size);
  });

  it('ownerKey 验证：对的认，错的/别的账户的不认', () => {
    const store = new AccountStore();
    const a = store.ensureAccount(COO);
    const other = store.ensureAccount('d3953d2f-0000-4000-8000-000000000002');
    expect(store.verifyOwnerKey(a.ownerKey!)?.id).toBe(a.account.id);
    expect(store.verifyOwnerKey('x'.repeat(32))).toBeNull();
    expect(store.verifyOwnerKey('')).toBeNull();
    expect(store.verifyOwnerKey(other.ownerKey!)?.id).toBe(other.account.id);
  });

  it('轮换后旧 key 失效，新 key 可用，sessionVersion +1', () => {
    const store = new AccountStore();
    const first = store.ensureAccount(COO);
    const before = first.account.sessionVersion;
    const next = store.rotateOwnerKey(COO);
    expect(next).toBeTruthy();
    expect(next).not.toBe(first.ownerKey);
    expect(store.verifyOwnerKey(first.ownerKey!)).toBeNull();
    expect(store.verifyOwnerKey(next!)?.id).toBe(first.account.id);
    expect(store.byCooId(COO)!.sessionVersion).toBe(before + 1);
  });

  it('改名；空名字拒绝', () => {
    const store = new AccountStore();
    const { account } = store.ensureAccount(COO, '家长');
    const renamed = store.rename(account.id, '  妈妈  ');
    expect(renamed?.displayName).toBe('妈妈');
    expect(store.rename(account.id, '   ')).toBeNull();
    expect(store.byId(account.id)!.displayName).toBe('妈妈');
  });

  it('退出所有设备只动 sessionVersion', () => {
    const store = new AccountStore();
    const { account, ownerKey } = store.ensureAccount(COO);
    const before = account.sessionVersion;
    expect(store.bumpSession(account.id)).toBe(true);
    expect(store.byId(account.id)!.sessionVersion).toBe(before + 1);
    expect(store.verifyOwnerKey(ownerKey!)).not.toBeNull();
  });

  it('落盘后重载：账户、key、版本都能对上', () => {
    const file = tempFile();
    const first = AccountStore.load({ file });
    const created = first.ensureAccount(COO, '爸爸');

    const second = AccountStore.load({ file });
    expect(second.size).toBe(1);
    const account = second.byCooId(COO);
    expect(account?.id).toBe(created.account.id);
    expect(account?.displayName).toBe('爸爸');
    expect(second.verifyOwnerKey(created.ownerKey!)?.id).toBe(created.account.id);
    expect(second.byCooId(COO)?.sessionVersion).toBe(1);
  });

  it('坏文件从空账户表开始，不阻断启动', () => {
    const file = tempFile();
    writeFileSync(file, '{ 坏掉的 json', 'utf8');
    const store = AccountStore.load({ file });
    expect(store.size).toBe(0);
    expect(store.ensureAccount(COO).created).toBe(true);
  });

  it('非法 cooId 拒绝', () => {
    const store = new AccountStore();
    expect(() => store.ensureAccount('x')).toThrow(/cooId/);
    expect(() => store.ensureAccount('')).toThrow(/cooId/);
  });

  it('账户上限', () => {
    const store = new AccountStore({ limit: 2 });
    store.ensureAccount(COO);
    store.ensureAccount('d3953d2f-0000-4000-8000-000000000002');
    expect(() => store.ensureAccount('d3953d2f-0000-4000-8000-000000000003')).toThrow(/满了/);
  });

  it('对外的账户视图不带 ownerKeyHash', () => {
    const store = new AccountStore();
    const { account } = store.ensureAccount(COO);
    const view = publicAccount(account);
    expect(view).toEqual({
      id: account.id,
      cooId: account.cooId,
      displayName: account.displayName,
      createdAt: account.createdAt,
    });
    expect('ownerKeyHash' in view).toBe(false);
    expect(JSON.stringify(view)).not.toContain(account.ownerKeyHash);
  });

  it('落盘文件里只有哈希，没有明文 ownerKey', () => {
    const file = tempFile();
    const store = AccountStore.load({ file });
    const { ownerKey } = store.ensureAccount(COO);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(ownerKey!);
    expect(raw).toContain('ownerKeyHash');
  });
});
