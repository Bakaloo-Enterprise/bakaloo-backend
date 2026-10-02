-- 152_whatsapp_settings.sql
--
-- WhatsApp connection settings entered from the dashboard (WhatsApp CRM → Settings) instead of the server's .env.
-- ONE row (id = 1). Secrets (access token, app secret, verify token) are stored ENCRYPTED (AES-256-GCM, see
-- utils/secret-box.js) and are never sent back to the browser. A value saved here wins over the same value in .env;
-- anything not saved here still falls back to .env, so an existing server keeps working untouched.
--
-- connection_status is what the last "Test connection" found: NOT_TESTED | CONNECTED | FAILED.
-- enabled is NULL until a person (or a successful test) decides; NULL means "follow WHATSAPP_ENABLED in .env".

CREATE TABLE IF NOT EXISTS wa_settings (
  id                SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled           BOOLEAN,
  phone_number_id   VARCHAR(40),
  waba_id           VARCHAR(40),
  app_id            VARCHAR(40),
  access_token_enc  TEXT,
  verify_token_enc  TEXT,
  app_secret_enc    TEXT,
  connection_status VARCHAR(12) NOT NULL DEFAULT 'NOT_TESTED' CHECK (connection_status IN ('NOT_TESTED','CONNECTED','FAILED')),
  last_test         JSONB,
  last_tested_at    TIMESTAMPTZ,
  connected_at      TIMESTAMPTZ,
  updated_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Permission (free-form string in roles.permissions, like the other crm.* strings; HQ SUPER_ADMIN / ADMIN always pass).
UPDATE roles SET permissions = (
  SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb) FROM jsonb_array_elements_text(permissions || '["crm.settings.manage"]'::jsonb) AS p
 )
 WHERE name IN ('CRM Manager', 'Super Admin');
