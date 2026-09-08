-- 010_shop_permission.sql

BEGIN;

INSERT INTO permissions (key, description) VALUES
    ('shop.manage', 'Add, update, or remove shop catalog listings')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'admin' AND p.key = 'shop.manage'
ON CONFLICT DO NOTHING;

COMMIT;
