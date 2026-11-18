import { clearSeat, saveSeat, seat } from '../stores/session.ts';
import { ApiError, timeoutSignal } from './client.ts';

export type WebPlayer = { name: string; guest: boolean; expiresAt: number; seated: boolean };

export function uncertainWebResult(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500);
}

/** `/v1/web/*` 的成功响应必须包含 JSON 对象，只有操作回执的端点也返回 `{ ok: true }`。 */
export async function webPlayerRequest<T>(path: string, body?: Record<string, unknown>, token?: string): Promise<T> {
  const signal = timeoutSignal();
  let status = 0;
  try {
    const response = await fetch('/v1/web/' + path, {
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) },
      cache: 'no-store',
      signal,
    });
    if (!response.ok) status = response.status;
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('无效响应');
    if (status) {
      throw new ApiError('error' in data && typeof data.error === 'string' ? data.error : `会馆请求失败（${status}）`, status, '');
    }
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const message = status ? `会馆请求失败（${status}）`
      : signal?.aborted ? '会馆请求超时，请检查网络后再试。' : '暂时未收到会馆的有效响应，请检查网络后再试。';
    throw new ApiError(message, status, '');
  }
}

export async function takeWebSeat(takeover: boolean, name?: string): Promise<void> {
  const joined = await webPlayerRequest<{
    room: string; token: string; guest: boolean; tableId?: string;
    seat: { id: string; name: string }; identity: { cooId: string; cooSecret: string };
  }>('play', { takeover, name });
  const query = new URLSearchParams({ room: joined.room });
  if (joined.tableId) {
    query.set('view', 'table');
    query.set('table', joined.tableId);
  }
  history.replaceState(history.state, '', '/play?' + query);
  saveSeat({ room: joined.room, token: joined.token, guest: joined.guest, seatId: joined.seat.id, name: joined.seat.name, ...joined.identity });
}

export async function logoutWebPlayer(): Promise<void> {
  const token = seat.value?.token;
  try {
    await webPlayerRequest('logout', {});
  } catch (cause) {
    if (!uncertainWebResult(cause)) throw cause;
    const signedOut = await webPlayerRequest('me').then(() => false,
      error => error instanceof ApiError && error.status === 401);
    if (!signedOut) throw cause;
  }
  if (token?.startsWith('web_') && seat.value?.token === token) clearSeat();
}
