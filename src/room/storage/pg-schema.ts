/**
 * PostgreSQL 的库结构。
 *
 * 与 SQLite 的 schema.ts 是同一批表、同一批业务约束，差别只在类型与方言：
 * - 毫秒时间戳一律 BIGINT（INTEGER 装不下 1970 年之后的毫秒）；
 * - 计数/序号/筹码用 INTEGER；布尔位（is_refill/is_bot/auto）用 SMALLINT + CHECK，
 *   不换成 BOOLEAN——客户端与 JSON 输出一直是 0/1，换类型要改三百多处比较；
 * - *_json 用 JSONB：查询里从不按字段过滤，只整块读写，JSONB 能校验且不丢数组顺序；
 * - 自增列用 identity（BY DEFAULT，迁移时要能带旧 id 导入），导入后统一校准序列；
 * - 名字的大小写不敏感比较改成 `lower(名字)` 表达式索引（SQLite 用 COLLATE NOCASE）。
 *
 * 迁移按版本号走：PG 有自己的一套编号，不沿用来源 SQLite 的 schema_version。
 */

import { NEWS_SCHEMA_SQL, SUPPORT_ADMIN_SCHEMA_SQL, SUPPORT_SCHEMA_SQL } from '../support-db.ts';
import { TABLE_DISCOVERY_SCHEMA_SQL } from '../table-discovery-db.ts';

export const PG_SCHEMA_VERSION = 11;

export const PG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coos (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('pet','human','legacy','system')),
  display_name TEXT NOT NULL DEFAULT '',
  secret_hash TEXT,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_coos_secret ON coos(secret_hash) WHERE secret_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  coo_id TEXT NOT NULL UNIQUE REFERENCES coos(id),
  player_coo_id TEXT REFERENCES coos(id),
  display_name TEXT NOT NULL,
  owner_key_hash TEXT NOT NULL UNIQUE,
  session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version >= 1),
  created_at BIGINT NOT NULL,
  last_login_at BIGINT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled'))
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('hall','room')),
  name TEXT NOT NULL,
  owner_coo_id TEXT REFERENCES coos(id),
  visibility TEXT NOT NULL CHECK (visibility IN ('public','unlisted','private')),
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 2 AND 500),
  topic TEXT,
  invite_code_hash TEXT,
  epoch TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0),
  created_at BIGINT NOT NULL,
  last_active_at BIGINT NOT NULL,
  archived_at BIGINT,
  CHECK (kind = 'hall' OR owner_coo_id IS NOT NULL),
  CHECK (kind = 'room' OR owner_coo_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_rooms_hall ON rooms(kind) WHERE kind = 'hall';
CREATE UNIQUE INDEX IF NOT EXISTS ux_rooms_invite ON rooms(invite_code_hash) WHERE invite_code_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_rooms_directory ON rooms(visibility, archived_at, last_active_at DESC);
CREATE INDEX IF NOT EXISTS ix_rooms_owner ON rooms(owner_coo_id);

CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  coo_id TEXT NOT NULL REFERENCES coos(id),
  joined_at BIGINT NOT NULL,
  removed_at BIGINT,
  PRIMARY KEY (room_id, coo_id)
);
CREATE INDEX IF NOT EXISTS ix_room_members_coo ON room_members(coo_id);

CREATE TABLE IF NOT EXISTS room_seats (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  coo_id TEXT NOT NULL REFERENCES coos(id),
  kind TEXT NOT NULL CHECK (kind IN ('pet','human','observer')),
  name TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('full','digest','quiet','off')),
  token_hash TEXT NOT NULL UNIQUE,
  legacy_owner_token_hash TEXT UNIQUE,
  joined_at BIGINT NOT NULL,
  last_seen_at BIGINT,
  released_at BIGINT,
  visible_from_seq INTEGER NOT NULL,
  visible_to_seq INTEGER,
  PRIMARY KEY (room_id, id),
  CHECK (visible_to_seq IS NULL OR visible_to_seq >= visible_from_seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_one_active_seat_per_coo
  ON room_seats(coo_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_room_seats_active ON room_seats(room_id, released_at);
CREATE INDEX IF NOT EXISTS ix_room_seats_coo ON room_seats(coo_id, joined_at);

CREATE TABLE IF NOT EXISTS account_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  session_version INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT,
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT
);
CREATE INDEX IF NOT EXISTS ix_account_sessions ON account_sessions(account_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS coo_sessions (
  coo_id TEXT PRIMARY KEY REFERENCES coos(id) ON DELETE CASCADE,
  session_version INTEGER NOT NULL DEFAULT 1,
  current_room_id TEXT,
  current_seat_id TEXT,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  FOREIGN KEY (current_room_id, current_seat_id) REFERENCES room_seats(room_id, id)
);

CREATE TABLE IF NOT EXISTS events (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  ts BIGINT NOT NULL,
  type TEXT NOT NULL,
  from_kind TEXT NOT NULL CHECK (from_kind IN ('seat','coo','system')),
  from_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('hall','room','table','seat')),
  scope_seat_id TEXT,
  scope_table_id TEXT,
  scope_seats_json JSONB,
  text TEXT NOT NULL,
  mentions_json JSONB,
  data_json JSONB,
  PRIMARY KEY (room_id, seq),
  CHECK (scope_kind <> 'table' OR scope_table_id IS NOT NULL),
  CHECK (scope_kind <> 'seat' OR scope_seat_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_events_ts ON events(room_id, ts);
CREATE INDEX IF NOT EXISTS ix_events_table ON events(room_id, scope_table_id) WHERE scope_table_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_events_seat ON events(room_id, scope_seat_id) WHERE scope_seat_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_audience (
  room_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  coo_id TEXT NOT NULL REFERENCES coos(id),
  seat_id TEXT,
  PRIMARY KEY (room_id, seq, coo_id),
  FOREIGN KEY (room_id, seq) REFERENCES events(room_id, seq) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_event_audience_coo ON event_audience(coo_id, room_id, seq);

CREATE TABLE IF NOT EXISTS ledger_entries (
  ord INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  ts BIGINT NOT NULL,
  room_id TEXT REFERENCES rooms(id),
  kind TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('room','private')),
  from_kind TEXT NOT NULL CHECK (from_kind IN ('coo','room')),
  from_coo_id TEXT REFERENCES coos(id),
  to_kind TEXT NOT NULL CHECK (to_kind IN ('coo','room','none')),
  to_coo_id TEXT REFERENCES coos(id),
  game TEXT,
  text TEXT NOT NULL,
  data_json JSONB,
  due_at BIGINT,
  ref_entry_id TEXT REFERENCES ledger_entries(id),
  effect_id TEXT,
  is_refill SMALLINT NOT NULL DEFAULT 0 CHECK (is_refill IN (0,1)),
  CHECK ((from_kind = 'coo') = (from_coo_id IS NOT NULL)),
  CHECK ((to_kind = 'coo') = (to_coo_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ledger_effect ON ledger_entries(effect_id) WHERE effect_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_ledger_grant_once
  ON ledger_entries(to_coo_id) WHERE kind = 'grant' AND is_refill = 0;
CREATE INDEX IF NOT EXISTS ix_ledger_room ON ledger_entries(room_id, visibility, ts);
CREATE INDEX IF NOT EXISTS ix_ledger_from ON ledger_entries(from_coo_id, ts);
CREATE INDEX IF NOT EXISTS ix_ledger_to ON ledger_entries(to_coo_id, ts);
CREATE INDEX IF NOT EXISTS ix_ledger_ref ON ledger_entries(ref_entry_id);
CREATE INDEX IF NOT EXISTS ix_ledger_social ON ledger_entries(from_coo_id, kind, ts);
CREATE INDEX IF NOT EXISTS ix_ledger_due ON ledger_entries(due_at) WHERE due_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS ledger_participants (
  entry_id TEXT NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  coo_id TEXT NOT NULL REFERENCES coos(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (entry_id, coo_id),
  UNIQUE (entry_id, position)
);
CREATE INDEX IF NOT EXISTS ix_ledger_participants_coo ON ledger_participants(coo_id, entry_id);

CREATE TABLE IF NOT EXISTS ledger_winners (
  entry_id TEXT NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  coo_id TEXT NOT NULL REFERENCES coos(id),
  PRIMARY KEY (entry_id, coo_id)
);
CREATE INDEX IF NOT EXISTS ix_ledger_winners_coo ON ledger_winners(coo_id, entry_id);

CREATE TABLE IF NOT EXISTS ledger_transfers (
  id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  from_kind TEXT NOT NULL CHECK (from_kind IN ('coo','room')),
  from_coo_id TEXT REFERENCES coos(id),
  to_kind TEXT NOT NULL CHECK (to_kind IN ('coo','room')),
  to_coo_id TEXT REFERENCES coos(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  CHECK ((from_kind = 'coo') = (from_coo_id IS NOT NULL)),
  CHECK ((to_kind = 'coo') = (to_coo_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_transfer_from ON ledger_transfers(from_coo_id);
CREATE INDEX IF NOT EXISTS ix_transfer_to ON ledger_transfers(to_coo_id);
CREATE INDEX IF NOT EXISTS ix_transfer_entry ON ledger_transfers(entry_id);

CREATE TABLE IF NOT EXISTS mail (
  seq INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  ts BIGINT NOT NULL,
  coo_id TEXT NOT NULL REFERENCES coos(id),
  from_coo_id TEXT REFERENCES coos(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  kind TEXT NOT NULL CHECK (kind IN ('whisper','gift','promise','ledger','invite')),
  action TEXT,
  from_name TEXT NOT NULL,
  text TEXT NOT NULL,
  entry_id TEXT REFERENCES ledger_entries(id),
  invitation_id TEXT,
  key TEXT,
  read_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_mail_key ON mail(key) WHERE key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_mail_unread ON mail(coo_id, read_at, seq);
CREATE INDEX IF NOT EXISTS ix_mail_room ON mail(coo_id, room_id, read_at, seq);
CREATE INDEX IF NOT EXISTS ix_mail_peer ON mail(coo_id, from_coo_id, seq);

CREATE TABLE IF NOT EXISTS tables (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  room_epoch TEXT NOT NULL,
  game TEXT NOT NULL CHECK (game IN ('dice','ddz','monopoly','werewolf')),
  status TEXT NOT NULL CHECK (status IN ('open','bidding','playing','ended','abandoned')),
  host_seat_id TEXT,
  stake INTEGER NOT NULL DEFAULT 0 CHECK (stake >= 0),
  state_json JSONB,
  engine_version TEXT,
  turn_seq INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  state_version INTEGER NOT NULL DEFAULT 0,
  deadline_at BIGINT,
  frozen_at BIGINT,
  recovery_error TEXT,
  created_at BIGINT NOT NULL,
  started_at BIGINT,
  ended_at BIGINT,
  end_reason TEXT,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (room_id, host_seat_id) REFERENCES room_seats(room_id, id)
);
CREATE INDEX IF NOT EXISTS ix_tables_room_status ON tables(room_id, status, created_at);

CREATE TABLE IF NOT EXISTS table_seats (
  table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  coo_id TEXT REFERENCES coos(id),
  position INTEGER NOT NULL,
  role TEXT,
  is_bot SMALLINT NOT NULL DEFAULT 0 CHECK (is_bot IN (0,1)),
  auto SMALLINT NOT NULL DEFAULT 0 CHECK (auto IN (0,1)),
  joined_at BIGINT NOT NULL,
  left_at BIGINT,
  PRIMARY KEY (table_id, seat_id),
  UNIQUE (table_id, position)
);
CREATE INDEX IF NOT EXISTS ix_table_seats_coo ON table_seats(coo_id, table_id);

CREATE TABLE IF NOT EXISTS active_table_players (
  coo_id TEXT PRIMARY KEY REFERENCES coos(id),
  table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  joined_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS action_receipts (
  coo_id TEXT NOT NULL REFERENCES coos(id),
  request_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  table_id TEXT,
  hash TEXT NOT NULL,
  receipt_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (coo_id, request_id)
);
CREATE INDEX IF NOT EXISTS ix_action_receipts_table ON action_receipts(table_id);

CREATE TABLE IF NOT EXISTS table_finalizations (
  table_id TEXT PRIMARY KEY REFERENCES tables(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('result','refund')),
  entry_id TEXT,
  at BIGINT NOT NULL,
  payload_json JSONB
);

CREATE TABLE IF NOT EXISTS room_access (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  coo_id TEXT NOT NULL REFERENCES coos(id),
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  source TEXT NOT NULL CHECK (source IN ('owner','invite','admin')),
  granted_by TEXT REFERENCES coos(id),
  granted_at BIGINT NOT NULL,
  revoked_at BIGINT,
  PRIMARY KEY (room_id, coo_id)
);
CREATE INDEX IF NOT EXISTS ix_room_access_coo ON room_access(coo_id, status);

CREATE TABLE IF NOT EXISTS room_invitations (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  invited_by TEXT NOT NULL REFERENCES coos(id),
  target_coo_id TEXT NOT NULL REFERENCES coos(id),
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','declined','revoked','expired')),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  handled_at BIGINT
);
CREATE INDEX IF NOT EXISTS ix_room_invitations_target ON room_invitations(target_coo_id, status, created_at);
CREATE INDEX IF NOT EXISTS ix_room_invitations_room ON room_invitations(room_id, status);

-- 历史遗留：大富翁的三张表当前没有代码读写，但来源库里可能有行。
-- 保留结构以便迁移原样搬运，不做清理。
CREATE TABLE IF NOT EXISTS monopoly_requests (
  game_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  hash TEXT NOT NULL,
  at BIGINT NOT NULL,
  receipt_json JSONB NOT NULL,
  PRIMARY KEY (game_id, key)
);

CREATE TABLE IF NOT EXISTS monopoly_pending (
  game_id TEXT PRIMARY KEY REFERENCES tables(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  action_json JSONB NOT NULL,
  turn_seq INTEGER NOT NULL,
  dice_json JSONB,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS monopoly_signups (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  host_seat_id TEXT NOT NULL,
  seats_json JSONB NOT NULL,
  size INTEGER NOT NULL CHECK (size IN (4,6)),
  pace TEXT NOT NULL CHECK (pace IN ('standard','quick')),
  created_at BIGINT NOT NULL,
  deadline_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS migration_runs (
  id TEXT PRIMARY KEY,
  source_dir TEXT NOT NULL,
  source_hashes_json JSONB NOT NULL,
  started_at BIGINT NOT NULL,
  finished_at BIGINT,
  status TEXT NOT NULL CHECK (status IN ('running','complete','failed')),
  counts_json JSONB,
  notes_json JSONB
);

CREATE TABLE IF NOT EXISTS global_handles (
  coo_id TEXT PRIMARY KEY REFERENCES coos(id),
  handle TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS identity_tickets (
  token_hash TEXT PRIMARY KEY,
  coo_id TEXT NOT NULL REFERENCES coos(id),
  audience TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_identity_tickets_expiry ON identity_tickets(expires_at);
CREATE INDEX IF NOT EXISTS ix_identity_tickets_coo ON identity_tickets(coo_id,audience);

-- 席位容量闸门：所有入座入口都走 INSERT，所以放在触发器里统一兜底。
-- 先锁 rooms 行再数：PG 里没有 SQLite 的单写者，不锁的话两个并发入座
-- 会各自通过 COUNT 检查。
CREATE OR REPLACE FUNCTION parlor_room_capacity() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.released_at IS NULL AND NEW.kind <> 'observer' THEN
    PERFORM 1 FROM rooms WHERE id = NEW.room_id FOR UPDATE;
    IF (
      SELECT COUNT(*) FROM room_seats s
       WHERE s.room_id = NEW.room_id
         AND s.released_at IS NULL
         AND s.kind <> 'observer'
    ) >= (SELECT capacity FROM rooms r WHERE r.id = NEW.room_id) THEN
      RAISE EXCEPTION 'room_full';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_room_capacity ON room_seats;
CREATE TRIGGER trg_room_capacity
BEFORE INSERT ON room_seats
FOR EACH ROW EXECUTE FUNCTION parlor_room_capacity();
`;

export interface PgMigration {
  version: number;
  name: string;
  sql: string;
}

/** 按版本顺序执行；只在 meta.schema_version 之后追加，不改已发布的段。 */
export const PG_MIGRATIONS: PgMigration[] = [
  { version: 1, name: 'initial', sql: PG_SCHEMA_SQL },
  { version: 2, name: 'feedback-and-announcements', sql: SUPPORT_SCHEMA_SQL },
  { version: 3, name: 'table-matching-and-recruitment', sql: TABLE_DISCOVERY_SCHEMA_SQL },
  { version: 4, name: 'room-and-seat-lifecycle', sql: `
    ALTER TABLE rooms ADD COLUMN business_active_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
    ALTER TABLE room_seats ADD COLUMN business_active_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
    ALTER TABLE room_seats ADD COLUMN location_capable SMALLINT NOT NULL DEFAULT 0 CHECK(location_capable IN (0,1));
    ALTER TABLE rooms ADD COLUMN archive_reason TEXT;
    ALTER TABLE coo_sessions ADD COLUMN return_room_id TEXT REFERENCES rooms(id);
    CREATE INDEX ix_rooms_idle_due ON rooms(business_active_at) WHERE archived_at IS NULL AND kind = 'room';
    CREATE INDEX ix_seats_idle_due ON room_seats(business_active_at) WHERE released_at IS NULL AND kind = 'pet';
    INSERT INTO meta(key,value) VALUES ('promises_disabled','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
  ` },
  // tables.game 的 CHECK 是 v1 写死的四个游戏；快局大富翁要落库就得放宽这一条。
  // 只加值、不删旧值：v4 及更早的桌仍然合法，老程序的读取路径不受影响。
  { version: 5, name: 'tables-game-monopoly2d', sql: `
    ALTER TABLE tables DROP CONSTRAINT IF EXISTS tables_game_check;
    ALTER TABLE tables ADD CONSTRAINT tables_game_check
      CHECK (game IN ('dice','ddz','monopoly','werewolf','monopoly2d'));
  ` },
  { version: 6, name: 'tables-game-gomoku', sql: `
    ALTER TABLE tables DROP CONSTRAINT tables_game_check;
    ALTER TABLE tables ADD CONSTRAINT tables_game_check
      CHECK (game IN ('dice','ddz','monopoly','werewolf','monopoly2d','gomoku'));
  ` },
  /**
   * 0.38.0：筹码整条下线。转移明细、开局押注额与「非 refill 发放」的唯一索引一起删。
   *
   * 这一步不可逆：v7 之后回退到 0.37.x 会因 schema 版本更高被拒开，
   * 必须同时恢复发布前那份 `pg-before.dump`（见发布手册）。
   * 迁移前请先把 `ledger_transfers` 导出留档：
   *   \copy (SELECT * FROM ledger_transfers) TO 'ledger_transfers-before-drop.csv' CSV HEADER;
   *
   * 不动 `ledger_entries.kind` 的取值：历史行里还有 grant / ante，
   * 收紧约束会让迁移当场失败。
   */
  { version: 7, name: 'drop-chips', sql: `
    DROP INDEX IF EXISTS ux_ledger_grant_once;
    ALTER TABLE ledger_entries DROP COLUMN IF EXISTS is_refill;
    ALTER TABLE tables DROP COLUMN IF EXISTS stake;
    DROP TABLE IF EXISTS ledger_transfers;
  ` },
  // 纯增量：新表 + 新列都有默认值，旧二进制读多出来的列不受影响，
  // 所以降级不需要恢复整库 dump，只要把 meta.schema_version 改回 7。
  { version: 8, name: 'news-and-recruit-version', sql: `
    ${NEWS_SCHEMA_SQL}
    ALTER TABLE table_discovery ADD COLUMN IF NOT EXISTS recruit_version BIGINT NOT NULL DEFAULT 0;
  ` },
  // 同样是纯增量：两张表各加两列（都有默认值），再补一张改动留痕表。
  // 回退到 0.39.0 只需把 meta.schema_version 改回 8——多出来的列与表老程序不读。
  { version: 9, name: 'support-edit-delete', sql: `
    ALTER TABLE news_items ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE news_items ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE support_announcements ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE support_announcements ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
    ${SUPPORT_ADMIN_SCHEMA_SQL}
  ` },
  /**
   * 每次发布一个唯一标识：同一天删掉重发沿用同一个 `id`，`created_at` 也可能撞在
   * 同一毫秒，只有它能把「上一期」与「重发的新稿」分开。老行按 id 派生，稳定且互不相同。
   * 纯增量：多一列有默认值，退回上一版（schema 9）只需把 meta.schema_version 改回 9。
   */
  { version: 10, name: 'news-publish-id', sql: `
    ALTER TABLE news_items ADD COLUMN IF NOT EXISTS publish_id TEXT NOT NULL DEFAULT '';
    UPDATE news_items SET publish_id = 'legacy-' || id WHERE publish_id = '';
  ` },
  /**
   * 公告也有每次发布的唯一标识：`id` 是运营自己选的 requestId，删掉后还能用同一个
   * requestId 重发，`revision` 又从 1 开始；只有它能把「这一条」与「上一条」分开。
   * 老行按 id 派生，稳定且互不相同。纯增量：回退到上一版（schema 10）只需把
   * meta.schema_version 改回 10——多出来的列老程序不读。
   */
  { version: 11, name: 'announcement-publish-id', sql: `
    ALTER TABLE support_announcements ADD COLUMN IF NOT EXISTS publish_id TEXT NOT NULL DEFAULT '';
    UPDATE support_announcements SET publish_id = 'legacy-' || id WHERE publish_id = '';
  ` },
];
