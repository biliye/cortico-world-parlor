/**
 * 大富翁活动存档：长局唯一的一份真相。
 *
 * 三条硬要求，和骰子/斗地主那种一分钟的局不一样：
 * 1. 原子写：临时文件 + fsync + 改名，另留上一份 `.bak`；坏文件不静默当成空局。
 * 2. 动作去重：同一个 requestId 重发要拿回同一份回执，不能重掷、重扣、重耗卡。
 * 3. 待发副作用：账本战绩/信箱通知先写进存档，发完再清；各存储按键去重。
 *
 * 这里只管文件与数据形状；什么时候调用由内核与服务器决定。
 */
import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { MonopolyTableSnapshot } from './games/monopoly-table.ts';

export interface RequestRecord {
  /** `gameId/seatId/requestId`。 */
  key: string;
  /** 请求内容的摘要；同键不同内容要明确拒绝。 */
  hash: string;
  at: number;
  receipt: unknown;
}

export type EffectKind = 'ledger-result' | 'mail-turn' | 'mail-end' | 'mail-managed';

/** 一条待发副作用。`id` 在各接收存储里做幂等键。 */
export interface Effect {
  id: string;
  kind: EffectKind;
  payload: Record<string, unknown>;
}

export interface MonopolyActivity {
  schemaVersion: 1;
  roomId: string;
  /** 房间代次；房间被清空重建后旧活动不能串过来。 */
  roomEpoch: string;
  gameId: string;
  savedAt: number;
  table: MonopolyTableSnapshot;
  requests: RequestRecord[];
  /** 已经送到各存储的副作用 id（有上限，超了丢最旧的）。 */
  applied: string[];
  /** 写进存档但还没送达的副作用。 */
  outbox: Effect[];
  /**
   * 已经受理、还没完成提交的那一手：先写下发点（骰点在里面），再执行规则，
   * 执行完连同新状态一起落盘。崩溃后按它重放一次，就不会「换一次骰子再掷」。
   */
  pending?: {
    key: string;
    seatId: string;
    action: Record<string, unknown>;
    turnSeq: number;
    dice?: [number, number];
  };
}

export interface ActivityStoreOptions {
  file?: string;
  /** 去重记录最多留多少条。 */
  requestLimit?: number;
  appliedLimit?: number;
}

const DEFAULT_REQUEST_LIMIT = 512;
const DEFAULT_APPLIED_LIMIT = 500;

export const requestKeyOf = (gameId: string, seatId: string, requestId: string): string => `${gameId}/${seatId}/${requestId}`;

export const hashOf = (value: unknown): string => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');

export type LookupResult =
  | { kind: 'repeat'; receipt: unknown }
  | { kind: 'mismatch' }
  | { kind: 'new' };

const isActivity = (raw: unknown): raw is MonopolyActivity => {
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as Partial<MonopolyActivity>;
  if (value.schemaVersion !== 1) return false;
  if (typeof value.roomId !== 'string' || typeof value.gameId !== 'string') return false;
  if (typeof value.roomEpoch !== 'string' || typeof value.savedAt !== 'number') return false;
  if (!value.table || typeof value.table !== 'object') return false;
  return Array.isArray(value.requests) && Array.isArray(value.applied) && Array.isArray(value.outbox);
};

export class ActivityStore {
  private readonly file?: string;
  private readonly requestLimit: number;
  private readonly appliedLimit: number;

  constructor(options: ActivityStoreOptions = {}) {
    this.file = options.file;
    this.requestLimit = options.requestLimit ?? DEFAULT_REQUEST_LIMIT;
    this.appliedLimit = options.appliedLimit ?? DEFAULT_APPLIED_LIMIT;
  }

  get path(): string | undefined {
    return this.file;
  }

  get backupPath(): string | undefined {
    return this.file ? `${this.file}.bak` : undefined;
  }

  exists(): boolean {
    return !!this.file && existsSync(this.file);
  }

  /**
   * 读存档。坏文件先退到 `.bak`；两份都读不出来返回 null，但**不删文件**，
   * 由调用方决定是冻结活动还是让运营者处理。
   */
  load(): MonopolyActivity | null {
    if (!this.file) return null;
    const primary = this.readOne(this.file);
    if (primary) return primary;
    return this.readOne(`${this.file}.bak`);
  }

  /** 原子写：成功返回 true；失败不抛，调用方据此冻结活动而不是继续跑。 */
  save(activity: MonopolyActivity): boolean {
    if (!this.file) return false;
    const body = `${JSON.stringify(activity)}\n`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      const fd = openSync(temp, 'w', 0o600);
      try {
        writeSync(fd, body);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (existsSync(this.file)) copyFileSync(this.file, `${this.file}.bak`);
      renameSync(temp, this.file);
      chmodSync(this.file, 0o600);
      return true;
    } catch {
      return false;
    }
  }

  /** 正常结束并确认副作用都送达后可以清掉；运营动作，不在恢复路径里自动调用。 */
  remove(): void {
    if (!this.file) return;
    for (const path of [this.file, `${this.file}.bak`]) {
      try {
        if (existsSync(path)) renameSync(path, `${path}.ended`);
      } catch { /* 删不掉就留着，不阻断 */ }
    }
  }

  private readOne(path: string): MonopolyActivity | null {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return isActivity(raw) ? raw : null;
    } catch {
      return null;
    }
  }
}

// —— 去重与待发队列：纯函数，便于单测 ——

export function lookupRequest(activity: MonopolyActivity, key: string, hash: string): LookupResult {
  const found = activity.requests.find((entry) => entry.key === key);
  if (!found) return { kind: 'new' };
  if (found.hash !== hash) return { kind: 'mismatch' };
  return { kind: 'repeat', receipt: found.receipt };
}

export function rememberRequest(
  activity: MonopolyActivity,
  record: RequestRecord,
  limit = DEFAULT_REQUEST_LIMIT,
): void {
  const existing = activity.requests.findIndex((entry) => entry.key === record.key);
  if (existing >= 0) activity.requests[existing] = record;
  else activity.requests.push(record);
  if (activity.requests.length > limit) {
    activity.requests.splice(0, activity.requests.length - limit);
  }
}

export function queueEffect(activity: MonopolyActivity, effect: Effect): void {
  if (activity.applied.includes(effect.id)) return;
  if (activity.outbox.some((entry) => entry.id === effect.id)) return;
  activity.outbox.push(effect);
}

/** 送达成功的副作用从待发队列移入已应用，保持有界。 */
export function settleEffect(activity: MonopolyActivity, id: string, limit = DEFAULT_APPLIED_LIMIT): void {
  activity.outbox = activity.outbox.filter((entry) => entry.id !== id);
  if (!activity.applied.includes(id)) activity.applied.push(id);
  if (activity.applied.length > limit) {
    activity.applied.splice(0, activity.applied.length - limit);
  }
}

export function freshActivity(input: {
  roomId: string;
  roomEpoch: string;
  gameId: string;
  savedAt: number;
  table: MonopolyTableSnapshot;
}): MonopolyActivity {
  return {
    schemaVersion: 1,
    roomId: input.roomId,
    roomEpoch: input.roomEpoch,
    gameId: input.gameId,
    savedAt: input.savedAt,
    table: input.table,
    requests: [],
    applied: [],
    outbox: [],
  };
}
