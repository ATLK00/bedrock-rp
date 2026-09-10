-- 028_ems.sql
-- EMS / emergency medical domain (player-operated):
--  * medical_records — one server-authoritative health-state row per citizen
--    with a FiveM-style state machine:
--      healthy --(report down)--> downed --(rescue)--> treated --(treat)--> healthy
--      downed --(expiry via server clock on read)--> dead
--      any --(declare death / entityDie)--> dead --(hospitalize on respawn)--> healthy
--    A citizen who dies is flagged `must_respawn_hospital`; the behavior pack
--    respawns them at the hospital point and calls /bridge/ems/hospitalize,
--    which returns them to healthy and issues a hospital bill.
--  * medical_bills — treatment/hospital charges billed to the patient as a
--    server-side money sink (economy.debit, refType 'medical'); unpaid bills
--    can be settled later from the phone app / player web.
-- Own state transitions (down/die/hospitalize) are self-service; medic verbs
-- (rescue/treat/declare-death) require the 'ems' role. Every transition is
-- audited. Downed expiry is lazy (settled on read, like warrant expiry in
-- 027) so no background job is needed and the server clock stays
-- authoritative.

BEGIN;

CREATE TABLE medical_records (
    character_id        BIGINT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
    health_state        TEXT NOT NULL DEFAULT 'healthy'
                        CHECK (health_state IN ('healthy', 'downed', 'treated', 'dead')),
    downed_at           TIMESTAMPTZ,
    downed_by           BIGINT REFERENCES characters(id) ON DELETE SET NULL,
    downed_location     JSONB,
    treated_by          BIGINT REFERENCES characters(id) ON DELETE SET NULL,
    treated_at          TIMESTAMPTZ,
    died_at             TIMESTAMPTZ,
    died_by             BIGINT REFERENCES characters(id) ON DELETE SET NULL,
    must_respawn_hospital BOOLEAN NOT NULL DEFAULT false,
    hospitalization_count INT NOT NULL DEFAULT 0,
    notes               TEXT,
    updated_by          BIGINT REFERENCES characters(id) ON DELETE SET NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE medical_bills (
    id           BIGSERIAL PRIMARY KEY,
    patient_id   BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    issued_by    BIGINT REFERENCES characters(id) ON DELETE SET NULL,
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    currency     TEXT NOT NULL DEFAULT 'cash'
                 CHECK (currency IN ('cash', 'bank', 'red_money')),
    reason       TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'unpaid'
                 CHECK (status IN ('unpaid', 'paid', 'waived')),
    issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at      TIMESTAMPTZ,
    paid_by      BIGINT REFERENCES characters(id) ON DELETE SET NULL,
    waived_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
    waived_at    TIMESTAMPTZ
);
CREATE INDEX idx_medical_bills_patient ON medical_bills (patient_id);
CREATE INDEX idx_medical_bills_status ON medical_bills (status);

-- Every existing citizen gets a healthy record (new characters are created
-- with one implicitly by the module on first read; this backfill covers the
-- pre-existing population so the MDT list is complete).
INSERT INTO medical_records (character_id)
SELECT id FROM characters
ON CONFLICT (character_id) DO NOTHING;

-- EMS role (rank 5 — grantable by admin) carrying day-to-day view+manage.
INSERT INTO roles (name) VALUES ('ems')
ON CONFLICT (name) DO NOTHING;

INSERT INTO permissions (key, description) VALUES
    ('ems.view',   'Read medical records: inquire a citizen, medical MDT lists'),
    ('ems.manage', 'Write EMS state: rescue/treat/declare-death, issue treatment bills'),
    ('ems.admin',  'Override EMS state: waive bills, administrative reset')
ON CONFLICT (key) DO NOTHING;

UPDATE roles SET rank = 5 WHERE name = 'ems';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'ems' AND p.key IN ('ems.view', 'ems.manage')
ON CONFLICT DO NOTHING;

-- admin gets all three EMS permissions (the 005 cross-join only granted what
-- existed at that time).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'admin' AND p.key IN ('ems.view', 'ems.manage', 'ems.admin')
ON CONFLICT DO NOTHING;

COMMIT;