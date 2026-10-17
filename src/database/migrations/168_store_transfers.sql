-- 168_store_transfers.sql
--
-- Stock sent to a store no longer HAS to be saleable the moment it is sent. A transfer can be sent "on the way"
-- (IN_TRANSIT): the units leave the purchase's free stock, but the store's shelf stock does not change until the store
-- confirms what actually arrived (APPLIED). Anything short is written off as lost on the way; a transfer that never left
-- can be cancelled (CANCELLED) and its units are free again.
--
--   applied_at   when the stock became saleable at the store (the moment of the stock movement). Existing rows: their creation time.
--   received_by  who confirmed it
-- IN_TRANSIT / CANCELLED allocations have no stock movement.

ALTER TABLE procurement_allocations DROP CONSTRAINT IF EXISTS procurement_allocations_status_check;
ALTER TABLE procurement_allocations ADD CONSTRAINT procurement_allocations_status_check CHECK (status IN ('IN_TRANSIT','APPLIED','REVERSED','CANCELLED'));
ALTER TABLE procurement_allocations ADD COLUMN IF NOT EXISTS applied_at  TIMESTAMPTZ;
ALTER TABLE procurement_allocations ADD COLUMN IF NOT EXISTS received_by UUID REFERENCES users(id) ON DELETE SET NULL;
UPDATE procurement_allocations SET applied_at = created_at WHERE applied_at IS NULL AND status IN ('APPLIED','REVERSED');
CREATE INDEX IF NOT EXISTS idx_proc_alloc_transit ON procurement_allocations (created_at) WHERE status = 'IN_TRANSIT';
