-- 145_whatsapp_crm_templates.sql
--
-- WhatsApp CRM — Phase 6: message templates + Meta approval tracking.
--
-- Facts this schema follows (Meta docs, checked 2026-10-01):
--   * names are ^[a-z0-9_]+$, unique per (name, language); languages use the API
--     form en_US (webhooks send en-US — normalised in code);
--   * parameters are NAMED ({{first_name}}) or POSITIONAL ({{1}}), examples required;
--   * only APPROVED templates may be sent; PAUSED / DISABLED / REJECTED may not;
--   * Meta can RE-CATEGORISE a template (affects price) — tracked in pending_category;
--   * status changes arrive by webhook but can be missed — a periodic sync repairs that.
--
-- `purpose` is OUR library tag from the agreement (Welcome, Abandoned Cart, …),
-- independent of Meta's MARKETING / UTILITY / AUTHENTICATION billing category.
--
-- Permissions (free-form strings, like 142–144):
--   crm.templates.view    list templates, see status
--   crm.templates.send    send an APPROVED template to a customer from the inbox
--   crm.templates.manage  create / edit / submit / sync / delete

CREATE TABLE IF NOT EXISTS wa_templates (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                  VARCHAR(512) NOT NULL CHECK (name ~ '^[a-z0-9_]+$'),
  language              VARCHAR(20) NOT NULL,
  meta_category         VARCHAR(14) NOT NULL CHECK (meta_category IN ('MARKETING','UTILITY','AUTHENTICATION')),
  purpose               VARCHAR(30) NOT NULL DEFAULT 'custom',
  parameter_format      VARCHAR(10) NOT NULL DEFAULT 'NAMED' CHECK (parameter_format IN ('NAMED','POSITIONAL')),
  status                VARCHAR(16) NOT NULL DEFAULT 'DRAFT'
                          CHECK (status IN ('DRAFT','PENDING','APPROVED','REJECTED','PAUSED','DISABLED','IN_APPEAL','PENDING_DELETION','ARCHIVED','DELETED')),
  components            JSONB NOT NULL,                     -- exactly the Meta "components" array
  body_text             TEXT NOT NULL DEFAULT '',           -- denormalised for search / list preview
  header_format         VARCHAR(10),                        -- TEXT | IMAGE | VIDEO | DOCUMENT | LOCATION | NULL
  variables             JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{name, example, where}]
  allow_category_change BOOLEAN NOT NULL DEFAULT TRUE,
  meta_template_id      VARCHAR(40) UNIQUE,
  rejection_reason      VARCHAR(40),
  rejection_detail      TEXT,
  quality_score         VARCHAR(8) CHECK (quality_score IN ('GREEN','YELLOW','RED','UNKNOWN')),
  pending_category      VARCHAR(14),                        -- Meta announced a re-categorisation
  pending_category_at   TIMESTAMPTZ,
  flagged               BOOLEAN NOT NULL DEFAULT FALSE,     -- negative feedback, at risk of being disabled
  locked                BOOLEAN NOT NULL DEFAULT FALSE,
  submitted_at          TIMESTAMPTZ,
  last_status_at        TIMESTAMPTZ,                        -- time of the newest status event applied (ordering guard)
  last_synced_at        TIMESTAMPTZ,
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- A deleted template frees its (name, language) locally; Meta still blocks reuse for 30 days
-- after deleting an approved one, which surfaces as a clear error on submit.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_templates_name_lang ON wa_templates (name, language) WHERE status <> 'DELETED';
CREATE INDEX IF NOT EXISTS idx_wa_templates_status ON wa_templates (status);

CREATE TABLE IF NOT EXISTS wa_template_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_id UUID NOT NULL REFERENCES wa_templates(id) ON DELETE CASCADE,
  event       VARCHAR(30) NOT NULL,
  detail      VARCHAR(400),
  source      VARCHAR(8) NOT NULL CHECK (source IN ('WEBHOOK','SYNC','SUBMIT','MANUAL','SYSTEM')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_template_events_tpl ON wa_template_events (template_id, created_at DESC);

ALTER TABLE wa_messages
  ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES wa_templates(id) ON DELETE SET NULL;

UPDATE roles SET permissions = (
  SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb)
    FROM jsonb_array_elements_text(permissions || '["crm.templates.view","crm.templates.send"]'::jsonb) AS p
 )
 WHERE name IN ('CRM Agent', 'CRM Manager', 'Super Admin');

UPDATE roles SET permissions = (
  SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb)
    FROM jsonb_array_elements_text(permissions || '["crm.templates.manage"]'::jsonb) AS p
 )
 WHERE name IN ('CRM Manager', 'Super Admin');
