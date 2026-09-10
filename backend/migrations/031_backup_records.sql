-- 031_backup_records.sql
-- Backup ledger (#5): every backup / verify / wipe / restore control action
-- records where the dump lives on disk, who ordered it, and the integrity
-- facts (size + sha256) needed to verify the file later.

BEGIN;

CREATE TABLE backup_records (
    id              BIGSERIAL PRIMARY KEY,
    filename        TEXT NOT NULL,
    app_version     TEXT NOT NULL,
    size_bytes      BIGINT NOT NULL,
    checksum_sha256 TEXT NOT NULL,
    created_by      BIGINT REFERENCES users(id),
    status          TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','failed','restored')),
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_backup_records_created ON backup_records (created_at DESC);

COMMIT;