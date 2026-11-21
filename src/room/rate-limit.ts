import { createHmac, randomBytes } from 'node:crypto';

interface RateWindow {
  ms: number;
  limit: number;
}

interface RateOptions {
  burst?: RateWindow;
  overflowBuckets?: number;
}

/** 进程内滑动窗口，保留仍在窗口内的计数。可用固定数量的共享桶接纳超出容量的新键。 */
export class SlidingRateLimit {
  private readonly entries = new Map<string, number[]>();
  private readonly window: RateWindow;
  private readonly burst?: RateWindow;
  private readonly capacity: number;
  private readonly overflow?: { secret: Buffer; count: number; entries: Map<string, number[]> };
  private nextSweep = 0;

  constructor(capacity: number, window: RateWindow, { burst, overflowBuckets = 0 }: RateOptions = {}) {
    this.capacity = capacity;
    this.window = window;
    this.burst = burst;
    if (overflowBuckets > 0) this.overflow = { secret: randomBytes(16), count: overflowBuckets, entries: new Map() };
  }

  take(key: string, now: number): boolean {
    const cutoff = now - this.window.ms;
    if (now >= this.nextSweep) {
      this.sweep(this.entries, cutoff);
      if (this.overflow) this.sweep(this.overflow.entries, cutoff);
      this.nextSweep = now + 1_000;
    }
    if (this.entries.has(key)) return this.record(this.entries, key, now, cutoff);

    const full = this.entries.size >= this.capacity;
    const overflow = this.overflow;
    if (overflow && (full || overflow.entries.size > 0)) {
      const hash = createHmac('sha256', overflow.secret).update(key).digest().readUInt32BE(0);
      const bucket = String(hash % overflow.count);
      const last = overflow.entries.get(bucket)?.at(-1);
      // 普通表有空位时，仍留在活跃的共享桶直到其窗口过期，避免换桶重置额度。
      if (full || (last !== undefined && last > cutoff)) return this.record(overflow.entries, bucket, now, cutoff);
    }
    return !full && this.record(this.entries, key, now, cutoff);
  }

  private sweep(entries: Map<string, number[]>, cutoff: number): void {
    for (const [key, times] of entries) {
      if (times[times.length - 1]! <= cutoff) entries.delete(key);
    }
  }

  private record(entries: Map<string, number[]>, key: string, now: number, cutoff: number): boolean {
    const recent = (entries.get(key) ?? []).filter(time => time > cutoff);
    if (recent.length >= this.window.limit) return false;
    const burst = this.burst;
    if (burst && recent.filter(time => time > now - burst.ms).length >= burst.limit) return false;

    recent.push(now);
    entries.set(key, recent);
    return true;
  }
}
