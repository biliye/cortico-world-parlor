import type { IncomingMessage, ServerResponse } from 'node:http';
import { GLOBAL_HEADER } from './identity-protocol.ts';
import { bearer, headerValue, HttpError, json, readJson } from './http.ts';
import type { StoryDb } from './story-db.ts';
import { STORY_ACTIONS } from './story-protocol.ts';

const PUBLIC_ARCHIVE = '/v1/story/archive';
const PERSONAL_ARCHIVE = '/v1/me/story/archive';
const PARENT_ARCHIVE = '/v1/parent/story';

export const isStoryPath = (path: string): boolean =>
  path.startsWith('/v1/story/') || path === PERSONAL_ARCHIVE || path === PARENT_ARCHIVE;

interface StoryRouteContext {
  story: StoryDb;
  cooOrSeat(): Promise<string>;
  parentCooId(): Promise<string>;
  actorName(id: string): Promise<string>;
  pokeClock(): void;
}

export async function serveStoryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: StoryRouteContext,
): Promise<void> {
  res.setHeader('cache-control', 'no-store');
  const { pathname: path, searchParams } = url;
  const { story } = context;
  if (path === '/v1/story/action' && req.method === 'POST') {
    const id = await context.cooOrSeat();
    const body = await readJson(req);
    if (!STORY_ACTIONS.some(action => action === body.action)) throw new HttpError(400, '未知说书操作');
    const name = await context.actorName(id);
    const result = await story.action({ id, name }, body);
    if (body.action !== 'listen') context.pokeClock();
    json(res, 200, result, req);
    return;
  }
  if (req.method !== 'GET') throw new HttpError(405, '需要 GET');
  if (path === '/v1/story/live') {
    const id = bearer(req) || headerValue(req, 'x-parlor-coo') || headerValue(req, GLOBAL_HEADER)
      ? await context.cooOrSeat() : undefined;
    const after = Number(searchParams.get('after') ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, '发言游标无效');
    json(res, 200, await story.state(id, searchParams.get('round') ?? undefined, after), req);
    return;
  }
  if (path === '/v1/story/notice') {
    json(res, 200, await story.notice(await context.cooOrSeat()), req);
    return;
  }
  if (path === '/v1/story/chat') {
    await context.cooOrSeat();
    const round = searchParams.get('round');
    const cursor = searchParams.get('before');
    const before = cursor === null ? undefined : Number(cursor);
    if (round !== null && (!round || round.length > 72)) throw new HttpError(400, '场次编号无效');
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new HttpError(400, '聊天游标无效');
    json(res, 200, await story.discussion(round ?? undefined, before), req);
    return;
  }
  if (![PUBLIC_ARCHIVE, PERSONAL_ARCHIVE, PARENT_ARCHIVE].includes(path)) {
    throw new HttpError(404, '没有这个说书接口');
  }
  const personal = path === PERSONAL_ARCHIVE;
  const actor = personal ? await context.cooOrSeat()
    : path === PARENT_ARCHIVE ? await context.parentCooId() : undefined;
  const id = searchParams.get('id');
  if (id) {
    json(res, 200, await story.archive(id, actor), req);
    return;
  }
  const cursorId = searchParams.get('cursorId');
  const cursorAt = searchParams.get('cursorAt');
  const endedAt = Number(cursorAt);
  if ((cursorId !== null || cursorAt !== null) && (!cursorId || cursorId.length > 72 || !cursorAt
    || !Number.isSafeInteger(endedAt) || endedAt < 0)) throw new HttpError(400, '说书档案游标无效');
  const cursor = cursorId ? { id: cursorId, endedAt } : undefined;
  json(res, 200, await story.history(actor, cursor, personal && searchParams.get('forward') === '1'), req);
}
