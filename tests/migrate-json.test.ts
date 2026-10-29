import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ParlorClient } from '../src/room/client.ts';
import { migrateLegacyJson } from '../src/room/migrate-json.ts';
import { ParlorServer } from '../src/room/server.ts';
import { WorldServer } from '../src/room/world-server.ts';

const A = 'coo-aaaaaaaa';
const B = 'coo-bbbbbbbb';
const secretFor = (cooId: string): string => `secret-${cooId}-0123456789`;

let dir: string;
let old: ParlorServer | undefined;
let server: WorldServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'parlor-migrate-'));
});

afterEach(async () => {
  await old?.close();
  old = undefined;
  await server?.close();
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const snapshot = async (base: string, token: string, path = '/v1/room?since=0&limit=100') => {
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

describe('旧 JSON 迁移到 SQLite', () => {
  it('席位/令牌/事件/账本/信箱都能对上，旧令牌还能用', async () => {
    const dataFile = join(dir, 'room.json');
    old = new ParlorServer({ id: 'lobby', inviteCode: 'inv', port: 0, dataFile });
    await old.listen();
    const ca = new ParlorClient(old.url, { cooId: A, cooSecret: secretFor(A) });
    const cb = new ParlorClient(old.url, { cooId: B, cooSecret: secretFor(B) });
    const a = await ca.join('inv', { name: '阿岚', kind: 'pet', tier: 'digest' });
    const b = await cb.join('inv', { name: '小满', kind: 'pet', tier: 'full' });

    await ca.action(a.token, { type: 'say', text: '大家好' });
    await ca.action(a.token, { type: 'whisper', to: '小满', text: '只给你' });
    await ca.action(a.token, { type: 'table_open', game: 'dice', stake: 5 });
    await cb.action(b.token, { type: 'table_join' });
    await ca.action(a.token, { type: 'table_start' });
    await ca.action(a.token, { type: 'table_action', action: 'stand' });
    await cb.action(b.token, { type: 'table_action', action: 'stand' });
    await ca.action(a.token, { type: 'gift', to: '小满', text: '一点心意', chips: 10 });
    await ca.action(a.token, { type: 'promise', to: '小满', text: '借你 20', chips: 20 });

    const peek = await cb.mail(b.token, 10, true);
    const letter = peek.items.find((item) => item.text.includes('借你 20'));
    expect(letter?.entryId).toBeTruthy();
    await cb.action(b.token, { type: 'respond', id: letter!.entryId!, action: 'accept' });
    await cb.action(b.token, { type: 'respond', id: letter!.entryId!, action: 'done' });
    await old.close();
    old = undefined;

    const dbFile = join(dir, 'parlor.db');
    const report = migrateLegacyJson({ dataDir: dir, dbFile });
    expect(report.counts.seats).toBe(2);
    expect(report.counts.releasedSeats).toBe(0);
    expect(report.counts.events).toBeGreaterThan(5);
    expect(report.counts.ledgerEntries).toBeGreaterThan(3);
    expect(report.counts.mail).toBeGreaterThan(0);
    expect(report.tokenChecks.every((check) => check.ok)).toBe(true);
    expect(report.balances.every((check) => check.match)).toBe(true);
    expect(report.unread.every((check) => check.match)).toBe(true);

    // 旧席位令牌在新网关里仍然有效；历史与私聊按原受众可见。
    server = new WorldServer({ dbFile, port: 0, inviteCode: 'inv' });
    await server.listen();
    const snapA = await snapshot(server.url, a.token);
    expect(snapA.status).toBe(200);
    expect((snapA.body.seat as { name: string }).name).toBe('阿岚');
    const aTexts = (snapA.body.events as { text: string }[]).map((event) => event.text);
    expect(aTexts).toContain('大家好');
    expect(aTexts.some((text) => text.includes('骰子桌结束'))).toBe(true);
    // 骰子/斗地主的牌桌不在旧 JSON 里；迁移后只留事件与账本，没有活动桌子。
    expect(snapA.body.table).toBeUndefined();
    expect((snapA.body.ledger as { games: number }).games).toBe(1);

    const snapB = await snapshot(server.url, b.token);
    const bTexts = (snapB.body.events as { text: string }[]).map((event) => event.text);
    expect(bTexts).toContain('只给你');
    expect((snapA.body.events as { text: string }[]).map((event) => event.text)).not.toContain('只给你');
    expect((snapB.body.mailUnread as number)).toBe(
      report.unread.find((check) => check.name === B)?.now ?? 0,
    );

    // 迁移不合并：同一个库再迁一次要拒绝。
    expect(() => migrateLegacyJson({ dataDir: dir, dbFile })).toThrow(/已经有数据/);
  });

  it('旧版的 legacy:<room>:<seat> 身份会被换成合法占位 cooId', () => {
    writeFileSync(join(dir, 'room.json'), JSON.stringify({
      version: 1,
      id: 'lobby',
      maxSeats: 8,
      seq: 2,
      seatSeq: 1,
      epoch: 'epoch-1',
      seats: [{
        id: 's1', name: '老席位', kind: 'pet', tier: 'digest', joinedAt: 1,
        token: 'old-seat-token', ownerToken: 'old-owner-token', cooId: 'legacy:lobby:s1',
      }],
      events: [
        { seq: 1, ts: 1, type: 'parlor.said', from: 's1', scope: { kind: 'seat', seatId: 's1' }, text: '你好' },
        { seq: 2, ts: 2, type: 'parlor.say', from: 's1', scope: { kind: 'room' }, text: '大家好' },
      ],
    }));
    writeFileSync(join(dir, 'ledger.json'), JSON.stringify({
      version: 1,
      identities: {},
      entries: [{
        id: 'l1', ts: 3, room: 'lobby', kind: 'note', from: 'legacy:lobby:s1',
        text: '旧账', visibility: 'private',
        transfers: [{ from: 'legacy:lobby:s1', to: 'room', amount: 5 }],
      }],
    }));
    writeFileSync(join(dir, 'mail.json'), JSON.stringify({
      version: 1,
      seq: 1,
      items: [{
        id: 'm1', seq: 1, ts: 4, room: 'lobby', to: 'legacy:lobby:s1',
        kind: 'whisper', fromName: '某人', text: '给你的信',
      }],
    }));

    const report = migrateLegacyJson({ dataDir: dir, dbFile: ':memory:' });
    expect(report.counts.seats).toBe(1);
    expect(report.counts.events).toBe(2);
    expect(report.counts.ledgerEntries).toBe(1);
    expect(report.counts.mail).toBe(1);
    expect(report.tokenChecks[0]).toMatchObject({ seat: 's1/老席位', ok: true });
    expect(report.balances.every((check) => check.match)).toBe(true);
  });

  it('大富翁还没结束时默认拒绝迁移，--abandon-monopoly 才作废留档', () => {
    writeFileSync(join(dir, 'room.json'), JSON.stringify({
      version: 1,
      id: 'lobby',
      maxSeats: 8,
      seq: 1,
      seatSeq: 1,
      epoch: 'epoch-1',
      seats: [{
        id: 's1', name: '阿岚', kind: 'pet', tier: 'digest', joinedAt: 1,
        token: 'tok-1', ownerToken: 'own-1', cooId: A,
      }],
      events: [{ seq: 1, ts: 1, type: 'parlor.say', from: 's1', scope: { kind: 'room' }, text: 'hi' }],
    }));
    writeFileSync(join(dir, 'activity.json'), JSON.stringify({
      version: 1,
      roomId: 'lobby',
      roomEpoch: 'epoch-1',
      gameId: 'g1',
      savedAt: 10,
      table: { status: 'playing', host: 's1', seats: [] },
    }));

    expect(() => migrateLegacyJson({ dataDir: dir, dbFile: ':memory:' })).toThrow(/大富翁/);
    const report = migrateLegacyJson({ dataDir: dir, dbFile: ':memory:', abandonMonopoly: true });
    expect(report.warnings.some((warning) => warning.includes('大富翁'))).toBe(true);
    expect(report.counts.events).toBe(2);
  });
});
