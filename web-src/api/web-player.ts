import { clearSeat, saveSeat, seat } from '../stores/session.ts';

export type WebPlayer = { name: string; guest: boolean; expiresAt: number; seated: boolean };

export async function webPlayerRequest<T>(path: string, body?: Record<string, unknown>, token?: string): Promise<T> {
  const response = await fetch('/v1/web/' + path, {
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '会馆请求失败');
  return data as T;
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
  await webPlayerRequest('logout', {});
  if (seat.value?.token.startsWith('web_')) clearSeat();
}
