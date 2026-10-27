/** 客厅线协议：席位、可见性 scope、事件与唤醒判定。线协议与服务器、World 共用。 */
import type { LedgerEntryView, LedgerSummary } from './ledger.ts';
import type { TableGame, TablePrivateSummary, TableSummary } from './table-engine.ts';

export type SeatKind = 'pet' | 'human' | 'observer';
export type WakeTier = 'full' | 'digest' | 'quiet' | 'off';

export const WAKE_TIERS: readonly WakeTier[] = ['full', 'digest', 'quiet', 'off'];
export const DEFAULT_WAKE_TIER: WakeTier = 'digest';

export const WAKE_TIER_LABELS: Readonly<Record<WakeTier, string>> = {
  full: '热闹',
  digest: '摘要',
  quiet: '只 @',
  off: '离开',
};

export interface Seat {
  id: string;
  name: string;
  kind: SeatKind;
  tier: WakeTier;
  joinedAt: number;
}

/** 一条事件能被谁看见。房间公开、或只给某一个席位。 */
export type Scope = { kind: 'room' } | { kind: 'seat'; seatId: string };

export interface RoomEvent {
  /** 房间内单调递增的游标，用来补看与断线重连。 */
  seq: number;
  ts: number;
  type: string;
  /** 发件席位 id；系统事件是 `system`。 */
  from: string;
  scope: Scope;
  text: string;
  mentions?: string[];
  data?: Record<string, unknown>;
}

export interface JoinRequest {
  name: string;
  kind?: SeatKind;
  tier?: WakeTier;
}

export interface JoinResponse {
  room: string;
  seat: Seat;
  token: string;
  ownerToken: string;
  maxSeats: number;
}

export type ActionRequest =
  | { type: 'say'; text: string }
  | { type: 'whisper'; to: string; text: string }
  | { type: 'set_tier'; tier: WakeTier }
  | { type: 'gift'; to: string; text: string; chips?: number }
  | { type: 'promise'; to: string; text: string; due?: number | string; chips?: number }
  | { type: 'respond'; id: string; action: 'accept' | 'decline' | 'done' | 'cancel' }
  | { type: 'table_open'; game?: TableGame; stake?: number }
  | { type: 'table_join' }
  | { type: 'table_start' }
  | { type: 'table_action'; action: 'roll' | 'stand'; die?: number }
  | { type: 'ddz_action'; move: 'bid' | 'play' | 'pass'; call?: boolean; cards?: string[] };

export interface ActionResponse {
  ok: true;
  seq: number;
}

export interface RoomSnapshot {
  id: string;
  /** 调用者自己的席位。 */
  seat: Seat;
  seats: Seat[];
  maxSeats: number;
  /** 房间当前最新游标。 */
  latest: number;
  /** `since` 之后对调用者可见的事件。 */
  events: RoomEvent[];
  /** 当前有推送连接（SSE）的席位 id。 */
  online?: string[];
  /** 房间里的桌子（公开视图，不含别人的隐藏信息）。 */
  table?: TableSummary;
  /** 调用者在桌上的私视图；不在桌上时为 null。 */
  tablePrivate?: TablePrivateSummary | null;
  /** 调用者自己的账本摘要（按 cooId 算）。 */
  ledger?: LedgerSummary;
  /** 本房最近的公开账本条目；不含别人的 cooId。 */
  ledgerRoom?: LedgerEntryView[];
  /** 自己信箱里的未读封数。 */
  mailUnread?: number;
}

export interface WakeDecision {
  wake: boolean;
  addressed: boolean;
  reason: 'mention' | 'whisper' | 'room' | 'quiet' | 'off' | 'observer';
}

/** 事件是否直接指向这个席位（私聊、或被 @）。 */
export function isAddressed(event: RoomEvent, seatId: string): boolean {
  if (event.scope.kind === 'seat') return event.scope.seatId === seatId;
  return event.mentions?.includes(seatId) ?? false;
}

/**
 * 单条事件要不要立刻叫醒这个席位。
 * `digest` 的公开闲聊返回 false，由 World 攒成周期摘要；`quiet` 连摘要也不叫。
 */
export function decideWake(event: RoomEvent, seat: Seat): WakeDecision {
  if (seat.kind === 'observer') return { wake: false, addressed: false, reason: 'observer' };
  if (seat.tier === 'off') return { wake: false, addressed: false, reason: 'off' };
  const addressed = isAddressed(event, seat.id);
  if (addressed) {
    return { wake: true, addressed: true, reason: event.scope.kind === 'seat' ? 'whisper' : 'mention' };
  }
  if (seat.tier === 'full') return { wake: true, addressed: false, reason: 'room' };
  return { wake: false, addressed: false, reason: seat.tier === 'quiet' ? 'quiet' : 'room' };
}
