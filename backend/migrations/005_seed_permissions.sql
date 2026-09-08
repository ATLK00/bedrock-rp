-- 005_seed_permissions.sql
-- Populates `permissions` with every action key referenced by
-- requirePermission() so far, and grants sensible defaults to
-- 'admin'/'moderator' roles. 'owner' bypasses all checks regardless
-- (see rbac/index.ts) and does not need explicit grants.

BEGIN;

INSERT INTO permissions (key, description) VALUES
    ('economy.grant',        'Mint money directly into a character''s wallet'),
    ('character.whitelist',  'Toggle a character''s server whitelist status'),
    ('inventory.give',       'Give items to a character''s inventory'),
    ('inventory.remove',     'Remove items from a character''s inventory'),
    ('rbac.manage_roles',    'Grant or revoke roles from users')
ON CONFLICT (key) DO NOTHING;

-- admin: full operational access to all four action types
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

-- moderator: whitelist only — day-to-day player management, not economy/inventory mutation
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'moderator' AND p.key = 'character.whitelist'
ON CONFLICT DO NOTHING;

COMMIT;
