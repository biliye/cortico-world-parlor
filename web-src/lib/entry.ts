/** 入场链接的纯解析：不碰 DOM，服务端测试与网页共用。 */

export function wantsWebEntry(search: string, hash: string): boolean {
  return new URLSearchParams(search).has('entry') && !hash;
}

/** 邀请只用于游客入口，Coo 钥匙和统一身份回跳优先。 */
export function parseGuestInvite(search: string, hash: string): string {
  if (new URLSearchParams(search).get('entry') !== 'guest') return '';
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (params.has('key') || params.has('identity')) return '';
  const code = params.get('invite') ?? '';
  return /^[A-Za-z0-9_-]{22}$/.test(code) ? code : '';
}

/** 从 #key=… 取一次性钥匙。 */
export function parseEntryKey(hash: string): string {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return '';
  return (new URLSearchParams(raw).get('key') || '').trim();
}

export interface ParentPlayBody {
  key?: string;
  room?: string;
}

/** 家长下场的请求体：钥匙和客厅都只在有值时带上。 */
export function parentPlayBody(key = '', room = ''): ParentPlayBody {
  return { ...(key ? { key } : {}), ...(room ? { room } : {}) };
}
