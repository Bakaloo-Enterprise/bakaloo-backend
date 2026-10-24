-- 169_erp_operations.sql
--
-- Operations ERP (Daily Ops day-close, Wastage Lab, Forecast, Explorer, Accounting).
--
-- * feature_flags row 'erp' — starts LOCKED like every new feature (only developers / granted people can open it).
-- * products.target_margin_pct / target_wastage_pct — what we aim for per product. NULL = use the default worked out from
--   shelf life (see erp/ops.rules.js). They only drive advice (price advisor, wastage breaches); no price is ever changed
--   by them.
--
-- Additive only: two nullable columns and one row.

INSERT INTO feature_flags (key, label, description) VALUES
  ('erp', 'Operations ERP', 'Day close and price advisor, Wastage Lab, demand forecast, data explorer, expenses and cash book.')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE products ADD COLUMN IF NOT EXISTS target_margin_pct  NUMERIC(5,2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS target_wastage_pct NUMERIC(5,2);

DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT chk_products_target_margin  CHECK (target_margin_pct  IS NULL OR (target_margin_pct  >= 0 AND target_margin_pct  < 90));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT chk_products_target_wastage CHECK (target_wastage_pct IS NULL OR (target_wastage_pct >= 0 AND target_wastage_pct <= 100));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
