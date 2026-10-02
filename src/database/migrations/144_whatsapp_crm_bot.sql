-- 144_whatsapp_crm_bot.sql
--
-- WhatsApp CRM — Phase 5: rule-based auto-reply bot (NO AI) + human handoff.
--
-- Safety design (see modules/whatsapp-crm/bot.service.js):
--   * Master switch wa_bot_settings.enabled defaults to FALSE: nothing is ever
--     auto-sent until a manager turns it on.
--   * Rules are data (editable keywords + reply text); first match by position wins.
--   * Per conversation the bot is BOT or HUMAN. An agent reply, a handoff rule,
--     "no rule matched", media, or a failed send flips it to HUMAN for
--     human_pause_minutes; after that quiet period (or when a RESOLVED chat
--     reopens) the bot is back.
--   * Bot messages are flagged is_bot so they are shown as "Bot", never count
--     as an agent reply for the pipeline, and are rate-limited per chat.
--   * wa_bot_events records every decision (replied / handed off / skipped and
--     why) so "why did the bot say that?" is answerable.
--
-- Permission (free-form string, like 142/143):  crm.bot.manage

ALTER TABLE wa_conversations
  ADD COLUMN IF NOT EXISTS bot_state          VARCHAR(5) NOT NULL DEFAULT 'BOT' CHECK (bot_state IN ('BOT','HUMAN')),
  ADD COLUMN IF NOT EXISTS bot_paused_until   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bot_handoff_reason VARCHAR(20);

CREATE TABLE IF NOT EXISTS wa_bot_settings (
  id                   SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled              BOOLEAN NOT NULL DEFAULT FALSE,
  human_pause_minutes  INTEGER NOT NULL DEFAULT 720 CHECK (human_pause_minutes BETWEEN 5 AND 10080),
  max_replies_per_hour INTEGER NOT NULL DEFAULT 6 CHECK (max_replies_per_hour BETWEEN 1 AND 60),
  fallback_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  fallback_text        TEXT NOT NULL DEFAULT 'Thanks for your message. A member of our team will reply to you shortly.',
  updated_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO wa_bot_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS wa_bot_rules (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name             VARCHAR(80) NOT NULL,
  position         INTEGER NOT NULL,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  match_type       VARCHAR(12) NOT NULL CHECK (match_type IN ('CONTAINS','EXACT','STARTS_WITH','PINCODE')),
  keywords         TEXT[] NOT NULL DEFAULT '{}',
  -- ALSO match when the WHOLE message is exactly one of these (menu digits: "2" must not fire inside "2 kg onions")
  exact_keywords   TEXT[] NOT NULL DEFAULT '{}',
  when_hours       VARCHAR(6) NOT NULL DEFAULT 'ANY' CHECK (when_hours IN ('ANY','OPEN','CLOSED')),
  action           VARCHAR(13) NOT NULL DEFAULT 'REPLY' CHECK (action IN ('REPLY','REPLY_HANDOFF','HANDOFF','OPT_OUT','OPT_IN')),
  reply_text       TEXT,
  cooldown_minutes INTEGER NOT NULL DEFAULT 0 CHECK (cooldown_minutes BETWEEN 0 AND 1440),
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_bot_rule_keywords CHECK (match_type = 'PINCODE' OR cardinality(keywords) + cardinality(exact_keywords) > 0),
  CONSTRAINT chk_bot_rule_reply CHECK (action = 'HANDOFF' OR (reply_text IS NOT NULL AND length(btrim(reply_text)) > 0))
);
CREATE INDEX IF NOT EXISTS idx_wa_bot_rules_order ON wa_bot_rules(position) WHERE is_active;

CREATE TABLE IF NOT EXISTS wa_bot_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES wa_conversations(id) ON DELETE CASCADE,
  inbound_wamid   VARCHAR(255),
  rule_id         UUID REFERENCES wa_bot_rules(id) ON DELETE SET NULL,
  outcome         VARCHAR(20) NOT NULL,   -- REPLIED, HANDOFF, NO_MATCH, SKIPPED_STALE, SKIPPED_COOLDOWN, RATE_LIMITED, SEND_FAILED, MEDIA
  detail          VARCHAR(200),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_bot_events_conv ON wa_bot_events(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_bot_events_rule ON wa_bot_events(rule_id, conversation_id, created_at DESC);

ALTER TABLE wa_messages
  ADD COLUMN IF NOT EXISTS is_bot      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bot_rule_id UUID REFERENCES wa_bot_rules(id) ON DELETE SET NULL;

-- Starter rules (English). Specific topics come BEFORE bare greetings; bare
-- greetings use EXACT so "hi, where is my order?" reaches the order rule.
-- Variables: {{customer_name}} {{last_order}} {{business_hours}} {{pincode_result}}
INSERT INTO wa_bot_rules (name, position, match_type, keywords, exact_keywords, when_hours, action, reply_text, cooldown_minutes)
SELECT * FROM (VALUES
  ('Unsubscribe from offers', 10, 'EXACT', ARRAY['stop','unsubscribe','stop messages','stop offers'], ARRAY[]::text[], 'ANY', 'OPT_OUT',
   'You have been unsubscribed from offers and promotions. You will still receive important updates about your orders. Reply START any time to subscribe again.', 0),
  ('Subscribe to offers', 20, 'EXACT', ARRAY['start','subscribe'], ARRAY[]::text[], 'ANY', 'OPT_IN',
   'Thank you! You will now receive offers and updates from Bakaloo. Reply STOP any time to unsubscribe.', 0),
  ('Talk to a person', 30, 'CONTAINS', ARRAY['agent','human','person','executive','representative','customer care','customer support','talk to','speak to','call me'], ARRAY['5'], 'ANY', 'REPLY_HANDOFF',
   'Sure, connecting you with our team. Someone will reply here shortly.', 0),
  ('Delivery area (PIN code check)', 40, 'PINCODE', ARRAY[]::text[], ARRAY[]::text[], 'ANY', 'REPLY',
   '{{pincode_result}}', 0),
  ('Menu 1 – Delivery area', 50, 'EXACT', ARRAY['1'], ARRAY[]::text[], 'ANY', 'REPLY',
   'Please send your 6-digit PIN code and I will check if we deliver to your area.', 0),
  ('Order status', 60, 'CONTAINS', ARRAY['order status','my order','where is my order','track','tracking','delivery status','where is my delivery'], ARRAY['2'], 'ANY', 'REPLY',
   'Hi {{customer_name}}, {{last_order}} For anything else, reply 5 to talk to our team.', 0),
  ('Payment or refund', 70, 'CONTAINS', ARRAY['payment','refund','paid','upi','money deducted','amount deducted'], ARRAY['3'], 'ANY', 'REPLY_HANDOFF',
   'Sorry for the trouble with your payment. A team member will check this for you shortly.', 0),
  ('Offers', 80, 'CONTAINS', ARRAY['offer','offers','coupon','coupons','discount','deal','deals'], ARRAY['4'], 'ANY', 'REPLY',
   'You can see our latest offers and coupons in the Bakaloo app. Reply 5 to talk to our team.', 0),
  ('Business hours', 90, 'CONTAINS', ARRAY['business hours','opening hours','timing','timings','what time','are you open','when do you open','when do you close'], ARRAY[]::text[], 'ANY', 'REPLY',
   'We are open {{business_hours}}.', 0),
  ('Help / menu', 100, 'CONTAINS', ARRAY['help','menu','options'], ARRAY[]::text[], 'ANY', 'REPLY',
   E'Hi {{customer_name}}! Reply with a number:\n1 – Delivery area\n2 – Order status\n3 – Payment or refund\n4 – Offers\n5 – Talk to our team', 10),
  ('Greeting (after hours)', 110, 'EXACT', ARRAY['hi','hii','hiii','hello','hey','hola','namaste','namaskar','good morning','good afternoon','good evening'], ARRAY[]::text[], 'CLOSED', 'REPLY',
   E'Hi {{customer_name}}, welcome to Bakaloo! 👋 We are closed right now. We are open {{business_hours}}.\nReply with a number:\n1 – Delivery area\n2 – Order status\n3 – Payment or refund\n4 – Offers\n5 – Talk to our team', 360),
  ('Greeting', 120, 'EXACT', ARRAY['hi','hii','hiii','hello','hey','hola','namaste','namaskar','good morning','good afternoon','good evening'], ARRAY[]::text[], 'OPEN', 'REPLY',
   E'Hi {{customer_name}}, welcome to Bakaloo! 👋\nReply with a number:\n1 – Delivery area\n2 – Order status\n3 – Payment or refund\n4 – Offers\n5 – Talk to our team', 360)
) AS v(name, position, match_type, keywords, exact_keywords, when_hours, action, reply_text, cooldown_minutes)
WHERE NOT EXISTS (SELECT 1 FROM wa_bot_rules);

UPDATE roles SET permissions = (
  SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb)
    FROM jsonb_array_elements_text(permissions || '["crm.bot.manage"]'::jsonb) AS p
 )
 WHERE name IN ('CRM Manager', 'Super Admin');
