export const GLOBAL_HEADER = 'x-parlor-identity';
export interface GlobalPerson { cooId: string; handle: string; name: string; kind: 'pet' | 'human' }
export interface IdentityTicket { token: string; expiresAt: number; person: GlobalPerson }

/** 只接受 HTTPS；本机联调允许 HTTP。禁止凭证随重定向流向其他地址。 */
export function identityOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('身份服务/服务器地址必须是源地址');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('全局身份需要 HTTPS（本机测试除外）');
  }
  return url.origin;
}

export async function identityRequest<T>(origin: string, path: string, body: unknown, token?: string): Promise<T> {
  const url = `${identityOrigin(origin)}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', ...(token ? { [GLOBAL_HEADER]: token } : {}) },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new Error('身份服务暂时无法连接，请稍后重试；新的身份验证或入座需要等它恢复。', { cause });
  }
  if (response.status >= 500) throw new Error(`身份服务暂时不可用（HTTP ${response.status}），请稍后重试。`);
  if (!response.ok) throw new Error(`身份服务 HTTP ${response.status}`);
  return await response.json() as T;
}
