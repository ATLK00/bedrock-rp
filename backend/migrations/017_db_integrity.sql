-- 017_db_integrity.sql
-- Hardening pass -- indexes/constraints only, no column changes.
-- Idempotent-friendly (IF NOT EXISTS guards) since this is the first
-- pass that revisits tables created by earlier migrations.

-- transactions: the hot history query is (character_id, created_at desc).
CREATE INDEX IF NOT EXISTS idx_transactions_character_created
  ON transactions (character_id, created_at DESC);

-- audit_log is filtered by target during admin investigations.
CREATE INDEX IF NOT EXISTS idx_audit_log_target
  ON audit_log (target_type, target_id);

-- whitelist enforcement looks up characters where whitelisted = true.
CREATE INDEX IF NOT EXISTS idx_characters_whitelisted_active
  ON characters (whitelisted) WHERE whitelisted = true;

-- active-session revocation sweeps per user; partial index stays lean.
CREATE INDEX IF NOT EXISTS idx_sessions_user_active
  ON sessions (user_id) WHERE revoked_at IS NULL;

-- inventory remove paths join slots on item_id.
CREATE INDEX IF NOT EXISTS idx_inventory_slots_item
  ON inventory_slots (item_id);

-- A slot is either empty (NULL item, qty 0) or holds a real item with a
-- positive quantity -- never NULL item with qty > 0, never item with qty 0.
ALTER TABLE inventory_slots
  ADD CONSTRAINT chk_inventory_slots_consistency
  CHECK (
    (item_id IS NULL AND quantity = 0) OR
    (item_id IS NOT NULL AND quantity > 0)
  );

-- trade cleanup/jobs filter by status then created_at.
CREATE INDEX IF NOT EXISTS idx_trades_status_created
  ON trades (status, created_at);