-- 002_rbac_audit.sql
-- RBAC and audit logging. Every admin action must write here.

BEGIN;

CREATE TABLE roles (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,   -- e.g. 'moderator', 'admin', 'owner'
    description     TEXT
);

CREATE TABLE permissions (
    id              SERIAL PRIMARY KEY,
    key             TEXT NOT NULL UNIQUE,   -- e.g. 'economy.grant', 'character.ban'
    description     TEXT
);

CREATE TABLE role_permissions (
    role_id         INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id   INT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id         INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    granted_by      BIGINT REFERENCES users(id),
    granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, role_id)
);

-- Append-only. Never UPDATE or DELETE rows here from application code.
CREATE TABLE audit_log (
    id              BIGSERIAL PRIMARY KEY,
    actor_user_id   BIGINT REFERENCES users(id),   -- null = system
    action          TEXT NOT NULL,                 -- e.g. 'economy.grant', 'character.whitelist'
    target_type     TEXT,                           -- e.g. 'character', 'user'
    target_id       TEXT,
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    result          TEXT NOT NULL,                  -- 'success' | 'failure'
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_log_actor ON audit_log(actor_user_id);
CREATE INDEX idx_audit_log_action ON audit_log(action);

-- seed baseline roles
INSERT INTO roles (name, description) VALUES
    ('owner', 'Full access, bypasses permission checks'),
    ('admin', 'Server administration'),
    ('moderator', 'Player moderation only');

COMMIT;
