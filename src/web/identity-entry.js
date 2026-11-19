/** 把入场参数留在当前浏览器，从统一身份服务回到 /play 时再换席位。 */
export function beginGlobalEntry(authority, input, returnTo = location.origin + location.pathname + location.search) {
  const target = new URL(authority);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && local)) throw new Error('身份服务需要 HTTPS');
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  sessionStorage.setItem('parlor-identity-pending', JSON.stringify({ ...input, state: nonce }));
  target.pathname = '/identity';
  target.search = new URLSearchParams({ returnTo, state: nonce, name: input.name || '' }).toString();
  location.assign(target.href);
}
