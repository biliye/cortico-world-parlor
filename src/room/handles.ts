/**
 * 人的短号：cooId 的前 8 位，给人看、给人念、给人抄。
 *
 * 短号不是新身份，只是 cooId 的前缀：完整 cooId 永远有效；两个 id 撞前缀时
 * 由调用方列出候选，不建唯一约束、不加列。
 */
export const HANDLE_LENGTH = 8;

/** cooId 的字符集（与 ledger.ts 的 COO_ID 一致），前缀长度 8–64。 */
const HANDLE_QUERY = /^[A-Za-z0-9_-]{8,64}$/;

export const shortHandle = (cooId: string): string => cooId.slice(0, HANDLE_LENGTH).toLowerCase();

/**
 * 把「#270fed72」或「#<完整 cooId>」解析成小写前缀；不是号（没 #、太短、
 * 夹了别的字符）返回 null。全角＃也认。
 */
export const parseHandleQuery = (value: string): string | null => {
  const text = value.trim().replace(/^＃/, '#');
  if (!text.startsWith('#')) return null;
  const rest = text.slice(1).toLowerCase();
  return HANDLE_QUERY.test(rest) ? rest : null;
};

/** LIKE 前缀匹配的转义：cooId 里可能出现 `_`，它本身是通配符。 */
export const likePrefix = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);
