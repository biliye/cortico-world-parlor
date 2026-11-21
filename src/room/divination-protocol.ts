export const DIVINATION_ROOM = 'divination';
export const DIVINATION_NAME = '问卦阁';
export const DIVINATION_CAPABILITY = 'divination-v1';

export function isDivinationRoom(room: { id: string; name: string; ownerCooId: string | null; visibility: string; archivedAt: number | null }): boolean {
  return room.id === DIVINATION_ROOM && room.name === DIVINATION_NAME && room.ownerCooId === 'system-owner'
    && room.visibility === 'public' && room.archivedAt === null;
}

export type LotGrade = '上上' | '上吉' | '中吉' | '中平' | '中下' | '下下';

export interface DivinationLot {
  number: number;
  grade: LotGrade;
  poem: string;
  advice: string;
  note: string;
}

export interface DivinationDraw {
  id: string;
  day: string;
  lot: DivinationLot;
  head: boolean;
  interpretation: string | null;
}

export interface DivinationBoardEntry {
  name: string;
  number: number;
  grade: LotGrade;
  head: boolean;
  time: number;
}

export interface DivinationChatMessage {
  seq: number;
  name: string;
  text: string;
  time: number;
}

export interface DivinationView {
  canDraw: boolean;
  canChat: boolean;
  draw: DivinationDraw | null;
  board: DivinationBoardEntry[];
  chat: DivinationChatMessage[];
}
