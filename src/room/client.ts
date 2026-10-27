/** 客厅客户端：World 用它与服务器说话。只发请求，不判断可见性。 */
import type { ActionRequest, ActionResponse, JoinRequest, JoinResponse, RoomEvent, RoomSnapshot } from './protocol.ts';

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

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async join(invite: string, request: JoinRequest): Promise<JoinResponse> {
    const response = await fetch(this.url('/v1/join'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-parlor-invite': invite },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<JoinResponse>(response);
  }

  async snapshot(token: string, since = 0, limit = 30): Promise<RoomSnapshot> {
    const query = new URLSearchParams({ since: String(since), limit: String(limit) });
    const response = await fetch(this.url(`/v1/room?${query}`), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<RoomSnapshot>(response);
  }

  async history(token: string, since: number, limit = 30): Promise<{ latest: number; events: RoomEvent[] }> {
    const query = new URLSearchParams({ since: String(since), limit: String(limit) });
    const response = await fetch(this.url(`/v1/history?${query}`), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<{ latest: number; events: RoomEvent[] }>(response);
  }

  async action(token: string, body: ActionRequest): Promise<ActionResponse> {
    const response = await fetch(this.url('/v1/action'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parse<ActionResponse>(response);
  }

  /** 读 SSE，直到 signal 中止或连接结束。 */
  async stream(
    token: string,
    since: number,
    onEvent: (event: RoomEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const query = new URLSearchParams({ since: String(since) });
    const response = await fetch(this.url(`/v1/stream?${query}`), {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      signal,
    });
    if (!response.ok || !response.body) {
      throw new ParlorHttpError(response.status, await errorText(response));
    }
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

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
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
