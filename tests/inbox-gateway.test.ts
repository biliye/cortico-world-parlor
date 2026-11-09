/**
 * 统一 inbox 网关（真实 PG）：公告 / 新闻 / 招募共用一次请求。
 *
 * 覆盖 v2 §十 的第 1–7 条：topics 过滤、复合游标、auto_push=0 不推送、
 * 未来条目不可见、一天一版与幂等、主动查三条分支、匿名与运营鉴权。
 * 时钟固定在 2026-11-09 12:00 北京时间，避免跨日跑测试时结果漂移。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WorldServer } from '../src/room/world-server.ts';
import { ParlorClient } from '../src/room/client.ts';
import { beijingDate } from '../src/room/support-db.ts';
import { pgServerStorage } from './helpers/pg.ts';

const OPERATOR = 'operator-key-for-inbox-tests';
const NOW = Date.parse('2026-11-09T12:00:00+08:00');

let app: WorldServer | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function start() {
  app = await WorldServer.create({
    ...(await pgServerStorage(':memory:')), port: 0, inviteCode: 'inv',
    operatorKey: OPERATOR, now: () => NOW,
  });
  await app.listen();
  const client = new ParlorClient(app.url, {
    cooId: 'coo-inbox-aaa', cooSecret: 'secret-inbox-aaa-0123456789',
  });
  const joined = await client.join('inv', { name: 'a' }, 'lobby');
  return { client, token: joined.token };
}

async function operator(path: string, body: unknown, key = OPERATOR) {
  const response = await fetch(`${app!.url}/v1/support/operator/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

const publish = (body: unknown, key?: string) => operator('news', body, key);

describe('统一 inbox 网关（真实 PG）', () => {
  it('默认一次给三块；topics 能只要其中一块，新闻只给摘要不给正文', async () => {
    const { client, token } = await start();
    const published = await publish({ issueDate: '2026-11-09', title: '今天的茶馆', summary: '摘要', body: '正文' });
    expect(published.status).toBe(200);
    expect(published.body.news.issueDate).toBe(beijingDate(NOW));

    const all = await client.inbox(token, {
      topics: ['announcements', 'news', 'recruit'], afterPublish: 0, afterId: '',
    });
    expect(Object.keys(all).sort()).toEqual(['announcements', 'news', 'recruit']);
    expect(all.news?.item).toMatchObject({ id: 'news-2026-11-09', title: '今天的茶馆' });
    // 推送只带摘要：正文留给主动查，别每分钟给所有 Coo 传 4000 字。
    expect((all.news?.item as unknown as { body?: string }).body).toBeUndefined();
    expect(all.recruit?.tables).toEqual([]);

    const onlyNews = await client.inbox(token, { topics: ['news'], afterPublish: 0, afterId: '' });
    expect(Object.keys(onlyNews)).toEqual(['news']);

    // 不带 topics 时按「三块全要」兜底。
    const raw = await fetch(`${app!.url}/v1/support/inbox`, { headers: { authorization: `Bearer ${token}` } });
    expect(Object.keys(await raw.json() as object).sort()).toEqual(['announcements', 'news', 'recruit']);
  });

  it('同毫秒发布靠 (publish_at, id) 复合游标推进：只推最新一条，也不吞后来的', async () => {
    const { client, token } = await start();
    const at = NOW - 3_600_000;
    await publish({ issueDate: '2026-11-01', title: '一号', summary: 's1', body: 'b1', publishAt: at, autoPush: true });
    await publish({ issueDate: '2026-11-02', title: '二号', summary: 's2', body: 'b2', publishAt: at, autoPush: true });

    const first = await client.inbox(token, { topics: ['news'], afterPublish: 0, afterId: '' });
    expect(first.news?.item).toMatchObject({ id: 'news-2026-11-02' });
    expect(first.news?.skipped).toBe(1);
    expect(first.news?.capped).toBe(false);
    const cursor = first.news!.cursor;
    expect(cursor).toEqual({ publishAt: at, id: 'news-2026-11-02' });

    // 同一个毫秒再发一条 id 更大的：v1 的 unread[len-1] 取法会漏掉它，复合游标不会。
    await publish({ issueDate: '2026-11-03', title: '三号', summary: 's3', body: 'b3', publishAt: at, autoPush: true });
    const second = await client.inbox(token, {
      topics: ['news'], afterPublish: cursor.publishAt, afterId: cursor.id,
    });
    expect(second.news?.item).toMatchObject({ id: 'news-2026-11-03' });
    expect(second.news?.skipped).toBe(0);

    const third = await client.inbox(token, {
      topics: ['news'], afterPublish: second.news!.cursor.publishAt, afterId: second.news!.cursor.id,
    });
    expect(third.news?.item).toBeNull();
    expect(third.news?.cursor).toEqual(second.news!.cursor);
  });

  it('补录（auto_push=0）不进推送但主动查能拿到；未到可见时刻的现在看不见', async () => {
    const { client, token } = await start();
    await publish({ issueDate: '2026-10-20', title: '旧闻', summary: 's', body: '旧正文', autoPush: false });
    await publish({ issueDate: '2026-11-09', title: '今天的', summary: 's', body: '今天正文' });
    await publish({
      issueDate: '2026-11-10', title: '明天的', summary: 's', body: '明天正文', publishAt: NOW + 3_600_000,
    });

    const feed = await client.inbox(token, { topics: ['news'], afterPublish: 0, afterId: '' });
    expect(feed.news?.item).toMatchObject({ id: 'news-2026-11-09' });
    expect(feed.news?.skipped).toBe(0);

    const list = await client.news(token, { list: true, limit: 10 }) as { news: Array<Record<string, any>> };
    expect(list.news.map((item) => item.id)).toEqual(['news-2026-11-09', 'news-2026-10-20']);
    expect(list.news[0].body).toBeUndefined();

    expect(await client.news(token, { id: 'news-2026-10-20' })).toMatchObject({ news: { body: '旧正文' } });
    expect(await client.news(token, { id: 'news-2026-11-10' })).toEqual({ news: null });
    expect(await client.news(token, { id: 'news-nope' })).toEqual({ news: null });
    expect(await client.news(token)).toMatchObject({ news: { id: 'news-2026-11-09' } });
  });

  it('一天一版：同 id 逐字段一致才幂等，改字段或换 id 判冲突，超长正文 400', async () => {
    const { client, token } = await start();
    const base = { issueDate: '2026-11-09', title: '今天的茶馆', summary: '摘要', body: '正文' };
    const one = await publish(base);
    expect(one.status).toBe(200);
    const again = await publish(base);
    expect(again.status).toBe(200);
    expect(again.body.news.id).toBe(one.body.news.id);

    expect((await publish({ ...base, body: '改过的正文' })).status).toBe(409);
    expect((await publish({ ...base, id: 'news-other' })).status).toBe(409);
    expect((await publish({ ...base, body: 'x'.repeat(4001) })).status).toBe(400);
    expect((await publish({ ...base, issueDate: '2026-11-31' })).status).toBe(400);

    // 同一天只有一条：冲突不会留下第二行。
    const list = await client.news(token, { list: true }) as { news: unknown[] };
    expect(list.news).toHaveLength(1);
  });

  it('公告照旧搭同一趟车；匿名读 401，运营入口无钥匙 403', async () => {
    const { client, token } = await start();
    const announced = await operator('announcements', { text: '今晚维护', requestId: 'ann-1' });
    expect(announced.status).toBe(200);
    const inbox = await client.inbox(token, { topics: ['announcements'], afterPublish: 0, afterId: '' });
    expect(inbox.announcements).toMatchObject([{ text: '今晚维护' }]);

    for (const path of ['inbox', 'news', 'announcements']) {
      expect((await fetch(`${app!.url}/v1/support/${path}`)).status).toBe(401);
    }
    expect((await publish({ issueDate: '2026-11-09', title: 't', summary: 's', body: 'b' }, 'wrong-key')).status).toBe(403);
  });
});
