-- 033_ops_permission.sql
-- Permission for the session-authenticated server-ops surface (`/admin/ops/*`:
-- status/monitoring/backups/wipe/resources). The `owner` role bypasses all
-- checks already (002); this lets non-owner admins use ops without the
-- CONTROL_API_KEY.

BEGIN;

INSERT INTO permissions (key, description) VALUES
    ('ops.manage', 'Server operations: status, monitoring, backups, wipe, resources')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'admin' AND p.key = 'ops.manage'
ON CONFLICT DO NOTHING;

COMMIT;