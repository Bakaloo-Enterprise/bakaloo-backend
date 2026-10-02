-- 147_whatsapp_crm_prospect_imports.sql
--
-- WhatsApp CRM — Phase 8: wholesale prospect outreach (WhatsApp only).
--
-- A sheet of prospects (name, business, phone) is uploaded, VALIDATED and MATCHED against what we
-- already know, shown as a preview, and only then confirmed. Nothing is messaged by an import:
-- confirming records the uploader's consent attestation and links each usable row to a wa_contacts
-- row; the prospects are then reached through an ordinary campaign (audience type IMPORT), so
-- every Phase 7 safeguard (approved template, opt-out, suppression, quiet hours, pacing) applies.
--
-- Row statuses:
--   NEW               a number we have never seen
--   EXISTING_CONTACT  already in the WhatsApp CRM (not a registered customer)
--   EXISTING_CUSTOMER already a Bakaloo customer (excluded unless the uploader includes them)
--   INVALID           not a usable phone number
--   DUPLICATE         the same number appeared earlier in this file
--   OPTED_OUT         the person previously opted out — never contacted
--   SUPPRESSED        on the do-not-contact list — never contacted
-- Permissions: reuses crm.campaigns.view / crm.campaigns.manage.

CREATE TABLE IF NOT EXISTS wa_prospect_imports (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name             VARCHAR(120) NOT NULL,
  filename         VARCHAR(200),
  status           VARCHAR(10) NOT NULL DEFAULT 'PREVIEW' CHECK (status IN ('PREVIEW','CONFIRMED')),
  total_rows       INTEGER NOT NULL DEFAULT 0,
  consent_source   VARCHAR(40),
  include_existing BOOLEAN NOT NULL DEFAULT FALSE,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wa_prospect_imports_created ON wa_prospect_imports (created_at DESC);

CREATE TABLE IF NOT EXISTS wa_prospect_rows (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  import_id     UUID NOT NULL REFERENCES wa_prospect_imports(id) ON DELETE CASCADE,
  row_number    INTEGER NOT NULL,
  name          VARCHAR(120),
  business_name VARCHAR(160),
  phone_raw     VARCHAR(40),
  wa_id         VARCHAR(20),
  status        VARCHAR(18) NOT NULL
                  CHECK (status IN ('NEW','EXISTING_CONTACT','EXISTING_CUSTOMER','INVALID','DUPLICATE','OPTED_OUT','SUPPRESSED')),
  contact_id    UUID REFERENCES wa_contacts(id) ON DELETE SET NULL,
  selected      BOOLEAN NOT NULL DEFAULT FALSE,   -- true once confirmed and usable
  UNIQUE (import_id, row_number)
);
CREATE INDEX IF NOT EXISTS idx_wa_prospect_rows_import ON wa_prospect_rows (import_id, status);
CREATE INDEX IF NOT EXISTS idx_wa_prospect_rows_contact ON wa_prospect_rows (contact_id) WHERE contact_id IS NOT NULL;
