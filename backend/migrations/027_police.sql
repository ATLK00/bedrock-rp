-- 027_police.sql
-- Police / law-enforcement domain (player-operated MDT):
--  * citizen + vehicle records with server-authoritative lookup (RBAC +
--    audit; NO search warrant required per current server policy — the
--    warrant feature is a record-keeping/arrest tool, not a read gate),
--  * licenses (one active instance per type per citizen),
--  * officer-authored police reports with attached evidence records,
--  * fines — issued by an officer, paid by the citizen as a server-side
--    money sink (economy.debit, refType 'fine'); there is no government
--    account yet, so paid fines are removed from circulation deliberately,
--  * warrants (arrest/search) — active until executed/revoked/expired,
--  * arrests / jail — a jail_until timestamp on the character; expired
--    sentences are auto-marked 'served' on read, and the behavior pack
--    respawns an actively-jailed player at the prison point.
-- Police permissions are gated by a dedicated 'police' role so RANKS can be
-- layered later (e.g. cadet/officer/sergeant) without schema changes.

BEGIN;

CREATE TABLE licenses (
    id             BIGSERIAL PRIMARY KEY,
    character_id   BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    license_type   TEXT NOT NULL
                   CHECK (license_type IN ('driving', 'weapon', 'business', 'fishing', 'aviation')),
    status         TEXT NOT NULL DEFAULT 'valid'
                   CHECK (status IN ('valid', 'suspended', 'revoked')),
    issued_by      BIGINT REFERENCES characters(id) ON DELETE SET NULL,
    issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at     TIMESTAMPTZ,
    notes          TEXT
);

-- One ACTIVE license per (character, type); a revoked/suspended record can
-- still live on as history while a fresh one may be issued.
CREATE UNIQUE INDEX uq_licenses_char_type_active
    ON licenses (character_id, license_type) WHERE status <> 'revoked';
CREATE INDEX idx_licenses_character ON licenses (character_id);

CREATE TABLE police_records (
    character_id   BIGINT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
    known_alias    TEXT,
    threat_level   TEXT NOT NULL DEFAULT 'none'
                   CHECK (threat_level IN ('none', 'low', 'medium', 'high', 'critical')),
    notes          TEXT,
    updated_by     BIGINT REFERENCES characters(id) ON DELETE SET NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE police_reports (
    id             BIGSERIAL PRIMARY KEY,
    officer_id     BIGINT REFERENCES characters(id) ON DELETE SET NULL,
    title          TEXT NOT NULL,
    body           TEXT NOT NULL,
    classification TEXT NOT NULL DEFAULT 'general'
                   CHECK (classification IN ('general', 'restricted', 'classified')),
    status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'closed')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_police_reports_officer ON police_reports (officer_id);

CREATE TABLE fines (
    id                 BIGSERIAL PRIMARY KEY,
    officer_id         BIGINT REFERENCES characters(id) ON DELETE SET NULL,
    target_character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    amount_cents       BIGINT NOT NULL CHECK (amount_cents > 0),
    currency           TEXT NOT NULL DEFAULT 'cash'
                       CHECK (currency IN ('cash', 'bank', 'red_money')),
    reason             TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'outstanding'
                       CHECK (status IN ('outstanding', 'paid')),
    paid_at            TIMESTAMPTZ,
    issued_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_fines_target ON fines (target_character_id);
CREATE INDEX idx_fines_status ON fines (status);

CREATE TABLE warrants (
    id                  BIGSERIAL PRIMARY KEY,
    target_character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    warrant_type        TEXT NOT NULL
                        CHECK (warrant_type IN ('arrest', 'search')),
    status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'executed', 'expired', 'revoked')),
    officer_id          BIGINT REFERENCES characters(id) ON DELETE SET NULL,
    reason              TEXT NOT NULL,
    issued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ,
    closed_at           TIMESTAMPTZ
);
CREATE INDEX idx_warrants_target ON warrants (target_character_id);
CREATE INDEX idx_warrants_status ON warrants (status);

CREATE TABLE evidence (
    id           BIGSERIAL PRIMARY KEY,
    report_id    BIGINT REFERENCES police_reports(id) ON DELETE SET NULL,
    officer_id   BIGINT REFERENCES characters(id) ON DELETE SET NULL,
    description  TEXT NOT NULL,
    item_id      TEXT REFERENCES items(id) ON DELETE SET NULL,
    quantity     INT NOT NULL DEFAULT 1 CHECK (quantity >= 1),
    status       TEXT NOT NULL DEFAULT 'stored'
                 CHECK (status IN ('stored', 'returned', 'destroyed', 'transferred')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_evidence_report ON evidence (report_id);

CREATE TABLE arrests (
    id                BIGSERIAL PRIMARY KEY,
    character_id      BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    officer_id        BIGINT REFERENCES characters(id) ON DELETE SET NULL,
    reason            TEXT NOT NULL,
    jail_until        TIMESTAMPTZ NOT NULL,
    status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'served', 'released', 'escaped')),
    released_by       BIGINT REFERENCES characters(id) ON DELETE SET NULL,
    released_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_arrests_character ON arrests (character_id);
CREATE INDEX idx_arrests_status ON arrests (status);

-- police role (rank 5 — below moderator 10, grantable by admin) carrying the
-- day-to-day view+manage permissions; police.admin (warrant revoke / release /
-- overrides) stays with admin staff unless explicitly granted.
INSERT INTO roles (name) VALUES ('police')
ON CONFLICT (name) DO NOTHING;

INSERT INTO permissions (key, description) VALUES
    ('police.view',   'Read police records: MDT lookups, fines, warrants, reports, arrests'),
    ('police.manage', 'Write police records: issue fines/licenses/warrants, write reports/evidence, make arrests'),
    ('police.admin',  'Override police state: revoke warrants, early release, administrative actions')
ON CONFLICT (key) DO NOTHING;

UPDATE roles SET rank = 5 WHERE name = 'police';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'police' AND p.key IN ('police.view', 'police.manage')
ON CONFLICT DO NOTHING;

-- admin gets police.admin on top of the cross-join grant from 005.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'admin' AND p.key = 'police.admin'
ON CONFLICT DO NOTHING;

COMMIT;