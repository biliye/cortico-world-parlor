/** 服务器形态判断：不碰 DOM，服务端测试与网页共用。 */

/**
 * 只有多客厅网关提供对外首页（/）。单客厅服务器（serve.ts）只发 /play 与
 * /play/assets/**，`GET /` 是 404，同一份 Vue 产物在那边不能给出回首页的入口。
 *
 * 判据用 healthz 里有没有 rooms 字段，和 api/client.ts 的房间路径探测同一条，
 * 不靠请求 `/` 拿 404 去猜。拿不到 healthz 时按单厅处理：宁可少一条入口，
 * 也不要给一条注定 404 的死链。
 */
export function isGatewayServer(health: unknown): boolean {
  if (!health || typeof health !== 'object') return false;
  return typeof (health as { rooms?: unknown }).rooms === 'number';
}
