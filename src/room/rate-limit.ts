interface RateWindow {
  ms: number;
  limit: number;
}

/** 进程内滑动窗口。容量耗尽时拒绝新键，保留仍在窗口内的计数。 */
export class SlidingRateLimit {
  private readonly entries = new Map<string, number[]>();
  private readonly window: RateWindow;
  private readonly burst?: RateWindow;
  private readonly capacity: number;
  private nextSweep = 0;

  constructor(capacity: number, window: RateWindow, burst?: RateWindow) {
    this.capacity = capacity;
    this.window = window;
    this.burst = burst;
  }

  take(key: string, now: number): boolean {
    const cutoff = now - this.window.ms;
    if (now >= this.nextSweep) {
      for (const [id, times] of this.entries) {
        if (times[times.length - 1]! <= cutoff) this.entries.delete(id);
      }
      this.nextSweep = now + 1_000;
    }
    if (!this.entries.has(key) && this.entries.size >= this.capacity) return false;
    const recent = (this.entries.get(key) ?? []).filter(time => time > cutoff);
    if (recent.length >= this.window.limit) return false;
    const burst = this.burst;
    if (burst && recent.filter(time => time > now - burst.ms).length >= burst.limit) return false;

    recent.push(now);
    this.entries.set(key, recent);
    return true;
  }
}
