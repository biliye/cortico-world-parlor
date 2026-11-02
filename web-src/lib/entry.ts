/** 入场链接的纯解析：不碰 DOM，服务端测试与网页共用。 */

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
