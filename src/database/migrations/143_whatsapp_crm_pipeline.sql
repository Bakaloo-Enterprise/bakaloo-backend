-- 143_whatsapp_crm_pipeline.sql
--
-- WhatsApp CRM — Phase 4: customer lifecycle pipeline (Kanban).
--
-- A card is a WhatsApp contact. Its stage lives on wa_contacts so it follows
-- the customer. Stages are ROWS (configurable), not an enum:
--   * is_auto = true  : the system may move cards in/out (order count, phone
--                       registration, first agent reply). Seeded ladder:
--                       lead -> conversation -> customer -> first_order ->
--                       second_order -> third_order -> repeat
--   * is_auto = false : human-only stages (Success, Needs Follow-up, B2B
--                       Opportunity, Negotiation). Automation NEVER moves a
--                       card out of one — a person decided it.
-- stage_source records who put the card where it is (AUTO | MANUAL); the rules
-- are in modules/whatsapp-crm/pipeline.js and are unit-tested.
--
-- "Order placed" = status NOT IN (PENDING, CANCELLED, REFUNDED): PENDING is an
-- unpaid order that can still expire, so it does not count yet. Cancelling an
-- order moves an AUTO card back; a MANUAL one stays put.
-- Evaluation is done by a reconcile job (no trigger on orders/users).
--
-- New CRM permissions (free-form strings, like migration 142):
--   crm.pipeline.view   see the board
--   crm.pipeline.move   drag a card to another stage

CREATE TABLE IF NOT EXISTS crm_stages (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key        VARCHAR(30) NOT NULL UNIQUE,
  name       VARCHAR(60) NOT NULL,
  position   INTEGER NOT NULL,
  is_auto    BOOLEAN NOT NULL,
  color      VARCHAR(7) NOT NULL DEFAULT '#64748B' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO crm_stages (key, name, position, is_auto, color) VALUES
  ('lead',            'WhatsApp Lead',        10, true,  '#6B7280'),
  ('conversation',    'Conversation',         20, true,  '#0369A1'),
  ('customer',        'Customer',             30, true,  '#2563EB'),
  ('first_order',     '1st Order',            40, true,  '#0F766E'),
  ('second_order',    '2nd Order',            50, true,  '#16A34A'),
  ('third_order',     '3rd Order',            60, true,  '#65A30D'),
  ('repeat',          'Repeat Customer',      70, true,  '#CA8A04'),
  ('success',         'Success / Monitoring', 80, false, '#9333EA'),
  ('follow_up',       'Needs Follow-up',      90, false, '#DC2626'),
  ('b2b_opportunity', 'B2B Opportunity',     100, false, '#0D9488'),
  ('negotiation',     'Negotiation',         110, false, '#EA580C')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE wa_contacts
  ADD COLUMN IF NOT EXISTS stage_id         UUID REFERENCES crm_stages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stage_source     VARCHAR(6) NOT NULL DEFAULT 'AUTO' CHECK (stage_source IN ('AUTO','MANUAL')),
  ADD COLUMN IF NOT EXISTS stage_changed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_wa_contacts_stage ON wa_contacts(stage_id);

CREATE TABLE IF NOT EXISTS crm_stage_history (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id    UUID NOT NULL REFERENCES wa_contacts(id) ON DELETE CASCADE,
  from_stage_id UUID REFERENCES crm_stages(id) ON DELETE SET NULL,
  to_stage_id   UUID REFERENCES crm_stages(id) ON DELETE SET NULL,
  source        VARCHAR(6) NOT NULL CHECK (source IN ('AUTO','MANUAL')),
  reason        VARCHAR(120),
  changed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crm_stage_history_contact ON crm_stage_history(contact_id, created_at DESC);

-- Helps the reconcile job's per-customer confirmed-order count.
CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(user_id, status);

UPDATE roles SET permissions = (
  SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb)
    FROM jsonb_array_elements_text(permissions || '["crm.pipeline.view","crm.pipeline.move"]'::jsonb) AS p
 )
 WHERE name IN ('CRM Agent', 'CRM Manager', 'Super Admin');
