/**
 * 新闻与公告的编辑 / 删除（真实 PG，SupportDb 层）。
 *
 * 三条边界值得单独钉住：
 * 1. 编辑不动 id 与日期，整条没变化时不涨 revision（表单重提不会白加一版）；
 * 2. 删除是物理删除——`UNIQUE(issue_date)` 要跟着释放，当天才能重发一条；
 * 3. 删掉的东西不会凭空消失：原文留在 `support_audit`，能从那儿找回来。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SupportDb } from '../src/room/support-db.ts';
import { HostError } from '../src/room/host-error.ts';
import type { Db } from '../src/room/storage/types.ts';
import { closePgTestDb, openPgTestDb } from './helpers/pg.ts';

const NOW = Date.parse('2026-11-09T12:00:00+08:00');
const base = { issueDate: '2026-11-09', title: '今天的茶馆', summary: '摘要', body: '正文' };

let db: Db | undefined;
afterEach(async () => { if (db) await closePgTestDb(db); db = undefined; });

const fresh = (at = NOW) => new SupportDb(db!, () => at);

describe('新闻的编辑与删除（真实 PG）', () => {
  it('改标题与正文：玩家侧立刻读到新文本，revision 加一，id 与日期不动', async () => {
    db = await openPgTestDb();
    const published = await fresh().publishNews(base);
    expect(published.revision).toBe(1);
    expect(published.updatedAt).toBe(0);

    const { item, changed } = await fresh(NOW + 60_000)
      .editNews({ id: published.id, title: '改过的标题', body: '改过的正文' });
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

  it('整条没有变化时不涨版本号；显式改可见时刻会让它从玩家侧暂时消失', async () => {
    db = await openPgTestDb();
    const published = await fresh().publishNews(base);

    // 表单重提同一份内容：不脏写、不加版本。
    const same = await fresh(NOW + 1_000)
      .editNews({ id: published.id, title: '今天的茶馆', summary: '摘要', body: '正文' });
    expect(same.changed).toBe(false);
    expect(same.item.revision).toBe(1);
    expect(same.item.updatedAt).toBe(0);

    const later = await fresh(NOW + 2_000).editNews({ id: published.id, publishAt: NOW + 3_600_000 });
    expect(later.item.publishAt).toBe(NOW + 3_600_000);
    expect(await fresh(NOW + 3_000).latestNews()).toBeUndefined();
    expect(await fresh(NOW + 3_000).newsById(published.id)).toBeUndefined();
    // 到点之后又出现。
    expect((await fresh(NOW + 3_600_001).latestNews())?.id).toBe(published.id);
  });

  it('历史上的一天不能被编辑成自动推送；不存在或非法 id 各有明确错误', async () => {
    db = await openPgTestDb();
    const old = await fresh().publishNews({ ...base, issueDate: '2026-10-20' });
    expect(old.autoPush).toBe(false);
    await expect(fresh().editNews({ id: old.id, autoPush: true }))
      .rejects.toThrow('历史补录不能开启自动推送');

    await expect(fresh().editNews({ id: 'news-2026-10-21', title: '没有这条' }))
      .rejects.toBeInstanceOf(HostError);
    await expect(fresh().editNews({ title: '缺 id' })).rejects.toThrow('需要新闻 id');
    // 正文上限沿用发布时的 4000 字。
    await expect(fresh().editNews({ id: old.id, body: '字'.repeat(4001) }))
      .rejects.toThrow('正文要有 1 到 4000 个字');
  });

  it('删除：玩家侧三条路都读不到，同一天可以重发，原文留在留痕里', async () => {
    db = await openPgTestDb();
    const published = await fresh().publishNews(base);
    expect(published.body).toBe('正文');

    const removed = await fresh(NOW + 1_000).deleteNews(published.id);
    expect(removed).toMatchObject({ id: published.id, title: '今天的茶馆', body: '正文' });
    expect(await fresh(NOW + 2_000).latestNews()).toBeUndefined();
    expect(await fresh(NOW + 2_000).newsList(5)).toEqual([]);
    expect(await fresh(NOW + 2_000).newsById(published.id)).toBeUndefined();

    // 重试幂等：第二次删返回 null，不报错。
    expect(await fresh(NOW + 3_000).deleteNews(published.id)).toBeNull();

    // 唯一索引跟着释放，同一天可以重新发一条（收件人拿到的是新内容）。
    const again = await fresh(NOW + 4_000).publishNews({ ...base, title: '重发的一期' });
    expect(again.id).toBe(published.id);
    expect(again.title).toBe('重发的一期');

    const audit = await fresh(NOW + 5_000).auditList(10);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'news.delete', targetId: published.id, after: null });
    expect(audit[0].before).toMatchObject({ id: published.id, body: '正文', title: '今天的茶馆' });
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
