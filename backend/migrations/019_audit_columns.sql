-- 019_audit_columns.sql
-- Enrich the audit log with request correlation, before/after state and a
-- human reason, plus the granular permissions the new modules need.
-- Additive: existing audit rows remain valid (new columns are NULL).

BEGIN;

ALTER TABLE audit_log
    ADD COLUMN request_id TEXT,
    ADD COLUMN before     JSONB,
    ADD COLUMN after      JSONB,
    ADD COLUMN reason     TEXT;

CREATE INDEX idx_audit_log_request_id ON audit_log (request_id);

-- Granular permissions for the new backend foundation systems.
INSERT INTO permissions (key, description) VALUES
    ('character.edit',         'Edit own character details (unlocked fields); staff: approve locked-field changes'),
    ('character.lock',         'Confirm/lock a character profile'),
    ('character.view',         'View any character profile'),
    ('economy.view',           'Read any character economy history'),
    ('economy.anomaly',        'View/resolve economy anomaly events'),
    ('inventory.manage',       'Administer containers and move items between them'),
    ('inventory.view',         'Read any character/container inventory'),
    ('case.create',            'Player creates a support case'),
    ('case.manage',            'View, act on and close support cases'),
    ('security.view',          'Read security events'),
    ('security.manage',        'Acknowledge/dismiss security events'),
    ('audit.view',             'Read the audit log'),
    ('bridge.view',            'Read bridge request logs')
ON CONFLICT (key) DO NOTHING;

-- Owner and admin get every permission (owner bypasses checks anyway).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name IN ('admin', 'owner')
ON CONFLICT DO NOTHING;

-- Moderators get the player-facing + case + security read permissions.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'moderator'
  AND p.key IN ('character.view', 'case.manage', 'security.view', 'audit.view')
ON CONFLICT DO NOTHING;

COMMIT;