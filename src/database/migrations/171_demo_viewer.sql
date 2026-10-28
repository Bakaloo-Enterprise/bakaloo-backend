-- 171_demo_viewer.sql
--
-- "Demo viewer" account: a normal dashboard login that can use every screen (WhatsApp CRM and B2B included) but only
-- ever sees the customers an admin picked as demo customers. Nothing else about the account is restricted.
--
-- * users.is_demo_viewer   — the restricted login.
-- * users.is_demo_customer — a customer whose activity demo viewers may see (their orders, wallet, refunds, notifications,
--                            addresses, WhatsApp chats ... follow that customer).
-- * demo_scope schema      — one filtered VIEW per customer-owned table, same name as the table. While a demo viewer's
--                            read request runs, the API puts demo_scope first in search_path, so every existing query
--                            (lists, counts, totals, charts) transparently sees only demo customers. Real customers
--                            therefore cannot appear by id, search, pagination or aggregate.
-- * demo_scope_rebuild()   — (re)creates those views from the CURRENT table columns. The API calls it on boot, so a
--                            later migration that adds a column never leaves a view stale.
--
-- Additive only: two NOT NULL DEFAULT false columns and a new schema. Nothing in public is changed.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_demo_viewer   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_demo_customer BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_users_demo_customer ON users (id) WHERE is_demo_customer;

CREATE SCHEMA IF NOT EXISTS demo_scope;

CREATE OR REPLACE FUNCTION demo_scope_rebuild() RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  demo_users   CONSTANT text := '(SELECT id FROM public.users WHERE is_demo_customer)';
  demo_orders  CONSTANT text := '(SELECT id FROM public.orders WHERE user_id IN ' || '(SELECT id FROM public.users WHERE is_demo_customer))';
  demo_wallets CONSTANT text := '(SELECT id FROM public.wallets WHERE user_id IN ' || '(SELECT id FROM public.users WHERE is_demo_customer))';
  demo_carts   CONSTANT text := '(SELECT id FROM public.abandoned_carts WHERE user_id IN ' || '(SELECT id FROM public.users WHERE is_demo_customer))';
  demo_contacts CONSTANT text := '(SELECT id FROM public.wa_contacts WHERE user_id IN ' || '(SELECT id FROM public.users WHERE is_demo_customer))';
  t record;
BEGIN
  PERFORM pg_advisory_xact_lock(171171);
  DROP VIEW IF EXISTS demo_scope.users; -- an earlier draft filtered users; never leave that view behind

  FOR t IN
    SELECT * FROM (VALUES
      -- NOTE: `users` is deliberately NOT filtered. The Customers list shows every customer (real total) with contact
      -- details blurred by the API; only what customers DO (orders, wallet, refunds ...) is limited to demo customers.

      -- owned directly by a customer
      ('orders',                             'user_id IN ' || demo_users),
      ('payments',                           'user_id IN ' || demo_users),
      ('wallets',                            'user_id IN ' || demo_users),
      ('wallet_credit_lots',                 'user_id IN ' || demo_users),
      ('addresses',                          'user_id IN ' || demo_users),
      ('notifications',                      'user_id IN ' || demo_users),
      ('fcm_tokens',                         'user_id IN ' || demo_users),
      ('refund_requests',                    'user_id IN ' || demo_users),
      ('reviews',                            'user_id IN ' || demo_users),
      ('wishlist',                           'user_id IN ' || demo_users),
      ('product_views',                      'user_id IN ' || demo_users),
      ('scheduled_orders',                   'user_id IN ' || demo_users),
      ('bulk_orders',                        'user_id IN ' || demo_users),
      ('business_accounts',                  'user_id IN ' || demo_users),
      ('abandoned_carts',                    'user_id IN ' || demo_users),
      ('cashback_transactions',              'user_id IN ' || demo_users),
      ('coupon_usages',                      'user_id IN ' || demo_users),
      ('coupon_target_users',                'user_id IN ' || demo_users),
      ('payment_offer_usages',               'user_id IN ' || demo_users),
      ('cart_milestone_usages',              'user_id IN ' || demo_users),
      ('customer_segment_members',           'user_id IN ' || demo_users),
      ('customer_address_rider_preferences', 'user_id IN ' || demo_users),
      ('area_segment_addresses',             'user_id IN ' || demo_users),
      ('user_shop_allocations',              'user_id IN ' || demo_users),
      ('user_spin_wallet',                   'user_id IN ' || demo_users),
      ('spin_history',                       'user_id IN ' || demo_users),
      ('spin_credit_grants',                 'user_id IN ' || demo_users),
      ('user_scratch_wallet',                'user_id IN ' || demo_users),
      ('scratch_history',                    'user_id IN ' || demo_users),
      ('scratch_credit_grants',              'user_id IN ' || demo_users),
      ('theme_analytics',                    'user_id IN ' || demo_users),

      -- follow a customer's order
      ('order_items',                        'order_id IN ' || demo_orders),
      ('order_status_history',               'order_id IN ' || demo_orders),
      ('order_notes',                        'order_id IN ' || demo_orders),
      ('order_pickup_tokens',                'order_id IN ' || demo_orders),
      ('order_b2b_settlements',              'order_id IN ' || demo_orders),
      ('delivery_assignments',               'order_id IN ' || demo_orders),
      ('rider_earnings',                     'order_id IN ' || demo_orders),
      ('rider_assignment_log',               'order_id IN ' || demo_orders),
      ('qr_scan_logs',                       'order_id IN ' || demo_orders),
      ('ledger_transactions',                'order_id IS NULL OR order_id IN ' || demo_orders),
      ('shop_transactions',                  'order_id IS NULL OR order_id IN ' || demo_orders),
      ('stock_movements',                    'order_id IS NULL OR order_id IN ' || demo_orders),
      ('wallet_lot_consumptions',            'order_id IN ' || demo_orders),
      ('pos_fulfillments',                   'order_id IN ' || demo_orders),
      ('pos_lines',                          'order_id IN ' || demo_orders),
      ('pos_scans',                          'order_id IN ' || demo_orders),
      ('pos_print_jobs',                     'order_id IN ' || demo_orders),
      ('pos_handovers',                      'order_id IN ' || demo_orders),
      ('pos_events',                         'order_id IS NULL OR order_id IN ' || demo_orders),
      ('pos_attention_resolutions',          'order_id IN ' || demo_orders),

      -- follow a customer's wallet / abandoned cart
      ('wallet_transactions',                'wallet_id IN ' || demo_wallets),
      ('abandoned_cart_items',               'abandoned_cart_id IN ' || demo_carts),
      ('abandoned_cart_events',              'abandoned_cart_id IN ' || demo_carts),
      ('abandoned_cart_notifications',       'abandoned_cart_id IN ' || demo_carts),
      ('abandoned_cart_coupons',             'abandoned_cart_id IN ' || demo_carts),

      -- WhatsApp CRM: a contact is visible only when it is a demo customer (so prospects and leads disappear)
      ('wa_contacts',                        'user_id IN ' || demo_users),
      ('wa_conversations',                   'contact_id IN ' || demo_contacts),
      ('wa_messages',                        'contact_id IN ' || demo_contacts),
      ('wa_contact_labels',                  'contact_id IN ' || demo_contacts),
      ('wa_campaign_recipients',             'contact_id IN ' || demo_contacts),
      ('wa_suppression',                     'contact_id IN ' || demo_contacts),
      ('wa_prospect_rows',                   'contact_id IN ' || demo_contacts),
      ('wa_workflow_runs',                   'contact_id IN ' || demo_contacts),
      ('crm_stage_history',                  'contact_id IN ' || demo_contacts)
    ) AS v(tbl, predicate)
  LOOP
    -- A table that does not exist (older database, or a feature not installed) is simply skipped.
    IF to_regclass('public.' || t.tbl) IS NOT NULL THEN
      EXECUTE format('DROP VIEW IF EXISTS demo_scope.%I', t.tbl);
      EXECUTE format('CREATE VIEW demo_scope.%I AS SELECT * FROM public.%I WHERE %s', t.tbl, t.tbl, t.predicate);
    END IF;
  END LOOP;
END
$fn$;

SELECT demo_scope_rebuild();
