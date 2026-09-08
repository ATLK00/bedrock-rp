-- 003_link_codes.sql
-- Adds a short-lived linking code so a Discord-authenticated character
-- can be tied to the Bedrock xuid that actually joins the game.

BEGIN;

ALTER TABLE characters
    ADD COLUMN link_code TEXT UNIQUE,
    ADD COLUMN link_code_expires_at TIMESTAMPTZ;

COMMIT;
