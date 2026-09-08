-- 007_ban_permission.sql
-- Adds the permission for the new admin ban route.

BEGIN;

INSERT INTO permissions (key, description) VALUES
    ('user.ban', 'Ban or unban a Discord user and revoke their active sessions')
ON CONFLICT (key) DO NOTHING;

-- admin gets this too, same as the other four operational permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'admin' AND p.key = 'user.ban'
ON CONFLICT DO NOTHING;

COMMIT;
