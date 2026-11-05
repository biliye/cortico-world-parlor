/** 大厅只公开等人桌的招募信息，身份令牌只保存哈希。 */
export const TABLE_DISCOVERY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS table_discovery (
  table_id TEXT PRIMARY KEY REFERENCES tables(id) ON DELETE CASCADE,
  match_open INTEGER NOT NULL DEFAULT 0 CHECK (match_open IN (0,1)),
  recruit_text TEXT NOT NULL DEFAULT '',
  author_coo_id TEXT REFERENCES coos(id),
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS table_entry_receipts (
  coo_id TEXT NOT NULL REFERENCES coos(id),
  request_id TEXT NOT NULL,
  source_token_hash TEXT NOT NULL,
  result_token_hash TEXT NOT NULL,
  body_key TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (coo_id, request_id)
);
CREATE INDEX IF NOT EXISTS ix_table_entry_source ON table_entry_receipts(source_token_hash, request_id);
`;

export interface TableRecruitment {
  tableId: string;
  room: string;
  roomName: string;
  game: string;
  label: string;
  seats: number;
  capacity: number;
  full: boolean;
  stake: number;
  text: string;
  author: string;
  updatedAt: number;
  link: string;
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

/** 当前多客厅注册表中的四种桌；旧大富翁报名不混入快速匹配。 */
export const tableCapacity = (game: string): number => ({ dice: 4, ddz: 3, werewolf: 9, monopoly2d: 4, gomoku: 2 }[game] ?? 0);

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
