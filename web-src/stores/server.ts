/**
 * 当前页面由哪种服务器提供 —— 只有多客厅网关才有对外首页（/）。
 *
 * 入场页与账户弹窗共用这一份：单厅里两边都不渲染回首页的控件，
 * 免得同一页出现两条通往 404 的链接。
 */
import { ref } from 'vue';
import { fetchHealth } from '../api/client.ts';
import { isGatewayServer } from '../lib/gateway.ts';

/** null = 还没探到。渲染上按「不是网关」处理，不先闪一个会 404 的链接。 */
export const gateway = ref<boolean | null>(null);

let task: Promise<boolean> | undefined;

/** 一次会话只探一次；同时调用共用同一个请求。 */
export function detectGateway(): Promise<boolean> {
  if (gateway.value !== null) return Promise.resolve(gateway.value);
  task ??= fetchHealth()
    .then(health => (gateway.value = isGatewayServer(health)))
    .finally(() => { task = undefined; });
  return task;
}
