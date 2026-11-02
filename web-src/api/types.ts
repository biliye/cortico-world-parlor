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
  now: number;
  latest: number;
  seat?: { id: string; name: string };
  seats?: HallSeat[];
  maxSeats?: number;
  online?: string[];
}

export interface Directory {
  rooms?: RoomCard[];
}

export interface HallPayload {
  hall?: { seats?: HallSeat[] };
}

export interface JoinResult {
  room: string;
  seat: { id: string; name: string };
  token: string;
  identity: { cooId: string; cooSecret: string };
}
