-- 146_whatsapp_crm_campaigns_workflows.sql
--
-- WhatsApp CRM — Phase 7: campaigns, automation workflows, abandoned-cart WhatsApp.
--
-- Rules this schema supports (agreement §06, Meta policy):
--   * a campaign only sends an APPROVED template, only to contacts with recorded opt-in,
--     never to opted-out or suppressed contacts (re-checked at send time);
--   * the audience is snapshotted into wa_campaign_recipients when the campaign is launched,
--     so progress is countable and a recipient can never be messaged twice
--     (UNIQUE (campaign_id, contact_id));
--   * delivery / read state is NOT copied here — it is read from wa_messages through message_id,
--     so the webhook status updates already in place stay the single source of truth;
--   * workflows are WHEN (trigger) / IF (conditions) / DO (actions) rows; each run is claimed by
--     INSERT … ON CONFLICT DO NOTHING on (workflow, subject), so an event fires at most once even
--     with several workers, and a crash mid-run is marked INTERRUPTED instead of re-sent.
--
-- Permissions (free-form strings, like 142–145):
--   crm.campaigns.view     see campaigns + results
--   crm.campaigns.manage   create / launch / pause / cancel, record consent, manage suppression
--   crm.workflows.manage   create / edit / switch workflows on and off

-- ─── Consent bookkeeping ─────────────────────────────────────────────
ALTER TABLE wa_contacts
  ADD COLUMN IF NOT EXISTS consent_source VARCHAR(40);   -- e.g. CUSTOMER_REPLY, CHECKOUT_FORM, STAFF_RECORDED

-- Manual do-not-contact list (complaints, legal). Separate from consent: a suppressed contact is
-- skipped by campaigns and workflows even if they once opted in.
CREATE TABLE IF NOT EXISTS wa_suppression (
  contact_id  UUID PRIMARY KEY REFERENCES wa_contacts(id) ON DELETE CASCADE,
  reason      VARCHAR(200),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Campaigns ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_campaigns (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name             VARCHAR(120) NOT NULL,
  template_id      UUID NOT NULL REFERENCES wa_templates(id) ON DELETE RESTRICT,
  template_values  JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {variableKey: "literal or {{customer_name}}"}
  header_media_url TEXT,
  -- {type: 'SEGMENT'|'LABEL'|'STAGE'|'ALL_OPTED_IN', ids: [uuid]}
  audience         JSONB NOT NULL,
  status           VARCHAR(10) NOT NULL DEFAULT 'DRAFT'
                     CHECK (status IN ('DRAFT','SCHEDULED','SENDING','PAUSED','COMPLETED','CANCELLED')),
  pause_reason     VARCHAR(200),
  scheduled_at     TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  rate_per_minute  INTEGER NOT NULL DEFAULT 60 CHECK (rate_per_minute BETWEEN 1 AND 600),
  total_recipients INTEGER NOT NULL DEFAULT 0,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_campaigns_status ON wa_campaigns (status, scheduled_at);

CREATE TABLE IF NOT EXISTS wa_campaign_recipients (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id UUID NOT NULL REFERENCES wa_campaigns(id) ON DELETE CASCADE,
  contact_id  UUID NOT NULL REFERENCES wa_contacts(id) ON DELETE CASCADE,
  status      VARCHAR(10) NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','SENDING','SENT','FAILED','SKIPPED')),
  skip_reason VARCHAR(30),          -- NO_CONSENT | OPTED_OUT | SUPPRESSED | NO_ADDRESS | …
  error_code  INTEGER,
  error_text  VARCHAR(300),
  attempts    INTEGER NOT NULL DEFAULT 0,
  message_id  UUID REFERENCES wa_messages(id) ON DELETE SET NULL,
  claimed_at  TIMESTAMPTZ,
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_wa_campaign_recipient UNIQUE (campaign_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_wa_campaign_recipients_todo ON wa_campaign_recipients (campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_wa_campaign_recipients_msg ON wa_campaign_recipients (message_id) WHERE message_id IS NOT NULL;

ALTER TABLE wa_messages
  ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES wa_campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS workflow_id UUID;
CREATE INDEX IF NOT EXISTS idx_wa_messages_campaign ON wa_messages (campaign_id) WHERE campaign_id IS NOT NULL;

-- ─── Workflows (WHEN / IF / DO) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_workflows (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name           VARCHAR(120) NOT NULL,
  description    VARCHAR(300),
  trigger_type   VARCHAR(20) NOT NULL CHECK (trigger_type IN ('CART_ABANDONED','ORDER_STATUS')),
  trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {delay_minutes} | {status}
  conditions     JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{field, op, value}]
  actions        JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{type:'SEND_TEMPLATE'|'ADD_LABEL', ...}]
  is_active      BOOLEAN NOT NULL DEFAULT FALSE,
  activated_at   TIMESTAMPTZ,                          -- only events AFTER this fire (no back-fill spam)
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_workflows_active ON wa_workflows (trigger_type) WHERE is_active;

CREATE TABLE IF NOT EXISTS wa_workflow_runs (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workflow_id  UUID NOT NULL REFERENCES wa_workflows(id) ON DELETE CASCADE,
  subject_type VARCHAR(20) NOT NULL CHECK (subject_type IN ('ABANDONED_CART','ORDER_STATUS')),
  subject_id   UUID NOT NULL,                          -- abandoned_carts.id | order_status_history.id
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  contact_id   UUID REFERENCES wa_contacts(id) ON DELETE SET NULL,
  status       VARCHAR(12) NOT NULL DEFAULT 'RUNNING'
                 CHECK (status IN ('RUNNING','SENT','SKIPPED','FAILED','INTERRUPTED')),
  reason       VARCHAR(60),                            -- why skipped / failed
  message_id   UUID REFERENCES wa_messages(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  CONSTRAINT uq_wa_workflow_run UNIQUE (workflow_id, subject_type, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_wa_workflow_runs_wf ON wa_workflow_runs (workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_workflow_runs_running ON wa_workflow_runs (created_at) WHERE status = 'RUNNING';

-- Links an abandoned-cart episode to the WhatsApp message(s) sent for it, beside the existing
-- app-push link table abandoned_cart_notifications.
CREATE TABLE IF NOT EXISTS abandoned_cart_wa_messages (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  abandoned_cart_id UUID NOT NULL REFERENCES abandoned_carts(id) ON DELETE CASCADE,
  message_id        UUID NOT NULL REFERENCES wa_messages(id) ON DELETE CASCADE,
  workflow_run_id   UUID REFERENCES wa_workflow_runs(id) ON DELETE SET NULL,
  coupon_id         UUID REFERENCES coupons(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_abandoned_cart_wa_cart ON abandoned_cart_wa_messages (abandoned_cart_id);

-- ─── Permissions ─────────────────────────────────────────────────────
UPDATE roles SET permissions = (
  SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb)
    FROM jsonb_array_elements_text(permissions || '["crm.campaigns.view","crm.campaigns.manage","crm.workflows.manage"]'::jsonb) AS p
 )
 WHERE name IN ('CRM Manager', 'Super Admin');
