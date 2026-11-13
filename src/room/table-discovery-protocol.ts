export interface TableRecruitment {
  tableId: string;
  room: string;
  roomName: string;
  game: string;
  label: string;
  seats: number;
  capacity: number;
  full: boolean;
  text: string;
  author: string;
  updatedAt: number;
  link: string;
  /** 这张桌是否也开着快速匹配；招募与匹配相互独立，可以同时为真。 */
  matchOpen: boolean;
  /**
   * 招募版本：只有招募内容或开放状态实际变化时才递增，人数变化不算。
   * 同厅事件与 inbox 搭车共用它做去重，避免「关掉再打开」回到旧键被误判已提示。
   */
  recruitVersion: number;
}

export interface TableEntryInput {
  requestId: string;
  game?: string;
  room?: string;
  table?: string;
}

export interface TableEntryResult {
  ok: true;
  matched: true;
  room: string;
  roomName: string;
  seat: { id: string; name: string; kind?: string; tier?: string };
  token: string;
  tableId: string;
  revision: number;
  seq: number;
  joinSeq: number;
}

export type TableEntryResponse = TableEntryResult | { ok: true; matched: false };

/** 同一链接供网页与 Coo 使用；拒绝跨服务器、凭证及非牌桌路径。 */
export function parseTableLink(link: string, baseUrl: string): { room: string; table: string } {
  const base = new URL(baseUrl);
  const target = new URL(link, base);
  if (target.origin !== base.origin || target.username || target.password || target.hash || target.pathname !== '/play') {
    throw new Error('请使用当前客厅服务器的牌桌分享链接');
  }
  const room = target.searchParams.get('room') || '';
  const table = target.searchParams.get('table') || '';
  if (target.searchParams.get('view') !== 'table' || !/^[\w-]{1,64}$/.test(room) || !/^t-[\w-]{1,80}$/.test(table)) {
    throw new Error('分享链接缺少有效的客厅号或桌号');
  }
  if ([...target.searchParams.keys()].some((key) => !['room', 'view', 'table'].includes(key))) {
    throw new Error('牌桌分享链接不能携带身份或额外参数');
  }
  return { room, table };
}
