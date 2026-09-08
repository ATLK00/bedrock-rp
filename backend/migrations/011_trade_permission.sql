-- 011_trade_permission.sql

BEGIN;

INSERT INTO permissions (key, description) VALUES
    ('trade.manage', 'Manually trigger trade maintenance actions (e.g. expiry sweep)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'admin' AND p.key = 'trade.manage'
ON CONFLICT DO NOTHING;

COMMIT;
