const HOUR_MS = 3_600_000;
const BURST = 3;

/** 普通闲聊的投递额度：平滑恢复，另守住滚动一小时的硬上限。 */
export class AmbientWakeBudget {
  // 用整数额度避免浮点误差把恰好到期的恢复时间再推迟一毫秒。
  private credit = BURST * HOUR_MS;
  private lastRefill?: number;
  private lastRate?: number;
  private readonly sent: number[] = [];

  /** 0 表示已预留一次额度；否则返回最早可重试的毫秒数。预留过程不跨 await。 */
  reserve(perHour: number, now: number): number {
    if (perHour <= 0) return Infinity;
    const at = Math.max(now, this.lastRefill ?? now);
    if (this.lastRefill !== undefined) {
      this.credit = Math.min(BURST * HOUR_MS, this.credit + (at - this.lastRefill) * this.lastRate!);
    }
    this.lastRefill = at;
    this.lastRate = perHour;
    while (this.sent.length && this.sent[0] <= at - HOUR_MS) this.sent.shift();
    const tokenWait = this.credit >= HOUR_MS ? 0 : Math.ceil((HOUR_MS - this.credit) / perHour);
    const windowWait = this.sent.length < perHour ? 0 : this.sent[this.sent.length - perHour] + HOUR_MS - at;
    const wait = Math.max(tokenWait, windowWait);
    if (wait > 0) return wait;
    this.credit -= HOUR_MS;
    this.sent.push(at);
    return 0;
  }
}
