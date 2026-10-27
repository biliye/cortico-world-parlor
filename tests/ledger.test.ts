import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerStore, isCooId, type LedgerEntry } from '../src/room/ledger.ts';

const A = 'coo-aaaaaaaa';
const B = 'coo-bbbbbbbb';
const C = 'coo-cccccccc';

const game = (
  room: string,
  participants: string[],
  winners: string[],
  tie = false,
  id = 'dice',
  label?: string,
): Omit<LedgerEntry, 'id' | 'ts'> => ({
  kind: 'game',
  room,
  from: 'room',
  game: id,
  participants,
  winners,
  text: `${room} 的一局`,
  visibility: 'room',
  data: { game: id, tie, ...(label ? { gameLabel: label } : {}) },
});

describe('账本', () => {
  it('战绩从记录现算：胜/负/平，别人看不到你的条目', () => {
    let now = 1000;
    const store = new LedgerStore({ now: () => (now += 1000) });
    store.record(game('lobby', [A, B], [A]));
    store.record(game('lobby', [A, B], [B]));
    store.record(game('lobby', [A, B], [A, B], true));

    expect(store.summaryFor(A)).toMatchObject({ games: 3, wins: 1, losses: 1, draws: 1 });
    expect(store.summaryFor(B)).toMatchObject({ games: 3, wins: 1, losses: 1, draws: 1 });
    expect(store.summaryFor(C)).toMatchObject({ games: 0, wins: 0, losses: 0, draws: 0 });

    const recent = store.summaryFor(A).recent;
    expect(recent).toHaveLength(3);
    expect(recent[0].text).toBe('lobby 的一局');
    expect('participants' in recent[0]).toBe(false);
    expect('winners' in recent[0]).toBe(false);
  });

  it('平局只算赢的人平，没赢的人算负', () => {
    const store = new LedgerStore();
    store.record(game('lobby', [A, B, C], [A, B], true));
    expect(store.summaryFor(A)).toMatchObject({ games: 1, draws: 1, losses: 0 });
    expect(store.summaryFor(B)).toMatchObject({ games: 1, draws: 1, losses: 0 });
    expect(store.summaryFor(C)).toMatchObject({ games: 1, draws: 0, losses: 1 });
  });

  it('按游戏分开统计，局数多的在前；显示名用条目里游戏自己给的', () => {
    const store = new LedgerStore();
    store.record(game('lobby', [A, B], [A], false, 'ddz', '斗地主'));
    store.record(game('lobby', [A, B], [B], false, 'ddz', '斗地主'));
    store.record(game('lobby', [A, B, C], [A, B], true, 'dice', '骰子'));

    const summary = store.summaryFor(A);
    expect(summary).toMatchObject({ games: 3, wins: 1, losses: 1, draws: 1 });
    expect(summary.byGame).toEqual([
      { game: 'ddz', label: '斗地主', games: 2, wins: 1, losses: 1, draws: 0 },
      { game: 'dice', label: '骰子', games: 1, wins: 0, losses: 0, draws: 1 },
    ]);
  });

  it('老账本条目只有 data.game 也能分开统计；后来的条目带了显示名就用它', () => {
    const store = new LedgerStore();
    const legacy: Omit<LedgerEntry, 'id' | 'ts'> = { ...game('lobby', [A], [A], false, 'ddz') };
    delete legacy.game;
    store.record(legacy);
    expect(store.summaryFor(A).byGame).toEqual([
      { game: 'ddz', label: 'ddz', games: 1, wins: 1, losses: 0, draws: 0 },
    ]);

    store.record(game('lobby', [A], [A], false, 'ddz', '斗地主'));
    expect(store.summaryFor(A).byGame[0]).toMatchObject({ game: 'ddz', label: '斗地主', games: 2 });
  });

  it('没有游戏名的条目归到「其他」，不丢局数', () => {
    const store = new LedgerStore();
    store.record({ kind: 'game', room: 'lobby', from: 'room', participants: [A], winners: [A], text: '一局', visibility: 'room' });
    expect(store.summaryFor(A)).toMatchObject({ games: 1, wins: 1 });
    expect(store.summaryFor(A).byGame).toEqual([
      { game: 'unknown', label: '其他', games: 1, wins: 1, losses: 0, draws: 0 },
    ]);
  });

  it('账本不认具体游戏：任意 game id 都只按 winners 与 tie 记', () => {
    const store = new LedgerStore();
    store.record(game('lobby', [A, B], [A, B], true, 'fakegame', '假游戏'));
    expect(store.summaryFor(A)).toMatchObject({ games: 1, wins: 0, losses: 0, draws: 1 });
    expect(store.summaryFor(B)).toMatchObject({ games: 1, draws: 1 });
    expect(store.summaryFor(C)).toMatchObject({ games: 0, draws: 0 });
    expect(store.summaryFor(A).byGame[0]).toMatchObject({ game: 'fakegame', label: '假游戏', draws: 1 });
  });

  it('公开条目按房间给，私密条目不进公开列表', () => {
    const store = new LedgerStore({ now: () => 1000 });
    store.record(game('lobby', [A, B], [A]));
    store.record({ kind: 'note', room: 'lobby', from: A, to: B, text: '私下说的', visibility: 'private' });
    store.record(game('other', [A, B], [B]));

    const room = store.publicInRoom('lobby', 5);
    expect(room.map((entry) => entry.text)).toEqual(['lobby 的一局']);
    expect(store.publicInRoom('other', 5).map((entry) => entry.text)).toEqual(['other 的一局']);
    expect(store.summaryFor(B).recent.map((entry) => entry.text)).toContain('私下说的');
  });

  it('同一个账本可以跨房：两个房间的战绩进同一份摘要', () => {
    const store = new LedgerStore();
    store.record(game('room-a', [A], [A]));
    store.record(game('room-b', [A], [A]));
    expect(store.summaryFor(A).games).toBe(2);
    expect(store.summaryFor(A).wins).toBe(2);
  });

  it('账本写入文件后能读回来；身份用同一个 secret 才能重入', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parlor-ledger-'));
    try {
      const file = join(dir, 'ledger.json');
      const first = LedgerStore.load({ file });
      expect(first.claimIdentity(A, 'secret-1234567890')).toBe('ok');
      first.record(game('lobby', [A], [A]));
      first.flush();

      const second = LedgerStore.load({ file });
      expect(second.count()).toBe(1);
      expect(second.summaryFor(A)).toMatchObject({ games: 1, wins: 1 });
      expect(second.claimIdentity(A, 'secret-1234567890')).toBe('ok');
      expect(second.claimIdentity(A, 'another-secret-1234')).toBe('mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('身份与条目都有格式/上限护栏', () => {
    const store = new LedgerStore({ entryLimit: 2 });
    expect(store.claimIdentity('short', 'secret-1234567890')).toBe('invalid');
    expect(store.claimIdentity(A, 'short')).toBe('invalid');
    expect(store.claimIdentity(A, 'secret-1234567890')).toBe('ok');

    store.record(game('lobby', [A], [A]));
    store.record(game('lobby', [A], [A]));
    store.record(game('lobby', [A], [A]));
    expect(store.count()).toBe(2);
    expect(store.summaryFor(A).games).toBe(2);
    expect(isCooId(A)).toBe(true);
    expect(isCooId('legacy:lobby:s1')).toBe(false);
  });
});
