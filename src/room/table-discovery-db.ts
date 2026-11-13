/** 大厅只公开等人桌的招募信息，身份令牌只保存哈希。 */
export const TABLE_DISCOVERY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS table_discovery (
  table_id TEXT PRIMARY KEY REFERENCES tables(id) ON DELETE CASCADE,
  match_open INTEGER NOT NULL DEFAULT 0 CHECK (match_open IN (0,1)),
  recruit_text TEXT NOT NULL DEFAULT '',
  author_coo_id TEXT REFERENCES coos(id),
  updated_at BIGINT NOT NULL,
  recruit_version BIGINT NOT NULL DEFAULT 0
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

/** 当前多客厅注册表中的四种桌；旧大富翁报名不混入快速匹配。 */
export const tableCapacity = (game: string): number => ({ dice: 4, ddz: 3, werewolf: 9, monopoly2d: 4, gomoku: 2, xiangqi: 2, aeroplane: 4 }[game] ?? 0);
