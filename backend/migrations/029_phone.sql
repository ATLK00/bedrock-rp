-- 029_phone.sql
-- Phone / mobile framework (expandable app framework, seed apps in v1:)
--  * phone_numbers — every linked citizen is issued one number at first use
--    (backfilled for the pre-existing population, deterministic + unique)
--  * phone_contacts — per-owner address book (name, number, note)
--  * phone_messages — SMS-style messages between phone numbers
--  * phone_calls — a server-authoritative call state machine
--    (ringing -> connected -> ended | missed) modelled as data so a real
--    voice provider (MASTER_PROMPT §15 "phone events must connect to
--    voice/realtime systematically") can attach to the same state later;
--    there is no audio in Bedrock, the state machine + eventbus events are
--    the "realtime" for now.
--  * phone_waypoints — GPS bookmark store (coordinates only; navigation is
--    pack-side)
--  * phone_taxi_requests — fare-backed job board (requester -> driver transfer
--    on completion via economy.transfer)
--  * phone_emergency_calls — 911-style calls, dispatchable by police/ems
-- All phone writes are audited. Personal actions are self-authenticated by
-- the caller's own identity; taxi driver + emergency dispatch are RBAC-gated
-- (phone.taxi.manage / phone.emergency.view+manage).

BEGIN;

CREATE TABLE phone_numbers (
    character_id BIGINT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
    number       TEXT NOT NULL UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE phone_contacts (
    id                 BIGSERIAL PRIMARY KEY,
    owner_character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    name               TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
    number             TEXT NOT NULL CHECK (length(number) BETWEEN 4 AND 24),
    note               TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner_character_id, number)
);
CREATE INDEX idx_phone_contacts_owner ON phone_contacts (owner_character_id);

CREATE TABLE phone_messages (
    id               BIGSERIAL PRIMARY KEY,
    from_character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    to_character_id  BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    body             TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
    read_at          TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_phone_messages_inbox ON phone_messages (to_character_id, from_character_id);
CREATE INDEX idx_phone_messages_from ON phone_messages (from_character_id);

CREATE TABLE phone_calls (
    id                 BIGSERIAL PRIMARY KEY,
    caller_character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    callee_character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    status             TEXT NOT NULL DEFAULT 'ringing'
                       CHECK (status IN ('ringing', 'connected', 'ended', 'missed')),
    started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    accepted_at        TIMESTAMPTZ,
    ended_at           TIMESTAMPTZ,
    ended_by           BIGINT REFERENCES characters(id) ON DELETE SET NULL,
    missed_reason      TEXT
);
CREATE INDEX idx_phone_calls_caller ON phone_calls (caller_character_id);
CREATE INDEX idx_phone_calls_callee ON phone_calls (callee_character_id, status);

CREATE TABLE phone_waypoints (
    id                 BIGSERIAL PRIMARY KEY,
    owner_character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    name               TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
    dimension_id       TEXT NOT NULL DEFAULT 'overworld',
    x                  DOUBLE PRECISION NOT NULL,
    y                  DOUBLE PRECISION NOT NULL,
    z                  DOUBLE PRECISION NOT NULL,
    note               TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_phone_waypoints_owner ON phone_waypoints (owner_character_id);

CREATE TABLE phone_taxi_requests (
    id                  BIGSERIAL PRIMARY KEY,
    requester_character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    pickup_name         TEXT,
    dimension_id        TEXT NOT NULL DEFAULT 'overworld',
    pickup_x            DOUBLE PRECISION NOT NULL,
    pickup_y            DOUBLE PRECISION NOT NULL,
    pickup_z            DOUBLE PRECISION NOT NULL,
    destination         TEXT NOT NULL CHECK (length(destination) BETWEEN 1 AND 200),
    fare_cents          BIGINT NOT NULL CHECK (fare_cents > 0),
    currency            TEXT NOT NULL DEFAULT 'cash'
                        CHECK (currency IN ('cash', 'bank', 'red_money')),
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'accepted', 'completed', 'cancelled')),
    driver_character_id BIGINT REFERENCES characters(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    accepted_at         TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ
);
CREATE INDEX idx_phone_taxi_status ON phone_taxi_requests (status);
CREATE INDEX idx_phone_taxi_requester ON phone_taxi_requests (requester_character_id);

CREATE TABLE phone_emergency_calls (
    id                 BIGSERIAL PRIMARY KEY,
    caller_character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    category           TEXT NOT NULL
                       CHECK (category IN ('police', 'ems', 'fire', 'general')),
    subject            TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 300),
    dimension_id       TEXT NOT NULL DEFAULT 'overworld',
    location_x         DOUBLE PRECISION,
    location_y         DOUBLE PRECISION,
    location_z         DOUBLE PRECISION,
    status             TEXT NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'dispatched', 'closed')),
    responder_character_id BIGINT REFERENCES characters(id) ON DELETE SET NULL,
    note               TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at       TIMESTAMPTZ,
    closed_at          TIMESTAMPTZ
);
CREATE INDEX idx_phone_emergency_status ON phone_emergency_calls (status);
CREATE INDEX idx_phone_emergency_caller ON phone_emergency_calls (caller_character_id);

-- Backfill a deterministic 10-digit number ("09" + 8 digits from a stable
-- ordering) for the pre-existing population; later issues use random
-- 8-digit suffixes with unique-conflict retry in the module.
INSERT INTO phone_numbers (character_id, number)
SELECT id, '09' || lpad(row_number() OVER (ORDER BY id)::text, 8, '0')
FROM characters c
WHERE NOT EXISTS (SELECT 1 FROM phone_numbers pn WHERE pn.character_id = c.id);

INSERT INTO permissions (key, description) VALUES
    ('phone.view',            'Read the phone directory: issued numbers + full customer data'),
    ('phone.manage',          'Configure the phone system (app store, future apps)'),
    ('phone.taxi.manage',     'Operate the taxi job board (accept/complete trips)'),
    ('phone.emergency.view',  'See open emergency calls (dispatch)'),
    ('phone.emergency.manage','Respond to / close emergency calls')
ON CONFLICT (key) DO NOTHING;

-- admin gets full phone access.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'admin' AND p.key IN (
    'phone.view', 'phone.manage', 'phone.taxi.manage',
    'phone.emergency.view', 'phone.emergency.manage'
)
ON CONFLICT DO NOTHING;

-- police + ems are joint emergency dispatchers (911 goes to both).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name IN ('police', 'ems') AND p.key IN ('phone.emergency.view', 'phone.emergency.manage')
ON CONFLICT DO NOTHING;

COMMIT;