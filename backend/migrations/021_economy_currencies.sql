-- 021_economy_currencies.sql
-- Multi-currency wallet: cash / bank / red_money.
--
-- Backward compatibility is preserved on purpose:
--   * `wallets.balance_cents` remains THE cash wallet (the legacy
--     economy paths -- trade, shop, admin grant/deduct -- keep reading
--     and writing it unchanged).
--   * `wallet_balances` only holds the NEW currencies (bank, red_money),
--     so there is never two sources of truth for one currency.
--   * `transactions.currency` tags every new ledger row; existing rows
--     default to 'cash', which is correct.

BEGIN;

CREATE TABLE wallet_balances (
    character_id  BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    currency      TEXT NOT NULL CHECK (currency IN ('bank', 'red_money')),
    balance_cents BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
    PRIMARY KEY (character_id, currency)
);

ALTER TABLE transactions
    ADD COLUMN currency TEXT NOT NULL DEFAULT 'cash'
    CHECK (currency IN ('cash', 'bank', 'red_money'));

CREATE INDEX idx_transactions_currency_character
    ON transactions (character_id, currency, id DESC);

COMMIT;