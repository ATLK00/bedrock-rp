-- 003_link_codes.sql
-- Adds a short-lived linking code so a Discord-authenticated character
-- can be tied to the Bedrock xuid that actually joins the game.
--
-- NOTE (legacy naming): the `characters.xuid` column referenced by the
-- linking flow in 001_core.sql was renamed to `characters.persistent_id`
-- in migration 015. The value stored there is NOT a literal Xbox Live
-- xuid - it's the opaque `persistentId` from @minecraft/server-admin's
-- `asyncPlayerJoin` event (see CHANGELOG_AI.md [2026-09-08 22:30]).
-- Prior historical migrations are left unchanged; only the final
-- column name in migration 015 reflects the correct meaning. The
-- external wire fields (`xuid` on /bridge/character/link, `playerId`
-- on /bridge/player/join) are unchanged for behavior-pack compatibility.

BEGIN;

ALTER TABLE characters
    ADD COLUMN link_code TEXT UNIQUE,
    ADD COLUMN link_code_expires_at TIMESTAMPTZ;

COMMIT;
