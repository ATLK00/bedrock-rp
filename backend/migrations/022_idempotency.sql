-- 022_idempotency.sql
-- Reusable idempotency store. A mutation that carries an Idempotency-Key
-- header inserts its (scope, key, request-hash) inside the SAME
-- transaction as the mutation itself; a concurrent or retried request
-- with the same key fails the INSERT (does nothing to the state) and is
-- reported as already-processed. Keyed per scope so one key can never
-- replay across different operations.

BEGIN;

CREATE TABLE idempotency_keys (
    id_key        TEXT NOT NULL,
    scope         TEXT NOT NULL,
    request_hash  TEXT NOT NULL,
    result_status INT NOT NULL,
    result_body   JSONB,
    created_by    BIGINT REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id_key, scope)
);

CREATE INDEX idx_idempotency_created ON idempotency_keys (created_at);

COMMIT;