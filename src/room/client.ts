/** 客厅客户端：World 用它与服务器说话。只发请求，不判断可见性。 */
import type { CooIdentity } from './identity.ts';
import { COO_HEADER, COO_SECRET_HEADER } from './identity.ts';
import type { MailPage } from './mail.ts';
import type { ReplayEventView } from './replay.ts';
import type {
  ActionRequest, ActionResponse, HallView, InviteResponse, JoinRequest, JoinResponse, MeView,
  RoomEvent, RoomSnapshot, RoomSummary, SwitchResponse,
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

export class ParlorHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ParlorHttpError';
  }
}

export class ParlorClient {
  readonly baseUrl: string;
  private readonly identity?: CooIdentity;

  constructor(baseUrl: string, identity?: CooIdentity) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.identity = identity;
  }

  async join(invite: string, request: JoinRequest, roomId?: string): Promise<JoinResponse> {
    const response = await fetch(this.path('join', roomId), {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json', 'x-parlor-invite': invite }),
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<JoinResponse>(response);
  }

  async snapshot(token: string, since = 0, limit = 30, roomId?: string): Promise<RoomSnapshot> {
    const query = new URLSearchParams({ since: String(since), limit: String(limit) });
    const response = await fetch(`${this.path('room', roomId)}?${query}`, {
      headers: this.headers({ authorization: `Bearer ${token}` }),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<RoomSnapshot>(response);
  }

  async history(
    token: string,
    since: number,
    limit = 30,
    roomId?: string,
  ): Promise<{ latest: number; events: RoomEvent[] }> {
    const query = new URLSearchParams({ since: String(since), limit: String(limit) });
    const response = await fetch(`${this.path('history', roomId)}?${query}`, {
      headers: this.headers({ authorization: `Bearer ${token}` }),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<{ latest: number; events: RoomEvent[] }>(response);
  }

  /** 读信箱；peek 只看不标已读，all 看所有客厅（跨厅邀请在这里）。 */
  async mail(token: string, limit = 10, peek = false, roomId?: string, all = false): Promise<MailPage> {
    const query = new URLSearchParams({
      limit: String(limit),
      ...(peek ? { peek: '1' } : {}),
      ...(all ? { all: '1' } : {}),
    });
    const response = await fetch(`${this.path('mail', roomId)}?${query}`, {
      headers: this.headers({ authorization: `Bearer ${token}` }),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<MailPage>(response);
  }

  /**
   * 身份级信箱：不占着任何客厅席位也能读（被移出客厅后，结算与退注还看得到）。
   * 用 x-parlor-coo 身份头，不需要席位令牌。
   */
  async mailAsIdentity(limit = 10, peek = false, roomId?: string): Promise<MailPage> {
    const query = new URLSearchParams({
      limit: String(limit),
      ...(peek ? { peek: '1' } : {}),
      ...(roomId ? { room: roomId } : {}),
    });
    const response = await fetch(`${this.url('/v1/me/mail')}?${query}`, {
      headers: this.headers({}),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<MailPage>(response);
  }

  /** 身份级账本摘要。 */
  async ledgerAsIdentity(): Promise<{ ledger: unknown }> {
    const response = await fetch(this.url('/v1/me/ledger'), {
      headers: this.headers({}),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<{ ledger: unknown }>(response);
  }

  /** 身份级回放：按历次到访区间的并集，不需要席位。 */
  async replayAsIdentity(roomId: string, limit = 30, before?: number): Promise<ReplayResponse> {
    const query = new URLSearchParams({
      room: roomId,
      limit: String(limit),
      ...(before ? { before: String(before) } : {}),
    });
    const response = await fetch(`${this.url('/v1/me/replay')}?${query}`, {
      headers: this.headers({}),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<ReplayResponse>(response);
  }

  /** 接受/拒绝私密厅邀请；有席位令牌就带，没有也能用身份头。 */
  async respondInvitation(
    token: string | undefined,
    id: string,
    action: 'accept' | 'decline',
  ): Promise<{ ok: boolean; room?: string }> {
    const response = await fetch(`${this.url('/v1/invitations')}/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      headers: this.headers({
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
      headers: this.headers({ authorization: `Bearer ${token}` }),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<ReplayResponse>(response);
  }

  async action(token: string, body: ActionRequest, roomId?: string): Promise<ActionResponse> {
    const response = await fetch(this.path('action', roomId), {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json', authorization: `Bearer ${token}` }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<ActionResponse>(response);
  }

  /** 我在哪：当前席位与能看到的客厅目录。 */
  async me(): Promise<MeView> {
    const response = await fetch(this.url('/v1/me'), {
      headers: this.headers({}),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<MeView>(response);
  }

  /** 大厅：谁在大厅、公开目录、我在哪。 */
  async hall(): Promise<HallView> {
    const response = await fetch(this.url('/v1/hall'), {
      headers: this.headers({}),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<HallView>(response);
  }

  async rooms(all = true): Promise<{ rooms: RoomSummary[] }> {
    const response = await fetch(this.url(`/v1/rooms${all ? '?all=1' : ''}`), {
      headers: this.headers({}),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<{ rooms: RoomSummary[] }>(response);
  }

  async createRoom(input: {
    name: string; visibility?: string; capacity?: number; topic?: string;
  }): Promise<{ room: RoomSummary }> {
    const response = await fetch(this.url('/v1/rooms'), {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<{ room: RoomSummary }>(response);
  }

  /** 换房：一次操作里释放旧席位、拿新席位；旧令牌立刻失效。 */
  async switchTo(token: string, fromRoom: string, to: string, name?: string): Promise<SwitchResponse> {
    const response = await fetch(this.path('switch', fromRoom), {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json', authorization: `Bearer ${token}` }),
      body: JSON.stringify({ to, ...(name ? { name } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<SwitchResponse>(response);
  }

  /** 离开客厅（释放席位，不自动进大厅）。 */
  async leaveRoom(token: string, roomId: string): Promise<{ ok: true; seq: number; at: string }> {
    const response = await fetch(this.path('leave', roomId), {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json', authorization: `Bearer ${token}` }),
      body: '{}',
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<{ ok: true; seq: number; at: string }>(response);
  }

  /** 定向邀请：跨客厅送达（信箱 + 对方当前客厅的一条私密通知）。 */
  async invite(to: string, room?: string, text?: string): Promise<InviteResponse> {
    const response = await fetch(this.url('/v1/invite'), {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
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
    const query = new URLSearchParams({ since: String(since) });
    const response = await fetch(`${this.path('stream', roomId)}?${query}`, {
      headers: this.headers({ authorization: `Bearer ${token}`, accept: 'text/event-stream' }),
      signal,
    });
    if (!response.ok || !response.body) {
      throw new ParlorHttpError(response.status, await errorText(response));
    }
    onOpen?.();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
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
      try { await reader.cancel(); } catch { /* 已结束 */ }
    }
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    if (!this.identity) return extra;
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
