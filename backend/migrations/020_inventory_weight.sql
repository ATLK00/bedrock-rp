-- 020_inventory_weight.sql
-- Weight-aware inventory.
--  * items get a default weight & category (grams),
--  * characters get a carry limit (grams),
--  * generic containers (vehicle/house/business/locker/warehouse) cover
--    the storage types the server needs. The existing inventory_slots
--    table remains the character's personal bar (kept for trade/shop
--    compatibility); its weight is enforced in code against carry_weight_g.

BEGIN;

ALTER TABLE items
    ADD COLUMN weight_g INT NOT NULL DEFAULT 0 CHECK (weight_g >= 0),
    ADD COLUMN category TEXT;

UPDATE items SET weight_g = 50   WHERE id = 'rp:bandage';
UPDATE items SET weight_g = 10   WHERE id = 'rp:id_card';
UPDATE items SET weight_g = 100  WHERE id = 'rp:cash_stack';

ALTER TABLE characters
    ADD COLUMN carry_weight_g INT NOT NULL DEFAULT 20000 CHECK (carry_weight_g > 0);

CREATE TABLE inventories (
    id                  BIGSERIAL PRIMARY KEY,
    storage_type        TEXT NOT NULL
                        CHECK (storage_type IN ('vehicle','house','business','locker','warehouse')),
    owner_character_id  BIGINT REFERENCES characters(id) ON DELETE CASCADE,
    label               TEXT,
    capacity_weight_g   INT NOT NULL DEFAULT 50000 CHECK (capacity_weight_g > 0),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_inventories_owner ON inventories (owner_character_id, storage_type);

CREATE TABLE inventory_items (
    id              BIGSERIAL PRIMARY KEY,
    inventory_id    BIGINT NOT NULL REFERENCES inventories(id) ON DELETE CASCADE,
    item_id         TEXT NOT NULL REFERENCES items(id),
    quantity        INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
    item_metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_inventory_items_container ON inventory_items (inventory_id, item_id);

COMMIT;