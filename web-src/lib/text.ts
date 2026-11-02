/** 服务器旧文案的统一替换（只改显示，不改事件本身）。与 common.js 的 RENAME 一致。 */
const RENAME: Record<string, string> = {
  底池: '彩头',
  底注: '每局',
  今晚净胜: '今晚的小收获',
  净胜: '小收获',
};

export function readable(text: unknown): string {
  let out = String(text ?? '');
  for (const [from, to] of Object.entries(RENAME)) out = out.split(from).join(to);
  return out;
}

/** 服务器时刻（UTC+8）的 HH:MM。 */
export function clockText(ts?: number): string {
  if (!ts) return '';
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(11, 16);
}

/** 服务器时刻（UTC+8）的 MM-DD HH:MM；邀请到期这类跨天时间用它。 */
export function dateTimeText(ts?: number): string {
  if (!ts) return '';
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');
}

export function initialOf(name: unknown): string {
  const chars = Array.from(String(name || '？').trim());
  return chars[0] || '？';
}
