-- 026_properties.sql
-- Property system (server-authoritative real-estate domain):
--  * properties own a storage container (storage_type='house', label "Storage <address>")
--    and a garage capacity that ADDS to the character's vehicle garage cap,
--  * ownership lives on the character; a physical deed item (rp:property_key,
--    metadata {property_id}) is issued to the owner and can be shared/handed
--    to someone else for access (storage/lock),
--  * properties may be listed for sale (owner listing or unowned "government"
--    listing bought from the auction/shop view),
--  * seized/delete clears deeds + storage, mirroring the vehicle subsystem.

BEGIN;

CREATE TABLE properties (
    id                    BIGSERIAL PRIMARY KEY,
    property_type         TEXT NOT NULL DEFAULT 'house'
                          CHECK (property_type IN ('house', 'apartment', 'warehouse', 'business', 'office')),
    address               TEXT NOT NULL,
    owner_character_id    BIGINT REFERENCES characters(id) ON DELETE SET NULL,
    status                TEXT NOT NULL DEFAULT 'owned'
                          CHECK (status IN ('owned', 'seized')),
    locked                BOOLEAN NOT NULL DEFAULT true,
    garage_capacity       INT NOT NULL DEFAULT 2 CHECK (garage_capacity >= 0),
    storage_inventory_id  BIGINT REFERENCES inventories(id) ON DELETE SET NULL,
    sale_price_cents      BIGINT CHECK (sale_price_cents IS NULL OR sale_price_cents > 0),
    sale_currency         TEXT CHECK (sale_currency IS NULL OR sale_currency IN ('cash', 'bank', 'red_money')),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_properties_owner ON properties (owner_character_id);
CREATE INDEX idx_properties_sale ON properties (sale_price_cents) WHERE sale_price_cents IS NOT NULL;

-- Physical deed item: one per property, kept in the owner's carry slots with
-- item_metadata { "property_id": <id> } (mirrors rp:vehicle_key).
INSERT INTO items (id, display_name, stackable, max_stack, weight_g, category)
VALUES ('rp:property_key', 'Property Deed', false, 1, 50, 'property')
ON CONFLICT (id) DO NOTHING;

INSERT INTO permissions (key, description) VALUES
    ('property.manage', 'Manage properties: create, grant, seize, delete, set for sale'),
    ('property.view',   'View properties and their state')
ON CONFLICT (key) DO NOTHING;

COMMIT;