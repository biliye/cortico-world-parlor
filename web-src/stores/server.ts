/**
 * 当前页面由哪种服务器提供 —— 只有多客厅网关才有对外首页（/）。
 *
 * 入场页与账户弹窗共用这一份：单厅里两边都不渲染回首页的控件，
 * 免得同一页出现两条通往 404 的链接。
 *
 * 探测失败（网关重启中的 503、断网、响应不是 JSON）不当作结论：gateway 保持
 * null，页面先按「不是网关」渲染，同时退避重试；服务回来后入口自己出现，
 * 不用刷新页面。任何一次交互再次调用 detectGateway() 也会重新探。
 */
import { ref } from 'vue';
import { fetchHealth } from '../api/client.ts';
import { gatewaySettlement } from '../lib/gateway.ts';

/** null = 还没探到（渲染上按「不是网关」处理，不先闪一个会 404 的链接）。 */
export const gateway = ref<boolean | null>(null);

let task: Promise<boolean | null> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let attempt = 0;

/** 一次会话只认一次结论；同时调用共用同一个请求，未确认时调用会重试。 */
export function detectGateway(): Promise<boolean | null> {
  if (gateway.value !== null) return Promise.resolve(gateway.value);
  task ??= fetchHealth()
    .then(health => {
      const { value, retryIn } = gatewaySettlement(health, attempt);
      // 没拿到 healthz：保持未确认，别把这次抖动钉成「单厅」。
      if (value === null) {
        if (retryIn !== null) { attempt += 1; scheduleRetry(retryIn); }
        return null;
      }
      gateway.value = value;
      if (timer) { clearTimeout(timer); timer = undefined; }
      return value;
    })
    .finally(() => { task = undefined; });
  return task;
}

function scheduleRetry(delay: number): void {
  if (timer) return;
  timer = setTimeout(() => { timer = undefined; void detectGateway(); }, delay);
}
