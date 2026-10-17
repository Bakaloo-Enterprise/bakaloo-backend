-- 162_b2b_reservations.sql
--
-- Procurement step 4: reserve B2B stock BY QUANTITY and send the rest to stores with one confirmed plan.
--
-- A reservation holds some units of ONE purchase for ONE customer request. The units stay in the central stock of
-- that purchase (they are never put on a store shelf), so retail cannot sell them and no retail stock check has to
-- change. Free stock of a purchase = usable − sent to stores − taken out − reserved.
--
-- Delivering the request turns each reservation into the existing "supplied to a B2B order" adjustment, so the
-- stock leaves exactly once. Cancelling the request (or releasing by hand) frees the units again.

CREATE TABLE IF NOT EXISTS b2b_reservations (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  requirement_id UUID NOT NULL REFERENCES b2b_requirements(id),
  product_id     UUID NOT NULL REFERENCES products(id),
  entry_id       UUID NOT NULL REFERENCES procurement_entries(id),
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  status         VARCHAR(10) NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED','FULFILLED','RELEASED')),
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_b2b_res_entry ON b2b_reservations (entry_id) WHERE status = 'RESERVED';
CREATE INDEX IF NOT EXISTS idx_b2b_res_req ON b2b_reservations (requirement_id, product_id);
