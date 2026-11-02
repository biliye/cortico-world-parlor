/** 建客厅的固定参数与请求体：人数不再让玩家选，服务端仍按 30 收。 */

export const ROOM_CAPACITY = 30;

export type RoomVisibility = 'public' | 'unlisted' | 'private';

export interface CreateRoomBody {
  name: string;
  visibility: RoomVisibility;
  capacity: number;
}

export function createRoomBody(name: string, visibility: RoomVisibility): CreateRoomBody {
  return { name: name.trim(), visibility, capacity: ROOM_CAPACITY };
}
