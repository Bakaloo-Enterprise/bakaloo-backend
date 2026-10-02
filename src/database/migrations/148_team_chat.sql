-- 148_team_chat.sql
--
-- WhatsApp CRM — Phase 9: internal team chat for dashboard staff (HQ + store).
--
-- Deliberately SEPARATE from wa_conversations / wa_messages: nothing written here can ever be sent
-- to a customer, and no customer message is stored here (agreement §04.9).
--
--   DM       exactly two people; one per pair (dm_key = the two user ids, sorted)
--   GROUP    any staff member can start one and becomes its owner
--   CHANNEL  created by HQ managers (permission chat.manage): HQ-wide or per-store ("audience"),
--            store <-> store included. Members are explicit rows; the audience only decides who is
--            added when the channel is created or refreshed — it never silently removes anyone.
--
-- Messages may point at one business object (ref_type/ref_id + a label snapshot) so a thread can be
-- "about" an order, a product or a customer. Procurement refs arrive with Phase 12.
-- Ordering/unread use a per-channel monotonic `seq` (inserts are serialised per channel by the app).
-- Permissions: chat.use is held by every active dashboard user; chat.manage by HQ SUPER_ADMIN/ADMIN
-- and any role that lists it.

CREATE TABLE IF NOT EXISTS chat_channels (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  kind            VARCHAR(8) NOT NULL CHECK (kind IN ('DM','GROUP','CHANNEL')),
  name            VARCHAR(80),
  description     VARCHAR(300),
  dm_key          VARCHAR(80) UNIQUE,
  audience        JSONB,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  archived_at     TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chat_dm_shape CHECK ((kind = 'DM' AND dm_key IS NOT NULL AND name IS NULL) OR (kind <> 'DM' AND dm_key IS NULL AND name IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS chat_members (
  channel_id    UUID NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          VARCHAR(6) NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('OWNER','MEMBER')),
  last_read_seq BIGINT NOT NULL DEFAULT 0,
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members (user_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  seq         BIGINT GENERATED ALWAYS AS IDENTITY,
  channel_id  UUID NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  sender_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  body        VARCHAR(4000) NOT NULL DEFAULT '',
  ref_type    VARCHAR(10) CHECK (ref_type IN ('ORDER','PRODUCT','CUSTOMER')),
  ref_id      UUID,
  ref_label   VARCHAR(160),
  mentions    UUID[] NOT NULL DEFAULT '{}',
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chat_msg_ref_pair CHECK ((ref_type IS NULL) = (ref_id IS NULL)),
  CONSTRAINT chat_msg_not_empty CHECK (deleted_at IS NOT NULL OR length(body) > 0 OR ref_type IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_seq ON chat_messages (channel_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_sender_time ON chat_messages (sender_id, created_at DESC);
