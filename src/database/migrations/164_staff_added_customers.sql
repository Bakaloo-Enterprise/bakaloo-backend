-- 164_staff_added_customers.sql
--
-- Staff can create a customer on the spot (a restaurant that phoned, a walk-in) before that person has ever opened
-- the app. The row is an ordinary users row — if they later sign in with the same phone number via OTP they get
-- this same account, with its order history — plus a few facts that say it was added by staff:
--
--   added_by_staff        who added it (NULL = signed up on their own)
--   staff_added_at        when
--   staff_business_name   the business name, when staff added a business that has no business account (a business
--                         account needs a GSTIN and an approval; staff just need to take an order today)
--   staff_business_gstin  optional, shape-checked only, never verified
--
-- "Not on the app yet" is derived: added_by_staff IS NOT NULL AND last_active_at IS NULL.

ALTER TABLE users ADD COLUMN IF NOT EXISTS added_by_staff        UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_added_at        TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_business_name   VARCHAR(160);
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_business_gstin  VARCHAR(15);
