/**
 * 新闻发布的幂等边界（真实 PG，SupportDb 层）。
 *
 * 三个都曾把同一份请求判成冲突：
 * 1. 并发：两个请求都先读到「还没有条目」，各算一个可见时刻再 INSERT；
 * 2. 跨午夜：当天发的稿，第二天带原日期重试时被重新算成「历史补录」；
 * 3. 历史补录：显式 autoPush 也不能把它塞进自动推送。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SupportDb } from '../src/room/support-db.ts';
import { HostError } from '../src/room/host-error.ts';
import type { Db, PreparedStatement } from '../src/room/storage/types.ts';
import { closePgTestDb, openPgTestDb } from './helpers/pg.ts';

const NOW = Date.parse('2026-11-09T12:00:00+08:00');
const base = { issueDate: '2026-11-09', title: '今天的茶馆', summary: '摘要', body: '正文' };

let db: Db | undefined;
afterEach(async () => { if (db) await closePgTestDb(db); db = undefined; });

/**
 * 把「第一次按 issue_date 读已有条目」藏起来，复现并发里对手还没提交的窗口：
 * 本请求读到空、于是自己算了一个可见时刻，但 INSERT 时库里已经有别人那行了。
 */
const blindFirstIssueRead = (inner: Db): Db => {
  let hidden = false;
  const proxy: Db = Object.create(inner) as Db;
  proxy.prepare = (sql: string): PreparedStatement => {
    const stmt = inner.prepare(sql);
    if (hidden || !sql.includes('FROM news_items WHERE issue_date = ?')) return stmt;
    hidden = true;
    return {
      get: async () => undefined,
      all: (...params) => stmt.all(...params),
      run: (...params) => stmt.run(...params),
    };
  };
  return proxy;
};

describe('新闻发布的幂等边界（真实 PG）', () => {
  it('并发窗口：读不到已有条目时，缺省可见时刻以库里那行为准，不算改了字段', async () => {
    db = await openPgTestDb();
    const first = await new SupportDb(db, () => NOW).publishNews(base);
    expect(first.publishAt).toBe(NOW);
    expect(first.autoPush).toBe(true);

    // 第二个请求晚 25 毫秒，且读已有条目发生在第一个提交之前：
    // 自己算出来的缺省时刻是 NOW+25，拿它比对就会判成「改了可见时刻」。
    const later = new SupportDb(blindFirstIssueRead(db), () => NOW + 25);
    const again = await later.publishNews(base);
    expect(again.id).toBe(first.id);
    expect(again.publishAt).toBe(NOW);
  });

  it('当天发的稿跨过午夜重试：沿用已存记录，不被判成改了推送设置', async () => {
    db = await openPgTestDb();
    const first = await new SupportDb(db, () => NOW).publishNews(base);
    expect(first.autoPush).toBe(true);

    // 北京时间过了午夜：重新按「历史补录」算会强制 auto_push=0。
    const afterMidnight = Date.parse('2026-11-10T00:10:00+08:00');
    const again = await new SupportDb(db, () => afterMidnight).publishNews(base);
    expect(again.id).toBe(first.id);
    expect(again.autoPush).toBe(true);
    // 线上那行没被改动：主动查仍然看得到，自动推送设置也保持原样。
    const stored = await new SupportDb(db, () => afterMidnight).newsById(first.id);
    expect(stored).toMatchObject({ publishAt: NOW, autoPush: true });
  });

  it('历史补录只在首次创建时强制不推送；显式改了可见时刻仍然判冲突', async () => {
    db = await openPgTestDb();
    const old = { ...base, issueDate: '2026-10-20' };
    const first = await new SupportDb(db, () => NOW).publishNews({ ...old, autoPush: true });
    expect(first.autoPush).toBe(false);

    // 同一份请求重试：库里已经是 0，不能因为输入还写着 true 就判冲突。
    const again = await new SupportDb(db, () => NOW + 1_000).publishNews({ ...old, autoPush: true });
    expect(again.id).toBe(first.id);
    expect(again.autoPush).toBe(false);

    // 当天这条：显式改可见时刻仍然是改了字段，不是重放。
    const today = await new SupportDb(db, () => NOW).publishNews(base);
    expect(today.publishAt).toBe(NOW);
    await expect(new SupportDb(db, () => NOW).publishNews({ ...base, publishAt: NOW + 5_000 }))
      .rejects.toBeInstanceOf(HostError);
  });
});
