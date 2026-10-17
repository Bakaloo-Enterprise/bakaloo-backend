-- 160_procurement_receiving.sql
--
-- Procurement step 2: receiving + quality check. A purchase can now be placed BEFORE the goods arrive
-- (status ORDERED, received_qty 0) and is then "received" once the manager has counted and checked it.
-- Stock figures need no change: usable = received − damaged, so an ORDERED entry simply holds 0 until it is received.
--
--   owed_qty        = what the supplier still has to bring (short delivery they will make up, or a replacement
--                     for rejected goods). It counts as "incoming" in the purchase plan.
--   received_at/by  = when and who confirmed the receipt.
--
-- Rejected goods are recorded with the vocabulary that already exists: thrown away = damaged_qty (a loss),
-- sent back / to be replaced = a VENDOR_RETURN adjustment (recovered cost, not a loss).

ALTER TABLE procurement_entries DROP CONSTRAINT IF EXISTS procurement_entries_received_qty_check;
ALTER TABLE procurement_entries ADD CONSTRAINT procurement_entries_received_qty_check CHECK (received_qty >= 0);
ALTER TABLE procurement_entries DROP CONSTRAINT IF EXISTS procurement_entries_status_check;
ALTER TABLE procurement_entries ADD CONSTRAINT procurement_entries_status_check CHECK (status IN ('ORDERED','ACTIVE','CANCELLED'));
ALTER TABLE procurement_entries DROP CONSTRAINT IF EXISTS chk_proc_received_when_active;
ALTER TABLE procurement_entries ADD CONSTRAINT chk_proc_received_when_active CHECK (status <> 'ACTIVE' OR received_qty > 0);

ALTER TABLE procurement_entries ADD COLUMN IF NOT EXISTS owed_qty INTEGER NOT NULL DEFAULT 0 CHECK (owed_qty >= 0);
ALTER TABLE procurement_entries ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;
ALTER TABLE procurement_entries ADD COLUMN IF NOT EXISTS received_by UUID REFERENCES users(id) ON DELETE SET NULL;
UPDATE procurement_entries SET received_at = created_at WHERE received_at IS NULL AND status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_proc_entries_open ON procurement_entries (status) WHERE status = 'ORDERED' OR owed_qty > 0;
