-- 015_persistent_id_rename.sql
-- Renames characters.xuid -> characters.persistent_id.
--
-- The column never stored a literal Xbox Live xuid — see
-- behavior_pack/scripts/main.js's IDENTITY NOTE: it stores
-- @minecraft/server-admin's `persistentId`, an opaque stable
-- per-player identifier that testing confirmed does NOT match the
-- real xuid printed in the server's own console log. The old column
-- name was a holdover from before that distinction was understood;
-- renaming it here so the schema stops implying it's a real xuid.
--
-- Scope: DB column + backend-internal variable/property names only.
-- Wire-level API field names are UNCHANGED by this migration — POST
-- /bridge/character/link still sends/reads `xuid` in its JSON body,
-- POST /bridge/player/join still uses `playerId`. Renaming those is a
-- separate, coordinated change with behavior_pack/scripts/main.js
-- (both sides deploy together), deliberately not bundled with this
-- lower-risk DB-only rename.

BEGIN;

ALTER TABLE characters RENAME COLUMN xuid TO persistent_id;
ALTER TABLE characters RENAME CONSTRAINT characters_xuid_key TO characters_persistent_id_key;

COMMIT;
