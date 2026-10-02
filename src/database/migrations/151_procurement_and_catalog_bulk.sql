-- 151_procurement_and_catalog_bulk.sql
--
-- Phase 12 (PDF §15-19): procurement intake + split across stores, returns/damage/adjustments, and the bulk
-- Excel/CSV catalog tool. Business analytics (§18-19) adds NO tables — every figure is computed live.
--
-- Reuse, not rebuild: store stock is shop_products.stock_quantity and every change to it still goes through the
-- one audited path (ShopProductsRepository.applyStockChange → stock_movements). This migration only widens the
-- movement vocabulary and adds what the existing tables cannot say: what was bought, from whom, at what cost,
-- where it went and why quantities differ.
--
-- Whole units: stock_quantity is an INTEGER, so procurement quantities are whole units of the product's selling
-- unit (a 10 kg purchase of a "1 kg" product is 10).

ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS chk_stock_movements_type;
-- NOT VALID: new rows are checked straight away, but the (large) existing table is NOT re-scanned while the table is
-- locked. Every existing row already satisfies this list (it only adds values), and migration 153 validates it
-- afterwards in its own step, which does not block order writes.
ALTER TABLE stock_movements ADD CONSTRAINT chk_stock_movements_type CHECK (type IN
  ('MANUAL_ADJUSTMENT','ORDER_DEDUCTION','CANCELLATION_RESTORE','DAMAGED_STOCK','RETURN_STOCK',
   'PROCUREMENT_RECEIPT','PROCUREMENT_REVERSAL','BULK_UPDATE')) NOT VALID;

CREATE TABLE IF NOT EXISTS vendors (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       VARCHAR(120) NOT NULL,
  phone      VARCHAR(20),
  notes      VARCHAR(300),
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendors_name ON vendors (LOWER(name));

-- One purchase of one product from one vendor.
CREATE TABLE IF NOT EXISTS procurement_entries (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entry_no            BIGINT GENERATED ALWAYS AS IDENTITY,
  product_id          UUID NOT NULL REFERENCES products(id),
  vendor_id           UUID NOT NULL REFERENCES vendors(id),
  unit                VARCHAR(40),
  expected_qty        INTEGER NOT NULL CHECK (expected_qty > 0),
  received_qty        INTEGER NOT NULL CHECK (received_qty > 0),
  damaged_qty         INTEGER NOT NULL DEFAULT 0 CHECK (damaged_qty >= 0),
  unit_price          NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  purchase_total      NUMERIC(12,2) NOT NULL CHECK (purchase_total >= 0),
  procured_on         DATE NOT NULL,
  invoice_ref         VARCHAR(80),
  receiving_note      VARCHAR(300),
  -- NULL = central: management may split it over any stores. Set = only that branch / dark store may receive it.
  destination_shop_id UUID REFERENCES shops(id),
  -- B2B_RESERVED stock cannot be sent to a store's retail stock until the reservation is released.
  purpose             VARCHAR(12) NOT NULL DEFAULT 'RETAIL' CHECK (purpose IN ('RETAIL','B2B_RESERVED')),
  business_account_id UUID REFERENCES business_accounts(id) ON DELETE SET NULL,
  reservation_note    VARCHAR(300),
  status              VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED')),
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_proc_damaged CHECK (damaged_qty <= received_qty),
  CONSTRAINT chk_proc_reserved CHECK (purpose = 'RETAIL' OR business_account_id IS NOT NULL OR reservation_note IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_proc_entries_date ON procurement_entries (procured_on DESC);
CREATE INDEX IF NOT EXISTS idx_proc_entries_product ON procurement_entries (product_id, procured_on DESC);
CREATE INDEX IF NOT EXISTS idx_proc_entries_vendor ON procurement_entries (vendor_id, procured_on DESC);

-- Stock sent from an entry to a store. Applied immediately (one transaction with the stock change).
CREATE TABLE IF NOT EXISTS procurement_allocations (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entry_id             UUID NOT NULL REFERENCES procurement_entries(id),
  shop_id              UUID NOT NULL REFERENCES shops(id),
  shop_product_id      UUID NOT NULL REFERENCES shop_products(id),
  quantity             INTEGER NOT NULL CHECK (quantity > 0),
  status               VARCHAR(10) NOT NULL DEFAULT 'APPLIED' CHECK (status IN ('APPLIED','REVERSED')),
  movement_id          UUID REFERENCES stock_movements(id),
  reversal_movement_id UUID REFERENCES stock_movements(id),
  note                 VARCHAR(300),
  created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reversed_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  reversed_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_proc_alloc_entry ON procurement_allocations (entry_id);
CREATE INDEX IF NOT EXISTS idx_proc_alloc_shop ON procurement_allocations (shop_id, created_at DESC);

-- Why available stock differs from what was bought. shop_id NULL = taken out of the central (unallocated) stock;
-- shop_id set = lost / returned from that store's allocated stock (its stock is reduced too).
CREATE TABLE IF NOT EXISTS procurement_adjustments (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entry_id    UUID NOT NULL REFERENCES procurement_entries(id),
  kind        VARCHAR(24) NOT NULL CHECK (kind IN ('VENDOR_RETURN','DAMAGE','WASTAGE','AUTHORIZED_ADJUSTMENT','B2B_SUPPLY')),
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  shop_id     UUID REFERENCES shops(id),
  movement_id UUID REFERENCES stock_movements(id),
  unit_cost   NUMERIC(12,2) NOT NULL DEFAULT 0,
  reason      VARCHAR(300) NOT NULL,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_proc_adj_entry ON procurement_adjustments (entry_id);
CREATE INDEX IF NOT EXISTS idx_proc_adj_time ON procurement_adjustments (created_at DESC);

CREATE TABLE IF NOT EXISTS procurement_events (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id   UUID NOT NULL REFERENCES procurement_entries(id) ON DELETE CASCADE,
  actor_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  kind       VARCHAR(32) NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_proc_events_entry ON procurement_events (entry_id, created_at);

-- Bulk catalog upload: nothing is applied until a person confirms the preview.
CREATE TABLE IF NOT EXISTS catalog_bulk_batches (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_name       VARCHAR(200),
  status          VARCHAR(10) NOT NULL DEFAULT 'PREVIEW' CHECK (status IN ('PREVIEW','APPLIED','DISCARDED')),
  total_rows      INTEGER NOT NULL DEFAULT 0,
  valid_rows      INTEGER NOT NULL DEFAULT 0,
  error_rows      INTEGER NOT NULL DEFAULT 0,
  unchanged_rows  INTEGER NOT NULL DEFAULT 0,
  shops_affected  INTEGER NOT NULL DEFAULT 0,
  products_affected INTEGER NOT NULL DEFAULT 0,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  applied_at      TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS catalog_bulk_rows (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id        UUID NOT NULL REFERENCES catalog_bulk_batches(id) ON DELETE CASCADE,
  row_no          INTEGER NOT NULL,
  raw             JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          VARCHAR(10) NOT NULL CHECK (status IN ('VALID','ERROR','UNCHANGED')),
  errors          JSONB NOT NULL DEFAULT '[]'::jsonb,
  shop_id         UUID REFERENCES shops(id),
  product_id      UUID REFERENCES products(id),
  shop_product_id UUID REFERENCES shop_products(id),
  changes         JSONB NOT NULL DEFAULT '{}'::jsonb,
  before_updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bulk_rows_batch ON catalog_bulk_rows (batch_id, row_no);

-- Permissions (free-form strings in roles.permissions, like crm.*). HQ SUPER_ADMIN / ADMIN always pass.
--   procurement.view     see entries, vendors, reconciliation
--   procurement.manage   create entries, split to stores, returns/damage/adjustments, reserve/release
--   catalog.bulk         bulk Excel update + bulk enable/disable/assign
--   analytics.business   Business Analytics dashboard
INSERT INTO roles (name, description, is_system, permissions) VALUES
  ('Procurement Manager', 'Records purchases, splits them across stores, tracks returns and damage, runs bulk catalog updates.', false,
   '["procurement.view","procurement.manage","catalog.bulk","analytics.business"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

UPDATE roles SET permissions = (
  SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb)
    FROM jsonb_array_elements_text(permissions || '["procurement.view","procurement.manage","catalog.bulk","analytics.business"]'::jsonb) AS p
 )
 WHERE name = 'Super Admin';
