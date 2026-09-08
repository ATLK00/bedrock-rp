-- 001_core.sql
-- Core identity, economy, inventory tables.
-- Server-authoritative: clients never write these directly.

BEGIN;

CREATE TABLE users (
    id              BIGSERIAL PRIMARY KEY,
    discord_id      TEXT NOT NULL UNIQUE,
    discord_tag     TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at   TIMESTAMPTZ,
    is_banned       BOOLEAN NOT NULL DEFAULT false,
    ban_reason      TEXT
);

-- One Discord account = one character. Enforced by UNIQUE(user_id).
CREATE TABLE characters (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL UNIQUE,
    xuid            TEXT UNIQUE, -- Bedrock player identity, linked after first join
    whitelisted     BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ,
    is_deleted      BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE wallets (
    character_id    BIGINT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
    balance_cents   BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only ledger. balance in `wallets` is a derived cache;
-- this table is the actual source of truth for economy.
CREATE TABLE transactions (
    id              BIGSERIAL PRIMARY KEY,
    character_id    BIGINT NOT NULL REFERENCES characters(id),
    counterparty_id BIGINT REFERENCES characters(id),
    amount_cents    BIGINT NOT NULL, -- signed: + credit, - debit
    reason          TEXT NOT NULL,
    ref_type        TEXT, -- e.g. 'trade', 'admin_grant', 'shop_purchase'
    ref_id          TEXT,
    created_by      BIGINT REFERENCES users(id), -- admin/system actor, null if player-initiated
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_transactions_character_id ON transactions(character_id);

CREATE TABLE items (
    id              TEXT PRIMARY KEY, -- e.g. 'rp:bandage'
    display_name    TEXT NOT NULL,
    stackable       BOOLEAN NOT NULL DEFAULT true,
    max_stack       INT NOT NULL DEFAULT 64,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE inventory_slots (
    id              BIGSERIAL PRIMARY KEY,
    character_id    BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    slot_index      INT NOT NULL,
    item_id         TEXT REFERENCES items(id),
    quantity        INT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    item_metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE(character_id, slot_index)
);

COMMIT;
