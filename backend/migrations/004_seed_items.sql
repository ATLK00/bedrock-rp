-- 004_seed_items.sql
-- A handful of sample items so the inventory module can be tested end
-- to end. Real item catalog design (crafting, rarity, etc.) is future work.

BEGIN;

INSERT INTO items (id, display_name, stackable, max_stack) VALUES
    ('rp:bandage', 'Bandage', true, 16),
    ('rp:id_card', 'ID Card', false, 1),
    ('rp:cash_stack', 'Cash Bundle', true, 64)
ON CONFLICT (id) DO NOTHING;

COMMIT;
