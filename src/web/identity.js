/** 身份只保存在统一服务的源下；跨站跳转只携带目标专用的临时通行证。 */
const status = document.getElementById('status');
const retry = document.getElementById('retry');
retry.addEventListener('click', enter);
enter();
async function enter() {
  retry.hidden = true;
  try {
    const args = new URLSearchParams(location.search);
    const target = new URL(args.get('returnTo') || '');
    if (target.username || target.password || target.hash || !['/play','/play/'].includes(target.pathname)
      || (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(target.hostname)))) {
      throw new Error('客厅返回地址不对');
    }
    const state = args.get('state');
    if (!/^[a-f0-9]{32}$/.test(state || '')) throw new Error('请从客厅的加入入口打开');
    let identity = JSON.parse(localStorage.getItem('parlor-global-player') || 'null');
    if (!identity) {
      const old = JSON.parse(localStorage.getItem('parlor-play-v1') || 'null');
      if (old?.cooId && typeof old.cooSecret === 'string' && old.cooSecret.length >= 16) {
        identity = { cooId: old.cooId, cooSecret: old.cooSecret, name: old.name || '家长' };
        localStorage.setItem('parlor-global-player', JSON.stringify(identity));
      }
    }
    if (!identity) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      identity = { cooId: crypto.randomUUID(), cooSecret: Array.from(bytes, b => b.toString(16).padStart(2,'0')).join(''),
        name: (args.get('name') || '家长').slice(0,24) };
      localStorage.setItem('parlor-global-player', JSON.stringify(identity));
    }
    const response = await fetch('/v1/identity/session', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({ ...identity, kind: 'human', useParent: true, audience: target.origin }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '暂时无法准备身份');
    target.hash = new URLSearchParams({ identity: body.token, state }).toString();
    location.replace(target.href);
  } catch (error) { status.textContent = error.message || '连接失败'; retry.hidden = false; }
}
