import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ActivityStore, freshActivity, hashOf, lookupRequest, queueEffect, rememberRequest, requestKeyOf, settleEffect,
  type MonopolyActivity,
} from '../src/room/activity-store.ts';
import { MonopolyTable } from '../src/room/games/monopoly-table.ts';
import { LedgerStore } from '../src/room/ledger.ts';
import { MailStore } from '../src/room/mail.ts';

const NOW = Date.parse('2026-10-28T10:00:00+08:00');

const seats = (ids = ['a', 'b']) => ids.map((id) => ({ id, name: id.toUpperCase() }));

const makeTable = () => new MonopolyTable({
  host: 'a',
  seats: seats(),
  now: NOW,
  rng: () => [1, 1],
  shuffle: (list) => [...list],
  turnMs: 60_000,
});

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'parlor-activity-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sample = (gameId = 'g1', roomEpoch = 'epoch-1'): MonopolyActivity => freshActivity({
  roomId: 'lobby',
  roomEpoch,
  gameId,
  savedAt: NOW,
  table: makeTable().snapshot(),
});

describe('活动存档', () => {
  it('存 → 读回来一模一样', () => {
    const store = new ActivityStore({ file: join(dir, 'activity.json') });
    const activity = sample();
    expect(store.save(activity)).toBe(true);
    const loaded = store.load();
    expect(loaded).toEqual(activity);
  });

  it('主文件坏了退到上一份快照', () => {
    const file = join(dir, 'activity.json');
    const store = new ActivityStore({ file });
    const first = sample('g1');
    store.save(first);
    const second = { ...sample('g1'), savedAt: NOW + 1000 };
    store.save(second); // 这时 .bak 是第一份
    writeFileSync(file, '{不是 JSON', 'utf8');
    const loaded = store.load();
    expect(loaded).toEqual(first);
  });

  it('两份都坏返回 null，但文件不删', () => {
    const file = join(dir, 'activity.json');
    const store = new ActivityStore({ file });
    store.save(sample());
    writeFileSync(file, 'x', 'utf8');
    writeFileSync(`${file}.bak`, 'y', 'utf8');
    expect(store.load()).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe('x');
  });

  it('schemaVersion 不认识就当没有，不悄悄换成新局', () => {
    const file = join(dir, 'activity.json');
    const store = new ActivityStore({ file });
    store.save(sample());
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.schemaVersion = 2;
    writeFileSync(file, JSON.stringify(raw), 'utf8');
    expect(store.load()).toBeNull();
  });

  it('写失败返回 false，不抛', () => {
    const store = new ActivityStore({ file: join(dir, 'no-such-dir', '\u0000bad', 'activity.json') });
    expect(store.save(sample())).toBe(false);
  });

  it('正常结束后归档，不再当恢复源', () => {
    const file = join(dir, 'activity.json');
    const store = new ActivityStore({ file });
    store.save(sample());
    store.remove();
    expect(store.load()).toBeNull();
    expect(store.exists()).toBe(false);
  });
});

describe('动作去重', () => {
  it('同键同内容返回原回执；同键不同内容明确拒绝', () => {
    const activity = sample();
    const key = requestKeyOf('g1', 'a', 'r1');
    const hash = hashOf({ type: 'roll' });
    expect(lookupRequest(activity, key, hash).kind).toBe('new');
    rememberRequest(activity, { key, hash, at: NOW, receipt: { ok: true, seq: 3 } });
    const again = lookupRequest(activity, key, hash);
    expect(again.kind).toBe('repeat');
    if (again.kind === 'repeat') expect(again.receipt).toEqual({ ok: true, seq: 3 });
    expect(lookupRequest(activity, key, hashOf({ type: 'buy' })).kind).toBe('mismatch');
  });

  it('去重记录有上限，超了丢最旧的', () => {
    const activity = sample();
    for (let index = 0; index < 5; index++) {
      rememberRequest(activity, { key: `k${index}`, hash: 'h', at: NOW, receipt: index }, 3);
    }
    expect(activity.requests.map((entry) => entry.key)).toEqual(['k2', 'k3', 'k4']);
  });
});

describe('待发副作用', () => {
  it('同一个 id 只排一次', () => {
    const activity = sample();
    queueEffect(activity, { id: 'e1', kind: 'mail-end', payload: {} });
    queueEffect(activity, { id: 'e1', kind: 'mail-end', payload: {} });
    expect(activity.outbox).toHaveLength(1);
  });

  it('送达后从待发移到已应用，已应用的不会再排', () => {
    const activity = sample();
    queueEffect(activity, { id: 'e1', kind: 'ledger-result', payload: {} });
    settleEffect(activity, 'e1');
    expect(activity.outbox).toHaveLength(0);
    expect(activity.applied).toEqual(['e1']);
    queueEffect(activity, { id: 'e1', kind: 'ledger-result', payload: {} });
    expect(activity.outbox).toHaveLength(0);
  });
});

describe('接收存储的幂等键', () => {
  it('账本同一个 effectId 只写一条', () => {
    const ledger = new LedgerStore({ file: join(dir, 'ledger.json'), now: () => NOW });
    const entry = {
      kind: 'game' as const,
      room: 'lobby',
      from: 'room',
      participants: ['coo-aaaaaaaa'],
      winners: ['coo-aaaaaaaa'],
      text: '大富翁结束',
      visibility: 'room' as const,
      data: { game: 'monopoly', gameLabel: '大富翁' },
    };
    const first = ledger.recordOnce('g1/result', entry);
    const second = ledger.recordOnce('g1/result', entry);
    expect(second.id).toBe(first.id);
    expect(ledger.count()).toBe(1);
  });

  it('信箱同一个 key 只留一封', () => {
    const mail = new MailStore({ file: join(dir, 'mail.json'), now: () => NOW });
    const input = {
      room: 'lobby',
      to: 'coo-aaaaaaaa',
      kind: 'ledger' as const,
      fromName: '客厅',
      text: '轮到你走一步',
    };
    const first = mail.appendOnce('g1/turn/7/coo-aaaaaaaa', input);
    const second = mail.appendOnce('g1/turn/7/coo-aaaaaaaa', input);
    expect(second.id).toBe(first.id);
    expect(mail.count()).toBe(1);
  });

  it('幂等键不落进给模型看的视图', () => {
    const mail = new MailStore({ file: join(dir, 'mail.json'), now: () => NOW });
    mail.appendOnce('k1', {
      room: 'lobby', to: 'coo-aaaaaaaa', kind: 'ledger', fromName: '客厅', text: '轮到你',
    });
    const page = mail.list('coo-aaaaaaaa', 'lobby', 10, false);
    expect(page.items[0]).not.toHaveProperty('key');
  });
});
