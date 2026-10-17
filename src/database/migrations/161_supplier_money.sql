-- 161_supplier_money.sql
--
-- Procurement step 3: who the supplier is, what we owe them, and what we paid.
--
--   vendors            + trade name, GSTIN, address, contact, payment terms, credit days, UPI / bank details
--   procurement_documents  supplier invoices / delivery slips / credit notes kept PRIVATELY in the database
--                          (not on a public CDN link) and only served to signed-in staff with procurement access.
--   vendor_payments    money actually paid out. A purchase is NOT a payment: the amount owed to a supplier is
--                      (received purchases − credit for goods sent back − payments that were not voided).
--
-- Payments are paid "on account" per supplier; which bill a payment settles is worked out oldest-first when read,
-- so no allocation rows can drift. Nothing here touches stock or customer money.

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS trade_name     VARCHAR(160);
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS gstin          VARCHAR(15);
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS address        VARCHAR(300);
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS contact_person VARCHAR(120);
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS payment_terms  VARCHAR(8) NOT NULL DEFAULT 'CASH' CHECK (payment_terms IN ('CASH','UPI','BANK','CREDIT'));
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS credit_days    INTEGER NOT NULL DEFAULT 0 CHECK (credit_days BETWEEN 0 AND 365);
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS upi_id         VARCHAR(80);
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS bank_name      VARCHAR(80);
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS bank_account_no VARCHAR(24);
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS bank_ifsc      VARCHAR(11);

CREATE TABLE IF NOT EXISTS procurement_documents (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entry_id    UUID NOT NULL REFERENCES procurement_entries(id) ON DELETE CASCADE,
  kind        VARCHAR(14) NOT NULL DEFAULT 'INVOICE' CHECK (kind IN ('INVOICE','DELIVERY_SLIP','CREDIT_NOTE')),
  file_name   VARCHAR(200) NOT NULL,
  mime_type   VARCHAR(60) NOT NULL,
  size_bytes  INTEGER NOT NULL CHECK (size_bytes > 0),
  data        BYTEA NOT NULL,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_proc_docs_entry ON procurement_documents (entry_id);

CREATE TABLE IF NOT EXISTS vendor_payments (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id  UUID NOT NULL REFERENCES vendors(id),
  amount     NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method     VARCHAR(6) NOT NULL CHECK (method IN ('CASH','UPI','BANK')),
  paid_on    DATE NOT NULL,
  reference  VARCHAR(80),
  note       VARCHAR(300),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voided_at  TIMESTAMPTZ,
  voided_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason VARCHAR(200)
);
CREATE INDEX IF NOT EXISTS idx_vendor_payments_vendor ON vendor_payments (vendor_id, paid_on DESC);
