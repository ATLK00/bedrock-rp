-- 024_cases.sql
-- Support cases / tickets with a lifecycle and an audit timeline.
-- A case can be referenced by character-change requests (locked RP fields
-- are changed only after a case is reviewed and approved).
-- Timeline events are append-only and also mirrored to audit_log.

BEGIN;

CREATE TABLE case_categories (
    id    SERIAL PRIMARY KEY,
    key   TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL
);

INSERT INTO case_categories (key, label) VALUES
    ('bug',             'Bug'),
    ('lost_item',       'Lost Item'),
    ('lost_vehicle',    'Lost Vehicle'),
    ('character_issue', 'Character Issue'),
    ('payment_issue',   'Payment Issue'),
    ('ban_appeal',      'Ban Appeal'),
    ('report_player',   'Report Player'),
    ('other',           'Other');

CREATE TABLE cases (
    id            BIGSERIAL PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id),
    character_id  BIGINT REFERENCES characters(id) ON DELETE SET NULL,
    category_key  TEXT NOT NULL REFERENCES case_categories(key),
    status        TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','in_progress','resolved','closed','rejected')),
    subject       TEXT NOT NULL CHECK (char_length(subject) BETWEEN 3 AND 200),
    description   TEXT NOT NULL CHECK (char_length(description) BETWEEN 10 AND 5000),
    created_by    BIGINT NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cases_user   ON cases (user_id, status);
CREATE INDEX idx_cases_status ON cases (status, created_at);

CREATE TABLE case_messages (
    id            BIGSERIAL PRIMARY KEY,
    case_id       BIGINT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    author_user_id BIGINT NOT NULL REFERENCES users(id),
    body          TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_case_messages_case ON case_messages (case_id, created_at);

CREATE TABLE case_events (
    id            BIGSERIAL PRIMARY KEY,
    case_id       BIGINT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    event_type    TEXT NOT NULL,
    actor_user_id BIGINT REFERENCES users(id),
    payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_case_events_case ON case_events (case_id, created_at);

COMMIT;