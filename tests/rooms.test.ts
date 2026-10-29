import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomRegistry, SYSTEM_OWNER } from '../src/room/rooms.ts';

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const COO = 'd3953d2f-0000-4000-8000-000000000001';
const COO2 = 'd3953d2f-0000-4000-8000-000000000002';
const COO3 = 'd3953d2f-0000-4000-8000-000000000003';

const tempFile = (): string => {
  dir = mkdtempSync(join(tmpdir(), 'parlor-rooms-'));
  return join(dir, 'rooms.json');
};

describe('客厅注册表', () => {
  it('建客厅：id 生成、默认不公开、默认 8 席、带主题', () => {
    const registry = new RoomRegistry();
    const room = registry.create({ name: '可可厅', ownerCooId: COO, topic: '  一起打牌  ' });
    expect(room.id).toMatch(/^r-[A-Za-z0-9_-]+$/);
    expect(room.name).toBe('可可厅');
    expect(room.topic).toBe('一起打牌');
    expect(room.ownerCooId).toBe(COO);
    expect(room.visibility).toBe('unlisted');
    expect(room.maxSeats).toBe(8);
    expect(room.archivedAt).toBeUndefined();
    expect(registry.size).toBe(1);
  });

  it('非法输入拒绝', () => {
    const registry = new RoomRegistry();
    expect(() => registry.create({ name: 'x', ownerCooId: COO })).toThrow(/名字/);
    expect(() => registry.create({ name: '好厅', ownerCooId: 'x' })).toThrow(/cooId/);
    expect(() => registry.create({ name: '好厅', ownerCooId: COO, visibility: 'secret' as never })).toThrow(/可见性/);
    expect(() => registry.create({ name: '好厅', ownerCooId: COO, maxSeats: 1 })).toThrow(/席位/);
    expect(() => registry.create({ name: '好厅', ownerCooId: COO, maxSeats: 13 })).toThrow(/席位/);
  });

  it('一个 Coo 最多同时开 3 个；归档后腾出名额', () => {
    const registry = new RoomRegistry();
    const first = registry.create({ name: '一厅', ownerCooId: COO });
    registry.create({ name: '二厅', ownerCooId: COO });
    registry.create({ name: '三厅', ownerCooId: COO });
    expect(() => registry.create({ name: '四厅', ownerCooId: COO })).toThrow(/最多/);
    registry.archive(first.id);
    expect(() => registry.create({ name: '四厅', ownerCooId: COO })).not.toThrow();
  });

  it('总数上限', () => {
    const registry = new RoomRegistry({ limit: 2, perOwnerLimit: 10 });
    registry.create({ name: '一厅', ownerCooId: COO });
    registry.create({ name: '二厅', ownerCooId: COO2 });
    expect(() => registry.create({ name: '三厅', ownerCooId: COO3 })).toThrow(/上限/);
  });

  it('按 id 或名字找；名字大小写不敏感', () => {
    const registry = new RoomRegistry();
    const room = registry.create({ name: 'Cocoa', ownerCooId: COO });
    expect(registry.resolve(room.id)?.id).toBe(room.id);
    expect(registry.resolve('cocoa')?.id).toBe(room.id);
    expect(registry.resolve('  Cocoa  ')?.id).toBe(room.id);
    expect(registry.resolve('')).toBeUndefined();
    expect(registry.resolve('没有')).toBeUndefined();
  });

  it('目录默认不含归档；按可见性过滤；可显式带归档', () => {
    const registry = new RoomRegistry();
    const pub = registry.create({ name: '公开厅', ownerCooId: COO, visibility: 'public' });
    const priv = registry.create({ name: '私密厅', ownerCooId: COO, visibility: 'private' });
    const archived = registry.create({ name: '旧厅', ownerCooId: COO, visibility: 'public' });
    registry.archive(archived.id);

    expect(registry.list().map((room) => room.id)).toEqual([pub.id, priv.id]);
    expect(registry.list({ visibility: 'public' }).map((room) => room.id)).toEqual([pub.id]);
    expect(registry.list({ includeArchived: true })).toHaveLength(3);
    expect(registry.list({ includeArchived: true, visibility: 'public' }).map((room) => room.id))
      .toEqual([pub.id, archived.id]);
  });

  it('改名/主题/可见性/容量；非法值拒绝', () => {
    const registry = new RoomRegistry();
    const room = registry.create({ name: '旧名字', ownerCooId: COO });
    const updated = registry.update(room.id, { name: '新名字', topic: '打牌', visibility: 'public', maxSeats: 6 });
    expect(updated).toMatchObject({ name: '新名字', topic: '打牌', visibility: 'public', maxSeats: 6 });
    expect(() => registry.update(room.id, { maxSeats: 20 })).toThrow(/席位/);
    expect(() => registry.update(room.id, { visibility: 'nope' as never })).toThrow(/可见性/);
    expect(registry.update('r-nope', { name: '无' })).toBeNull();
  });

  it('归档/恢复；归档不改最后活跃', () => {
    let tick = 1000;
    const registry = new RoomRegistry({ now: () => (tick += 1000) });
    const room = registry.create({ name: '客厅', ownerCooId: COO });
    const before = room.lastActiveAt;
    tick += 5000;
    registry.touch(room.id);
    expect(registry.get(room.id)!.lastActiveAt).toBeGreaterThan(before);
    const activeAt = registry.get(room.id)!.lastActiveAt;
    const archived = registry.archive(room.id);
    expect(archived?.archivedAt).toBeGreaterThan(activeAt);
    expect(registry.list()).toHaveLength(0);
    const restored = registry.unarchive(room.id);
    expect(restored?.archivedAt).toBeUndefined();
    expect(registry.list()).toHaveLength(1);
  });

  it('落盘后重载：目录、归档、时间都在', () => {
    const file = tempFile();
    const first = RoomRegistry.load({ file });
    const room = first.create({ name: '可可厅', ownerCooId: COO, visibility: 'public', maxSeats: 6 });
    first.touch(room.id);

    const second = RoomRegistry.load({ file });
    expect(second.size).toBe(1);
    expect(second.get(room.id)).toMatchObject({
      name: '可可厅',
      ownerCooId: COO,
      visibility: 'public',
      maxSeats: 6,
    });
    expect(second.get(room.id)!.archivedAt).toBeUndefined();
  });

  it('坏文件从空目录开始，不阻断启动', () => {
    const file = tempFile();
    writeFileSync(file, '{ 坏掉的 json', 'utf8');
    const registry = RoomRegistry.load({ file });
    expect(registry.size).toBe(0);
    expect(registry.create({ name: '新厅', ownerCooId: COO }).id).toBeTruthy();
  });

  it('ensureDefault 幂等；默认厅归 system-owner、公开', () => {
    const registry = new RoomRegistry();
    const first = registry.ensureDefault('lobby', '默认客厅');
    const second = registry.ensureDefault('lobby', '另一个名字');
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('默认客厅');
    expect(second.ownerCooId).toBe(SYSTEM_OWNER);
    expect(second.visibility).toBe('public');
    expect(registry.size).toBe(1);
  });

  it('大量建厅 id 不重复', () => {
    const registry = new RoomRegistry({ limit: 200, perOwnerLimit: 200 });
    const ids = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      ids.add(registry.create({ name: `厅 ${index}`, ownerCooId: COO }).id);
    }
    expect(ids.size).toBe(50);
  });
});
