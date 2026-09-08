-- 009_shop.sql
-- NPC shop catalog. Buy/sell prices are independent (sell price is
-- typically lower than buy price — standard "shop margin" pattern).
-- `stock` NULL means unlimited; a non-null stock decrements on buy and
-- increments on sell, and buy fails at 0.

BEGIN;

CREATE TABLE shop_listings (
    item_id         TEXT PRIMARY KEY REFERENCES items(id),
    buy_price_cents  BIGINT CHECK (buy_price_cents IS NULL OR buy_price_cents >= 0),  -- NULL = not purchasable from the shop
    sell_price_cents BIGINT CHECK (sell_price_cents IS NULL OR sell_price_cents >= 0), -- NULL = shop won't buy this item back
    stock           INT CHECK (stock IS NULL OR stock >= 0), -- NULL = unlimited
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- seed the existing sample items with sensible defaults
INSERT INTO shop_listings (item_id, buy_price_cents, sell_price_cents, stock) VALUES
    ('rp:bandage', 50, 20, NULL),
    ('rp:cash_stack', NULL, NULL, NULL) -- not sold in the shop, this represents in-hand cash bundles
ON CONFLICT (item_id) DO NOTHING;

COMMIT;
