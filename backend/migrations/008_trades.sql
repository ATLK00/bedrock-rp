-- 008_trades.sql
-- Player-to-player trading. The initiator proposes a full trade ("I
-- give X, in exchange for Y from you"); the counterparty can only
-- accept or decline — no back-and-forth counter-offer negotiation in
-- this version. Nothing moves until accept, and accept moves both
-- sides atomically in one transaction — avoids the classic trade-scam
-- pattern where one side hands something over before the other
-- reciprocates.

BEGIN;

CREATE TABLE trades (
    id                      BIGSERIAL PRIMARY KEY,
    initiator_id            BIGINT NOT NULL REFERENCES characters(id),
    counterparty_id         BIGINT NOT NULL REFERENCES characters(id),
    status                  TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired'
    -- what the initiator gives
    initiator_cents         BIGINT NOT NULL DEFAULT 0 CHECK (initiator_cents >= 0),
    initiator_item_id       TEXT REFERENCES items(id),
    initiator_item_qty      INT NOT NULL DEFAULT 0 CHECK (initiator_item_qty >= 0),
    -- what the initiator wants back from the counterparty
    counterparty_cents      BIGINT NOT NULL DEFAULT 0 CHECK (counterparty_cents >= 0),
    counterparty_item_id    TEXT REFERENCES items(id),
    counterparty_item_qty   INT NOT NULL DEFAULT 0 CHECK (counterparty_item_qty >= 0),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at             TIMESTAMPTZ,
    CHECK (initiator_id != counterparty_id),
    CHECK (initiator_cents > 0 OR initiator_item_id IS NOT NULL OR counterparty_cents > 0 OR counterparty_item_id IS NOT NULL) -- no empty no-op trades
);
CREATE INDEX idx_trades_counterparty_pending ON trades(counterparty_id) WHERE status = 'pending';
CREATE INDEX idx_trades_initiator_pending ON trades(initiator_id) WHERE status = 'pending';

COMMIT;
