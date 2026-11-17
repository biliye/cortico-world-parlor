/** 服务器形态判断：不碰 DOM，服务端测试与网页共用。 */

/**
 * 只有多客厅网关提供对外首页（/）。单客厅服务器（serve.ts）只发 /play 与
 * /play/assets/**，`GET /` 是 404，同一份 Vue 产物在那边不能给出回首页的入口。
 *
 * 判据用 healthz 里有没有 rooms 字段，和 api/client.ts 的房间路径探测同一条，
 * 不靠请求 `/` 拿 404 去猜。**只回答「这份 healthz 是不是网关的」**；拿不到
 * healthz 是另一种情况，交给 gatewayOf 判成未确认，别在这里当成单厅。
 */
export function isGatewayServer(health: unknown): boolean {
  if (!health || typeof health !== 'object') return false;
  return typeof (health as { rooms?: unknown }).rooms === 'number';
}

/**
 * 三态结论：true 网关 / false 单厅 / null 未确认。
 *
 * healthz 没拿到（网关重启中的 503、断网、响应不是 JSON）**不算**「不是网关」：
 * 把它当单厅缓存下来，服务恢复后要刷新页面链接才回来。拿不到就保持未确认，
 * 由 stores/server.ts 退避重试，任何一次交互探测也能把它救回来。
 */
export function gatewayOf(health: unknown): boolean | null {
  if (health === null || health === undefined) return null;
  return isGatewayServer(health);
}

/** 首屏探测失败的退避节奏；用完就只剩交互触发（打开账户弹窗、点「再试一次」）。 */
export const GATEWAY_RETRY_DELAYS = [2_000, 4_000, 8_000, 16_000, 30_000];

export interface GatewaySettlement {
  /** true 网关 / false 单厅 / null 未确认。 */
  value: boolean | null;
  /** 未确认时下一次自动重试等多久；null = 不再自动重试。 */
  retryIn: number | null;
}

/**
 * 一次探测怎么落账：拿到 healthz 才下结论，拿不到留未确认并给出重试间隔。
 * 网页侧（stores/server.ts）只负责把 value 写进 ref、按 retryIn 起表。
 */
export function gatewaySettlement(health: unknown, retryAttempt = 0): GatewaySettlement {
  const value = gatewayOf(health);
  if (value !== null) return { value, retryIn: null };
  return { value: null, retryIn: GATEWAY_RETRY_DELAYS[retryAttempt] ?? null };
}
