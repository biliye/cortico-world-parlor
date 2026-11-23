/** 网关运营与支持路由：公告、每日新闻、收件箱、反馈箱与运营工作台接口（/v1/support/*）。 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { HttpError, json, readJson } from './http.ts';
import type { InboxView } from './protocol.ts';
import type { RecruitSnapshot } from './recruit-snapshot.ts';
import type { StoryDb } from './story-db.ts';
import { SupportDb } from './support-db.ts';

export function payloadVersion(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 22);
}

export interface SupportRouteContext {
  db: Db;
  now: () => number;
  recruitSnapshot: RecruitSnapshot;
  story: StoryDb;
  cooOrSeat(req: IncomingMessage): Promise<string>;
  supportActor(req: IncomingMessage, url: URL): Promise<string>;
  personInfo(cooId: string): Promise<{ name: string }>;
  requireWebPost(req: IncomingMessage): void;
  checkOperator(req: IncomingMessage): void;
}

export async function serveSupportRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  ctx: SupportRouteContext,
): Promise<void> {
  res.setHeader('cache-control', 'no-store');
  const support = new SupportDb(ctx.db, ctx.now);
  const path = url.pathname.slice('/v1/support/'.length);
  if (path === 'announcements' && method === 'GET') {
    await ctx.supportActor(req, url);
    json(res, 200, { announcements: await support.announcements() }); return;
  }
  // 公告 / 新闻 / 招募共用一次请求：Coo 侧只有 60 秒一个定时器，
  // 分成三条路由会让每个 Coo 每分钟发三次请求。
  if (path === 'inbox' && method === 'GET') {
    const actor = await ctx.cooOrSeat(req);
    const topics = new Set((url.searchParams.get('topics') ?? 'announcements,news,recruit')
      .split(',').map((item) => item.trim()).filter(Boolean));
    const afterPublish = Number(url.searchParams.get('after_publish') ?? 0) || 0;
    const afterId = url.searchParams.get('after_id') ?? '';
    // 同厅的桌已经走 SSE 即时通知；这里排掉，别让两条通路说同一桌、也别白占前三的名额。
    const here = (url.searchParams.get('room') ?? '').trim();
    const announcement: Pick<InboxView, 'announcements' | 'announcementVersion'> = {};
    if (topics.has('announcements')) {
      const items = await support.announcements();
      if (url.searchParams.has('announcement_version')) {
        announcement.announcementVersion = payloadVersion(items);
      }
      if (!announcement.announcementVersion || announcement.announcementVersion !== url.searchParams.get('announcement_version')) {
        announcement.announcements = items;
      }
    }
    json(res, 200, {
      ...announcement,
      ...(topics.has('news') ? { news: await support.newsFeed(afterPublish, afterId) } : {}),
      ...(topics.has('recruit') ? { recruit: { tables: await ctx.recruitSnapshot.take(3, here) } } : {}),
      ...(topics.has('story') ? { story: await ctx.story.liveHint(actor) } : {}),
    }, req);
    return;
  }
  // 主动查：一律 200，找不到就是 news:null。旧服务器没有这条路由才是 404，
  // Coo 侧据此区分「本版没有新闻板块」和「这条还没发」。
  if (path === 'news' && method === 'GET') {
    await ctx.cooOrSeat(req);
    const id = url.searchParams.get('id') ?? '';
    // 没有就是 news:null——不能留 undefined，否则序列化成 {}，客户端判不出「这条还没发」。
    if (id) { json(res, 200, { news: (await support.newsById(id)) ?? null }); return; }
    if (url.searchParams.get('list') === '1') {
      json(res, 200, { news: await support.newsList(Number(url.searchParams.get('limit') ?? 5)) }); return;
    }
    json(res, 200, { news: (await support.latestNews()) ?? null }); return;
  }
  if (path === 'feedback' && (method === 'GET' || method === 'POST')) {
    if (method === 'POST' && ['parent', 'web'].includes(url.searchParams.get('as') ?? '')) ctx.requireWebPost(req);
    const cooId = await ctx.supportActor(req, url);
    if (method === 'GET') { json(res, 200, { feedback: await support.feedback(cooId) }); return; }
    const body = await readJson(req);
    const person = await ctx.personInfo(cooId);
    json(res, 200, { feedback: await support.submit(cooId, person.name, body.text, body.requestId) }); return;
  }
  if (path.startsWith('operator/')) {
    ctx.checkOperator(req);
    if (path === 'operator/feedback' && method === 'GET') {
      json(res, 200, { feedback: await support.feedback() }); return;
    }
    if (path === 'operator/reply' && method === 'POST') {
      const body = await readJson(req);
      await support.reply(String(body.id ?? ''), body.text, body.status);
      json(res, 200, { ok: true }); return;
    }
    if (path === 'operator/announcements' && method === 'POST') {
      const body = await readJson(req);
      json(res, 200, { announcement: await support.announce(body.text, body.requestId) }); return;
    }
    // 运营列表：玩家那条 `announcements` 走 Coo / 席位鉴权，运营钥匙调不动，
    // 所以工作台要自己有一条读法，否则改与删都没有入口。
    if (path === 'operator/announcements' && method === 'GET') {
      json(res, 200, { announcements: await support.announcementAdminList(Number(url.searchParams.get('limit') ?? 20)) }); return;
    }
    if (path === 'operator/announcements' && method === 'PATCH') {
      const body = await readJson(req);
      const id = String(body.id ?? '').trim();
      if (!id) throw new HttpError(400, '需要公告 id');
      // revision 必须是运营页面看到的那一版：服务端读到的版本不能当并发条件。
      // publishId 认「这一条发布」：删掉后用同一个 requestId 重发，版本又从 1 开始。
      json(res, 200, {
        announcement: (await support.editAnnouncement(id, body.text, body.revision, body.publishId)).item,
      }); return;
    }
    if (path === 'operator/announcements' && method === 'DELETE') {
      const id = (url.searchParams.get('id') ?? '').trim();
      if (!id) throw new HttpError(400, '需要公告 id');
      // 旧标签页拿着过期版本不能删掉别人刚改出来的新版；
      // publishId 再挡一层：不能删掉用同一个 requestId 重发的下一条。
      json(res, 200, {
        ok: true,
        deleted: await support.deleteAnnouncement(
          id, url.searchParams.get('revision') ?? '', url.searchParams.get('publishId') ?? '',
        ),
      }); return;
    }
    if (path === 'operator/news' && method === 'GET') {
      const id = (url.searchParams.get('id') ?? '').trim();
      if (id) {
        const item = await support.newsAdminById(id);
        if (!item) throw new HttpError(404, '没有这条新闻');
        json(res, 200, { news: item }); return;
      }
      // 运营列表含还没到可见时刻的预录条目：这条走运营钥匙，不走席位鉴权。
      json(res, 200, { news: await support.newsAdminList(Number(url.searchParams.get('limit') ?? 10)) }); return;
    }
    if (path === 'operator/news' && method === 'POST') {
      const body = await readJson(req);
      json(res, 200, { news: await support.publishNews(body) }); return;
    }
    // 改：只动内容与可见设置，不动 id 与日期；字段没给就保持原样。
    if (path === 'operator/news' && method === 'PATCH') {
      const body = await readJson(req);
      const result = await support.editNews(body);
      json(res, 200, { news: result.item, changed: result.changed }); return;
    }
    // 删：物理删除，当天可以重发；原文进留痕表，`deleted: null` 表示本来就没有。
    // `publishId` 必填：同一天重发沿用同一个 id，只带 id 的旧请求会误删新稿；
    // 也不用 createdAt——两次发布可以落在同一毫秒。
    if (path === 'operator/news' && method === 'DELETE') {
      const id = (url.searchParams.get('id') ?? '').trim();
      if (!id) throw new HttpError(400, '需要新闻 id');
      const publishId = (url.searchParams.get('publishId') ?? '').trim();
      if (!publishId) throw new HttpError(400, '需要 publishId（本次发布的唯一标识）');
      json(res, 200, { ok: true, deleted: await support.deleteNews(id, publishId) }); return;
    }
    if (path === 'operator/audit' && method === 'GET') {
      json(res, 200, { audit: await support.auditList(Number(url.searchParams.get('limit') ?? 20)) }); return;
    }
  }
  throw new HttpError(404, '没有这个反馈通道地址');
}
