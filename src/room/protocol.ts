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
  | { type: 'ddz_action'; move: 'bid' | 'play' | 'pass'; call?: boolean; cards?: string[] }
  | {
    type: 'monopoly';
    action: 'open' | 'join' | 'leave' | 'cancel' | 'start' | 'set_auto'
      | 'roll' | 'use_item' | 'buy' | 'upgrade' | 'take_item' | 'pass';
    /** open / start：4 或 6 席。 */
    size?: number;
    /** open：standard（30 分钟/回合）或 quick（5 分钟）。 */
    pace?: string;
    /** open / start：补几个脚本陪练。 */
    bots?: number;
    /** set_auto。 */
    on?: boolean;
    /** use_item / take_item：signpost、pass、repair。 */
    item?: string;
    /** use_item(signpost)：向前几格。 */
    steps?: number;
    /** use_item(repair)：哪块地。 */
    target?: number;
    /** 客户端生成，网络重试必须复用同一个。 */
    requestId?: string;
    /** 动作是基于哪一回合的视图（表子的 turnSeq）。 */
    turnId?: number;
  };

/** 一条东西已经留进某个席位的信箱；只给寄信人看「已投递」，不给已读。 */
export interface DeliveryReceipt {
  /** 收件人的显示名（不是 cooId）。 */
  to: string;
  /** 信箱里的序号；不暴露收件人身份。 */
  mailSeq: number;
  ts: number;
  /** 服务器时刻。 */
  at: string;
}

export interface ActionResponse {
  ok: true;
  /** 服务器处理完这次动作后的房间游标。 */
  seq: number;
  ts: number;
  /** 服务器时刻（UTC+8），让「发了≠到了」有一个共同锚点。 */
  at: string;
  /** 私聊/礼物/承诺/回应：这些东西已经留进对方信箱。 */
  delivered?: DeliveryReceipt[];
  /** 开局那一刻现读的桌上席位名（含脚本陪练）。 */
  seats?: string[];
  /** 下一步的绝对截止时刻（服务器时钟）。 */
  deadline?: number;
  deadlineAt?: string;
  /** 下一个截止属于谁（显示名；脚本陪练也在内）。 */
  turn?: string;
  /** 大富翁动作之后本人看到的私视图；别的游戏不带。 */
  text?: string;
}

export interface RoomSnapshot {
  id: string;
  /** 调用者自己的席位。 */
  seat: Seat;
  seats: Seat[];
  maxSeats: number;
  /** 房间当前最新游标。 */
  latest: number;
  /** 服务器此刻的时钟（epoch ms）与显示值。 */
  now: number;
  at: string;
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
  /** 大富翁：报名表或活动存档的故障。 */
  monopoly?: MonopolyInfo;
}

/** 报名表：还没开局的大富翁。 */
export interface MonopolySignupView {
  /** 发起人显示名。 */
  host: string;
  /** 已报名的席位显示名，发起人在第一个。 */
  seats: string[];
  /** 目标人数（4 或 6）。 */
  size: number;
  pace: 'standard' | 'quick';
  /** 报名截止（服务器时刻）。 */
  deadlineAt: number;
  /** 还差几个真人；脚本陪练最多补 2 个。 */
  missing: number;
}

export interface MonopolyInfo {
  signup?: MonopolySignupView;
  /** 有值时这局被冻结：存档读不出来或写不进去，不会自动重开。 */
  fault?: string;
  gameId?: string;
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
