/**
 * 多客厅 SQLite schema。
 *
 * 原则：
 * - 身份/账户/账本/信箱全局；成员资格长期；席位是一次到访。
 * - 账本只追加，余额/承诺状态现算；信箱逐封 read_at；没有 coo 级已读游标。
 * - 事件存快照；可见性用 room_seats.visible_from_seq/visible_to_seq。
 * - 一个 Coo 全局最多一个活跃席位；一个客厅一个 Coo 一个活跃席位。
 * - 表顺序按外键依赖排；可重复执行。
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coos (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('pet','human','legacy','system')),
  display_name TEXT NOT NULL DEFAULT '',
  secret_hash TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_coos_secret ON coos(secret_hash) WHERE secret_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  coo_id TEXT NOT NULL UNIQUE REFERENCES coos(id),
  display_name TEXT NOT NULL,
  owner_key_hash TEXT NOT NULL UNIQUE,
  session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version >= 1),
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled'))
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('hall','room')),
  name TEXT NOT NULL,
  owner_coo_id TEXT REFERENCES coos(id),
  visibility TEXT NOT NULL CHECK (visibility IN ('public','unlisted','private')),
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 2 AND 64),
  topic TEXT,
  invite_code_hash TEXT,
  epoch TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0),
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  archived_at INTEGER,
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
  joined_at INTEGER NOT NULL,
  removed_at INTEGER,
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
  joined_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  released_at INTEGER,
  visible_from_seq INTEGER NOT NULL,
  visible_to_seq INTEGER,
  PRIMARY KEY (room_id, id),
  CHECK (visible_to_seq IS NULL OR visible_to_seq >= visible_from_seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_one_active_seat_per_coo
  ON room_seats(coo_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_active_seat_name
  ON room_seats(room_id, name COLLATE NOCASE) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_room_seats_active ON room_seats(room_id, released_at);
CREATE INDEX IF NOT EXISTS ix_room_seats_coo ON room_seats(coo_id, joined_at);

CREATE TABLE IF NOT EXISTS account_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  session_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_account_sessions ON account_sessions(account_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS coo_sessions (
  coo_id TEXT PRIMARY KEY REFERENCES coos(id) ON DELETE CASCADE,
  session_version INTEGER NOT NULL DEFAULT 1,
  current_room_id TEXT,
  current_seat_id TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  FOREIGN KEY (current_room_id, current_seat_id) REFERENCES room_seats(room_id, id)
);

CREATE TABLE IF NOT EXISTS events (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  from_kind TEXT NOT NULL CHECK (from_kind IN ('seat','coo','system')),
  from_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('hall','room','table','seat')),
  scope_seat_id TEXT,
  scope_table_id TEXT,
  scope_seats_json TEXT,
  text TEXT NOT NULL,
  mentions_json TEXT,
  data_json TEXT,
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
  ord INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  room_id TEXT REFERENCES rooms(id),
  kind TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('room','private')),
  from_kind TEXT NOT NULL CHECK (from_kind IN ('coo','room')),
  from_coo_id TEXT REFERENCES coos(id),
  to_kind TEXT NOT NULL CHECK (to_kind IN ('coo','room','none')),
  to_coo_id TEXT REFERENCES coos(id),
  game TEXT,
  text TEXT NOT NULL,
  data_json TEXT,
  due_at INTEGER,
  ref_entry_id TEXT REFERENCES ledger_entries(id),
  effect_id TEXT,
  is_refill INTEGER NOT NULL DEFAULT 0 CHECK (is_refill IN (0,1)),
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

CREATE TABLE IF NOT EXISTS ledger_participants (
  entry_id TEXT NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  coo_id TEXT NOT NULL REFERENCES coos(id),
  PRIMARY KEY (entry_id, coo_id)
);
CREATE INDEX IF NOT EXISTS ix_ledger_participants_coo ON ledger_participants(coo_id, entry_id);

CREATE TABLE IF NOT EXISTS ledger_winners (
  entry_id TEXT NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  coo_id TEXT NOT NULL REFERENCES coos(id),
  PRIMARY KEY (entry_id, coo_id)
);
CREATE INDEX IF NOT EXISTS ix_ledger_winners_coo ON ledger_winners(coo_id, entry_id);

CREATE TABLE IF NOT EXISTS ledger_transfers (
  id INTEGER PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  from_kind TEXT NOT NULL CHECK (from_kind IN ('coo','room')),
  from_coo_id TEXT REFERENCES coos(id),
  to_coo_id TEXT NOT NULL REFERENCES coos(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  CHECK ((from_kind = 'coo') = (from_coo_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_transfer_from ON ledger_transfers(from_coo_id);
CREATE INDEX IF NOT EXISTS ix_transfer_to ON ledger_transfers(to_coo_id);
CREATE INDEX IF NOT EXISTS ix_transfer_entry ON ledger_transfers(entry_id);

CREATE TABLE IF NOT EXISTS mail (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  coo_id TEXT NOT NULL REFERENCES coos(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  kind TEXT NOT NULL CHECK (kind IN ('whisper','gift','promise','ledger')),
  action TEXT,
  from_name TEXT NOT NULL,
  text TEXT NOT NULL,
  entry_id TEXT REFERENCES ledger_entries(id),
  key TEXT,
  read_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_mail_key ON mail(key) WHERE key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_mail_unread ON mail(coo_id, read_at, seq);
CREATE INDEX IF NOT EXISTS ix_mail_room ON mail(coo_id, room_id, read_at, seq);

CREATE TABLE IF NOT EXISTS tables (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  room_epoch TEXT NOT NULL,
  game TEXT NOT NULL CHECK (game IN ('dice','ddz','monopoly')),
  status TEXT NOT NULL CHECK (status IN ('open','bidding','playing','ended','abandoned')),
  host_seat_id TEXT,
  stake INTEGER NOT NULL DEFAULT 0 CHECK (stake >= 0),
  state_json TEXT,
  engine_version TEXT,
  turn_seq INTEGER NOT NULL DEFAULT 0,
  deadline_at INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  end_reason TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (room_id, host_seat_id) REFERENCES room_seats(room_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_live_table_per_room
  ON tables(room_id) WHERE status IN ('open','bidding','playing');
CREATE INDEX IF NOT EXISTS ix_tables_room_status ON tables(room_id, status, created_at);

CREATE TABLE IF NOT EXISTS table_seats (
  table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  coo_id TEXT REFERENCES coos(id),
  position INTEGER NOT NULL,
  role TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0 CHECK (is_bot IN (0,1)),
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  PRIMARY KEY (table_id, seat_id),
  UNIQUE (table_id, position)
);
CREATE INDEX IF NOT EXISTS ix_table_seats_coo ON table_seats(coo_id, table_id);

CREATE TABLE IF NOT EXISTS monopoly_requests (
  game_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  hash TEXT NOT NULL,
  at INTEGER NOT NULL,
  receipt_json TEXT NOT NULL,
  PRIMARY KEY (game_id, key)
);

CREATE TABLE IF NOT EXISTS monopoly_pending (
  game_id TEXT PRIMARY KEY REFERENCES tables(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  action_json TEXT NOT NULL,
  turn_seq INTEGER NOT NULL,
  dice_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS monopoly_signups (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  host_seat_id TEXT NOT NULL,
  seats_json TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size IN (4,6)),
  pace TEXT NOT NULL CHECK (pace IN ('standard','quick')),
  created_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS migration_runs (
  id TEXT PRIMARY KEY,
  source_dir TEXT NOT NULL,
  source_hashes_json TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('running','complete','failed')),
  counts_json TEXT,
  notes_json TEXT
);

CREATE TRIGGER IF NOT EXISTS trg_room_capacity
BEFORE INSERT ON room_seats
WHEN NEW.released_at IS NULL AND NEW.kind <> 'observer'
 AND (SELECT COUNT(*) FROM room_seats s
      WHERE s.room_id = NEW.room_id
        AND s.released_at IS NULL
        AND s.kind <> 'observer')
     >= (SELECT capacity FROM rooms r WHERE r.id = NEW.room_id)
BEGIN
  SELECT RAISE(ABORT, 'room_full');
END;
`;
