import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY_FILE, loadOrCreateIdentity } from '../src/room/identity.ts';

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('账本身份', () => {
  it('第一次生成并落盘，第二次读回同一份', () => {
    dir = mkdtempSync(join(tmpdir(), 'parlor-identity-'));
    const file = join(dir, IDENTITY_FILE);
    const first = loadOrCreateIdentity(file);
    expect(first.cooId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(first.cooSecret.length).toBeGreaterThanOrEqual(16);
    const second = loadOrCreateIdentity(file);
    expect(second).toEqual(first);
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { cooId: string };
    expect(raw.cooId).toBe(first.cooId);
  });

  it('文件坏了就生成新的，不阻断启动', () => {
    dir = mkdtempSync(join(tmpdir(), 'parlor-identity-'));
    const file = join(dir, IDENTITY_FILE);
    writeFileSync(file, '{ 坏掉的 json', 'utf8');
    const identity = loadOrCreateIdentity(file);
    expect(identity.cooId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ cooId: identity.cooId });
  });
});
