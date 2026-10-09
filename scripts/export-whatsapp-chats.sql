-- READ-ONLY export of every WhatsApp chat, for analysing how the team really talks to customers.
-- Writes 3 CSV files into the current directory. Changes nothing in the database.
--
-- Run (from a folder you can write to):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f export-whatsapp-chats.sql
-- or on the server:
--   sudo -u postgres psql grocery_db -v ON_ERROR_STOP=1 -f export-whatsapp-chats.sql
--
-- The CSVs contain customers' phone numbers and messages: keep them private, never commit them.

BEGIN READ ONLY;

-- 1) Every message, oldest first inside each chat.
\copy (SELECT c.wa_id AS customer_wa_id, c.profile_name, c.source AS lead_source, m.conversation_id, m.created_at, m.direction, CASE WHEN m.direction = 'INBOUND' THEN 'CUSTOMER' WHEN m.is_bot THEN 'BOT' WHEN m.template_name IS NOT NULL THEN 'TEMPLATE' ELSE 'TEAM' END AS who, u.name AS team_member, m.msg_type, m.template_name, m.body, m.interactive->>'title' AS button_or_list_title, m.status, m.error_code FROM wa_messages m JOIN wa_contacts c ON c.id = m.contact_id LEFT JOIN users u ON u.id = m.sent_by ORDER BY m.conversation_id, m.created_at) TO 'wa_messages.csv' WITH CSV HEADER

-- 2) One row per customer: where they came from (Meta ad details included), consent, linked app account, orders.
\copy (SELECT c.wa_id, c.profile_name, c.source, c.referral->>'headline' AS ad_headline, c.referral->>'source_url' AS ad_url, c.marketing_consent, c.first_seen_at, cv.status AS chat_status, cv.last_message_at, (SELECT COUNT(*) FROM wa_messages x WHERE x.conversation_id = cv.id AND x.direction = 'INBOUND') AS customer_msgs, (SELECT COUNT(*) FROM wa_messages x WHERE x.conversation_id = cv.id AND x.direction = 'OUTBOUND') AS our_msgs, (c.user_id IS NOT NULL) AS has_app_account, (SELECT COUNT(*) FROM orders o WHERE o.user_id = c.user_id) AS orders_placed FROM wa_contacts c LEFT JOIN wa_conversations cv ON cv.contact_id = c.id ORDER BY c.first_seen_at) TO 'wa_customers.csv' WITH CSV HEADER

-- 3) The bot rules and bot settings as they are today.
\copy (SELECT position, name, match_type, keywords, exact_keywords, when_hours, action, reply_text FROM wa_bot_rules ORDER BY position) TO 'wa_bot_rules.csv' WITH CSV HEADER

ROLLBACK;
