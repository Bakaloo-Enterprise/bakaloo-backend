-- 154_developer_access.sql
--
-- "Developer Super Admin" + feature locks for the features that are still in development.
--
-- * users.is_developer — the superior role. A developer passes every feature lock. It is a separate flag (not a new
--   platform_role value) so no existing role/permission logic changes. Only developers can set it (see the
--   /admin/developer routes); no existing endpoint touches this column.
-- * feature_flags — one row per lockable feature. released = false means ONLY developers (and people the developer
--   granted individually) can use it; everyone else, including Admin and Super Admin, gets "in development".
--   Flipping released = true opens it to everyone who already holds the feature's normal permission.
-- * feature_grants — early access for a specific person before the feature is released to everyone.
--
-- Additive only: one NOT NULL DEFAULT false column (metadata-only in PostgreSQL 11+, no table rewrite) and two new tables.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_developer BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS feature_flags (
  key          VARCHAR(40) PRIMARY KEY,
  label        VARCHAR(80) NOT NULL,
  description  TEXT,
  released     BOOLEAN NOT NULL DEFAULT false,
  released_at  TIMESTAMPTZ,
  updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feature_grants (
  feature_key  VARCHAR(40) NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (feature_key, user_id)
);
CREATE INDEX IF NOT EXISTS idx_feature_grants_user ON feature_grants (user_id);

-- Everything starts LOCKED. ON CONFLICT DO NOTHING keeps a re-run from re-locking something a developer released.
INSERT INTO feature_flags (key, label, description) VALUES
  ('whatsapp_crm',       'WhatsApp CRM',        'Shared inbox, pipeline, templates, campaigns, workflows, bot, analytics and WhatsApp settings.'),
  ('team_chat',          'Team Chat',           'Internal team chat channels and direct messages.'),
  ('procurement',        'Procurement',         'Vendors, purchases, returns, damage and wastage with stock-ledger effects.'),
  ('catalog_bulk',       'Catalog Bulk Update', 'Bulk product / price / stock import and apply.'),
  ('store_pos',          'Store Fulfillment POS','Picker / packer board, scanning and print documents.'),
  ('business_analytics', 'Business Analytics',  'Procurement, loss and profit reporting.')
ON CONFLICT (key) DO NOTHING;
