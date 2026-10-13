-- 158_wallet_credit_expiry.sql
-- Expiring wallet credits (spin / scratch / coupon cashback / offer / admin
-- bonus) alongside never-expiring money (top-ups, refunds, plain admin
-- credits).
--
-- Model: wallets.balance stays the single spendable total, so every existing
-- reader/writer keeps working. Each expiring credit additionally gets a "lot"
-- row here that remembers how much of it is still unspent and when it dies:
--
--     wallets.balance  =  permanent money  +  SUM(remaining_amount of ACTIVE lots)
--
-- Debits consume ACTIVE lots first (soonest expiry first) so a customer's
-- bonus is used before their own top-up money. When a lot passes expires_at
-- the unspent remainder is removed from wallets.balance and a DEBIT
-- wallet_transactions row (sub_type='EXPIRY') records it.
--
-- Nothing here touches existing balances: money that already sits in a wallet
-- has no lot, so it is treated as permanent and never expires retroactively.

CREATE TABLE IF NOT EXISTS wallet_credit_lots (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet_id           UUID NOT NULL REFERENCES wallets(id),
  user_id             UUID NOT NULL REFERENCES users(id),
  source_type         VARCHAR(20) NOT NULL,
  original_amount     DECIMAL(10,2) NOT NULL CHECK (original_amount > 0),
  remaining_amount    DECIMAL(10,2) NOT NULL CHECK (remaining_amount >= 0),
  expires_at          TIMESTAMPTZ NOT NULL,
  status              VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
  -- The CREDIT wallet_transactions row that created this lot.
  credit_tx_id        UUID REFERENCES wallet_transactions(id),
  -- Originating record (cashback_transactions.id / spin_history.id / ...).
  source_id           UUID,
  -- The DEBIT wallet_transactions row written when the lot expired.
  expired_tx_id       UUID REFERENCES wallet_transactions(id),
  expired_amount      DECIMAL(10,2),
  expired_at          TIMESTAMPTZ,
  -- Notification bookkeeping (claimed once by the worker, so a cluster of
  -- API processes never double-notifies).
  reminder_sent_at    TIMESTAMPTZ,
  expired_notified_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_wallet_lot_source CHECK (
    source_type IN ('SPIN', 'SCRATCH', 'COUPON', 'OFFER', 'ADMIN')
  ),
  CONSTRAINT chk_wallet_lot_status CHECK (
    status IN ('ACTIVE', 'EXHAUSTED', 'EXPIRED')
  ),
  CONSTRAINT chk_wallet_lot_remaining CHECK (remaining_amount <= original_amount)
);

-- Hot paths: "any lots due for this wallet", "lots to spend, soonest first",
-- and the worker's global "what is due now" scan.
CREATE INDEX IF NOT EXISTS idx_wallet_lots_wallet_active
  ON wallet_credit_lots (wallet_id, expires_at) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_wallet_lots_due
  ON wallet_credit_lots (expires_at) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_wallet_lots_source
  ON wallet_credit_lots (source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wallet_lots_user ON wallet_credit_lots (user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_lots_unnotified_expiry
  ON wallet_credit_lots (expired_at) WHERE status = 'EXPIRED' AND expired_notified_at IS NULL;

-- Which lots paid for which debit. Only needed so that cancelling an order
-- that was (partly) paid with bonus money hands the bonus back to its lot
-- instead of laundering it into never-expiring balance.
CREATE TABLE IF NOT EXISTS wallet_lot_consumptions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lot_id          UUID NOT NULL REFERENCES wallet_credit_lots(id),
  wallet_tx_id    UUID NOT NULL REFERENCES wallet_transactions(id),
  order_id        UUID REFERENCES orders(id),
  amount          DECIMAL(10,2) NOT NULL CHECK (amount > 0),
  restored_amount DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (restored_amount >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_wallet_lot_consumption_restored CHECK (restored_amount <= amount)
);

CREATE INDEX IF NOT EXISTS idx_wallet_lot_cons_order
  ON wallet_lot_consumptions (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wallet_lot_cons_lot ON wallet_lot_consumptions (lot_id);

-- Customer-visible expiry date on the CREDIT row, and the new sub_types.
ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS chk_wallet_tx_sub_type;
ALTER TABLE wallet_transactions
  ADD CONSTRAINT chk_wallet_tx_sub_type
  CHECK (sub_type IS NULL OR sub_type IN
    ('REFUND', 'BONUS', 'SCRATCH', 'CASHBACK', 'ORDER', 'TOPUP', 'EXPIRY'));

-- Admin-configurable rules (Settings → Wallet). Master switch ships OFF so
-- deploying this migration changes nothing until an admin opts in; a days
-- value of 0 means "this source never expires".
INSERT INTO app_settings (key, value, description) VALUES
  ('wallet_expiry_enabled',        'false', 'Master switch: bonus/cashback credits expire. Top-ups and refunds never do'),
  ('wallet_expiry_days_spin',      '30',    'Days a Spin & Win cash prize stays valid (0 = never)'),
  ('wallet_expiry_days_scratch',   '30',    'Days a Scratch Card cash prize stays valid (0 = never)'),
  ('wallet_expiry_days_coupon',    '30',    'Days coupon cashback stays valid (0 = never)'),
  ('wallet_expiry_days_offer',     '30',    'Days first-order / milestone / payment-offer cashback stays valid (0 = never)'),
  ('wallet_expiry_days_admin',     '30',    'Default days an admin-issued bonus credit stays valid (0 = never)'),
  ('wallet_expiry_reminder_days',  '3',     'Remind the customer this many days before a credit expires (0 = no reminder)')
ON CONFLICT (key) DO NOTHING;
