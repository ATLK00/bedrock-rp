-- 006_sessions.sql
-- Enables real session revocation. Previously sessions were pure
-- stateless JWTs — banning a user blocked new logins but couldn't kill
-- an already-issued token until it naturally expired (up to 7 days).

BEGIN;

CREATE TABLE sessions (
    jti             TEXT PRIMARY KEY,   -- JWT ID claim, random per issued token
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ
);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);

COMMIT;
