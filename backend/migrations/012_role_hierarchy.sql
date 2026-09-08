-- 012_role_hierarchy.sql
-- Grants 'rbac.manage_roles' to the 'admin' role. This was
-- deliberately withheld before (005_seed_permissions.sql) because role
-- management had no hierarchy check — any grantee could hand out any
-- role including 'admin' or 'owner', which would have been a real
-- self-escalation path. Application code (backend/src/rbac/admin.ts)
-- now enforces a rank hierarchy: an 'admin' can only grant/revoke roles
-- ranked below their own (i.e. 'moderator'), never 'admin' or 'owner'.
-- 'owner's RBAC bypass is unaffected and can still manage any role.

BEGIN;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'admin' AND p.key = 'rbac.manage_roles'
ON CONFLICT DO NOTHING;

COMMIT;
