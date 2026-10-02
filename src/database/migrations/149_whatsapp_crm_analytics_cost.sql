-- 149_whatsapp_crm_analytics_cost.sql
--
-- WhatsApp CRM — Phase 10: analytics and cost.
--
-- Nothing is copied into report tables: every figure is computed from the records that already
-- exist (wa_messages, wa_campaign_recipients, wa_workflow_runs, orders…), so a webhook that arrives
-- late simply makes the next report right.
--
-- What is new:
--   * wa_messages.billable / billing_category / billing_type — what Meta says it charged for, taken from
--     the `pricing` block on delivery webhooks (Phase 1 already parsed it, nothing stored it). Cost uses
--     these when present and falls back to an ESTIMATE from the template category when they are not.
--   * wa_rate_cards — what a message costs, per category, from a date. VERSIONED and insert-only:
--     a price change is a new row with a new effective_from; old rows are never edited, so past
--     reports do not drift. Nothing is hard-coded or seeded — rates are copied from Meta's published
--     rate card by someone who can vouch for them (agreement §13).
--   * indexes for the report queries.
-- Permissions (free-form strings in roles.permissions, CRM Manager + Super Admin only):
--   crm.analytics.view   see the analytics and cost reports
--   crm.rates.manage     add / remove (future-dated) rate card versions

ALTER TABLE wa_messages
  ADD COLUMN IF NOT EXISTS billable         BOOLEAN,
  ADD COLUMN IF NOT EXISTS billing_category VARCHAR(20),
  ADD COLUMN IF NOT EXISTS billing_type     VARCHAR(30);

CREATE TABLE IF NOT EXISTS wa_rate_cards (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category       VARCHAR(14) NOT NULL CHECK (category IN ('MARKETING','UTILITY','AUTHENTICATION','SERVICE')),
  rate           NUMERIC(10,4) NOT NULL CHECK (rate >= 0),     -- rupees per message
  effective_from DATE NOT NULL,
  note           VARCHAR(200),
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_wa_rate_card UNIQUE (category, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_wa_messages_out_created
  ON wa_messages (created_at) WHERE direction = 'OUTBOUND';
CREATE INDEX IF NOT EXISTS idx_wa_messages_in_contact_created
  ON wa_messages (contact_id, created_at) WHERE direction = 'INBOUND';
CREATE INDEX IF NOT EXISTS idx_wa_messages_workflow
  ON wa_messages (workflow_id) WHERE workflow_id IS NOT NULL;

UPDATE roles SET permissions = (
  SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb)
    FROM jsonb_array_elements_text(permissions || '["crm.analytics.view","crm.rates.manage"]'::jsonb) AS p
 )
 WHERE name IN ('CRM Manager', 'Super Admin');
