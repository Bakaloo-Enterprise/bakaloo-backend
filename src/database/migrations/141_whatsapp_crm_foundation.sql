-- 141_whatsapp_crm_foundation.sql
--
-- WhatsApp CRM — Phase 1 foundation (Meta WhatsApp Cloud API, single number).
--
-- Design notes
--   * ONE customer record. wa_contacts never duplicates users — it only holds
--     the WhatsApp identity and an optional pointer (user_id) to the existing
--     Bakaloo customer. Matching key is the normalised 10-digit Indian phone
--     (same format as users.phone).
--   * A phone number is NOT always available. Meta's usernames feature omits
--     the phone from webhooks for some senders and sends only a business-scoped
--     user id (BSUID) — so a contact can be keyed by wa_id (phone) OR bsuid,
--     and must stay usable ("unmatched") when only the BSUID is known.
--   * users is deliberately NOT touched (no trigger, no new column): linking
--     is done by the CRM code, so a CRM bug can never break customer signup.
--   * Webhooks are stored raw (wa_webhook_events) before processing, deduped
--     by body hash, so a Meta retry or a worker crash never loses or doubles
--     an event.
--   * Message status only moves forward (SENT -> DELIVERED -> READ); enforced
--     in code (status-ladder.js) because Meta delivers statuses out of order.
--   * Customer WhatsApp messages (wa_messages) and, later, internal staff chat
--     live in SEPARATE tables so an internal note can never reach a customer.

CREATE TABLE IF NOT EXISTS wa_webhook_events (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payload_hash  CHAR(64) NOT NULL UNIQUE,          -- sha256 of the raw body
  payload       JSONB NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
);
CREATE INDEX IF NOT EXISTS idx_wa_webhook_events_unprocessed
  ON wa_webhook_events(received_at) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS wa_contacts (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wa_id              VARCHAR(20) UNIQUE,            -- digits only incl. country code, e.g. 919876543210
  bsuid              VARCHAR(64) UNIQUE,            -- business-scoped user id, e.g. IN.1349...
  parent_bsuid       VARCHAR(64),
  wa_username        VARCHAR(64),
  phone              VARCHAR(15),                   -- normalised 10-digit Indian mobile (matches users.phone); NULL if unknown/non-Indian
  user_id            UUID REFERENCES users(id) ON DELETE SET NULL,
  profile_name       VARCHAR(255),
  source             VARCHAR(20) NOT NULL DEFAULT 'ORGANIC'
                       CHECK (source IN ('ORGANIC','META_AD','IMPORT','APP')),
  referral           JSONB,                         -- Click-to-WhatsApp ad info exactly as Meta sent it
  marketing_consent  VARCHAR(10) NOT NULL DEFAULT 'UNKNOWN'
                       CHECK (marketing_consent IN ('UNKNOWN','OPTED_IN','OPTED_OUT')),
  consent_updated_at TIMESTAMPTZ,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_inbound_at    TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_wa_contacts_identity CHECK (wa_id IS NOT NULL OR bsuid IS NOT NULL),
  CONSTRAINT chk_wa_contacts_wa_id_digits CHECK (wa_id IS NULL OR wa_id ~ '^[0-9]{8,15}$')
);
CREATE INDEX IF NOT EXISTS idx_wa_contacts_phone ON wa_contacts(phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wa_contacts_user ON wa_contacts(user_id) WHERE user_id IS NOT NULL;

-- One conversation per contact in V1 (agreement: "one inbox, one owner").
CREATE TABLE IF NOT EXISTS wa_conversations (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id             UUID NOT NULL UNIQUE REFERENCES wa_contacts(id) ON DELETE CASCADE,
  status                 VARCHAR(10) NOT NULL DEFAULT 'OPEN'
                           CHECK (status IN ('OPEN','PENDING','RESOLVED')),
  assigned_to            UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_at            TIMESTAMPTZ,
  unread_count           INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  last_message_at        TIMESTAMPTZ,
  last_message_preview   VARCHAR(200),
  last_message_direction VARCHAR(8) CHECK (last_message_direction IN ('INBOUND','OUTBOUND')),
  last_inbound_at        TIMESTAMPTZ,               -- drives the 24-hour free-reply window
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_conversations_inbox
  ON wa_conversations(status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_conversations_assignee
  ON wa_conversations(assigned_to) WHERE assigned_to IS NOT NULL;

CREATE TABLE IF NOT EXISTS wa_messages (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id  UUID NOT NULL REFERENCES wa_conversations(id) ON DELETE CASCADE,
  contact_id       UUID NOT NULL REFERENCES wa_contacts(id) ON DELETE CASCADE,
  direction        VARCHAR(8) NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  wamid            VARCHAR(255),                    -- Meta message id; NULL until Meta accepts an outbound send
  msg_type         VARCHAR(20) NOT NULL DEFAULT 'text',
  body             TEXT,
  media            JSONB,                           -- {id, mime_type, sha256, caption, filename} (not downloaded in Phase 1)
  interactive      JSONB,                           -- button/list reply payload
  template_name    VARCHAR(512),
  template_language VARCHAR(20),
  reply_to_wamid   VARCHAR(255),
  status           VARCHAR(10) NOT NULL
                     CHECK (status IN ('RECEIVED','QUEUED','SENT','DELIVERED','READ','FAILED')),
  error_code       INTEGER,
  error_title      TEXT,
  error_details    TEXT,
  sent_by          UUID REFERENCES users(id) ON DELETE SET NULL,   -- staff member for outbound
  wa_timestamp     TIMESTAMPTZ,                     -- Meta's own timestamp
  sent_at          TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  read_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_wa_messages_status_dir CHECK (
    (direction = 'INBOUND'  AND status = 'RECEIVED') OR
    (direction = 'OUTBOUND' AND status <> 'RECEIVED')
  )
);
-- Idempotency: Meta retries webhooks; the same wamid must never insert twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_messages_wamid
  ON wa_messages(wamid) WHERE wamid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wa_messages_conversation
  ON wa_messages(conversation_id, created_at DESC);
