-- 014_role_rank.sql
-- Moves role rank (used by rbac/admin.ts's grant/revoke hierarchy
-- check) out of the hardcoded ROLE_RANK object in application code
-- and into the roles table itself. 'owner' keeps its special-case
-- always-highest behavior in code (NOT stored as a finite rank here,
-- consistent with rbac/index.ts's OWNER_BYPASS_ROLE special-case and
-- 012_role_hierarchy.sql's comment that owner is never grantable).
--
-- rank = 0 (the DEFAULT) means "no role-management rank" — matches
-- old code's `ROLE_RANK[n] ?? 0` fallback for any role not in the
-- hardcoded map.

BEGIN;

ALTER TABLE roles ADD COLUMN rank INT NOT NULL DEFAULT 0;

UPDATE roles SET rank = 10 WHERE name = 'moderator';
UPDATE roles SET rank = 50 WHERE name = 'admin';
-- 'owner' intentionally left at rank 0 here — code treats owner as an
-- always-highest special case, never compares it via this column.

COMMIT;
