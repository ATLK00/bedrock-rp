-- 025_vehicles.sql
-- Vehicle system (server-authoritative ownership/state, reconciled with the
-- in-world entity by the behavior pack):
--  * vehicles own a trunk container (storage_type='vehicle'),
--  * ownership lives on the character, not the entity,
--  * state (fuel/damage/lock) is stored server-side; the pack only reports
--    sensors and applies what the backend echoes back,
--  * a physical key item (rp:vehicle_key, metadata {vehicle_id}) is issued to
--    the owner and can be handed to someone else for shared access.
--  * vehicles carry a unique plate and may be listed for sale (player-to-player
--    transfer or dealership purchase).

BEGIN;

ALTER TABLE characters
    ADD COLUMN garage_capacity INT NOT NULL DEFAULT 3 CHECK (garage_capacity >= 0);

CREATE TABLE vehicles (
    id                   BIGSERIAL PRIMARY KEY,
    entity_type          TEXT NOT NULL DEFAULT 'megaverse:buggy',
    plate                TEXT NOT NULL UNIQUE,
    owner_character_id   BIGINT REFERENCES characters(id) ON DELETE SET NULL,
    status               TEXT NOT NULL DEFAULT 'garaged'
                         CHECK (status IN ('garaged', 'deployed', 'seized')),
    locked               BOOLEAN NOT NULL DEFAULT true,
    fuel_level           DOUBLE PRECISION NOT NULL DEFAULT 100.0
                         CHECK (fuel_level >= 0.0 AND fuel_level <= 100.0),
    engine_health        DOUBLE PRECISION NOT NULL DEFAULT 100.0
                         CHECK (engine_health >= 0.0 AND engine_health <= 100.0),
    suspension_health    DOUBLE PRECISION NOT NULL DEFAULT 100.0
                         CHECK (suspension_health >= 0.0 AND suspension_health <= 100.0),
    body_damage          DOUBLE PRECISION NOT NULL DEFAULT 0.0
                         CHECK (body_damage >= 0.0 AND body_damage <= 100.0),
    trunk_inventory_id   BIGINT REFERENCES inventories(id) ON DELETE SET NULL,
    sale_price_cents     BIGINT CHECK (sale_price_cents IS NULL OR sale_price_cents > 0),
    sale_currency        TEXT CHECK (sale_currency IS NULL OR sale_currency IN ('cash', 'bank', 'red_money')),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_vehicles_owner ON vehicles (owner_character_id);
CREATE INDEX idx_vehicles_status ON vehicles (status);
CREATE INDEX idx_vehicles_sale ON vehicles (sale_price_cents) WHERE sale_price_cents IS NOT NULL;

-- Physical key item: one per vehicle, kept in the owner's carry slots with
-- item_metadata { "vehicle_id": <id> } so keys are distinguishable.
INSERT INTO items (id, display_name, stackable, max_stack, weight_g, category)
VALUES ('rp:vehicle_key', 'Vehicle Key', false, 1, 20, 'vehicle')
ON CONFLICT (id) DO NOTHING;

INSERT INTO permissions (key, description) VALUES
    ('vehicle.manage', 'Manage vehicles: create, grant, seize, delete, override state'),
    ('vehicle.view',   'View vehicles and their state')
ON CONFLICT (key) DO NOTHING;

COMMIT;