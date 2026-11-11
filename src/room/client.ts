/** 客厅客户端：World 用它与服务器说话。只发请求，不判断可见性。 */
import type { CooIdentity } from './identity.ts';
import { COO_HEADER, COO_SECRET_HEADER } from './identity.ts';
import { GLOBAL_HEADER, identityOrigin, identityRequest, type IdentityTicket } from './global-identity.ts';
import type { MailPage, MailReadResult } from './mail.ts';
import type { ReplayEventView } from './replay.ts';
import type { HistorySyncPage } from './history-sync.ts';
import type { Announcement, Feedback } from './support-db.ts';
import type { ParentMailView } from './mail-db.ts';
import type { TableEntryInput, TableEntryResponse } from './table-discovery-db.ts';
import type { GameQuery } from './game-api.ts';
import type {
  ActionRequest, ActionResponse, HallView, InboxView, InviteResponse, JoinRequest, JoinResponse, MeView,
  NewsItemView, NewsSummaryView, RoomEvent, RoomSnapshot, RoomSummary, SwitchResponse,
} from './protocol.ts';

export interface ReplayResponse {
  room: string;
  latest: number;
  now: number;
  at: string;
  retentionDays: number;
  events: ReplayEventView[];
  older: boolean;
}

/**
 * 客户端协议能力版本：World 每次动作都自报，服务端据此判断这只 Coo
 * 能不能玩需要新能力的游戏（狼人杀要 ≥ 0.29.0）。
 * 它跟 npm 包版本解耦——发新版时在这里抬一格即可（有测试盯着别忘）。
 */
export const PARLOR_CLIENT_VERSION = '0.41.0';

export class ParlorHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ParlorHttpError';
  }
}

export class ParlorClient {
  async support(token: string, action: 'feedback' | 'announcements', body?: { text: string; requestId: string }): Promise<{ feedback?: Feedback[] | Feedback; announcements?: Announcement[] }> {
    const response = await fetch(this.url(`/v1/support/${action}`), {
      method: body ? 'POST' : 'GET',
      headers: await this.headers({ authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }),
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse(response);
  }

  /** 公告 + 新闻摘要 + 跨厅招募共用一次请求；旧服务器没有这条路由会抛 404。 */
  async inbox(token: string, query: { topics: string[]; afterPublish: number; afterId: string; room?: string }): Promise<InboxView> {
    const params = new URLSearchParams({
      topics: query.topics.join(','),
      after_publish: String(query.afterPublish),
    });
    if (query.afterId) params.set('after_id', query.afterId);
    // 当前所在厅：服务端据此排掉同厅的桌，招募只搭「别的厅」。
    if (query.room) params.set('room', query.room);
    const response = await fetch(this.url(`/v1/support/inbox?${params.toString()}`), {
      headers: await this.headers({ authorization: `Bearer ${token}` }),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<InboxView>(response);
  }

  /** 主动查新闻：不带参数给最新一篇全文，list 只给摘要列表。 */
  async news(token: string, query: { id?: string; list?: boolean; limit?: number } = {}): Promise<{
    news: NewsItemView | NewsSummaryView[] | null;
  }> {
    const params = new URLSearchParams();
    if (query.id) params.set('id', query.id);
    if (query.list) {
      params.set('list', '1');
      if (query.limit) params.set('limit', String(query.limit));
    }
    const search = params.toString();
    const response = await fetch(this.url(`/v1/support/news${search ? `?${search}` : ''}`), {
      headers: await this.headers({ authorization: `Bearer ${token}` }),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse(response);
  }

  readonly baseUrl: string;
  private readonly identity?: CooIdentity;
  private global?: { authority: string; audience: string; invite: string; name: string };
  private ticket?: IdentityTicket;
  private refreshing?: Promise<IdentityTicket>;

  /** 只向目标服务器探测能力；需要新通行证时才联系权威。返回是否为多客厅网关。 */
  async initializeIdentity(authority: string, invite: string, name: string): Promise<boolean> {
    const response = await fetch(this.url('/healthz'), { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new ParlorHttpError(response.status, '读取服务器能力失败');
    const health = await response.json() as { protocol?: number; globalIdentity?: { authority: string; audience: string } };
    if (!health.globalIdentity) {
      if (this.identity?.authority || identityOrigin(this.baseUrl) !== identityOrigin(authority)) {
        throw new Error('目标服务器尚未支持全局身份；请先升级服务器');
      }
      return health.protocol === 2;
    }
    authority = identityOrigin(authority);
    if (this.identity?.authority && this.identity.authority !== authority) throw new Error('已有身份属于另一统一身份服务，请保持原身份服务地址');
    const audience = identityOrigin(health.globalIdentity.audience);
    if (identityOrigin(health.globalIdentity.authority) !== authority || audience !== identityOrigin(this.baseUrl)) {
      throw new Error('目标服务器的身份服务或公开地址与配置不一致');
    }
    this.global = { authority, audience, invite, name };
    return health.protocol === 2;
  }

  private async globalTicket(): Promise<IdentityTicket> {
    if (this.ticket && this.ticket.expiresAt > Date.now() + 60_000) return this.ticket;
    if (!this.global || !this.identity) throw new Error('尚未初始化统一身份');
    const cfg = this.global;
    this.refreshing ??= identityRequest<IdentityTicket>(cfg.authority, '/v1/identity/session', {
      cooId: this.identity.cooId, cooSecret: this.identity.cooSecret,
      name: cfg.name, audience: cfg.audience, invite: cfg.invite,
    });
    try {
      this.ticket = await this.refreshing;
      this.identity.authority = cfg.authority;
      this.identity.handle = this.ticket.person.handle;
      return this.ticket;
    } finally { this.refreshing = undefined; }
  }

  constructor(baseUrl: string, identity?: CooIdentity) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.identity = identity;
  }

  async join(invite: string, request: JoinRequest, roomId?: string): Promise<JoinResponse> {
    const response = await fetch(this.path('join', roomId), {
      method: 'POST',
      headers: await this.headers({ 'content-type': 'application/json', 'x-parlor-invite': invite }),
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<JoinResponse>(response);
  }

  async snapshot(token: string, since = 0, limit = 30, roomId?: string): Promise<RoomSnapshot> {
    const query = new URLSearchParams({ since: String(since), limit: String(limit) });
    const response = await fetch(`${this.path('room', roomId)}?${query}`, {
      headers: await this.headers({ authorization: `Bearer ${token}` }),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<RoomSnapshot>(response);
  }

  /** 只改当前令牌所属席位的名字，不重新入座。 */
  async rename(token: string, name: string): Promise<{ name: string }> {
    const response = await fetch(this.url('/v1/me/rename'), {
      method: 'POST',
      headers: await this.headers({ authorization: `Bearer ${token}`, 'content-type': 'application/json' }),
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse(response);
  }

  async history(
    token: string,
    since: number,
    limit = 30,
    roomId?: string,
  ): Promise<{ latest: number; events: RoomEvent[] }> {
    const query = new URLSearchParams({ since: String(since), limit: String(limit) });
    const response = await fetch(`${this.path('history', roomId)}?${query}`, {
      headers: await this.headers({ authorization: `Bearer ${token}` }),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<{ latest: number; events: RoomEvent[] }>(response);
  }

  /** 读信箱；peek 只看不标已读，all 看所有客厅（跨厅邀请在这里）。 */
  async mail(token: string, limit = 10, peek = false, roomId?: string, all = false, newest = false): Promise<MailPage> {
    const query = new URLSearchParams({
      limit: String(limit),
      ...(peek ? { peek: '1' } : {}),
      all: all ? '1' : '0',
      ...(newest ? { newest: '1' } : {}),
    });
    const response = await fetch(`${this.path('mail', roomId)}?${query}`, {
      headers: await this.headers({ authorization: `Bearer ${token}` }),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<MailPage>(response);
  }

  /**
   * 身份级信箱：不占着任何客厅席位也能读（被移出客厅后，结算与退注还看得到）。
   * 用 x-parlor-coo 身份头，不需要席位令牌。
   */
  async mailAsIdentity(limit = 10, peek = false, roomId?: string, newest = false): Promise<MailPage> {
    const query = new URLSearchParams({
      limit: String(limit),
      ...(peek ? { peek: '1' } : {}),
      ...(roomId ? { room: roomId } : {}),
      ...(newest ? { newest: '1' } : {}),
    });
    const response = await fetch(`${this.url('/v1/me/mail')}?${query}`, {
      headers: await this.headers({}),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<MailPage>(response);
  }

  async markAllMailRead(token: string): Promise<MailReadResult> {
    const response = await fetch(this.url('/v1/mail/read-all'), {
      method: 'POST',
      headers: await this.headers({ authorization: `Bearer ${token}` }),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<MailReadResult>(response);
  }

  /** 只读补档：包括已读信，按游标向前，不动信箱。 */
  async messageHistory(token: string, after = 0): Promise<{ items: ParentMailView[]; seats: { id: string; room: string }[] }> {
    const response = await fetch(this.url(`/v1/me/message-history?after=${after}`), {
      headers: await this.headers({ authorization: `Bearer ${token}` }),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse(response);
  }

  /** 身份级账本摘要。 */
  async ledgerAsIdentity(token?: string): Promise<{ ledger: unknown }> {
    const response = await fetch(this.url('/v1/me/ledger'), {
      headers: await this.headers(token ? { authorization: `Bearer ${token}` } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<{ ledger: unknown }>(response);
  }

  /** 茶单与本人存货（礼物，纯展示，不影响任何数值）。 */
  async gifts(token: string, mine = false, roomId?: string): Promise<{
    items: Array<{ id: string; kind: string; kindLabel?: string; name: string; desc?: string; count?: number }>;
  }> {
    const response = await fetch(`${this.path('gifts', roomId)}${mine ? '?mine=1' : ''}`, {
      headers: await this.headers({ authorization: `Bearer ${token}` }),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse(response);
  }

  async location(token: string): Promise<{ room: string | null; seat: RoomSnapshot['seat'] | null }> {
    const response = await fetch(this.url('/v1/me/location'), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    return this.parse(response);
  }
  async accountHistory(token: string, query: Record<string, unknown>) {
    const params = new URLSearchParams(Object.entries(query).filter(([,v]) => v !== undefined).map(([k,v]): [string,string] => [k,String(v)]));
    const response = await fetch(this.url('/v1/me/history') + '?' + params, { headers: await this.headers({ authorization: `Bearer ${token}` }), signal: AbortSignal.timeout(15_000) });
    return this.parse<{ items: Array<{
      id: string; ts: number; roomName: string; kind: string; game?: string;
      result?: string; itemId?: string; itemName?: string;
      direction?: 'in' | 'out' | 'used'; text: string;
    }>; next: number | null }>(response);
  }

  /** 身份级回放：按历次到访区间的并集，不需要席位。 */
  async replayAsIdentity(roomId: string, limit = 30, before?: number): Promise<ReplayResponse> {
    const query = new URLSearchParams({
      room: roomId,
      limit: String(limit),
      ...(before ? { before: String(before) } : {}),
    });
    const response = await fetch(`${this.url('/v1/me/replay')}?${query}`, {
      headers: await this.headers({}),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<ReplayResponse>(response);
  }

  /** 本机补档只拉已落盘游标之后的新正文，不下载回放里的完整游戏数据。 */
  async historySync(roomId: string, after = 0, limit = 200): Promise<HistorySyncPage> {
    const query = new URLSearchParams({ room: roomId, after: String(after), limit: String(limit) });
    const response = await fetch(`${this.url('/v1/me/history-sync')}?${query}`, {
      headers: await this.headers({}),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<HistorySyncPage>(response);
  }

  /** 接受/拒绝私密厅邀请；有席位令牌就带，没有也能用身份头。 */
  async respondInvitation(
    token: string | undefined,
    id: string,
    action: 'accept' | 'decline',
  ): Promise<{ ok: boolean; room?: string }> {
    const response = await fetch(`${this.url('/v1/invitations')}/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      headers: await this.headers({
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      }),
      body: '{}',
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<{ ok: boolean; room?: string }>(response);
  }

  /** 读回放：默认最近的；before 往前翻。 */
  async replay(token: string, limit = 30, before?: number, roomId?: string): Promise<ReplayResponse> {
    const query = new URLSearchParams({ limit: String(limit), ...(before ? { before: String(before) } : {}) });
    const response = await fetch(`${this.path('replay', roomId)}?${query}`, {
      headers: await this.headers({ authorization: `Bearer ${token}` }),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<ReplayResponse>(response);
  }

  async games(token: string, query: GameQuery = {}, roomId?: string): Promise<Record<string, unknown>> {
    if (query.op === 'ratings' && !query.game?.trim()) throw new Error('查等级分榜需要 game，例如 gomoku');
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    if (query.op === 'ratings' && query.limit === undefined) params.set('limit', '20');
    const path = query.op === 'ratings' ? this.url('/v1/hall/ratings') : this.path('games', roomId);
    const response = await fetch(`${path}?${params}`, {
      headers: await this.headers({ authorization: `Bearer ${token}` }),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse(response);
  }

  async action(token: string, body: ActionRequest, roomId?: string): Promise<ActionResponse> {
    const response = await fetch(this.path('action', roomId), {
      method: 'POST',
      headers: await this.headers({
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        // 自报协议能力版本：狼人杀开局前服务端按它校验每只 Coo。
        'x-parlor-client': PARLOR_CLIENT_VERSION,
      }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<ActionResponse>(response);
  }

  /** 游戏历史查询（狼人杀的按天/按人回看与终局复盘）。 */
  async tableLog(
    token: string,
    query: Omit<GameQuery, 'op' | 'game'> = {},
    roomId?: string,
  ): Promise<{ ok: true; at: string; log: Record<string, unknown> }> {
    const params = new URLSearchParams();
    if (query.table) params.set('table', query.table);
    if (query.day !== undefined) params.set('day', String(query.day));
    if (query.seatNo !== undefined) params.set('seatNo', String(query.seatNo));
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.review) params.set('review', '1');
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    const response = await fetch(`${this.path('table-log', roomId)}?${params}`, {
      headers: await this.headers({
        authorization: `Bearer ${token}`,
        'x-parlor-client': PARLOR_CLIENT_VERSION,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<{ ok: true; at: string; log: Record<string, unknown> }>(response);
  }

  /** 我在哪：当前席位与能看到的客厅目录。 */
  async me(token?: string): Promise<MeView> {
    const response = await fetch(this.url('/v1/me'), {
      headers: await this.headers(token ? { authorization: `Bearer ${token}` } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<MeView>(response);
  }

  /** 大厅：谁在大厅、公开目录、我在哪。 */
  async hall(token?: string): Promise<HallView> {
    const response = await fetch(this.url('/v1/hall'), {
      headers: await this.headers(token ? { authorization: `Bearer ${token}` } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<HallView>(response);
  }

  async enterTable(token: string, input: TableEntryInput): Promise<TableEntryResponse> {
    const send = async () => {
      const response = await fetch(this.url('/v1/table-entry'), {
        method: 'POST',
        headers: await this.headers({ 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-parlor-client': PARLOR_CLIENT_VERSION }),
        body: JSON.stringify(input), signal: AbortSignal.timeout(15_000),
      });
      return this.parse<TableEntryResponse>(response);
    };
    try { return await send(); } catch (error) {
      if (error instanceof ParlorHttpError) throw error;
      // 回包丢失时只重放这一笔幂等请求，不能重新抽一张桌。
      return send();
    }
  }

  async rooms(all = true, token?: string): Promise<{ rooms: RoomSummary[] }> {
    const response = await fetch(this.url(`/v1/rooms${all ? '?all=1' : ''}`), {
      headers: await this.headers(token ? { authorization: `Bearer ${token}` } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<{ rooms: RoomSummary[] }>(response);
  }

  async createRoom(input: {
    name: string; visibility?: string; capacity?: number; topic?: string;
  }, token?: string): Promise<{ room: RoomSummary }> {
    const response = await fetch(this.url('/v1/rooms'), {
      method: 'POST',
      headers: await this.headers({ 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<{ room: RoomSummary }>(response);
  }

  /** 换房：一次操作里释放旧席位、拿新席位；旧令牌立刻失效。 */
  async switchTo(token: string, fromRoom: string, to: string, name?: string): Promise<SwitchResponse> {
    const response = await fetch(this.path('switch', fromRoom), {
      method: 'POST',
      headers: await this.headers({ 'content-type': 'application/json', authorization: `Bearer ${token}` }),
      body: JSON.stringify({ to, ...(name ? { name } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<SwitchResponse>(response);
  }

  /** 离开客厅（释放席位，不自动进大厅）。 */
  async leaveRoom(token: string, roomId: string): Promise<{ ok: true; seq: number; at: string }> {
    const response = await fetch(this.path('leave', roomId), {
      method: 'POST',
      headers: await this.headers({ 'content-type': 'application/json', authorization: `Bearer ${token}` }),
      body: '{}',
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<{ ok: true; seq: number; at: string }>(response);
  }

  /** 定向邀请：跨客厅送达（信箱 + 对方当前客厅的一条私密通知）。 */
  async invite(to: string, room?: string, text?: string, token?: string): Promise<InviteResponse> {
    const response = await fetch(this.url('/v1/invite'), {
      method: 'POST',
      headers: await this.headers({ 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }),
      body: JSON.stringify({ to, ...(room ? { room } : {}), ...(text ? { text } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<InviteResponse>(response);
  }

  /** 读 SSE，直到 signal 中止或连接结束。`onOpen` 只在拿到 200 响应时调一次。 */
  async stream(
    token: string,
    since: number,
    onEvent: (event: RoomEvent) => void,
    signal?: AbortSignal,
    roomId?: string,
    onOpen?: () => void,
  ): Promise<void> {
    // 服务端每 15 秒发心跳；覆盖连响应头都收不到、以及 TCP 半开不再收数据的情况。
    const connection = new AbortController();
    const abort = () => connection.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let watchdog: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => connection.abort(new Error('客厅连接 45 秒未收到数据，正在重新连接')), 45_000);
      watchdog.unref?.();
    };
    arm();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
    const query = new URLSearchParams({ since: String(since) });
    const response = await fetch(`${this.path('stream', roomId)}?${query}`, {
      headers: await this.headers({ authorization: `Bearer ${token}`, accept: 'text/event-stream' }),
      signal: connection.signal,
    });
    if (!response.ok || !response.body) {
      throw new ParlorHttpError(response.status, await errorText(response));
    }
    onOpen?.();
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        arm();
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = chunk.split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          try {
            onEvent(JSON.parse(data) as RoomEvent);
          } catch { /* 单条坏消息不影响后续 */ }
        }
      }
    } finally {
      clearTimeout(watchdog!);
      signal?.removeEventListener('abort', abort);
      try { await reader?.cancel(); } catch { /* 已结束 */ }
    }
  }

  private async headers(extra: Record<string, string>): Promise<Record<string, string>> {
    // 快照与 SSE 续连也携带能力，升级后无需退桌重入。
    extra = { 'x-parlor-client': PARLOR_CLIENT_VERSION, 'x-parlor-capabilities':'seat-location-v1', ...extra };
    if (!this.identity) return extra;
    if (this.global) {
      if (extra.authorization) return extra;
      return { ...extra, [GLOBAL_HEADER]: (await this.globalTicket()).token };
    }
    return {
      ...extra,
      [COO_HEADER]: this.identity.cooId,
      [COO_SECRET_HEADER]: this.identity.cooSecret,
    };
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /** 给了 roomId 走多客厅路径；没给就走旧的默认客厅别名。 */
  private path(action: string, roomId?: string): string {
    return roomId
      ? this.url(`/v1/rooms/${encodeURIComponent(roomId)}/${action}`)
      : this.url(`/v1/${action}`);
  }

  private async parse<T>(response: Response): Promise<T> {
    if (!response.ok) throw new ParlorHttpError(response.status, await errorText(response));
    return await response.json() as T;
  }
}

const errorText = async (response: Response): Promise<string> => {
  try {
    const body = await response.json() as { error?: string };
    return body.error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
};
