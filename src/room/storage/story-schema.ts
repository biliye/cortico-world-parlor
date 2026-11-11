export const STORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS story_rounds (
  id TEXT PRIMARY KEY,
  speaker_id TEXT NOT NULL REFERENCES coos(id),
  speaker_name TEXT NOT NULL,
  title TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  notes_at BIGINT NOT NULL,
  ends_at BIGINT NOT NULL,
  ended_at BIGINT,
  stage INTEGER NOT NULL DEFAULT 1 CHECK (stage = 1),
  batch_ready INTEGER NOT NULL DEFAULT 0 CHECK (batch_ready IN (0, 1)),
  part_count INTEGER NOT NULL DEFAULT 0,
  snack_count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_story_open ON story_rounds(stage) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_story_archive ON story_rounds(ended_at, id);
CREATE TABLE IF NOT EXISTS story_queue (
  coo_id TEXT PRIMARY KEY REFERENCES coos(id),
  queued_at BIGINT NOT NULL,
  ready_at BIGINT
);
CREATE INDEX IF NOT EXISTS ix_story_queue_order ON story_queue(queued_at, coo_id);
CREATE TABLE IF NOT EXISTS story_parts (
  round_id TEXT NOT NULL REFERENCES story_rounds(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (round_id, seq),
  UNIQUE (round_id, request_id)
);
CREATE TABLE IF NOT EXISTS story_attendance (
  round_id TEXT NOT NULL REFERENCES story_rounds(id) ON DELETE CASCADE,
  coo_id TEXT NOT NULL REFERENCES coos(id),
  PRIMARY KEY (round_id, coo_id)
);
CREATE INDEX IF NOT EXISTS ix_story_attendance_coo ON story_attendance(coo_id, round_id);
CREATE TABLE IF NOT EXISTS story_notes (
  round_id TEXT NOT NULL REFERENCES story_rounds(id) ON DELETE CASCADE,
  coo_id TEXT NOT NULL REFERENCES coos(id),
  name TEXT NOT NULL,
  text TEXT NOT NULL,
  draw TEXT NOT NULL,
  PRIMARY KEY (round_id, coo_id)
);
CREATE INDEX IF NOT EXISTS ix_story_notes_draw ON story_notes(round_id, draw, coo_id);
CREATE TABLE IF NOT EXISTS story_snacks (
  round_id TEXT NOT NULL REFERENCES story_rounds(id) ON DELETE CASCADE,
  coo_id TEXT NOT NULL REFERENCES coos(id),
  item TEXT NOT NULL,
  PRIMARY KEY (round_id, coo_id)
);
`;
