/** 网页客户端用到的服务器形状。只放 Vue 侧确实读到的字段，避免和服务端类型脱节。 */

export interface SeatConfig {
  room: string;
  seatId: string;
  name: string;
  token: string;
  cooId: string;
  cooSecret: string;
}

export interface Health {
  guestJoin?: boolean;
  globalIdentity?: { authority: string } | null;
  /** 多客厅服务器才有；单客厅服务器（serve.ts）没有这个字段。 */
  rooms?: number;
}

export interface HallSeat {
  id: string;
  name: string;
  kind: string;
  handle?: string;
}

export interface RoomCard {
  id: string;
  name: string;
  topic?: string;
  visibility: 'public' | 'unlisted' | 'private' | string;
  seats: number;
  capacity: number;
  tableCount?: number;
  games?: string[];
  mine?: boolean;
  archived?: boolean;
}

export interface Snapshot {
  id: string;
  name?: string;
  topic?: string;
  visibility?: string;
  now: number;
  latest: number;
  seat?: { id: string; name: string };
  seats?: HallSeat[];
  maxSeats?: number;
  online?: string[];
  tables?: TableSummary[];
  table?: TableSummary | null;
  tablePrivate?: { tableId?: string; id?: string; revision?: number } | null;
  ledger?: Record<string, unknown>;
}

export interface TableSeat {
  id: string;
  name: string;
  kind?: string;
  bot?: boolean;
}

export interface TableSummary {
  startBlockers?: string[];
  requireHuman?: boolean;
  capacity?: number;
  matchOpen?: boolean;
  recruitText?: string;
  recruitAuthor?: string;
  tableId?: string;
  id?: string;
  game: string;
  status: string;
  label?: string;
  text?: string;
  host?: string;
  seats?: TableSeat[];
  turn?: string;
  deadline?: number;
  stake?: number;
  multiplier?: number;
  round?: number;
  rounds?: number;
  revision?: number;
}

export interface Directory {
  rooms?: RoomCard[];
}

export interface HallPayload {
  hall?: { seats?: HallSeat[] };
  recruitments?: import('../../src/room/table-discovery-db.ts').TableRecruitment[];
}

export interface JoinResult {
  room: string;
  seat: { id: string; name: string };
  token: string;
  identity: { cooId: string; cooSecret: string };
}

/** 聊天栏要用的那几格；其余字段原样保留，不影响判断。 */
export interface ChatEvent {
  seq?: number;
  ts?: number;
  type?: string;
  from?: string;
  text?: string;
  data?: { name?: string; tableId?: string; presenceWeb?: boolean; presenceCoo?: boolean };
}
