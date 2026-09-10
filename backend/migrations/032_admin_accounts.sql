-- 032_admin_accounts.sql
-- Username/password admin accounts (local accounts, no Discord identity).
-- `users.discord_id` becomes nullable: Discord users keep their id, local
-- admin accounts have NULL there and identify via `username` instead.

BEGIN;

ALTER TABLE users ALTER COLUMN discord_id DROP NOT NULL;

ALTER TABLE users ADD COLUMN username TEXT;
ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username);
ALTER TABLE users ADD COLUMN password_hash TEXT;

COMMIT;