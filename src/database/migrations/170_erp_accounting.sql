-- 170_erp_accounting.sql
--
-- Operations ERP — Accounting: the money the system cannot see by itself.
--
-- * erp_expenses     — running costs (rent, salaries, electricity, packing, rider pay, fees …). Never deleted: a wrong entry
--                      is VOIDED with a reason and stays visible (who, when, why).
-- * erp_cash_entries — the owner's side of the money: opening balance, capital put in, drawings taken out, other income and
--                      moves between the cash box and the bank. Same rule: void, never delete.
--
-- Sales, purchases, supplier payments, B2B collections, COD cash and gateway money are NOT copied here — they are read from
-- the tables that already hold them, so nothing can be typed twice or disagree.
--
-- Additive only: two new tables.

CREATE TABLE IF NOT EXISTS erp_expenses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spent_on    DATE NOT NULL,
  category    VARCHAR(20) NOT NULL CHECK (category IN ('RENT','SALARY','ELECTRICITY','INTERNET','TAXES','TRANSPORT','PACKING','RIDER_PAY','MARKETING','GATEWAY_FEES','MAINTENANCE','OTHER')),
  kind        VARCHAR(8)  NOT NULL CHECK (kind IN ('FIXED','VARIABLE')),
  amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  paid_via    VARCHAR(4)  NOT NULL CHECK (paid_via IN ('CASH','UPI','BANK')),
  shop_id     UUID REFERENCES shops(id) ON DELETE SET NULL,
  party       VARCHAR(120),
  note        VARCHAR(300),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voided_at   TIMESTAMPTZ,
  voided_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason VARCHAR(300),
  CONSTRAINT chk_erp_expense_void CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_erp_expenses_day  ON erp_expenses (spent_on DESC) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_erp_expenses_shop ON erp_expenses (shop_id, spent_on DESC) WHERE voided_at IS NULL;

CREATE TABLE IF NOT EXISTS erp_cash_entries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_on    DATE NOT NULL,
  kind        VARCHAR(16) NOT NULL CHECK (kind IN ('OPENING_BALANCE','OWNER_CAPITAL','OWNER_DRAWING','OTHER_INCOME','BANK_DEPOSIT','BANK_WITHDRAWAL')),
  account     VARCHAR(4)  CHECK (account IN ('CASH','BANK')),
  amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  note        VARCHAR(300),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voided_at   TIMESTAMPTZ,
  voided_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason VARCHAR(300),
  -- moves between cash and bank have no single account; everything else must name one
  CONSTRAINT chk_erp_cash_account CHECK ((kind IN ('BANK_DEPOSIT','BANK_WITHDRAWAL')) = (account IS NULL)),
  CONSTRAINT chk_erp_cash_void CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_erp_cash_day ON erp_cash_entries (entry_on DESC) WHERE voided_at IS NULL;
