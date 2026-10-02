-- 142_whatsapp_crm_labels_assignment_roles.sql
--
-- WhatsApp CRM — Phase 3: labels, conversation ownership audit, CRM roles.
--
-- Permissions here are the FREE-FORM strings of the DB-driven RBAC
-- (roles.permissions JSONB, checked by the CRM guard in
-- modules/whatsapp-crm/access.js). They are deliberately NOT added to the
-- canonical 37-string vocabulary in utils/permissions.js, which is covered by
-- property tests and mirrored by migration 046.
--
--   crm.inbox.view        see the inbox (own + unassigned chats)
--   crm.inbox.view_all    see EVERY conversation, including other agents'
--   crm.inbox.reply       send WhatsApp replies, take an unassigned chat
--   crm.labels.apply      add/remove labels on a customer
--   crm.labels.manage     create / edit / delete labels
--   crm.conversations.assign   assign, transfer, bulk reassign
--   crm.workload.view     agent workload board
-- HQ SUPER_ADMIN / ADMIN (users.platform_role) always pass in code.

CREATE TABLE IF NOT EXISTS wa_labels (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(40) NOT NULL,
  color       VARCHAR(7) NOT NULL DEFAULT '#64748B' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  description VARCHAR(200),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_labels_name_ci ON wa_labels (lower(name));

-- Labels belong to the CONTACT (the customer), so they follow them everywhere.
CREATE TABLE IF NOT EXISTS wa_contact_labels (
  contact_id UUID NOT NULL REFERENCES wa_contacts(id) ON DELETE CASCADE,
  label_id   UUID NOT NULL REFERENCES wa_labels(id) ON DELETE CASCADE,
  source     VARCHAR(10) NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','AUTO')),
  added_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contact_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_wa_contact_labels_label ON wa_contact_labels(label_id);

-- WHO moved WHICH conversation to WHOM, and when (agreement: audit rule).
CREATE TABLE IF NOT EXISTS wa_assignment_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES wa_conversations(id) ON DELETE CASCADE,
  from_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  to_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  changed_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  action          VARCHAR(12) NOT NULL CHECK (action IN ('ASSIGN','TRANSFER','UNASSIGN','CLAIM','BULK')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_assignment_log_conv ON wa_assignment_log(conversation_id, created_at DESC);

-- Starter labels from the agreement (editable / deletable by managers).
INSERT INTO wa_labels (name, color) VALUES
  ('New Customer', '#16A34A'), ('Existing Customer', '#2563EB'), ('VIP', '#CA8A04'),
  ('High Value', '#9333EA'), ('B2B', '#0F766E'), ('B2C', '#0369A1'),
  ('Abandoned Cart', '#EA580C'), ('Needs Follow-up', '#DC2626'), ('Complaint', '#B91C1C'),
  ('Repeat Customer', '#4F46E5'), ('Inactive', '#6B7280')
ON CONFLICT DO NOTHING;

-- Roles (non-system so admins can tune them on the Team & Roles page).
INSERT INTO roles (name, description, is_system, permissions) VALUES
  ('CRM Agent', 'Replies to customers on WhatsApp. Sees own and unassigned chats.', false,
   '["crm.inbox.view","crm.inbox.reply","crm.labels.apply"]'::jsonb),
  ('CRM Manager', 'Full WhatsApp CRM: sees all chats, assigns work, manages labels and workload.', false,
   '["crm.inbox.view","crm.inbox.view_all","crm.inbox.reply","crm.labels.apply","crm.labels.manage","crm.conversations.assign","crm.workload.view"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- The legacy all-powerful role also gets CRM access (re-runnable: union, no duplicates).
UPDATE roles SET permissions = (
  SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb)
    FROM jsonb_array_elements_text(
           permissions || '["crm.inbox.view","crm.inbox.view_all","crm.inbox.reply","crm.labels.apply","crm.labels.manage","crm.conversations.assign","crm.workload.view"]'::jsonb
         ) AS p
 )
 WHERE name = 'Super Admin';
