-- 165_accounting_periods.sql
--
-- Month closing. Closing a month freezes what was signed off:
--   accounting_periods       one row per CLOSED month: who closed it, a note, and the full report as it stood (JSONB),
--                            so the screen and the Excel file of a closed month never change afterwards
--   period_stock_snapshots   the stock (quantity + average cost) on every shelf at the end of that month; the next month
--                            starts from these instead of estimating
--   accounting_period_log    every close and every reopen, with who and why (append-only)
-- Reopening is allowed for the LATEST closed month only; the row and its stock snapshots are removed, the log stays.

CREATE TABLE IF NOT EXISTS accounting_periods (
  month      CHAR(7) PRIMARY KEY CHECK (month ~ '^\d{4}-\d{2}$'),
  closed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  note       VARCHAR(300),
  snapshot   JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS period_stock_snapshots (
  month           CHAR(7) NOT NULL REFERENCES accounting_periods(month) ON DELETE CASCADE,
  shop_product_id UUID NOT NULL,
  qty             INTEGER NOT NULL CHECK (qty >= 0),
  avg_cost        NUMERIC(14,4) NOT NULL CHECK (avg_cost >= 0),
  PRIMARY KEY (month, shop_product_id)
);

CREATE TABLE IF NOT EXISTS accounting_period_log (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  month      CHAR(7) NOT NULL,
  action     VARCHAR(10) NOT NULL CHECK (action IN ('CLOSED','REOPENED')),
  actor_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  note       VARCHAR(300),
  totals     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_period_log_month ON accounting_period_log (month, created_at);
