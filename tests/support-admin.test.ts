/**
 * 新闻与公告的编辑 / 删除（真实 PG，SupportDb 层）。
 *
 * 边界：
 * 1. 编辑不动 id 与日期，整条没变化时不涨 revision（表单重提不会白加一版）；
 * 2. 已可见的新闻不能改可见时刻——Coo 的游标按 publishAt 存，改晚会重推同一个 id；
 * 3. 删除是物理删除——`UNIQUE(issue_date)` 要跟着释放，当天才能重发一条；
 * 4. 同一天重发沿用同一个 id，所以编辑 / 删除都要带 `createdAt`，旧请求不能落到新一稿；
 * 5. 并发编辑用 `revision` 做条件更新，后提交的旧版本被拒，不丢字段；
 * 6. 删掉的东西不会凭空消失：原文留在 `support_audit`，能从那儿找回来。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SupportDb } from '../src/room/support-db.ts';
import { HostError } from '../src/room/host-error.ts';
import type { Db, SqlParam } from '../src/room/storage/types.ts';
import { closePgTestDb, openPgTestDb } from './helpers/pg.ts';

const NOW = Date.parse('2026-11-09T12:00:00+08:00');
const base = { issueDate: '2026-11-09', title: '今天的茶馆', summary: '摘要', body: '正文' };

let db: Db | undefined;
afterEach(async () => { if (db) await closePgTestDb(db); db = undefined; });

const fresh = (at = NOW) => new SupportDb(db!, () => at);
/** 编辑 / 删除时带上的「这一期」指纹。 */
const stamp = (item: { createdAt: number; revision: number }) => ({
  createdAt: item.createdAt, revision: item.revision,
});

describe('新闻的编辑与删除（真实 PG）', () => {
  it('改标题与正文：玩家侧立刻读到新文本，revision 加一，id 与日期不动', async () => {
    db = await openPgTestDb();
    const published = await fresh().publishNews(base);
    expect(published.revision).toBe(1);
    expect(published.updatedAt).toBe(0);

    const { item, changed } = await fresh(NOW + 60_000)
      .editNews({ id: published.id, ...stamp(published), title: '改过的标题', body: '改过的正文' });
    expect(changed).toBe(true);
    expect(item).toMatchObject({
      id: published.id, issueDate: '2026-11-09', title: '改过的标题',
      summary: '摘要', body: '改过的正文', revision: 2, updatedAt: NOW + 60_000,
    });
    expect(item.publishAt).toBe(published.publishAt);

    // 玩家侧（主动查与列表）看到的是改后的文本。
    const seen = await fresh(NOW + 90_000).newsById(published.id);
    expect(seen).toMatchObject({ title: '改过的标题', body: '改过的正文', revision: 2 });
    const list = await fresh(NOW + 90_000).newsList(5);
    expect(list[0]).toMatchObject({ id: published.id, title: '改过的标题' });
  });

  it('整条没有变化时不涨版本号；预录稿可以改期，已可见的不能改（否则会重推）', async () => {
    db = await openPgTestDb();

    // 预录：还没到可见时刻，改期不影响任何人的游标。
    const future = await fresh().publishNews({
      ...base, issueDate: '2026-11-10', publishAt: Date.parse('2026-11-10T10:00:00+08:00'),
    });
    const moved = await fresh(NOW + 1_000)
      .editNews({ id: future.id, ...stamp(future), publishAt: Date.parse('2026-11-10T11:00:00+08:00') });
    expect(moved.changed).toBe(true);
    expect(moved.item.publishAt).toBe(Date.parse('2026-11-10T11:00:00+08:00'));
    expect(await fresh(NOW + 2_000).latestNews()).toBeUndefined();
    expect(await fresh(NOW + 2_000).newsById(future.id)).toBeUndefined();

    // 已经可见的今天这条：表单重提同一份内容不算改动。
    const published = await fresh().publishNews(base);
    const same = await fresh(NOW + 3_000)
      .editNews({ id: published.id, ...stamp(published), title: '今天的茶馆', summary: '摘要', body: '正文' });
    expect(same.changed).toBe(false);
    expect(same.item.revision).toBe(1);
    expect(same.item.updatedAt).toBe(0);

    // 改晚可见时刻 = 同一个 id 再次落进 `publish_at > 游标` 的窗口，等于重推。
    const feed = await fresh(NOW + 3_000).newsFeed(0, '');
    expect(feed.item?.id).toBe(published.id);
    await expect(fresh(NOW + 4_000)
      .editNews({ id: published.id, ...stamp(published), publishAt: NOW + 3_600_000 }))
      .rejects.toThrow('已可见的新闻不能改可见时刻');
    // 游标没有被推动，也不会再收到同一条。
    const again = await fresh(NOW + 3_600_001).newsFeed(feed.cursor.publishAt, feed.cursor.id);
    expect(again.item).toBeNull();
  });

  it('运营列表带 revision 与 createdAt：改过一次就显示第 2 版', async () => {
    db = await openPgTestDb();
    const published = await fresh().publishNews(base);
    expect((await fresh(NOW + 1_000).newsAdminList(10))[0])
      .toMatchObject({ id: published.id, revision: 1, createdAt: published.createdAt });

    await fresh(NOW + 2_000).editNews({ id: published.id, ...stamp(published), title: '改过的标题' });
    const list = await fresh(NOW + 3_000).newsAdminList(10);
    // 漏查 revision 时 `newsSummary` 会兜底成 1，列表永远显示「第 1 版」——这里钉住它。
    expect(list[0]).toMatchObject({ id: published.id, revision: 2, createdAt: published.createdAt });
  });

  it('两个人同时编辑：后提交的旧版本被拒，不覆盖先改的字段', async () => {
    // 两个连接必须指向同一个库：用文件语义的键让 openPgTestDb 复用同一个库。
    db = await openPgTestDb('support-admin-concurrency');
    const main = db;
    const other = await openPgTestDb('support-admin-concurrency');
    try {
      const published = await fresh().publishNews(base);
      let raced = false;
      // 在「本事务读完这一行」与「写回」之间插进另一个运营的提交：
      // 她读到同一版、先改标题并成功；我们手上这份就是过期快照。
      const wrapped = {
        kind: main.kind,
        get isTransaction() { return main.isTransaction; },
        prepare(sql: string) {
          const stmt = main.prepare(sql);
          if (raced || !sql.includes('FROM news_items WHERE id = ?')) return stmt;
          const original = stmt.get.bind(stmt);
          return {
            get: async (...params: SqlParam[]) => {
              const row = await original(...params);
              if (!raced) {
                raced = true;
                await new SupportDb(other, () => NOW + 500).editNews({
                  id: published.id, ...stamp(published), title: '别人改的标题',
                });
              }
              return row;
            },
            all: (...params: SqlParam[]) => stmt.all(...params),
            run: (...params: SqlParam[]) => stmt.run(...params),
          };
        },
        exec: (sql: string) => main.exec(sql),
        runInTransaction: <T,>(fn: () => Promise<T>) => main.runInTransaction(fn),
        afterCommit: (fn: () => void) => main.afterCommit(fn),
        close: async () => {},
      } as unknown as Db;

      await expect(new SupportDb(wrapped, () => NOW + 1_000).editNews({
        id: published.id, ...stamp(published), body: '我改的正文',
      })).rejects.toThrow('这条新闻刚被改过');

      const after = await fresh(NOW + 2_000).newsAdminById(published.id);
      expect(after).toMatchObject({ title: '别人改的标题', body: '正文', revision: 2 });
      // 失败的那次没有留痕，只有真正提交的那一条。
      expect(await fresh(NOW + 2_000).auditList(10)).toHaveLength(1);
    } finally {
      await closePgTestDb(other);
    }
  });

  it('历史上的一天不能被编辑成自动推送；不存在或非法 id 各有明确错误', async () => {
    db = await openPgTestDb();
    const old = await fresh().publishNews({ ...base, issueDate: '2026-10-20' });
    expect(old.autoPush).toBe(false);
    await expect(fresh().editNews({ id: old.id, ...stamp(old), autoPush: true }))
      .rejects.toThrow('历史补录不能开启自动推送');

    await expect(fresh().editNews({ id: 'news-2026-10-21', createdAt: 1, revision: 1, title: '没有这条' }))
      .rejects.toBeInstanceOf(HostError);
    await expect(fresh().editNews({ title: '缺 id' })).rejects.toThrow('需要新闻 id');
    // 编辑 / 删除必须带「这一期」的指纹；缺了就拒绝，不能退回只按 id 改删。
    await expect(fresh().editNews({ id: old.id, title: '缺指纹' })).rejects.toThrow('需要 createdAt');
    await expect(fresh().editNews({ id: old.id, createdAt: old.createdAt, title: '缺指纹' }))
      .rejects.toThrow('需要 revision');
    // 正文上限沿用发布时的 4000 字。
    await expect(fresh().editNews({ id: old.id, ...stamp(old), body: '字'.repeat(4001) }))
      .rejects.toThrow('正文要有 1 到 4000 个字');
  });

  it('删除：玩家侧三条路都读不到，同一天可以重发，原文留在留痕里', async () => {
    db = await openPgTestDb();
    const published = await fresh().publishNews(base);
    expect(published.body).toBe('正文');
    await expect(fresh().deleteNews(published.id, 0)).rejects.toThrow('需要 createdAt');

    const removed = await fresh(NOW + 1_000).deleteNews(published.id, published.createdAt);
    expect(removed).toMatchObject({ id: published.id, title: '今天的茶馆', body: '正文' });
    expect(await fresh(NOW + 2_000).latestNews()).toBeUndefined();
    expect(await fresh(NOW + 2_000).newsList(5)).toEqual([]);
    expect(await fresh(NOW + 2_000).newsById(published.id)).toBeUndefined();

    // 重试幂等：第二次删返回 null，不报错。
    expect(await fresh(NOW + 3_000).deleteNews(published.id, published.createdAt)).toBeNull();

    // 唯一索引跟着释放，同一天可以重新发一条（收件人拿到的是新内容）。
    const again = await fresh(NOW + 4_000).publishNews({ ...base, title: '重发的一期' });
    expect(again.id).toBe(published.id);
    expect(again.title).toBe('重发的一期');
    expect(again.createdAt).toBe(NOW + 4_000);

    // 旧标签页 / 重试请求带的是上一期的 createdAt：只能报冲突，不能删掉重发的新稿。
    await expect(fresh(NOW + 5_000).deleteNews(published.id, published.createdAt))
      .rejects.toThrow('已经被重发过');
    expect(await fresh(NOW + 5_000).newsById(again.id)).toMatchObject({ title: '重发的一期' });

    // 带上新一期的指纹才真删。
    expect(await fresh(NOW + 6_000).deleteNews(again.id, again.createdAt))
      .toMatchObject({ id: again.id, title: '重发的一期' });

    const audit = await fresh(NOW + 7_000).auditList(10);
    expect(audit.map((entry) => entry.action)).toEqual(['news.delete', 'news.delete']);
    expect(audit[0].before).toMatchObject({ id: published.id, title: '重发的一期' });
    expect(audit[1].before).toMatchObject({ id: published.id, title: '今天的茶馆', body: '正文' });
  });
});

describe('公告的编辑与删除（真实 PG）', () => {
  it('改公告只换文本并留痕；删公告之后玩家侧就没了', async () => {
    db = await openPgTestDb();
    const created = await fresh().announce('原来的公告', 'announce-1');
    expect(created.text).toBe('原来的公告');

    const edited = await fresh(NOW + 1_000).editAnnouncement(created.id, '改过的公告');
    expect(edited.changed).toBe(true);
    expect(edited.item).toMatchObject({ id: created.id, text: '改过的公告', revision: 2 });

    // 同一段文本重提：不算改动。
    const same = await fresh(NOW + 2_000).editAnnouncement(created.id, '改过的公告');
    expect(same.changed).toBe(false);
    expect(same.item.revision).toBe(2);

    expect((await fresh(NOW + 3_000).announcementAdminList(10))[0]).toMatchObject({ text: '改过的公告' });
    expect((await fresh(NOW + 3_000).announcements())[0]).toMatchObject({ text: '改过的公告' });

    const removed = await fresh(NOW + 4_000).deleteAnnouncement(created.id);
    expect(removed).toMatchObject({ id: created.id, text: '改过的公告' });
    expect(await fresh(NOW + 5_000).announcements()).toEqual([]);
    expect(await fresh(NOW + 5_000).deleteAnnouncement(created.id)).toBeNull();

    const audit = await fresh(NOW + 6_000).auditList(10);
    expect(audit.map((entry) => entry.action)).toEqual(['announcement.delete', 'announcement.edit']);
    expect(audit[1].before).toMatchObject({ text: '原来的公告' });
    expect(audit[1].after).toMatchObject({ text: '改过的公告' });
  });

  it('改不存在的公告报 not_found；空正文按 2000 字上限拦下', async () => {
    db = await openPgTestDb();
    await expect(fresh().editAnnouncement('announce-none', '新文本'))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(fresh().editAnnouncement('announce-none', '   '))
      .rejects.toThrow('正文要有 1 到 2000 个字');
  });
});
