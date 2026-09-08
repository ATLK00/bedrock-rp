-- 016_player_sessions.sql
-- Player online-session history. Postgres is the permanent record;
-- Redis holds the transient "currently online" presence set (see
-- modules/player_session). One row per join..leave window; a
-- persistent_id can have at most ONE open (left_at IS NULL) row at any
-- time (partial unique index) -- reconnect closes the previous window
-- first, so this never treats a reconnect as two live sessions.
CREATE TABLE player_sessions (
  id            BIGSERIAL   PRIMARY KEY,
  persistent_id TEXT        NOT NULL,
  player_name   TEXT        NOT NULL,
  character_id  BIGINT      REFERENCES characters(id) ON DELETE SET NULL,
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at       TIMESTAMPTZ
);

-- The exact constraint that enforces "no duplicate active sessions".
CREATE UNIQUE INDEX uq_player_sessions_one_active
  ON player_sessions (persistent_id)
  WHERE left_at IS NULL;

CREATE INDEX idx_player_sessions_persistent_id ON player_sessions (persistent_id);
CREATE INDEX idx_player_sessions_character_id  ON player_sessions (character_id);
-- history queries sort by most recent first
CREATE INDEX idx_player_sessions_joined_at     ON player_sessions (joined_at DESC);

-- Sanity: a session cannot end before it started, or be seen after it left.
ALTER TABLE player_sessions
  ADD CONSTRAINT chk_player_sessions_timeline
  CHECK (left_at IS NULL OR last_seen_at <= left_at);