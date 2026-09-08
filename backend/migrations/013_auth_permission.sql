-- 013_auth_permission.sql

BEGIN;

INSERT INTO permissions (key, description) VALUES
    ('auth.manage', 'Manually trigger auth/session maintenance actions (e.g. stale session cleanup)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'admin' AND p.key = 'auth.manage'
ON CONFLICT DO NOTHING;

COMMIT;
