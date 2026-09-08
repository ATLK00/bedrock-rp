-- 023_security_events.sql
-- Security Center: append-only event feed surfaced to staff.
-- Sources: failed logins, rate-limit trips, bridge replay / bad
-- signature, economy anomalies, unexpected server errors, admin actions.

BEGIN;

CREATE TABLE security_events (
    id                BIGSERIAL PRIMARY KEY,
    event_type        TEXT NOT NULL,
    severity          TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
    actor_user_id     BIGINT REFERENCES users(id),
    ip                TEXT,
    target_type       TEXT,
    target_id         TEXT,
    request_id        TEXT,
    payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
    acknowledged_at   TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_security_events_created  ON security_events (created_at DESC);
CREATE INDEX idx_security_events_severity ON security_events (severity);
CREATE INDEX idx_security_events_type     ON security_events (event_type);
CREATE INDEX idx_security_events_open     ON security_events (created_at DESC) WHERE acknowledged_at IS NULL;

COMMIT;