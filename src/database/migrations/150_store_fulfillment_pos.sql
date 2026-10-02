-- 150_store_fulfillment_pos.sql
--
-- Store Fulfillment POS (Phase 11). NOT a walk-in billing counter: the internal screen store staff use to
-- prepare ONLINE orders — pick, scan, pack, verify, print, hand to the right rider.
--
-- Reuse, not rebuild: orders / order_items / order_status_history, delivery_assignments, order_pickup_tokens
-- and qr_scan_logs (rider-side signed QR) already exist. Order status moves still go through the existing shop
-- order service and rider assignment through FinalizeAssignmentService (the only writer that mints pickup
-- tokens), so notifications, audit and the rider app keep working. This migration adds only what the existing
-- tables cannot say: who picked/packed, what was scanned, what is missing, what was printed, who handed over.
--
-- Roles: Picker / Packer are a STATION on a SHOP_STAFF member (pos_station), not new shop_staff.role values — the
-- canonical RBAC vocabulary and the dashboard's role handling stay untouched. NULL station = an all-round
-- staff member who can pick and pack.
--
-- "Where an order is" (New / Picking / Packing / Ready / Waiting for rider / Picked up / Out for delivery) is
-- DERIVED from orders.status + pos_fulfillments + the current assignment — never stored twice.

ALTER TABLE shop_staff
  ADD COLUMN IF NOT EXISTS pos_station VARCHAR(8) CHECK (pos_station IS NULL OR pos_station IN ('PICKER','PACKER'));

-- One row per order the store has started working on (or had a picker/packer assigned).
CREATE TABLE IF NOT EXISTS pos_fulfillments (
  order_id         UUID PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  shop_id          UUID NOT NULL REFERENCES shops(id),
  stage            VARCHAR(8) NOT NULL DEFAULT 'PICKING' CHECK (stage IN ('PICKING','PACKING','DONE')),
  picker_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  packer_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  pick_started_at  TIMESTAMPTZ,
  pick_finished_at TIMESTAMPTZ,
  pack_started_at  TIMESTAMPTZ,
  pack_finished_at TIMESTAMPTZ,
  package_count    INTEGER NOT NULL DEFAULT 1 CHECK (package_count BETWEEN 1 AND 20),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pos_fulfillments_shop_stage ON pos_fulfillments (shop_id, stage);
CREATE INDEX IF NOT EXISTS idx_pos_fulfillments_picker ON pos_fulfillments (picker_id) WHERE picker_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pos_fulfillments_packer ON pos_fulfillments (packer_id) WHERE packer_id IS NOT NULL;

-- The digital pick list: one row per order line, snapshotted when picking starts.
CREATE TABLE IF NOT EXISTS pos_lines (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id       UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id  UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  shop_id        UUID NOT NULL REFERENCES shops(id),
  product_id     UUID REFERENCES products(id) ON DELETE SET NULL,
  name           VARCHAR(255) NOT NULL,
  unit           VARCHAR(40),
  image_url      TEXT,
  barcode        VARCHAR(100),
  sku            VARCHAR(100),
  required_qty   INTEGER NOT NULL CHECK (required_qty > 0),
  picked_qty     INTEGER NOT NULL DEFAULT 0 CHECK (picked_qty >= 0),
  packed_qty     INTEGER NOT NULL DEFAULT 0 CHECK (packed_qty >= 0),
  status         VARCHAR(8) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PICKED','MISSING','RESOLVED')),
  missing_note   VARCHAR(300),
  missing_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  missing_at     TIMESTAMPTZ,
  decision       VARCHAR(8) CHECK (decision IS NULL OR decision IN ('REPLACE','REMOVE','REFUND')),
  decision_note  VARCHAR(300),
  decided_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at     TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_pos_line_item UNIQUE (order_item_id),
  CONSTRAINT chk_pos_line_picked CHECK (picked_qty <= required_qty),
  CONSTRAINT chk_pos_line_decision CHECK ((status = 'RESOLVED') = (decision IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_pos_lines_order ON pos_lines (order_id);
CREATE INDEX IF NOT EXISTS idx_pos_lines_missing ON pos_lines (shop_id) WHERE status = 'MISSING';

-- Every scan attempt, accepted or not. A wrong scan is never silently accepted, and it is counted.
CREATE TABLE IF NOT EXISTS pos_scans (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shop_id   UUID NOT NULL REFERENCES shops(id),
  order_id  UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_id   UUID REFERENCES pos_lines(id) ON DELETE SET NULL,
  stage     VARCHAR(4) NOT NULL CHECK (stage IN ('PICK','PACK')),
  code      VARCHAR(120),
  result    VARCHAR(12) NOT NULL CHECK (result IN ('OK','MANUAL','WRONG_ITEM','OVER_QTY','NOT_NEEDED')),
  user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pos_scans_order ON pos_scans (order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pos_scans_shop_time ON pos_scans (shop_id, created_at);

-- Printers a store has set up. kind BROWSER = a print station (a browser tab at the printer);
-- the same queue API can serve a network/ESC-POS agent later.
CREATE TABLE IF NOT EXISTS pos_printers (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shop_id      UUID NOT NULL REFERENCES shops(id),
  name         VARCHAR(80) NOT NULL,
  paper_mm     INTEGER NOT NULL DEFAULT 80 CHECK (paper_mm IN (58, 80, 210)),
  kind         VARCHAR(8) NOT NULL DEFAULT 'BROWSER' CHECK (kind IN ('BROWSER')),
  is_default   BOOLEAN NOT NULL DEFAULT FALSE,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_printer_default ON pos_printers (shop_id) WHERE is_default AND is_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_printer_name ON pos_printers (shop_id, lower(name)) WHERE is_active;

-- The print queue. The POS never pretends something printed: a job is PRINTED only when a station says so.
CREATE TABLE IF NOT EXISTS pos_print_jobs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shop_id       UUID NOT NULL REFERENCES shops(id),
  order_id      UUID REFERENCES orders(id) ON DELETE CASCADE,
  printer_id    UUID REFERENCES pos_printers(id) ON DELETE SET NULL,
  kind          VARCHAR(8) NOT NULL CHECK (kind IN ('INVOICE','LABEL','TEST')),
  package_no    INTEGER,
  package_total INTEGER,
  status        VARCHAR(10) NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','PRINTING','PRINTED','FAILED','CANCELLED')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    VARCHAR(300),
  claimed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  claimed_at    TIMESTAMPTZ,
  printed_at    TIMESTAMPTZ,
  reprint_of    UUID REFERENCES pos_print_jobs(id) ON DELETE SET NULL,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pos_print_jobs_queue ON pos_print_jobs (shop_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_pos_print_jobs_order ON pos_print_jobs (order_id);

-- Proof of responsibility at the store door: which staff member released which package to which rider.
CREATE TABLE IF NOT EXISTS pos_handovers (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shop_id       UUID NOT NULL REFERENCES shops(id),
  assignment_id UUID NOT NULL REFERENCES delivery_assignments(id) ON DELETE CASCADE,
  rider_id      UUID NOT NULL REFERENCES users(id),
  staff_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  token_id      UUID REFERENCES order_pickup_tokens(id) ON DELETE SET NULL,
  scan_result   VARCHAR(12) NOT NULL CHECK (scan_result IN ('VERIFIED','CONSUMED')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_pos_handover_assignment UNIQUE (assignment_id)
);
CREATE INDEX IF NOT EXISTS idx_pos_handovers_shop ON pos_handovers (shop_id, created_at);

-- Append-only audit trail of everything the POS did (the order's own status history and the rider's QR scans
-- are merged in when the timeline is read; they are not copied here).
CREATE TABLE IF NOT EXISTS pos_events (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id    UUID NOT NULL REFERENCES shops(id),
  order_id   UUID REFERENCES orders(id) ON DELETE CASCADE,
  actor_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  kind       VARCHAR(32) NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pos_events_order ON pos_events (order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pos_events_shop_time ON pos_events (shop_id, created_at DESC);

-- Needs-Attention items are DERIVED live (so they can never drift from reality); this only remembers which a
-- manager has dealt with.
CREATE TABLE IF NOT EXISTS pos_attention_resolutions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shop_id     UUID NOT NULL REFERENCES shops(id),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind        VARCHAR(24) NOT NULL,
  ref         VARCHAR(80) NOT NULL DEFAULT '',
  note        VARCHAR(300),
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_pos_attention UNIQUE (order_id, kind, ref)
);
