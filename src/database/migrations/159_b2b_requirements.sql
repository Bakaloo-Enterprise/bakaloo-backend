-- 159_b2b_requirements.sql
--
-- Procurement step 1: "what do we need to buy, and why". A B2B requirement is a restaurant/shop asking for goods
-- through a channel that does NOT create an app order: a normal WhatsApp chat, a phone call, a walk-in, or a Meta
-- (Cloud API) WhatsApp conversation handled in the CRM inbox. Requests that arrive as real app orders are NOT copied
-- here — the demand view reads orders with b2b_approval_status = 'PENDING' directly, so nothing is counted twice.
--
-- Stock is not touched by this table. A requirement only feeds the purchase plan; delivery and stock deduction keep
-- using the existing order / procurement paths.

CREATE TABLE IF NOT EXISTS b2b_requirements (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  req_no              BIGINT GENERATED ALWAYS AS IDENTITY,
  customer_name       VARCHAR(120) NOT NULL,
  customer_phone      VARCHAR(20),
  business_account_id UUID REFERENCES business_accounts(id) ON DELETE SET NULL,
  wa_conversation_id  UUID REFERENCES wa_conversations(id) ON DELETE SET NULL,
  source              VARCHAR(20) NOT NULL
                        CHECK (source IN ('WHATSAPP_META','WHATSAPP_PERSONAL','PHONE_CALL','WALK_IN','OTHER')),
  -- INQUIRY = "might need" (projected only). CONFIRMED = promised, counts as committed demand.
  status              VARCHAR(10) NOT NULL DEFAULT 'INQUIRY' CHECK (status IN ('INQUIRY','CONFIRMED','DELIVERED','CANCELLED')),
  delivery_date       DATE,
  payment_terms       VARCHAR(12) NOT NULL DEFAULT 'COD' CHECK (payment_terms IN ('COD','UPI','ADVANCE_PAID','CREDIT','PARTIAL')),
  note                VARCHAR(500),
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_b2b_req_status ON b2b_requirements (status, delivery_date);
CREATE INDEX IF NOT EXISTS idx_b2b_req_convo ON b2b_requirements (wa_conversation_id) WHERE wa_conversation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS b2b_requirement_items (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  requirement_id UUID NOT NULL REFERENCES b2b_requirements(id) ON DELETE CASCADE,
  product_id     UUID NOT NULL REFERENCES products(id),
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  -- Agreed selling price per unit; NULL = not negotiated yet.
  unit_price     NUMERIC(12,2) CHECK (unit_price IS NULL OR unit_price >= 0),
  UNIQUE (requirement_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_b2b_req_items_product ON b2b_requirement_items (product_id);

CREATE TABLE IF NOT EXISTS b2b_requirement_events (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requirement_id UUID NOT NULL REFERENCES b2b_requirements(id) ON DELETE CASCADE,
  actor_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  kind           VARCHAR(24) NOT NULL,
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_b2b_req_events ON b2b_requirement_events (requirement_id, created_at);
