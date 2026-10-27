/**
 * 回放：把房间事件按时间线留 7 天，给「赛后回看」用。
 *
 * 房间日志（room.json）只留最近 500 条，会被滚掉；回放单独落一个
 * `replay.jsonl`（每行一条 JSON，0600），只追加、按 seq 去重。
 * 读的时候仍然按可见性过滤：公开事件谁都能看，seat 事件只有那个席位
 * （和它的家长页）能看。运营者能直接读服务器上的文件。
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { serverClock } from './clock.ts';
import type { RoomEvent, Scope } from './protocol.ts';

/** 回放留 7 天；另外留一个安全上限，防止有人在 7 天里刷出无限多条。 */
export const REPLAY_RETENTION_DAYS = 7;
export const REPLAY_RETENTION_MS = REPLAY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const REPLAY_MAX_EVENTS = 50_000;

export interface ReplayEventView {
  seq: number;
  ts: number;
  /** 服务器时刻，给「哪条先哪条后」一个可信的锚点。 */
  at: string;
  type: string;
  from: string;
  text: string;
  data?: Record<string, unknown>;
}

export interface ReplayPage {
  events: ReplayEventView[];
  /** 还有更早的、这段没取完的可见事件。 */
  older: boolean;
}

export interface ReplayStoreOptions {
  file?: string;
  now?: () => number;
  retentionMs?: number;
  maxEvents?: number;
}

const isScope = (value: unknown): value is Scope => {
  if (!value || typeof value !== 'object') return false;
  const scope = value as Partial<Scope>;
  return scope.kind === 'room'
    || (scope.kind === 'seat' && typeof (scope as { seatId?: unknown }).seatId === 'string');
};

const isRecord = (value: unknown): value is RoomEvent => {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<RoomEvent>;
  return typeof event.seq === 'number'
    && Number.isFinite(event.seq)
    && typeof event.ts === 'number'
    && Number.isFinite(event.ts)
    && typeof event.type === 'string'
    && typeof event.from === 'string'
    && typeof event.text === 'string'
    && isScope(event.scope);
};

const view = (event: RoomEvent): ReplayEventView => ({
  seq: event.seq,
  ts: event.ts,
  at: serverClock(event.ts),
  type: event.type,
  from: event.from,
  text: event.text,
  ...(event.data ? { data: event.data } : {}),
});

export class ReplayStore {
  private records: RoomEvent[] = [];
  private readonly file?: string;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maxEvents: number;
  private lastSeq = 0;
  private lastPrune = 0;

  constructor(options: ReplayStoreOptions = {}) {
    this.file = options.file;
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? REPLAY_RETENTION_MS;
    this.maxEvents = options.maxEvents ?? REPLAY_MAX_EVENTS;
  }

  static load(options: ReplayStoreOptions = {}): ReplayStore {
    const store = new ReplayStore(options);
    if (!options.file || !existsSync(options.file)) return store;
    let changed = false;
    try {
      const seen = new Set<number>();
      const records: RoomEvent[] = [];
      for (const line of readFileSync(options.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { changed = true; continue; }
        if (!isRecord(parsed) || seen.has(parsed.seq)) { changed = true; continue; }
        seen.add(parsed.seq);
        records.push(parsed);
      }
      records.sort((left, right) => left.seq - right.seq);
      store.records = records;
      store.lastSeq = records.at(-1)?.seq ?? 0;
      changed = store.prune(store.now()) || changed;
      if (changed) store.rewrite();
    } catch { /* 坏文件从空回放开始，不阻断房间 */ }
    return store;
  }

  /** 房间数据里还留着的事件（重启或崩溃后补进回放）。 */
  seed(events: readonly RoomEvent[]): void {
    const cutoff = this.now() - this.retentionMs;
    for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
      if (event.seq <= this.lastSeq || event.ts < cutoff) continue;
      this.append(event);
    }
  }

  append(event: RoomEvent): void {
    if (!isRecord(event) || event.seq <= this.lastSeq) return;
    this.records.push(event);
    this.lastSeq = event.seq;
    this.save(event);
    const now = this.now();
    if (now - this.lastPrune >= 3_600_000) {
      this.lastPrune = now;
      if (this.prune(now)) this.rewrite();
    }
  }

  /** 某个席位能看的回放：公开 + 自己的私密；按 seq 升序，`before` 之前的部分。 */
  page(seatId: string, limit = 100, before?: number): ReplayPage {
    const count = Math.max(1, Math.min(500, Math.trunc(limit) || 100));
    const upto = before && before > 0 ? before : Number.POSITIVE_INFINITY;
    const visible = this.records.filter((event) => (
      event.seq < upto
      && (event.scope.kind === 'room' || event.scope.seatId === seatId)
    ));
    const picked = visible.slice(-count);
    return {
      events: picked.map(view),
      older: visible.length > picked.length,
    };
  }

  count(): number {
    return this.records.length;
  }

  /** 房间数据被清空重建时，旧回放的序号对不上，整份作废。 */
  reset(): void {
    this.records = [];
    this.lastSeq = 0;
    this.rewrite();
  }

  span(): { from: number; to: number } | null {
    if (this.records.length === 0) return null;
    return { from: this.records[0].ts, to: this.records[this.records.length - 1].ts };
  }

  /** 丢掉超过保留期与超过上限的最旧记录；返回有没有变化。 */
  private prune(now: number): boolean {
    const cutoff = now - this.retentionMs;
    const kept = this.records.filter((event) => event.ts >= cutoff);
    const capped = kept.length > this.maxEvents ? kept.slice(-this.maxEvents) : kept;
    const changed = capped.length !== this.records.length;
    this.records = capped;
    return changed;
  }

  private save(event: RoomEvent): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
      chmodSync(this.file, 0o600);
    } catch { /* 回放写不进去不阻断房间 */ }
  }

  private rewrite(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const body = this.records.map((event) => JSON.stringify(event)).join('\n');
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, body ? `${body}\n` : '', { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.file);
      chmodSync(this.file, 0o600);
    } catch { /* 回放写不进去不阻断房间 */ }
  }
}
